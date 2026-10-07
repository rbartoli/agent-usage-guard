// The local journal: one row per intervention, answer, override, limit
// crossing and lockout. Rows hold rule names, tool names, coarse buckets and
// times, never prompt text, tool inputs or model output.

import { duration, windowName } from './text.ts'

export type JournalEvent =
  | 'ask' // the guard asked the user
  | 'answer' // the user answered (or dismissed) a question
  | 'deny' // a model-facing refusal
  | 'drop' // a prompt was held
  | 'override' // /usage-guard allow or pause
  | 'limit' // a plan window crossed an ask or deny threshold
  | 'lockout' // a request failed on a usage limit

export type JournalRow = {
  t: number
  /** First 8 characters of the session id. */
  s: string
  ev: JournalEvent
  rule?: string
  /** For `answer`: allow, refuse, compact, cancel, dismiss or other. */
  answer?: string
  tool?: string
  ctx?: string
  /** Plan-window percentage, for `limit` and `lockout`. */
  pct?: number
  kind?: string
  /** For `deny`: which refusal of the condition this was. */
  n?: number
}

const KEY_PREFIX = 'journal:'
const DAY_MS = 86_400_000

/** Each session appends only to its own key for the day, so sessions never overwrite each other. */
export function journalKey(sessionId: string, now: number): string {
  return `${KEY_PREFIX}${new Date(now).toISOString().slice(0, 10)}:${sessionId}`
}

export function isJournalKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX)
}

function keyDay(key: string): number | undefined {
  const day = Date.parse(key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 10))
  return Number.isNaN(day) ? undefined : day
}

/** Keys whose day is older than the retention. */
export function expiredJournalKeys(keys: readonly string[], now: number, days: number): string[] {
  const cutoff = now - days * DAY_MS
  return keys.filter((key) => {
    if (!isJournalKey(key)) return false
    const day = keyDay(key)
    return day !== undefined && day + DAY_MS < cutoff
  })
}

/** Keys that can hold rows from the last `days` days. */
export function journalKeysSince(keys: readonly string[], now: number, days: number): string[] {
  const cutoff = now - days * DAY_MS
  return keys.filter((key) => {
    if (!isJournalKey(key)) return false
    const day = keyDay(key)
    return day !== undefined && day + DAY_MS >= cutoff
  })
}

export function isJournalRow(value: unknown): value is JournalRow {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.t === 'number' && typeof r.ev === 'string' && typeof r.s === 'string'
}

type RuleCount = { asks: number; allowed: number; declined: number; denials: number; drops: number }

/** The text `/usage-guard report` prints. */
export function formatReport(rows: readonly JournalRow[], now: number, days: number): string {
  const recent = rows.filter((r) => now - r.t < days * DAY_MS).sort((a, b) => a.t - b.t)
  const lines = [`agent-usage-guard report: last ${days} day${days === 1 ? '' : 's'}`]
  if (recent.length === 0) {
    lines.push('', 'Nothing recorded yet. The journal fills as the guard asks, refuses, or sees a limit.')
    return lines.join('\n')
  }
  const sessions = new Set(recent.map((r) => r.s)).size
  lines.push(`${recent.length} events from ${sessions} session${sessions === 1 ? '' : 's'}`)

  const lockouts = recent.filter((r) => r.ev === 'lockout' && r.kind !== 'model')
  const modelScoped = recent.filter((r) => r.ev === 'lockout' && r.kind === 'model').length
  const weeks = Math.max(days / 7, 1)
  lines.push('', `Usage-limit lockouts: ${lockouts.length} (${(lockouts.length / weeks).toFixed(1)} per week)`)
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
    else if (row.ev === 'answer') bump(row.rule, row.answer === 'allow' || row.answer === 'compact' ? 'allowed' : 'declined')
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
