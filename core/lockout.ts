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

/**
 * The window a failed request ran into, or undefined for a failure that is
 * not a usage limit, such as an overloaded or transient 429. A limit scoped to
 * one model is reported as `model`: switching models continues the work.
 */
export function lockoutKind(error: string, text: string, readings: readonly LimitReading[]): string | undefined {
  if (error !== 'rate_limit' && error !== 'billing_error') return undefined
  if (MODEL_SWITCH.test(text)) return 'model'
  const named = PHRASES.find(([pattern]) => pattern.test(text))?.[1]
  if (named !== undefined && named !== 'unknown') return named
  // A generic phrase, or none, is pinned to the window a reading shows full.
  return readings.find((r) => r.percent >= 100)?.kind ?? named
}
