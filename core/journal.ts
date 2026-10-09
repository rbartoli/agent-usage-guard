// The local journal: one row per intervention, answer, override, limit
// crossing and lockout. Rows hold rule names, tool names, coarse buckets and
// times, never prompt text, tool inputs or model output.

import { count, duration, windowName } from './text.ts'

export type JournalEvent =
  | 'ask' // the guard asked the user
  | 'answer' // the user answered (or dismissed) a question
  | 'deny' // a model-facing refusal
  | 'drop' // a prompt was held
  | 'override' // /agent-guard allow or pause
  | 'limit' // a plan window crossed an ask or deny threshold
  | 'lockout' // a request failed on a usage limit

export type JournalRow = {
  t: number
  /** First 8 characters of the session id. */
  s: string
  ev: JournalEvent
  rule?: string
  /** For `answer`: allow, compact, refuse, cancel or dismiss, or unavailable when the question could not be shown. */
  answer?: string
  tool?: string
  ctx?: string
  /** Plan-window percentage, for `limit` and `lockout`. */
  pct?: number
  kind?: string
  /** For `lockout`: when the window that locked resets, from a current reading of it. */
  resets?: number
  /** For `deny`: which refusal of the condition this was. */
  n?: number
}

const KEY_PREFIX = 'journal:'
const DAY_MS = 86_400_000
/** Lockout rows with no reset time belong to one lockout while less than an hour apart. */
const LOCKOUT_GAP_MS = 3_600_000

/** Each session appends only to its own key for the day, so sessions never overwrite each other. */
export function journalKey(sessionId: string, now: number): string {
  return `${KEY_PREFIX}${new Date(now).toISOString().slice(0, 10)}:${sessionId}`
}

/**
 * Picks the journal's keys out of the store's and splits them by age: `recent`
 * days can hold rows from the last `days` days, `expired` days ended before
 * those began.
 */
export function splitJournalKeys(keys: readonly string[], now: number, days: number): { recent: string[]; expired: string[] } {
  const start = now - days * DAY_MS
  const split = { recent: [] as string[], expired: [] as string[] }
  for (const key of keys) {
    if (!key.startsWith(KEY_PREFIX)) continue
    const day = Date.parse(key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 10))
    if (Number.isNaN(day)) continue
    split[day + DAY_MS < start ? 'expired' : 'recent'].push(key)
  }
  return split
}

export function isJournalRow(value: unknown): value is JournalRow {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.t === 'number' && typeof r.ev === 'string' && typeof r.s === 'string'
}

type RuleCount = { asks: number; allowed: number; declined: number; denials: number; drops: number }

