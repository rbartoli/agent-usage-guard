// Facts the harness reports after they happen. None of these decide anything;
// they keep the state the gates read accurate.

import type { Config } from './config.ts'
import { type AgentKind, type LimitReading, type LoopId, MAIN, type SessionState, loopOf } from './state.ts'

export type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Tokens a request carried in: what the loop's next request re-reads, roughly. */
function contextOf(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

/**
 * One model request finished in `loop`, with the usage the API reported. An
 * agent that makes one is running, even if it had gone quiet for long enough
 * to stop counting.
 */
export function observeResponse(state: SessionState, config: Config, now: number, loop: LoopId, usage: TokenUsage): void {
  const context = contextOf(usage)
  setContext(state, config, loop, context)
  loopOf(state, loop).activeAt = now
  const agent = state.agents[loop]
  if (!agent) return
  agent.running = true
  state.agentTokens.push([now, context + usage.output])
}

/** The main conversation's context as the harness reports it, without a request. */
export function observeMainContext(state: SessionState, config: Config, tokens: number): void {
  setContext(state, config, MAIN, tokens)
}

/** Records a loop's context. Below a threshold, what was tied to it ends: the heavy approval and tool budget, the warning, the prompt approval. */
function setContext(state: SessionState, config: Config, loop: LoopId, context: number): void {
  const l = loopOf(state, loop)
  l.context = context
  if (context < config.toolContext) {
    delete l.heavyLeaseUntil
    l.heavyCalls = []
  }
  if (loop !== MAIN) return
  if (context < config.contextWarn) state.warned = false
  if (context < config.contextHard) delete state.leases['prompt-context']
}

/** The conversation was compacted: the old context and approvals tied to it are gone. */
export function observeCompaction(state: SessionState, loop: LoopId = MAIN): void {
  const l = loopOf(state, loop)
  delete l.context
  delete l.heavyLeaseUntil
  l.heavyCalls = []
  if (loop === MAIN) {
    state.warned = false
    delete state.leases['prompt-context']
  }
}

/**
 * The plan windows the latest response reported. Returns the windows whose
 * percentage crossed one of the guard's thresholds since the previous reading,
 * so the adapter can journal the crossing once.
 */
export function observeLimits(
  state: SessionState,
  config: Config,
  readings: readonly LimitReading[],
): Array<{ reading: LimitReading; threshold: number }> {
  const crossings: Array<{ reading: LimitReading; threshold: number }> = []
  for (const reading of readings) {
    const previous = state.limits[reading.kind]
    const sameWindow = previous?.resetsAt === reading.resetsAt
    for (const threshold of [config.limitAskPercent, config.limitDenyPercent]) {
      const before = sameWindow && previous ? previous.percent : 0
      if (before < threshold && reading.percent >= threshold) crossings.push({ reading, threshold })
    }
    state.limits[reading.kind] = reading
    state.limitHistory.push(reading)
  }
  return crossings
}

export type SpawnFacts = {
  agentId: string
  kind: AgentKind
  depth: number
  name?: string
}

/**
 * Holds a slot for an agent the gate just allowed. Call it in the same
 * synchronous step as the verdict: parallel spawns are judged concurrently, and
 * each must see the slots the others already took. Returns the start's time,
 * which `releaseStart` takes back if the agent never starts.
 */
export function reserveStart(state: SessionState, now: number): number {
  state.pendingStarts += 1
  state.starts.push(now)
  return now
}

/**
 * Ends a reservation: `agentId` started, or, when it is undefined, the start
 * failed and is not counted. Once no gated agent is starting, the starts none
 * of them claimed are counted.
 */
export function releaseStart(state: SessionState, reservedAt: number, agentId: string | undefined): void {
  state.pendingStarts = Math.max(0, state.pendingStarts - 1)
  if (agentId === undefined) {
    const index = state.starts.indexOf(reservedAt)
    if (index >= 0) state.starts.splice(index, 1)
  } else {
    delete state.unclaimed[agentId]
  }
  countUnclaimed(state)
}

/** An agent the gate allowed has started; its start was counted by `reserveStart`. */
export function observeSpawn(state: SessionState, now: number, facts: SpawnFacts): void {
  state.agents[facts.agentId] = {
    id: facts.agentId,
    kind: facts.kind,
    depth: facts.depth,
    running: true,
    startedAt: now,
    ...(facts.name ? { name: facts.name } : {}),
  }
}

/** A known agent's loop ran again: a resumed subagent or a teammate that woke. */
export function observeAgentActive(state: SessionState, agentId: string): void {
  const agent = state.agents[agentId]
  if (agent) agent.running = true
}

/**
 * The harness reported an agent's loop starting. A known agent is running
 * again. An unknown one started without passing the gate, such as a /subtask
 * fork the user ran: it is counted, never blocked. While a gated agent is
 * still starting, its own report looks the same, so an unknown start waits
 * until every gated agent has claimed its own. An agent with no type is the
 * harness's own and is left out, which is the one case that returns false.
 */
export function observeAgentStart(state: SessionState, now: number, agentId: string, type: string): boolean {
  if (state.agents[agentId]) {
    observeAgentActive(state, agentId)
    return true
  }
  if (!type) return false
  state.unclaimed[agentId] = { at: now, kind: type === 'fork' ? 'fork' : 'subagent' }
  countUnclaimed(state)
  return true
}

/** Once no gated agent is starting, counts the starts none of them claimed. */
function countUnclaimed(state: SessionState): void {
  if (state.pendingStarts > 0) return
  for (const [agentId, { at, kind }] of Object.entries(state.unclaimed)) {
    observeSpawn(state, at, { agentId, kind, depth: 1 })
    state.starts.push(at)
  }
  state.unclaimed = {}
}

/** A known agent finished a run. Its context leaves with it. */
export function observeAgentRunEnd(state: SessionState, agentId: string): void {
  const agent = state.agents[agentId]
  if (agent) agent.running = false
  const loop = state.loops[agentId]
  if (loop) loop.stopped = false
}

/**
 * Agents with no sign of life for `ttlMs` stop counting as running: no model
 * request, and no tool call running or finished. That catches an agent whose
 * end the harness never reported; one that is only slow comes back with its
 * next request.
 */
export function expireAgents(state: SessionState, now: number, ttlMs: number): void {
  for (const agent of Object.values(state.agents)) {
    const loop = state.loops[agent.id]
    if (!agent.running || (loop?.toolsRunning ?? 0) > 0) continue
    if (now - Math.max(agent.startedAt, loop?.activeAt ?? 0) > ttlMs) agent.running = false
  }
}

/** A tool call is starting to run in `loop`. */
export function observeToolStart(state: SessionState, loop: LoopId): void {
  const l = loopOf(state, loop)
  l.toolsRunning = (l.toolsRunning ?? 0) + 1
}

/**
 * A tool call finished; identical failures in a row feed the retry fuse. Any
 * other call by the same loop breaks the row, so test, edit, re-run is never
 * a retry loop.
 */
export function observeToolResult(state: SessionState, now: number, loop: LoopId, fingerprint: string, failed: boolean): void {
  const l = loopOf(state, loop)
  l.toolsRunning = Math.max(0, (l.toolsRunning ?? 0) - 1)
  l.activeAt = now
  for (const [key, failure] of Object.entries(state.failures)) {
    if (failure.loop === loop && key !== fingerprint) delete state.failures[key]
  }
  if (!failed) {
    delete state.failures[fingerprint]
    return
  }
  const previous = state.failures[fingerprint]
  state.failures[fingerprint] = { count: (previous?.count ?? 0) + 1, last: now, loop }
}

/** The main turn ended: per-turn conditions reset. */
export function observeTurnEnd(state: SessionState): void {
  state.reopened = false
  const main = state.loops[MAIN]
  if (main) main.stopped = false
}
