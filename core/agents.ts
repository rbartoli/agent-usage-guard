// The agent gate: every subagent, teammate, workflow agent and resumed agent
// passes here before it starts.

import type { Config } from './config.ts'
import { type LimitReading, type LoopId, type PeerRecord, type SessionState, countOnMachine, overrideCovers, runningAgents, tokensWithin } from './state.ts'
import { count, duration, join, sentence, shortClock, tokens, windowName } from './text.ts'
import { ALLOW, type Ask, type Deny, SIGNATURE, type Trip, type Verdict, refuse } from './verdict.ts'

export type AgentRequest = {
  /** The loop asking for the agent. */
  loop: LoopId
  /** Layers below the main conversation the new agent would run at. */
  depth: number
  /** True when a finished agent is being sent a new task. */
  resume: boolean
}

const AGENT_ALLOW = 'Allow'
const AGENT_REFUSE = "Don't start it"

export function agentGate(
  state: SessionState,
  peers: readonly PeerRecord[],
  config: Config,
  now: number,
  request: AgentRequest,
): Verdict {
  if (!config.enabled || overrideCovers(state, now, 'agents')) return ALLOW
  const what = request.resume ? 'resuming this agent' : 'this agent'

  if (request.depth > config.depthMax) {
    const base = `${request.resume ? 'This agent cannot be resumed' : 'This agent was not started'}: subagents may not start agents of their own here (depth limit ${config.depthMax}). Do the work yourself and report back.`
    return refuse(state, config, now, 'depth', 'depth', base, true)
  }
  if (state.fuseUntil !== undefined && now < state.fuseUntil) {
    const base = `Agent spawns in this session are paused until ${shortClock(state.fuseUntil)} after repeated refused agent calls. Continue without agents; the user can lift this with /agent-guard allow.`
    return refuse(state, config, now, 'fuse', 'fuse', base, false)
  }

  const limit = highestLimit(state, peers, now)
  if (limit && limit.percent >= config.limitDenyPercent) {
    const base = `${sentence(what)} was refused: ${limitDetail(limit)}, and the guard keeps the rest of the window for the user. Continue without agents; the user can lift this with /agent-guard allow.`
    return refuse(state, config, now, 'limit-deny', 'limit-deny', base, true)
  }

  const trips = agentTrips(state, peers, config, now, limit).filter((t) => !leased(state, t, now))
  if (trips.length === 0) return ALLOW

  const details = join(trips.map((t) => t.detail))
  const declinedAt = state.refusals.agents
  if (declinedAt !== undefined && now < declinedAt) {
    const base = `The user declined new agents for now (${details}). Continue without starting agents; the user can lift this with /agent-guard allow.`
    return refuse(state, config, now, trips[0]!.rule, `agents:${trips[0]!.rule}`, base, true)
  }
  if (!state.canAsk) return unattended(state, config, now, trips, details)
  return {
    kind: 'ask',
    family: 'agents',
    loop: request.loop,
    trips,
    question: `${sentence(details)}. Allowing lifts ${trips.length > 1 ? 'these limits' : 'this limit'} until ${shortClock(Math.max(...trips.map((t) => t.leaseUntil)))}. ${request.resume ? 'Resume this agent' : 'Start this agent'}?`,
    options: [AGENT_ALLOW, AGENT_REFUSE],
  }
}

/**
 * Applies the user's answer to an agents question. Any answer other than the
 * allow label refuses, and typed words reach the model so it can act on them.
 * `answer` is undefined when the question was dismissed.
 */
export function resolveAgentAsk(
  state: SessionState,
  config: Config,
  now: number,
  ask: Ask,
  answer: string | undefined,
): Verdict {
  if (answer === AGENT_ALLOW) {
    for (const trip of ask.trips) state.leases[trip.leaseKey] = Math.max(state.leases[trip.leaseKey] ?? 0, trip.leaseUntil)
    return ALLOW
  }
  state.refusals.agents = now + config.windowMs
  const details = join(ask.trips.map((t) => t.detail))
  const said =
    answer === undefined
      ? 'The user dismissed the question about starting it'
      : answer === AGENT_REFUSE
        ? 'The user chose not to start it'
        : `The user answered "${answer}" instead of allowing it`
  const base = `This agent was not started: ${details}. ${said}. Continue without starting agents unless the user says otherwise.`
  return refuse(state, config, now, ask.trips[0]!.rule, `agents:${ask.trips[0]!.rule}`, base, true)
}

/**
 * Holds back a call that tripped while the user is already being asked the
 * same question. It does not wait for the answer, which could outlast the
 * hook's time limit, and it is not a refusal of the condition: no ladder rung,
 * no fuse.
 */
export function heldForQuestion(subject: 'agents' | 'heavy'): Deny {
  const message =
    subject === 'agents'
      ? 'The user is being asked about starting agents. Wait for that answer, then start this agent again.'
      : 'The user is being asked whether to keep working at this context size. Wait for that answer, then make this call again.'
  return { kind: 'deny', rule: 'asking', message: `${message} [${SIGNATURE}]` }
}