/** The text `/agent-guard report` prints. */
export function formatReport(rows: readonly JournalRow[], now: number, days: number): string {
  const recent = rows.filter((r) => now - r.t < days * DAY_MS).sort((a, b) => a.t - b.t)
  const lines = [`agent-usage-guard report: last ${count(days, 'day')}`]
  if (recent.length === 0) {
    lines.push('', 'Nothing recorded yet. The journal fills as the guard asks, refuses, or sees a limit.')
    return lines.join('\n')
  }
  const sessions = new Set(recent.map((r) => r.s)).size
  lines.push(`${count(recent.length, 'event')} from ${count(sessions, 'session')}`)

  const lockouts = lockedWindows(recent.filter((r) => r.ev === 'lockout' && r.kind !== 'model'))
  const modelScoped = recent.filter((r) => r.ev === 'lockout' && r.kind === 'model').length
  // Only a span of a week or more gives a weekly rate; a shorter one would extrapolate.
  const rate = days >= 7 ? ` (${(lockouts.length / (days / 7)).toFixed(1)} per week)` : ''
  lines.push('', `Usage-limit lockouts: ${lockouts.length}${rate}`)
  for (const row of lockouts.slice(-5)) {
    lines.push(`  ${stamp(row.t)}${row.kind && row.kind !== 'unknown' ? ` · ${windowName(row.kind)} window` : ''}`)
  }
  if (modelScoped > 0) lines.push(`Limits on one model, where /model switched away: ${modelScoped}`)

  const crossings = recent.filter((r) => r.ev === 'limit')
  if (crossings.length > 0) {
    const byThreshold = countBy(crossings, (r) => `${windowName(r.kind ?? '?')} ${r.rule ?? ''}`.trim())
    lines.push(`Limit crossings: ${[...byThreshold].map(([k, n]) => `${k} ×${n}`).join(', ')}`)
  }

  const perRule = new Map<string, RuleCount>()
  const bump = (rule: string | undefined, field: keyof RuleCount): void => {
    const key = rule ?? 'unknown'
    const entry = perRule.get(key) ?? { asks: 0, allowed: 0, declined: 0, denials: 0, drops: 0 }
    entry[field] += 1
    perRule.set(key, entry)
  }
  for (const row of recent) {
    if (row.ev === 'ask') bump(row.rule, 'asks')
    else if (row.ev === 'deny') bump(row.rule, 'denials')
    else if (row.ev === 'drop') bump(row.rule, 'drops')
    // A question that could not be shown was neither allowed nor declined.
    else if (row.ev === 'answer' && row.answer !== 'unavailable') {
      bump(row.rule, row.answer === 'allow' || row.answer === 'compact' ? 'allowed' : 'declined')
    }
  }
  if (perRule.size > 0) {
    lines.push('', 'By rule (asks: allowed / declined · refusals to the model · prompts held)')
    const width = Math.max(...[...perRule.keys()].map((k) => k.length))
    for (const [rule, c] of [...perRule].sort((a, b) => total(b[1]) - total(a[1]))) {
      lines.push(`  ${rule.padEnd(width)}  asks ${c.asks}: ${c.allowed} / ${c.declined} · refusals ${c.denials} · held ${c.drops}`)
    }
  }

  const denials = recent.filter((r) => r.ev === 'deny')
  const late = denials.filter((r) => (r.n ?? 1) >= 3).length
  const fuses = denials.filter((r) => r.rule === 'fuse').length
  if (denials.length > 0) lines.push(`Refusals at rung 3 or later: ${late} · refused while the agent fuse was burning: ${fuses}`)

  const tools = countBy(denials.filter((r) => r.tool), (r) => r.tool ?? '')
  if (tools.size > 0) lines.push(`Refusals by tool: ${[...tools].map(([k, n]) => `${k} ${n}`).join(', ')}`)

  const contexts = countBy(recent.filter((r) => r.ctx), (r) => r.ctx ?? '')
  if (contexts.size > 0) lines.push(`Context when it acted: ${[...contexts].map(([k, n]) => `${k} ${n}`).join(', ')}`)

  const overrides = recent.filter((r) => r.ev === 'override')
  if (overrides.length > 0) lines.push(`Overrides: ${overrides.length} (${[...countBy(overrides, (r) => r.rule ?? 'all')].map(([k, n]) => `${k} ${n}`).join(', ')})`)

  lines.push('', `Span: ${stamp(recent[0]!.t)} to ${stamp(recent.at(-1)!.t)} (${duration(recent.at(-1)!.t - recent[0]!.t)})`)
  return lines.join('\n')
}

/**
 * The first row of each locked window. Rows with the same reset time are one
 * window, whichever session hit it and however often; a row without one, from
 * an older version or a session with no current reading, joins the row before
 * it unless an hour or more separates them.
 */
function lockedWindows(lockouts: readonly JournalRow[]): JournalRow[] {
  const firsts: JournalRow[] = []
  const previous = new Map<string, JournalRow>()
  for (const row of lockouts) {
    const kind = row.kind ?? 'unknown'
    const before = previous.get(kind)
    previous.set(kind, row)
    const same =
      before !== undefined &&
      (row.resets !== undefined && before.resets !== undefined ? row.resets === before.resets : row.t - before.t < LOCKOUT_GAP_MS)
    if (!same) firsts.push(row)
  }
  return firsts
}

function total(c: RuleCount): number {
  return c.asks + c.denials + c.drops
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return new Map([...counts].sort((a, b) => b[1] - a[1]))
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
