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
export function contextOf(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

/** One model request finished in `loop`, with the usage the API reported. */
export function observeResponse(state: SessionState, config: Config, now: number, loop: LoopId, usage: TokenUsage): void {
  const l = loopOf(state, loop)
  const context = contextOf(usage)
  l.context = context
  l.lastResponseAt = now
  if (context < config.toolContext) {
    delete l.heavyLeaseUntil
    l.heavyCalls = []
  }
  if (loop === MAIN) {
    if (context < config.contextWarn) state.warned = false
    if (context < config.contextHard) delete state.leases['prompt-context']
    return
  }
  if (state.agents[loop]) state.agentTokens.push([now, context + usage.output])
}

/** The main conversation's context as the harness reports it, without a request. */
export function observeMainContext(state: SessionState, config: Config, tokens: number): void {
  const main = loopOf(state, MAIN)
  main.context = tokens
  if (tokens < config.contextWarn) state.warned = false
  if (tokens < config.contextHard) delete state.leases['prompt-context']
  if (tokens < config.toolContext) delete main.heavyLeaseUntil
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

/** Ends a reservation: the agent started, or the start failed and is not counted. */
export function releaseStart(state: SessionState, reservedAt: number, started: boolean): void {
  state.pendingStarts = Math.max(0, state.pendingStarts - 1)
  if (started) return
  const index = state.starts.indexOf(reservedAt)
  if (index >= 0) state.starts.splice(index, 1)
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

/** A known agent finished a run. Its context leaves with it. */
export function observeAgentRunEnd(state: SessionState, agentId: string): void {
  const agent = state.agents[agentId]
  if (agent) agent.running = false
  const loop = state.loops[agentId]
  if (loop) loop.stopped = false
}

/** Agent records that have not run for `ttlMs` stop counting as running. */
export function expireAgents(state: SessionState, now: number, ttlMs: number): void {
  for (const agent of Object.values(state.agents)) {
    const loop = state.loops[agent.id]
    const lastSeen = Math.max(agent.startedAt, loop?.lastResponseAt ?? 0)
    if (agent.running && now - lastSeen > ttlMs) agent.running = false
  }
}

/** A tool call finished; identical failures in a row feed the retry fuse. */
export function observeToolResult(state: SessionState, now: number, fingerprint: string, failed: boolean): void {
  if (!failed) {
    delete state.failures[fingerprint]
    return
  }
  const previous = state.failures[fingerprint]
  state.failures[fingerprint] = { count: (previous?.count ?? 0) + 1, last: now }
}

/** The main turn ended: per-turn conditions reset. */
export function observeTurnEnd(state: SessionState): void {
  state.reopened = false
  const main = state.loops[MAIN]
  if (main) main.stopped = false
}
