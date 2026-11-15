// The local journal: one row per intervention, answer, override, limit
// crossing and lockout. Rows hold rule names, tool names, coarse buckets and
// times, never prompt text, tool inputs or model output.

import { WINDOW_KIND } from './state.ts'
import { count, duration, windowName } from './text.ts'

export type JournalEvent =
  | 'ask' // the guard asked the user
  | 'answer' // the user answered (or dismissed) a question
  | 'deny' // a model-facing refusal
  | 'drop' // a prompt was held
  | 'override' // /agent-guard allow or pause
  | 'limit' // a plan window crossed an ask or deny threshold
  | 'note' // Claude was told to wind down
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
  /** For an agent question: the subagent tokens it counted, as a bucket. */
  tok?: string
  /** Plan-window percentage, for `limit`, `note` and `lockout`. */
  pct?: number
  kind?: string
  /** For `limit` and `lockout`: when the plan window resets, from a current reading of it. */
  resets?: number
  /** For `deny`: which refusal of the condition this was. */
  n?: number
}

const KEY_PREFIX = 'journal:'
const DAY_MS = 86_400_000
/** Lockout rows with no reset time belong to one lockout while less than an hour apart. */
const LOCKOUT_GAP_MS = 3_600_000
/** The report lists this many lockouts, the latest. */
const LOCKOUTS_LISTED = 5

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

const EVENTS: ReadonlySet<string> = new Set(['ask', 'answer', 'deny', 'drop', 'override', 'limit', 'note', 'lockout'])
const ANSWERS: ReadonlySet<string> = new Set(['allow', 'compact', 'refuse', 'cancel', 'dismiss', 'unavailable'])
const BUCKETS: ReadonlySet<string> = new Set(['<150k', '150-300k', '300-400k', '400-500k', '>=500k'])
const TOKEN_BUCKETS: ReadonlySet<string> = new Set(['<10M', '10-15M', '15-20M', '20-30M', '30-50M', '50-100M', '>=100M'])
/** Rule names, override scopes and thresholds such as `80%`. */
const RULE = /^[a-z0-9%-]{1,32}$/
/** Tool names, MCP ones included: `mcp__github__create_issue`. */
const TOOL = /^[\w.-]{1,128}$/
const SESSION_PREFIX = /^[\w-]{1,32}$/

/**
 * A row read back from the store, checked field by field: the report prints
 * them, and Claude reads the report with its next request.
 */
export function isJournalRow(value: unknown): value is JournalRow {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  const optional = (key: string, ok: (v: unknown) => boolean): boolean => r[key] === undefined || ok(r[key])
  const text = (pattern: RegExp) => (v: unknown) => typeof v === 'string' && pattern.test(v)
  const oneOf = (set: ReadonlySet<string>) => (v: unknown) => typeof v === 'string' && set.has(v)
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  return (
    finite(r.t) &&
    text(SESSION_PREFIX)(r.s) &&
    oneOf(EVENTS)(r.ev) &&
    optional('rule', text(RULE)) &&
    optional('answer', oneOf(ANSWERS)) &&
    optional('tool', text(TOOL)) &&
    optional('ctx', oneOf(BUCKETS)) &&
    optional('tok', oneOf(TOKEN_BUCKETS)) &&
    optional('kind', text(WINDOW_KIND)) &&
    optional('pct', finite) &&
    optional('resets', finite) &&
    optional('n', finite)
  )
}

type RuleCount = { asks: number; allowed: number; compacted: number; declined: number; unanswered: number; denials: number; drops: number }

