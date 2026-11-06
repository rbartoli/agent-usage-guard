// Which failed requests were usage-limit lockouts: the outcome the guard
// exists to prevent, and the figure its report is judged by.

import type { LimitReading } from './state.ts'

/** Claude Code offers `/model` when only one model's limit was reached. */
const MODEL_SWITCH = /\/model\b[^.\n]{0,40}\bswitch\b|\bswitch(?:ing)?\s+(?:to\s+)?(?:another\s+|a\s+different\s+)?models?\b|\bopus\b[^.\n]{0,24}\blimit\b/i

const PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:5-hour|five-hour|session) limit\b/i, 'five_hour'],
  [/\bweekly limit\b/i, 'seven_day'],
  [/\bmonthly spend limit\b|\bspend limit\b|\busage credits\b/i, 'spend_limit'],
  [/\busage limit\b|\blimit reached\b|\bhit your limit\b/i, 'unknown'],
]

/** How Claude Code's usage-limit messages open: the test it applies itself, as of 2.1.318. */
const LIMIT_MESSAGE =
  /^(?:You've hit your|You've reached your|You're out of (?:usage credits|extra usage)|Your org is out of usage|Your seat type doesn't include|Your usage allocation has been disabled|Your group's usage limit|(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^\u00B7\n]{1,40})? requires usage credits)/

/** A request the API refused with a 429, as Claude Code shows one it has no message of its own for. */
const REJECTED = /^API Error:.*\b429\b/

/**
 * The window a failed request ran into, or undefined for a failure that is
 * not a usage limit, such as an overloaded or transient 429. A limit scoped to
 * one model is reported as `model`: switching models continues the work.
 * `error` is the kind StopFailure reports; without it, only Claude Code's own
 * limit messages and 429 refusals can be limits. A limit message names a
 * lockout even when the window can't be told.
 */
export function lockoutKind(error: string | undefined, text: string, readings: readonly LimitReading[]): string | undefined {
  const message = LIMIT_MESSAGE.test(text.trim())
  const limited = error === undefined ? message || REJECTED.test(text.trim()) : error === 'rate_limit' || error === 'billing_error'
  if (!limited) return undefined
  if (MODEL_SWITCH.test(text)) return 'model'
  const named = PHRASES.find(([pattern]) => pattern.test(text))?.[1]
  if (named !== undefined && named !== 'unknown') return named
  // A generic phrase, or none, is pinned to the window a reading shows full.
  return readings.find((r) => r.percent >= 100)?.kind ?? named ?? (message ? 'unknown' : undefined)
}
