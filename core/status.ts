// What the user sees without asking: one status line while something needs
// attention, and the `/agent-guard` command's text.

import { highestLimit } from './agents.ts'
import type { Config } from './config.ts'
import { MAIN, type PeerRecord, type Scope, type SessionState, countOnMachine, runningAgents } from './state.ts'
import { count, duration, shortClock, tokens, windowName } from './text.ts'

/** The line under the prompt, or undefined when there is nothing to say. */
export function statusLine(state: SessionState, peers: readonly PeerRecord[], config: Config, now: number): string | undefined {
  if (!config.enabled) return undefined
  const parts = liftedOrPaused(state, now)
  const limit = highestLimit(state, peers, now)
  if (limit && limit.percent >= config.limitDenyPercent) {
    parts.push(`${windowName(limit.kind)} window ${limit.percent}%: new agents refused`)
  } else if (limit && limit.percent >= config.limitAskPercent) {
    parts.push(`${windowName(limit.kind)} window ${limit.percent}%: new agents need approval`)
  }
  const context = state.loops[MAIN]?.context
  if (context !== undefined && context >= config.contextHard) {
    parts.push(`context ${tokens(context)}: /compact recommended`)
  } else if (context !== undefined && context >= config.contextWarn) {
    parts.push(`context ${tokens(context)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Which questions are open now, for the band. */
export type Asking = { agents: boolean; context: boolean }

/**
 * The band above the prompt: the guard's own state while it has something to
 * say, the agents on this machine against their limits first. `alert` when a
 * limit is reached or the guard is holding something.
 */
export function bandLine(
  state: SessionState,
  peers: readonly PeerRecord[],
  config: Config,
  now: number,
  asking: Asking,
): { text: string; alert: boolean } | undefined {
  if (!config.enabled) return undefined
  const window = config.windowMs
  const running = runningAgents(state) + peers.reduce((sum, p) => sum + p.running, 0)
  const starts = countOnMachine(state, peers, 'starts', now, window)
  const declined = state.refusals.agents !== undefined && now < state.refusals.agents ? state.refusals.agents : undefined
  const paused = state.fuseUntil !== undefined && now < state.fuseUntil ? state.fuseUntil : undefined
  const refusal = state.denials.filter((d) => now - d.at < window).at(-1)

  const parts: string[] = []
  if (running > 0 || starts > 0) parts.push(`${running} of ${config.agentMax} agents running`)
  if (starts > 0) parts.push(`${starts} of ${config.rollingMax} started in the last ${duration(window)}`)
  if (asking.agents) parts.push('asking you about starting agents')
  if (asking.context) parts.push('asking you about the context size')
  if (declined !== undefined) parts.push(`new agents declined until ${shortClock(declined)}`)
  if (paused !== undefined) parts.push(`agent spawns paused until ${shortClock(paused)}`)
  if (refusal) parts.push(`last refusal ${shortClock(refusal.at)}: ${refusal.rule}`)
  if (parts.length === 0) return undefined

  const holding = asking.agents || asking.context || declined !== undefined || paused !== undefined || refusal !== undefined
  const full = running >= config.agentMax || starts >= config.rollingMax
  return { text: `Usage guard · ${parts.join(' · ')}`, alert: holding || full }
}

/** When the band changes with no event to redraw it: a start, a refusal, a decline or the pause ages out. */
export function bandExpiry(state: SessionState, peers: readonly PeerRecord[], config: Config, now: number): number | undefined {
  if (!config.enabled) return undefined
  const window = config.windowMs
  const aging = [...state.starts, ...peers.flatMap((p) => p.starts), ...state.denials.map((d) => d.at)].map((t) => t + window)
  const later = [...aging, state.refusals.agents, state.fuseUntil].filter((t): t is number => t !== undefined && t > now)
  return later.length > 0 ? Math.min(...later) : undefined
}

/** When the line changes with no event to redraw it: an allow or the fuse ends, or the most-used plan window resets. */
export function statusLineExpiry(state: SessionState, peers: readonly PeerRecord[], config: Config, now: number): number | undefined {
  if (!config.enabled) return undefined
  const times = [state.override?.until, state.fuseUntil, highestLimit(state, peers, now)?.resetsAt]
  const later = times.filter((t): t is number => t !== undefined && t > now)
  return later.length > 0 ? Math.min(...later) : undefined
}

/** What is lifted or paused now, worded alike in the status line and the report. */
function liftedOrPaused(state: SessionState, now: number): string[] {
  const parts: string[] = []
  if (state.override && now < state.override.until) {
    parts.push(`${scopeName(state.override.scope)} lifted until ${shortClock(state.override.until)}`)
  }
  if (state.fuseUntil !== undefined && now < state.fuseUntil) {
    parts.push(`agent spawns paused until ${shortClock(state.fuseUntil)}`)
  }
  return parts
}

export function scopeName(scope: Scope): string {
  if (scope === 'agents') return 'agent limits'
  if (scope === 'context') return 'context limits'
  return 'all limits'
}

/** The text `/agent-guard` and `/agent-guard status` print. */
export function statusReport(
  state: SessionState,
  peers: readonly PeerRecord[],
  config: Config,
  now: number,
  problems: readonly string[],
  version?: string,
): string {
  const running = version ? ` (${version})` : ''
  if (!config.enabled) return `Off${running}: AGENT_GUARD is set to turn it off.`
  const window = config.windowMs
  const lines = [`On${running}.`]

  const peerRunning = peers.reduce((sum, p) => sum + p.running, 0)
  const starts = countOnMachine(state, peers, 'starts', now, window)
  lines.push(
    `Agents: ${runningAgents(state)} running here, ${peerRunning} in ${count(peers.length, 'other session')} (limit ${config.agentMax}); ${starts} started in the last ${duration(window)} (limit ${config.rollingMax}).`,
  )

  const limits = Object.values(state.limits).filter((r) => r.resetsAt === undefined || r.resetsAt > now)
  if (limits.length > 0) {
    const text = limits
      .map((r) => `${windowName(r.kind)} ${r.percent}%${r.resetsAt === undefined ? '' : ` (resets ${shortClock(r.resetsAt)})`}`)
      .join(', ')
    lines.push(`Plan windows: ${text}. New agents ask from ${config.limitAskPercent}% and are refused from ${config.limitDenyPercent}%.`)
  } else {
    lines.push('Plan windows: no reading yet (one arrives with the next response on a subscription).')
  }

  const context = state.loops[MAIN]?.context
  lines.push(
    `Context: ${context === undefined ? 'unknown until the next response' : `${tokens(context)} tokens`} (warn ${tokens(config.contextWarn)}, ask before a prompt from ${tokens(config.contextHard)}).`,
  )

  const held = liftedOrPaused(state, now)
  for (const [key, until] of Object.entries(state.leases)) {
    if (now < until) held.push(`${key} approved${until < Number.MAX_SAFE_INTEGER ? ` until ${shortClock(until)}` : ' until the context shrinks'}`)
  }
  for (const [key, until] of Object.entries(state.refusals)) if (now < until) held.push(`${key} declined until ${shortClock(until)}`)
  if (held.length > 0) lines.push(`Now: ${held.join('; ')}.`)
  for (const problem of problems) lines.push(`Config: ${problem}.`)
  lines.push('', USAGE)
  return lines.join('\n')
}

export const USAGE = [
  'Commands:',
  '  /agent-guard allow [agents|context] [minutes]   lift the guard\'s limits for this session (default: all, 10 min)',
  '  /agent-guard pause [minutes]                     same as allow, for every limit',
  '  /agent-guard resume                              end an allow or pause early, and clear declined questions',
  '  /agent-guard report [days]                       what the guard did on this machine (default 7 days)',
  '  /agent-guard status                              this summary',
].join('\n')
