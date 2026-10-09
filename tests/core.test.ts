// Unit tests of the harness-agnostic core: no mod, no stubs, plain data.

import { describe, expect, test } from 'claude-code/testing'

import {
  type JournalRow,
  agentGate,
  canonical,
  defaultConfig,
  fingerprint,
  formatReport,
  highestLimit,
  journalKey,
  livePeers,
  newSession,
  parseCommand,
  parseConfig,
  peerRecord,
  prune,
  splitJournalKeys,
} from '../core/index.ts'

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0)
const DAY = 86_400_000

describe('config', () => {
  test('defaults match the documented values', () => {
    const c = defaultConfig()
    expect(c).toMatchObject({ agentMax: 4, rollingMax: 12, windowMs: 600_000, limitAskPercent: 80, limitDenyPercent: 95, contextHard: 500_000 })
  })

  test('seconds become milliseconds, underscores are allowed, and switches read words', () => {
    const { config, problems } = parseConfig({ AGENT_GUARD_WINDOW_SECONDS: '900', AGENT_GUARD_CONTEXT_HARD: '800_000', AGENT_GUARD_JOURNAL: 'off' })
    expect(problems).toEqual([])
    expect(config.windowMs).toBe(900_000)
    expect(config.contextHard).toBe(800_000)
    expect(config.journal).toBe(false)
    expect(config.enabled).toBe(true)
  })

  test('out-of-range values fall back with a reason, never disabling a gate', () => {
    const { config, problems } = parseConfig({ AGENT_GUARD_AGENT_MAX: '0', AGENT_GUARD_LIMIT_ASK_PERCENT: '90', AGENT_GUARD_LIMIT_DENY_PERCENT: '85' })
    expect(config.agentMax).toBe(4)
    expect(problems).toEqual([
      'AGENT_GUARD_AGENT_MAX=0 is not a number from 1 to 1000; using 4',
      'AGENT_GUARD_LIMIT_DENY_PERCENT is below AGENT_GUARD_LIMIT_ASK_PERCENT; new agents are refused from 85%',
    ])
  })
})

describe('commands', () => {
  test('parses every subcommand and its arguments', () => {
    expect(parseCommand('')).toEqual({ action: 'status' })
    expect(parseCommand('allow')).toEqual({ action: 'allow', scope: 'all', minutes: 10 })
    expect(parseCommand('allow agents 30')).toEqual({ action: 'allow', scope: 'agents', minutes: 30 })
    expect(parseCommand('ALLOW 45m context')).toEqual({ action: 'allow', scope: 'context', minutes: 45 })
    expect(parseCommand('pause 20')).toEqual({ action: 'allow', scope: 'all', minutes: 20 })
    expect(parseCommand('report 30')).toEqual({ action: 'report', days: 30 })
    expect(parseCommand('resume')).toEqual({ action: 'resume' })
  })

  test('rejects what it cannot read instead of guessing', () => {
    expect(parseCommand('allow forever')).toMatchObject({ action: 'help' })
    expect(parseCommand('pause agents')).toMatchObject({ action: 'help' })
    expect(parseCommand('allow 9999')).toMatchObject({ action: 'help' })
    expect(parseCommand('report -1')).toMatchObject({ action: 'help' })
    expect(parseCommand('frobnicate')).toEqual({ action: 'help', error: 'unknown subcommand "frobnicate"' })
  })
})