/** The text `/agent-guard report` prints. */
export function formatReport(rows: readonly JournalRow[], now: number, days: number): string {
  const recent = rows.filter((r) => now - r.t < days * DAY_MS).sort((a, b) => a.t - b.t)
  const lines = [`Report for the last ${count(days, 'day')}`]
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
  const listed = lockouts.length > LOCKOUTS_LISTED ? `, the latest ${LOCKOUTS_LISTED}:` : ''
  lines.push('', `Usage-limit lockouts: ${lockouts.length}${rate}${listed}`)
  for (const row of lockouts.slice(-LOCKOUTS_LISTED)) {
    lines.push(`  ${stamp(row.t)}${row.kind && row.kind !== 'unknown' ? ` · ${windowName(row.kind)} window` : ''}`)
  }
  if (modelScoped > 0) lines.push(`Limits on one model, where /model switched away: ${modelScoped}`)

  const limits = recent.filter((r) => r.ev === 'limit')
  if (limits.length > 0) lines.push(`Plan windows past a threshold: ${windowsPast(limits)}`)
  const windDowns = recent.filter((r) => r.ev === 'note' && r.rule === 'wind-down')
  if (windDowns.length > 0) lines.push(`Wind-down notes: ${windDowns.length} in ${count(new Set(windDowns.map((r) => r.s)).size, 'session')}`)

  const perRule = byRule(recent)
  if (perRule.size > 0) {
    lines.push('', 'By rule (asks: allowed / compacted / declined / no answer · refusals to the model · prompts held)')
    const width = Math.max(...[...perRule.keys()].map((k) => k.length))
    for (const [rule, c] of [...perRule].sort((a, b) => total(b[1]) - total(a[1]))) {
      lines.push(
        `  ${rule.padEnd(width)}  asks ${c.asks}: ${c.allowed} / ${c.compacted} / ${c.declined} / ${c.unanswered} · refusals ${c.denials} · held ${c.drops}`,
      )
    }
  }

  const denials = recent.filter((r) => r.ev === 'deny')
  const late = denials.filter((r) => (r.n ?? 1) >= 3).length
  const fuses = denials.filter((r) => r.rule === 'fuse').length
  if (denials.length > 0) lines.push(`Refusals at rung 3 or later: ${late} · refused while the agent fuse was burning: ${fuses}`)

  const tools = countBy(denials.filter((r) => r.tool), (r) => r.tool ?? '')
  if (tools.size > 0) lines.push(`Refusals by tool: ${[...tools].map(([k, n]) => `${k} ${n}`).join(', ')}`)

  const contexts = inOrder(countBy(recent.filter((r) => r.ctx), (r) => r.ctx ?? ''), BUCKETS)
  if (contexts.size > 0) lines.push(`Context when it acted: ${[...contexts].map(([k, n]) => `${k} ${n}`).join(', ')}`)

  const agentTokens = inOrder(countBy(recent.filter((r) => r.ev === 'ask' && r.tok), (r) => r.tok ?? ''), TOKEN_BUCKETS)
  if (agentTokens.size > 0) lines.push(`Subagent tokens when it asked: ${[...agentTokens].map(([k, n]) => `${k} ${n}`).join(', ')}`)

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

/**
 * Asks and how each ended, per rule. Every ask ends as one of allowed,
 * compacted, declined or no answer, so the four add up to the asks. An
 * answer with no open question in its session counts the question too: it
 * can only follow one, and before 1.2.2 two journal writes at once could
 * drop the question's row and keep the answer's. A question that could not be
 * shown, or has no answer recorded, has no answer.
 */
function byRule(rows: readonly JournalRow[]): Map<string, RuleCount> {
  const perRule = new Map<string, RuleCount>()
  const open = new Map<string, number>()
  const bump = (rule: string | undefined, field: keyof RuleCount): void => {
    const key = rule ?? 'unknown'
    const entry = perRule.get(key) ?? { asks: 0, allowed: 0, compacted: 0, declined: 0, unanswered: 0, denials: 0, drops: 0 }
    entry[field] += 1
    perRule.set(key, entry)
  }
  for (const row of rows) {
    const question = `${row.s}\n${row.rule ?? 'unknown'}`
    if (row.ev === 'ask') {
      bump(row.rule, 'asks')
      open.set(question, (open.get(question) ?? 0) + 1)
    } else if (row.ev === 'answer') {
      const waiting = open.get(question) ?? 0
      if (waiting > 0) open.set(question, waiting - 1)
      else bump(row.rule, 'asks')
      bump(row.rule, row.answer === 'allow' ? 'allowed' : row.answer === 'compact' ? 'compacted' : row.answer === 'unavailable' ? 'unanswered' : 'declined')
    } else if (row.ev === 'deny') bump(row.rule, 'denials')
    else if (row.ev === 'drop') bump(row.rule, 'drops')
  }
  for (const [question, waiting] of open) {
    for (let i = 0; i < waiting; i++) bump(question.split('\n')[1], 'unanswered')
  }
  return perRule
}

/**
 * The plan windows that passed each threshold, from rows that name their
 * window: every session records the thresholds it finds passed, so one window
 * has a row per session. Rows from before 1.2.2 don't name it and can't be
 * counted exactly, so they are left out, and the line says how many and from
 * when it counts.
 */
function windowsPast(limits: readonly JournalRow[]): string {
  const named = limits.filter((r) => r.resets !== undefined)
  const unnamed = limits.length - named.length
  const leftOut = `${count(unnamed, 'row')} that ${unnamed === 1 ? "doesn't" : "don't"} name the window left out`
  if (named.length === 0) return `none counted, ${leftOut}`
  const windows = new Map<string, JournalRow>()
  for (const row of named) windows.set(`${row.kind}\n${row.rule}\n${row.resets}`, row)
  const byThreshold = countBy([...windows.values()], (r) => `${windowName(r.kind ?? '?')} ${r.rule ?? ''}`.trim())
  const counts = [...byThreshold].map(([k, n]) => `${k} ×${n}`).join(', ')
  return unnamed === 0 ? counts : `${counts} (from ${stamp(named[0]!.t)}; ${leftOut})`
}

/** The counts in the order the buckets run, smallest first. */
function inOrder(counts: ReadonlyMap<string, number>, buckets: ReadonlySet<string>): Map<string, number> {
  const order = [...buckets]
  return new Map([...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])))
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
