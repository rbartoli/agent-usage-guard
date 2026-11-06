// On a Team or Enterprise plan, or a machine with managed settings, Claude
// Code seats its built-in cc-plugin-sec-default plugin ahead of every other.
// Its 2.1.318 source sends each classic.* event, and each session.compact
// hook, on to the append tier, past user plugins such as the guard (issue
// #60). The stand-in below does the same, so these tests run the guard as it
// runs there. Each test fires the classic events Claude Code fires, which the
// stand-in passes over.

import { type Plugin, describe, expect, test } from 'claude-code/testing'

import { T0, endTurn, journalRows, respond, spawn, start, world } from './harness.ts'

const HOUR = 3_600_000
const bash = (command: string) => ({ tool: 'Bash', command }) as never
const typed = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as never

const secDefault: Plugin = {
  name: 'sec-default-stand-in',
  tier: 'prepend',
  register(on) {
    on('classic.*', ($, e, next) => next.to(e, 'append'))
    on('session.compact', ($, e, next) => next.to(e, 'append'))
  },
}
const managed = { plugins: [secDefault] }

describe('where Claude Code passes its classic events over the guard', () => {
  test('a /compact clears the context the prompt gate held', managed, async ($, on) => {
    const w = world(on, { contextTokens: 520_000 })
    await start($, w, true)
    await respond($, w, 520_000)
    await $.classic.SessionStart({ source: 'compact', transcript_path: '/t.jsonl' } as never)
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: '' } as never)
    w.setContext(undefined) // Claude Code has no figure until the next response
    expect(await $.prompt.submit(typed('next step'))).toEqual({ text: 'next step' })
    expect(w.questions).toEqual([])
  })

  test('a usage-limit lockout is journaled when the turn it stopped ends', managed, async ($, on) => {
    const w = world(on)
    await start($, w, false)
    for (const text of [
      "You've hit your session limit · resets 3pm",
      "You've hit your weekly limit · resets Oct 9",
      "You've hit your monthly spend limit.",
      "You've reached your Fable limit. Switch to another model to continue.",
      "You've hit your Sonnet limit · resets Mon 9am",
      'API Error: Request rejected (429) · usage limit reached, resets 3pm',
    ]) {
      w.transcript = [{ role: 'user', text: 'go on' }, { role: 'assistant', text }]
      await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: text } as never)
      await endTurn($, 'error')
    }
    const kinds = ['five_hour', 'seven_day', 'spend_limit', 'model', 'unknown', 'unknown']
    expect(journalRows(w).map((r) => `${r.ev}:${r.kind}`)).toEqual(kinds.map((k) => `lockout:${k}`))
  })

  test('an API error that is not a usage limit is not a lockout', managed, async ($, on) => {
    const w = world(on)
    await start($, w, false)
    for (const text of ['Context limit reached · /compact or /clear to continue', 'API Error: Request rejected (429) · overloaded', 'API Error: 500 Internal server error']) {
      w.transcript = [{ role: 'assistant', text }]
      await endTurn($, 'error')
    }
    expect(journalRows(w)).toEqual([])
  })

  test('a session resumed in place is judged as itself, not as the one it replaced', managed, async ($, on) => {
    const w = world(on, { answers: ['Send anyway'], contextTokens: 200_000, store: { 'last-active:sess-0002-bbbb': T0 - 2 * HOUR } })
    await start($, w, true)
    await respond($, w, 30_000)
    await $.session.end({ reason: 'resume' } as never)
    w.sessionId = 'sess-0002-bbbb'
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl' } as never)
    expect(await $.prompt.submit(typed('continue'))).toEqual({ text: 'continue' })
    expect(w.questions).toEqual(['This session was idle for 2 h, so its prompt cache has likely expired and this request re-writes about 200k tokens. Send this prompt?'])
  })

  test('a Stop hook that reopens the turn hands the decision to the user', managed, async ($, on) => {
    const w = world(on, { toolResult: () => ({ result: 'failed', isError: true }) })
    await start($, w, false)
    for (let i = 0; i < 3; i++) await $.tool.call(bash('flaky'))
    await respond($, w, 10_000) // the model ends the turn
    await $.classic.Stop({ stop_hook_active: false } as never) // a Stop hook blocks the end
    await respond($, w, 10_000) // and the turn goes on
    await $.tool.call(bash('flaky'))
    const second = (await $.tool.call(bash('flaky'))) as Record<string, unknown>
    expect(String(second.deny)).toMatch(/A Stop hook reopened this turn, so ending the turn will not clear this\. Tell the user/)
  })

  test('"Compact, then send" still compacts and sends', managed, async ($, on) => {
    const w = world(on, { answers: ['Compact, then send'], contextTokens: 520_000 })
    await start($, w, true)
    await $.prompt.submit(typed('next step'))
    await w.clock.settle()
    expect(w.compactions).toBe(1)
    expect(w.submits).toHaveLength(1)
  })

  test('the agent gate still holds agents', managed, async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_AGENT_MAX: '1' }, onSpawn: () => new Promise(() => undefined) })
    await start($, w, false)
    void spawn($, w)
    await w.clock.settle()
    expect(String((await spawn($, w)).deny)).toMatch(/limit 1/)
  })
})