describe('denial ladder', () => {
  test('each refusal of a condition reads differently and escalates', () => {
    const config = defaultConfig()
    const state = newSession('s', false)
    state.agents.a = { id: 'a', kind: 'subagent', depth: 1, running: true, startedAt: NOW }
    const request = { loop: 'a', depth: 2, resume: false }
    const texts = [0, 1, 2].map((i) => {
      const v = agentGate(state, [], config, NOW + i * 1000, request)
      return v.kind === 'deny' ? v.message : ''
    })
    expect(new Set(texts).size).toBe(3)
    expect(texts[0]).toMatch(/refusal 1 at/)
    expect(texts[1]).toMatch(/This has not changed since \d\d:\d\d:\d\d, so the same call fails again\. Do something different\./)
    expect(texts[2]).toMatch(/End the turn and tell the user what is blocked\./)
  })

  test('refusals of other conditions keep their own count', () => {
    const config = { ...defaultConfig(), agentMax: 1 }
    const state = newSession('s', false)
    state.agents.a = { id: 'a', kind: 'subagent', depth: 1, running: true, startedAt: NOW }
    const nested = agentGate(state, [], config, NOW, { loop: 'a', depth: 2, resume: false })
    const busy = agentGate(state, [], config, NOW + 1, { loop: 'main', depth: 1, resume: false })
    expect(nested.kind === 'deny' && nested.message).toMatch(/refusal 1 at/)
    expect(busy.kind === 'deny' && busy.message).toMatch(/refusal 1 at/)
  })
})

describe('plan windows', () => {
  test('the freshest reading per window wins, and an expired window is ignored', () => {
    const state = newSession('s', false)
    state.limits.five_hour = { at: NOW - 60_000, kind: 'five_hour', percent: 40, resetsAt: NOW + 3_600_000 }
    state.limits.seven_day = { at: NOW, kind: 'seven_day', percent: 70, resetsAt: NOW - 1 }
    const peer = { ...peerRecord(newSession('p', false), NOW, 600_000), limit: { at: NOW, kind: 'five_hour', percent: 55, resetsAt: NOW + 3_600_000 } }
    expect(highestLimit(state, [peer], NOW)).toMatchObject({ kind: 'five_hour', percent: 55 })
  })
})

describe('peers', () => {
  test('only fresh records of our own shape count', () => {
    const good = { v: 2, at: NOW - 1000, running: 2, starts: [], agentTokens: [], dormantResumes: [] }
    const stale = { ...good, at: NOW - 3_600_000 }
    const older = { ...good, v: 1, agentTokens: 0 }
    expect(livePeers([good, stale, older, { v: 2 }, 'junk', null], NOW, 900_000)).toEqual([good])
  })

  test('a published record carries counts, never names or prompts', () => {
    const state = newSession('s', false)
    state.agents.a = { id: 'a', kind: 'subagent', depth: 1, running: true, startedAt: NOW, name: 'secret-name' }
    state.starts = [NOW - 700_000, NOW - 1000]
    state.agentTokens = [[NOW - 700_000, 9], [NOW - 90_000, 1000], [NOW - 70_000, 500], [NOW - 1000, 20]]
    prune(state, NOW, 600_000)
    const record = peerRecord(state, NOW, 600_000)
    expect(record).toEqual({ v: 2, at: NOW, running: 1, starts: [NOW - 1000], agentTokens: [[NOW - 70_000, 1500], [NOW - 1000, 20]], dormantResumes: [] })
    expect(JSON.stringify(record)).not.toMatch(/secret/)
  })
})

describe('fingerprints', () => {
  test('equal inputs in any key order give one fingerprint; different inputs differ', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}')
    expect(fingerprint(canonical({ a: 1, b: 2 }))).toBe(fingerprint(canonical({ b: 2, a: 1 })))
    expect(fingerprint('npm test')).not.toBe(fingerprint('npm  test'))
    expect(fingerprint('x')).toMatch(/^[0-9a-z]{13}$/)
  })
})