function agentTrips(
  state: SessionState,
  peers: readonly PeerRecord[],
  config: Config,
  now: number,
  limit: LimitReading | undefined,
): Trip[] {
  const window = config.windowMs
  const span = duration(window)
  const until = now + window
  const trips: Trip[] = []

  const running = runningAgents(state) + peers.reduce((sum, p) => sum + p.running, 0)
  if (running >= config.agentMax) {
    trips.push({
      rule: 'concurrency',
      detail: `${count(running, 'agent')} ${running === 1 ? 'is' : 'are'} running on this machine (limit ${config.agentMax})`,
      leaseKey: 'concurrency',
      leaseUntil: until,
    })
  }

  const starts = countOnMachine(state, peers, 'starts', now, window)
  if (starts >= config.rollingMax) {
    trips.push({
      rule: 'starts',
      detail: `${count(starts, 'agent')} started on this machine in the last ${span} (limit ${config.rollingMax})`,
      leaseKey: 'starts',
      leaseUntil: until,
    })
  }

  const processed = tokensWithin(state.agentTokens, now, window) + peers.reduce((sum, p) => sum + tokensWithin(p.agentTokens, now, window), 0)
  if (processed >= config.agentTokensMax) {
    trips.push({
      rule: 'agent-tokens',
      detail: `subagents processed ${tokens(processed)} tokens in the last ${span} (limit ${tokens(config.agentTokensMax)})`,
      leaseKey: 'agent-tokens',
      leaseUntil: until,
    })
  }

  const burned = burn(state, peers, now, window)
  if (burned && burned.points >= config.burnPercent) {
    trips.push({
      rule: 'burn',
      detail: `the 5-hour window rose ${burned.points} points in the last ${span} (now ${burned.percent}%)`,
      leaseKey: 'burn',
      leaseUntil: until,
    })
  }

  if (limit && limit.percent >= config.limitAskPercent) {
    trips.push({
      rule: 'limit',
      detail: limitDetail(limit),
      leaseKey: `limit:${limit.kind}`,
      leaseUntil: limit.resetsAt ?? until,
    })
  }
  return trips
}

function unattended(state: SessionState, config: Config, now: number, trips: Trip[], details: string): Deny {
  const first = trips[0]!
  const advice: Record<string, string> = {
    concurrency: 'Wait for a running agent to finish before starting another',
    starts: 'Starts free up as they age out of the window; batch the work or do it yourself',
    'agent-tokens': 'Do the remaining work yourself instead of in agents',
    burn: 'Continue without agents until the burn slows',
    limit: 'Continue without agents',
  }
  const base = `This agent was not started: ${details}. Nobody can approve it in this session. ${advice[first.rule] ?? 'Continue without agents'}.`
  return refuse(state, config, now, first.rule, `agents:${first.rule}`, base, true)
}

function leased(state: SessionState, trip: Trip, now: number): boolean {
  const until = state.leases[trip.leaseKey]
  return until !== undefined && now < until
}

/** The most-used plan window with a current reading, from this session or its peers. */
export function highestLimit(state: SessionState, peers: readonly PeerRecord[], now: number): LimitReading | undefined {
  const readings = [...Object.values(state.limits), ...peers.flatMap((p) => (p.limit ? [p.limit] : []))]
  const freshest = new Map<string, LimitReading>()
  for (const r of readings) {
    if (r.resetsAt !== undefined && r.resetsAt <= now) continue
    const seen = freshest.get(r.kind)
    if (!seen || r.at > seen.at) freshest.set(r.kind, r)
  }
  let highest: LimitReading | undefined
  for (const r of freshest.values()) if (!highest || r.percent > highest.percent) highest = r
  return highest
}

function limitDetail(limit: LimitReading): string {
  const reset = limit.resetsAt === undefined ? '' : ` (resets ${shortClock(limit.resetsAt)})`
  return `the ${windowName(limit.kind)} window is ${limit.percent}% used${reset}`
}

/** Points the 5-hour window rose within the rolling window, across this machine. */
function burn(
  state: SessionState,
  peers: readonly PeerRecord[],
  now: number,
  windowMs: number,
): { points: number; percent: number } | undefined {
  const own = state.limits.five_hour
  const peerReadings = peers.flatMap((p) => (p.limit?.kind === 'five_hour' ? [p.limit] : []))
  const current = [own, ...peerReadings].reduce<LimitReading | undefined>(
    (best, r) => (r && (!best || r.at > best.at) ? r : best),
    undefined,
  )
  if (!current) return undefined
  const sameWindow = [...state.limitHistory, ...peerReadings].filter(
    (r) => r.kind === 'five_hour' && r.resetsAt === current.resetsAt && now - r.at < windowMs,
  )
  if (sameWindow.length === 0) return undefined
  const lowest = Math.min(...sameWindow.map((r) => r.percent))
  return { points: Math.round((current.percent - lowest) * 10) / 10, percent: current.percent }
}
