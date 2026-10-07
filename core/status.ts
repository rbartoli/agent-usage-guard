// What the user sees without asking: one status line while something needs
// attention, and the `/usage-guard` command's text.

import { highestLimit } from './agents.ts'
import type { Config } from './config.ts'
import { MAIN, type PeerRecord, type Scope, type SessionState, runningAgents, within } from './state.ts'
import { duration, shortClock, tokens, windowName } from './text.ts'

/** The line under the prompt, or undefined when there is nothing to say. */
export function statusLine(state: SessionState, peers: readonly PeerRecord[], config: Config, now: number): string | undefined {
  if (!config.enabled) return undefined
  const parts: string[] = []
  if (state.override && now < state.override.until) {
    parts.push(`${scopeName(state.override.scope)} lifted until ${shortClock(state.override.until)}`)
  }
  if (state.fuseUntil !== undefined && now < state.fuseUntil) {
    parts.push(`agent spawns paused until ${shortClock(state.fuseUntil)}`)
  }
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

export function scopeName(scope: Scope): string {
  if (scope === 'agents') return 'agent limits'
  if (scope === 'context') return 'context limits'
  return 'all limits'
}

/** The text `/usage-guard` and `/usage-guard status` print. */
export function statusReport(
  state: SessionState,
  peers: readonly PeerRecord[],
  config: Config,
  now: number,
  problems: readonly string[],
): string {
  if (!config.enabled) return 'Off: AGENT_GUARD is set to turn it off.'
  const window = config.windowMs
  const lines = ['On.']

  const running = runningAgents(state)
  const peerRunning = peers.reduce((sum, p) => sum + p.running, 0)
  const starts = within(state.starts, now, window).length
  const peerStarts = peers.reduce((sum, p) => sum + within(p.starts, now, window).length, 0)
  lines.push(
    `Agents: ${running} running here, ${peerRunning} in ${peers.length} other session${peers.length === 1 ? '' : 's'} (limit ${config.agentMax}); ${starts + peerStarts} started in the last ${duration(window)} (limit ${config.rollingMax}).`,
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

  const held: string[] = []
  if (state.override && now < state.override.until) held.push(`${scopeName(state.override.scope)} lifted until ${shortClock(state.override.until)}`)
  if (state.fuseUntil !== undefined && now < state.fuseUntil) held.push(`agent fuse burning until ${shortClock(state.fuseUntil)}`)
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
  '  /usage-guard allow [agents|context] [minutes]   lift the guard\'s limits for this session (default: all, 10 min)',
  '  /usage-guard pause [minutes]                     same as allow, for every limit',
  '  /usage-guard resume                              end an allow or pause early, and clear declined questions',
  '  /usage-guard report [days]                       what the guard did on this machine (default 7 days)',
  '  /usage-guard status                              this summary',
].join('\n')