describe('journal', () => {
  test('keys are per session per day, and retention drops whole days', () => {
    expect(journalKey('abc', NOW)).toBe('journal:2027-01-15:abc')
    const keys = ['journal:2027-01-15:a', 'journal:2026-10-01:b', 'journal:2026-12-20:c', 'peer:x']
    expect(splitJournalKeys(keys, NOW, 30)).toEqual({ recent: ['journal:2027-01-15:a', 'journal:2026-12-20:c'], expired: ['journal:2026-10-01:b'] })
    expect(splitJournalKeys(keys, NOW, 7).recent).toEqual(['journal:2027-01-15:a'])
  })

  test('the report counts lockouts per week, answers and refusals by rule', () => {
    const rows: JournalRow[] = [
      { t: NOW - 2 * DAY, s: 'a', ev: 'lockout', kind: 'five_hour', pct: 100 },
      { t: NOW - DAY, s: 'a', ev: 'ask', rule: 'concurrency' },
      { t: NOW - DAY, s: 'a', ev: 'answer', rule: 'concurrency', answer: 'allow' },
      { t: NOW - DAY, s: 'b', ev: 'ask', rule: 'concurrency' },
      { t: NOW - DAY, s: 'b', ev: 'answer', rule: 'concurrency', answer: 'refuse' },
      { t: NOW - DAY, s: 'b', ev: 'ask', rule: 'concurrency' },
      { t: NOW - DAY, s: 'b', ev: 'answer', rule: 'concurrency', answer: 'unavailable' },
      { t: NOW - 3600, s: 'b', ev: 'deny', rule: 'retry', tool: 'Bash', n: 3 },
      { t: NOW - 3600, s: 'b', ev: 'limit', kind: 'five_hour', pct: 81, rule: '80%' },
      { t: NOW - 60, s: 'b', ev: 'override', rule: 'agents' },
      { t: NOW - 30 * DAY, s: 'c', ev: 'lockout' },
    ]
    const text = formatReport(rows, NOW, 7)
    expect(text).toMatch(/^agent-usage-guard report: last 7 days\n10 events from 2 sessions/)
    expect(text).toMatch(/Usage-limit lockouts: 1 \(1\.0 per week\)/)
    expect(text).toMatch(/concurrency\s+asks 3: 1 \/ 1 · refusals 0 · held 0/)
    expect(text).toMatch(/retry\s+asks 0: 0 \/ 0 · refusals 1 · held 0/)
    expect(text).toMatch(/Refusals at rung 3 or later: 1/)
    expect(text).toMatch(/Limit crossings: 5-hour 80% ×1/)
    expect(text).toMatch(/Overrides: 1 \(agents 1\)/)
  })

  test('lockouts count once per locked window, however many sessions and retries hit it', () => {
    const HOUR = DAY / 24
    const lockout = (ago: number, s: string, resets?: number) => ({ t: NOW - ago, s, ev: 'lockout' as const, kind: 'five_hour', ...(resets ? { resets } : {}) })
    const rows = [
      // Rows from before reset times were recorded: one run, then a second after a long gap.
      lockout(3 * DAY, 'a'),
      lockout(3 * DAY - 20 * 60_000, 'b'),
      lockout(2 * DAY, 'a'),
      // One window that two sessions hit and one retried an hour later, then the next window.
      lockout(9 * HOUR, 'a', NOW - 7 * HOUR),
      lockout(9 * HOUR - 60_000, 'b', NOW - 7 * HOUR),
      lockout(8 * HOUR, 'a', NOW - 7 * HOUR),
      lockout(3 * HOUR, 'a', NOW + 2 * HOUR),
    ]
    expect(formatReport(rows, NOW, 7)).toMatch(/Usage-limit lockouts: 4 \(4\.0 per week\)/)
    // Under a week there is no rate to give: it would be the count again.
    expect(formatReport(rows, NOW, 2)).toMatch(/Usage-limit lockouts: 2\n/)
  })

  test('an empty journal says so', () => {
    expect(formatReport([], NOW, 7)).toMatch(/Nothing recorded yet/)
  })

  test('one event from one session over one day reads in the singular', () => {
    expect(formatReport([{ t: NOW - 60, s: 'a', ev: 'override', rule: 'all' }], NOW, 1)).toMatch(/^agent-usage-guard report: last 1 day\n1 event from 1 session\n/)
  })
})
