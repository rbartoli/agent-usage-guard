// `/usage-guard` and its arguments. The command runs without a model turn, so
// the model never sees an override and cannot take one as permission.

import { type Scope, type SessionState, loopOf } from './state.ts'
import { duration, shortClock } from './text.ts'
import { USAGE, scopeName } from './status.ts'

export type Command =
  | { action: 'status' }
  | { action: 'allow'; scope: Scope; minutes: number }
  | { action: 'resume' }
  | { action: 'report'; days: number }
  | { action: 'help'; error?: string }

export const DEFAULT_ALLOW_MINUTES = 10
const MAX_ALLOW_MINUTES = 8 * 60
const DEFAULT_REPORT_DAYS = 7
const MAX_REPORT_DAYS = 3650

export function parseCommand(args: string): Command {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [verb, ...rest] = words
  if (verb === undefined || verb === 'status') return { action: 'status' }
  if (verb === 'help') return { action: 'help' }
  if (verb === 'resume') return { action: 'resume' }
  if (verb === 'report') {
    const days = rest[0] === undefined ? DEFAULT_REPORT_DAYS : Number(rest[0])
    if (!Number.isInteger(days) || days < 1 || days > MAX_REPORT_DAYS) return { action: 'help', error: `"${rest[0]}" is not a number of days` }
    return { action: 'report', days }
  }
  if (verb === 'allow' || verb === 'pause') {
    let scope: Scope = 'all'
    let minutes = DEFAULT_ALLOW_MINUTES
    for (const word of rest) {
      if (verb === 'allow' && (word === 'agents' || word === 'context' || word === 'all')) {
        scope = word
        continue
      }
      const n = Number(word.replace(/m(in(utes?)?)?$/, ''))
      if (!Number.isInteger(n) || n < 1 || n > MAX_ALLOW_MINUTES) {
        return { action: 'help', error: `"${word}" is not ${verb === 'allow' ? 'agents, context or ' : ''}a number of minutes from 1 to ${MAX_ALLOW_MINUTES}` }
      }
      minutes = n
    }
    return { action: 'allow', scope, minutes }
  }
  return { action: 'help', error: `unknown subcommand "${verb}"` }
}

/** Lifts limits for this session, and forgets the declines and the fuse they cover. */
export function applyOverride(state: SessionState, now: number, scope: Scope, minutes: number): string {
  const until = now + minutes * 60_000
  state.override = { until, scope }
  if (scope !== 'context') {
    delete state.fuseUntil
    delete state.refusals.agents
  }
  if (scope !== 'agents') {
    for (const loop of Object.values(state.loops)) loop.stopped = false
    state.failures = {}
  }
  return `${sentenceCase(scopeName(scope))} lifted for ${duration(minutes * 60_000)}, until ${shortClock(until)}. /usage-guard resume ends it early.`
}

/** Ends an override and clears declined questions, so the guard asks again. */
export function resumeGuard(state: SessionState): string {
  const had = state.override !== undefined
  delete state.override
  state.refusals = {}
  loopOf(state, 'main').stopped = false
  return had
    ? 'Limits apply again.'
    : 'No override was active. Declined questions are cleared, so the guard asks again.'
}

export function helpText(error?: string): string {
  return error ? `${sentenceCase(error)}.\n\n${USAGE}` : USAGE
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
