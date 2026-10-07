// The tool gate: identical failing retries, and long runs of tool calls while a
// loop carries a heavy context. Each loop is judged on its own context, so a
// subagent's calls never inherit the main conversation's size.

import type { Config } from './config.ts'
import { type LoopId, MAIN, type SessionState, loopOf, overrideCovers, within } from './state.ts'
import { count, duration, shortClock, tokens } from './text.ts'
import { ALLOW, type Ask, type Verdict, refuse } from './verdict.ts'

/**
 * Tools the guard never holds: holding them loses a subagent's report, stops
 * a cleanup, or blocks the user from answering a question.
 */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'SubagentHandback',
  'TaskStop',
  'AskUserQuestion',
  'ExitPlanMode',
])

export type ToolRequest = {
  loop: LoopId
  tool: string
  fingerprint: string
  /** How the user names the loop in a question: "this conversation", "agent Explore". */
  label: string
}

/** How long "keep going" lasts if the loop never compacts. */
export const HEAVY_LEASE_MS = 60 * 60 * 1000

export const HEAVY_CONTINUE = 'Keep going'
export const HEAVY_COMPACT = 'Compact after this turn'
export const HEAVY_STOP = 'Stop this turn'
export const HEAVY_STOP_AGENT = 'Stop this agent'

export function toolGate(state: SessionState, config: Config, now: number, request: ToolRequest): Verdict {
  if (!config.enabled || EXEMPT_TOOLS.has(request.tool)) return ALLOW
  const lifted = overrideCovers(state, now, 'context')

  const failure = state.failures[request.fingerprint]
  if (!lifted && failure && failure.count >= config.failureMax && now - failure.last < config.windowMs) {
    const base = `This exact ${request.tool} call failed ${failure.count} times in a row, most recently at ${shortClock(failure.last)}. Change the input or the approach, or report the failure, instead of repeating it.`
    return refuse(state, config, now, 'retry', `retry:${request.fingerprint}`, base, false)
  }

  const loop = loopOf(state, request.loop)
  if (loop.stopped) {
    const base = `The user stopped this ${request.loop === MAIN ? 'turn' : 'agent'} at ${tokens(loop.context ?? 0)} context tokens. ${request.loop === MAIN ? 'End the turn now and recommend /compact before the next task.' : 'Stop working and report back what you have.'}`
    return refuse(state, config, now, 'stopped', `stopped:${request.loop}`, base, false)
  }

  const context = loop.context
  if (lifted || context === undefined || context < config.toolContext) return ALLOW
  const heavy = within(loop.heavyCalls, now, config.windowMs)
  loop.heavyCalls = heavy
  const leasedUntil = loop.heavyLeaseUntil
  if (heavy.length < config.toolMax || (leasedUntil !== undefined && now < leasedUntil)) {
    heavy.push(now)
    return ALLOW
  }

  const detail = `${request.label} made ${count(heavy.length, 'tool call')} in the last ${duration(config.windowMs)} above ${tokens(config.toolContext)} context tokens, and each one re-reads the ${tokens(context)}`
  if (!state.canAsk) {
    const base = `${detail.charAt(0).toUpperCase()}${detail.slice(1)}. Nobody can approve more in this session. ${request.loop === MAIN ? 'End the turn; the session needs /compact.' : 'Finish with what you have and report back.'}`
    return refuse(state, config, now, 'tool-budget', `tool-budget:${request.loop}`, base, false)
  }
  return {
    kind: 'ask',
    family: 'heavy',
    loop: request.loop,
    trips: [{ rule: 'tool-budget', detail, leaseKey: `heavy:${request.loop}`, leaseUntil: now + HEAVY_LEASE_MS }],
    question: `${detail.charAt(0).toUpperCase()}${detail.slice(1)}. Keep working at ${tokens(context)} context?`,
    options: request.loop === MAIN ? [HEAVY_CONTINUE, HEAVY_COMPACT, HEAVY_STOP] : [HEAVY_CONTINUE, HEAVY_STOP_AGENT],
  }
}

export type HeavyOutcome = { verdict: Verdict; compactAfterTurn: boolean }

/** Applies the user's answer to a heavy-context question; dismissing it stops the loop. */
export function resolveHeavyAsk(
  state: SessionState,
  config: Config,
  now: number,
  ask: Ask,
  answer: string | undefined,
): HeavyOutcome {
  const loop = loopOf(state, ask.loop)
  if (answer === HEAVY_CONTINUE || answer === HEAVY_COMPACT) {
    loop.heavyLeaseUntil = now + HEAVY_LEASE_MS
    loop.heavyCalls.push(now)
    return { verdict: ALLOW, compactAfterTurn: answer === HEAVY_COMPACT }
  }
  loop.stopped = true
  const isMain = ask.loop === MAIN
  const said =
    answer === undefined || answer === HEAVY_STOP || answer === HEAVY_STOP_AGENT
      ? `The user stopped this ${isMain ? 'turn' : 'agent'}`
      : `The user answered "${answer}"`
  const base = `${said} at ${tokens(loop.context ?? 0)} context tokens. ${isMain ? 'End the turn now and recommend /compact before the next task.' : 'Stop working and report back what you have.'}`
  return { verdict: refuse(state, config, now, 'stopped', `stopped:${ask.loop}`, base, false), compactAfterTurn: false }
}
