import { describe, expect, test } from 'claude-code/testing'

import { SESSION_ID, T0, journalRows, start, world } from './harness.ts'

const DAY = 86_400_000

describe('lockouts and the report', () => {
  test('a usage-limit failure is journaled as a lockout; a transient rate limit is not', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await $.classic.StopFailure({ error: 'rate_limit', error_details: 'API Error: Request rejected (429) · overloaded' } as never)
    await $.classic.StopFailure({ error: 'rate_limit', error_details: "Claude usage limit reached. Your limit will reset at 3pm" } as never)
    await $.classic.StopFailure({ error: 'server_error', error_details: 'usage limit' } as never)
    await $.classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your weekly limit · resets Oct 9" } as never)
    await $.classic.StopFailure({ error: 'billing_error', error_details: 'You have reached your monthly spend limit.' } as never)
    await $.classic.StopFailure({ error: 'rate_limit', error_details: 'Opus limit reached. Use /model to switch to another model.' } as never)
    expect(journalRows(w).map((r) => `${r.ev}:${r.kind}`)).toEqual(['lockout:unknown', 'lockout:seven_day', 'lockout:spend_limit', 'lockout:model'])
  })

  test('/agent-guard report reads every session\'s journal on this machine', async ($, on) => {
    const w = world(on, {
      store: {
        'journal:2027-01-14:other-session': [
          { t: T0 - DAY / 2, s: 'other-se', ev: 'lockout', kind: 'five_hour', pct: 100 },
          { t: T0 - DAY / 2, s: 'other-se', ev: 'deny', rule: 'retry', tool: 'Bash', n: 1 },
        ],
      },
    })
    await start($, w, false)
    await $.command.run({ command: 'agent-guard', args: 'allow' } as never)
    const report = await $.command.run({ command: 'agent-guard', args: 'report 3' } as never)
    expect(report.text).toMatch(/3 events from 2 sessions/)
    expect(report.text).toMatch(/Usage-limit lockouts: 1/)
    expect(report.text).toMatch(/Overrides: 1 \(all 1\)/)
  })

  test('AGENT_GUARD_JOURNAL=0 records nothing', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_JOURNAL: '0' } })
    await start($, w, false)
    await $.command.run({ command: 'agent-guard', args: 'allow' } as never)
    expect(journalRows(w)).toEqual([])
  })

  test('housekeeping drops expired journal days and records of sessions long gone', async ($, on) => {
    const w = world(on, {
      store: {
        'journal:2026-09-01:old': [{ t: T0 - 136 * DAY, s: 'old', ev: 'lockout' }],
        'journal:2027-01-10:recent': [{ t: T0 - 5 * DAY, s: 'recent', ev: 'lockout' }],
        'peer:gone': { v: 2, at: T0 - 2 * DAY, running: 3, starts: [], agentTokens: [], dormantResumes: [] },
        'peer:alive': { v: 2, at: T0 - 60_000, running: 1, starts: [], agentTokens: [], dormantResumes: [] },
        'last-active:gone': T0 - 31 * DAY,
        'last-active:recent': T0 - 3 * DAY,
      },
    })
    await start($, w, false)
    expect([...w.store.keys()].sort()).toEqual(['journal:2027-01-10:recent', 'last-active:recent', 'peer:alive'])
  })

  test('a journal row stores the rule and a context bucket, never the prompt', async ($, on) => {
    const w = world(on, { contextTokens: 520_000 })
    await start($, w, false)
    await $.prompt.submit({ text: 'please refactor the billing module', origin: { kind: 'sdk' }, wait: false } as never)
    const rows = journalRows(w)
    expect(rows).toEqual([{ t: T0, s: SESSION_ID.slice(0, 8), ev: 'drop', rule: 'prompt-context', ctx: '>=500k' }])
    expect(JSON.stringify([...w.store.values()])).not.toMatch(/billing/)
  })
})
