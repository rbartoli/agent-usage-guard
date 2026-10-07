// The guard's state for one session, plus the small record each session
// publishes for the others on the same machine. Everything here is plain JSON,
// so an adapter can keep it in memory, in a key-value store, or in a file
// between hook processes.
//
// The core updates a SessionState in place, inside synchronous functions only:
// one adapter owns one state, and no update spans an await, so concurrent hooks
// in the same process cannot interleave halfway through a change.

/** `main` for the main conversation, otherwise the agent's id. */
export type LoopId = string

export const MAIN: LoopId = 'main'

export type AgentKind = 'subagent' | 'teammate' | 'workflow' | 'fork'

export type AgentRecord = {
  id: string
  kind: AgentKind
  /** Layers below the main conversation: 1 for an agent the main loop started. */
  depth: number
  running: boolean
  startedAt: number
  name?: string
}

export type LoopState = {
  /** Input tokens of the loop's latest model request: what the next one re-reads. */
  context?: number
  lastResponseAt?: number
  /** Tool calls made while the loop was above the tool-budget threshold. */
  heavyCalls: number[]
  /** The user approved heavy work in this loop until then, or until it compacts. */
  heavyLeaseUntil?: number
  /** The user chose to stop this turn: refuse its tool calls until it ends. */
  stopped?: boolean
}

export type LimitReading = {
  at: number
  /** `five_hour`, `seven_day`, a gateway's `spend_limit`, ... */
  kind: string
  percent: number
  resetsAt?: number
}

export type Scope = 'all' | 'agents' | 'context'

export type Denial = { at: number; key: string; agent: boolean }

export type SessionState = {
  id: string
  /** A person can answer questions in this session. */
  canAsk: boolean
  loops: Record<LoopId, LoopState>
  agents: Record<string, AgentRecord>
  /** Agents the gate allowed that Claude Code has not reported started yet. */
  pendingStarts: number
  /** This session's agent starts and resumes, newest last. */
  starts: number[]
  /** Tokens each subagent request processed, as [time, tokens]. */
  agentTokens: Array<[number, number]>
  /** Latest reading per plan window, and the readings inside the current window. */
  limits: Record<string, LimitReading>
  limitHistory: LimitReading[]
  /** An approved condition stays approved until the time stored under its key. */
  leases: Record<string, number>
  /** A family the user declined is refused without asking until then. */
  refusals: Record<string, number>
  denials: Denial[]
  fuseUntil?: number
  /** Consecutive identical failures per tool-call fingerprint, and the loop that made them. */
  failures: Record<string, { count: number; last: number; loop: LoopId }>
  override?: { until: number; scope: Scope }
  /** The context warning was given and still applies. */
  warned: boolean
  /** A Stop hook reopened the current turn, so "end the turn" cannot clear a block. */
  reopened: boolean
  dormantResumes: number[]
}

/** What one session publishes for the others: counts, never content. */
export type PeerRecord = {
  v: 1
  /** When the session last made a model request or changed this record. */
  at: number
  running: number
  starts: number[]
  agentTokens: number
  dormantResumes: number[]
  limit?: LimitReading
}

export function newSession(id: string, canAsk: boolean): SessionState {
  return {
    id,
    canAsk,
    loops: {},
    agents: {},
    pendingStarts: 0,
    starts: [],
    agentTokens: [],
    limits: {},
    limitHistory: [],
    leases: {},
    refusals: {},
    denials: [],
    failures: {},
    warned: false,
    reopened: false,
    dormantResumes: [],
  }
}

export function loopOf(state: SessionState, id: LoopId): LoopState {
  const existing = state.loops[id]
  if (existing) return existing
  const created: LoopState = { heavyCalls: [] }
  state.loops[id] = created
  return created
}

export function within(times: readonly number[], now: number, windowMs: number): number[] {
  return times.filter((t) => now - t < windowMs)
}

/** Running agents, counting those allowed a moment ago that are still starting. */
export function runningAgents(state: SessionState): number {
  return Object.values(state.agents).filter((a) => a.running).length + state.pendingStarts
}

export function overrideCovers(state: SessionState, now: number, scope: Exclude<Scope, 'all'>): boolean {
  const override = state.override
  if (!override || now >= override.until) return false
  return override.scope === 'all' || override.scope === scope
}

/** Drops what has aged out of every rolling list, so the state stays small. */
export function prune(state: SessionState, now: number, windowMs: number): void {
  state.starts = within(state.starts, now, windowMs)
  state.agentTokens = state.agentTokens.filter(([t]) => now - t < windowMs)
  state.limitHistory = state.limitHistory.filter((r) => now - r.at < windowMs)
  state.denials = state.denials.filter((d) => now - d.at < windowMs)
  state.dormantResumes = within(state.dormantResumes, now, windowMs)
  for (const [key, until] of Object.entries(state.leases)) if (now >= until) delete state.leases[key]
  for (const [key, until] of Object.entries(state.refusals)) if (now >= until) delete state.refusals[key]
  for (const [key, failure] of Object.entries(state.failures)) {
    if (now - failure.last >= windowMs) delete state.failures[key]
  }
  for (const loop of Object.values(state.loops)) loop.heavyCalls = within(loop.heavyCalls, now, windowMs)
  if (state.fuseUntil !== undefined && now >= state.fuseUntil) delete state.fuseUntil
  if (state.override && now >= state.override.until) delete state.override
}

/** The record this session publishes for its peers. */
export function peerRecord(state: SessionState, now: number, windowMs: number): PeerRecord {
  const tokens = state.agentTokens.filter(([t]) => now - t < windowMs).reduce((sum, [, n]) => sum + n, 0)
  const fiveHour = state.limits.five_hour
  return {
    v: 1,
    at: now,
    running: runningAgents(state),
    starts: within(state.starts, now, windowMs),
    agentTokens: tokens,
    dormantResumes: within(state.dormantResumes, now, windowMs),
    ...(fiveHour ? { limit: fiveHour } : {}),
  }
}

/**
 * Accepts only records that look like ours and are fresh: a session that has
 * made no model request for `ttlMs` is not spending, so its agents stop
 * counting even if it crashed without clearing its record.
 */
export function livePeers(records: readonly unknown[], now: number, ttlMs: number): PeerRecord[] {
  const peers: PeerRecord[] = []
  for (const record of records) {
    if (!isPeerRecord(record)) continue
    if (now - record.at > ttlMs) continue
    peers.push(record)
  }
  return peers
}

function isPeerRecord(value: unknown): value is PeerRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    r.v === 1 &&
    typeof r.at === 'number' &&
    typeof r.running === 'number' &&
    Array.isArray(r.starts) &&
    typeof r.agentTokens === 'number' &&
    Array.isArray(r.dormantResumes)
  )
}
