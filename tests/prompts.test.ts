import { describe, expect, test } from 'claude-code/testing'

import { SPECS } from '../core/index.ts'
import { SESSION_ID, T0, journalRows, respond, start, world } from './harness.ts'

const HOUR = 3_600_000
const typed = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as never
const headless = (text: string) => ({ text, origin: { kind: 'sdk' }, wait: false }) as never

describe('heavy prompt', () => {
  test('at 520k the user is asked before the prompt re-reads it all', async ($, on) => {
    const w = world(on, { answers: ['Send anyway'], contextTokens: 520_000 })
    await start($, w, true)
    expect(await $.prompt.submit(typed('next step'))).toEqual({
      text: 'next step',
      context: [expect.stringMatching(/^agent-usage-guard: this session's context is 520k tokens\. Keep this turn bounded/)],
    })
    expect(w.questions[0]).toBe('This session holds 520k context tokens, and sending re-reads all of them; compacting first shrinks this request and every later one. Send this prompt?')
    expect(w.options[0]).toEqual(['Compact, then send', 'Send anyway', 'Cancel'])
    expect(await $.prompt.submit(typed('and another'))).toEqual({ text: 'and another' })
    expect(w.questions).toHaveLength(1)
  })

  test('compact, then send drops the prompt, compacts, and sends it as the user\'s own', async ($, on) => {
    const w = world(on, { answers: ['Compact, then send'], contextTokens: 520_000 })
    await start($, w, true)
    const result = (await $.prompt.submit(typed('next step'))) as Record<string, unknown>
    expect(String(result.drop)).toMatch(/^agent-usage-guard: compacting first, because this session holds 520k context tokens/)
    await w.clock.settle()
    expect(w.compactions).toBe(1)
    expect(w.submits).toEqual([expect.objectContaining({ text: 'next step', origin: expect.objectContaining({ kind: 'plugin', asUser: true }) })])
    expect(journalRows(w).filter((r) => r.ev === 'answer')).toEqual([expect.objectContaining({ rule: 'prompt-context', answer: 'compact' })])
  })

  test('compact, then send takes the dropped prompt back out of the input box before sending it', async ($, on) => {
    const w = world(on, { answers: ['Compact, then send'], contextTokens: 520_000 })
    await start($, w, true)
    await $.prompt.submit(typed('next step'))
    w.draft = 'next step' // Claude Code puts a dropped prompt back in the input box
    await w.clock.settle()
    expect(w.draft).toBe('')
    expect(w.submits).toHaveLength(1)
  })

  test('compact, then send takes the prompt back out when Claude Code puts it back late', async ($, on) => {
    const w = world(on, {
      answers: ['Compact, then send'],
      contextTokens: 520_000,
      compactResult: () => {
        w.draft = 'merge' // the put-back lands after the guard first looked
        return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 0, tokensAfter: 0 }
      },
    })
    await start($, w, true)
    await $.prompt.submit(typed('merge'))
    await w.clock.settle()
    expect(w.draft).toBe('')
    expect(w.submits).toHaveLength(1)
  })

  test('compact, then send leaves a different draft in the input box', async ($, on) => {
    const w = world(on, { answers: ['Compact, then send'], contextTokens: 520_000 })
    await start($, w, true)
    await $.prompt.submit(typed('next step'))
    w.draft = 'next step, and add tests'
    await w.clock.settle()
    expect(w.draft).toBe('next step, and add tests')
  })

  test('a compaction a hook vetoes puts the prompt back instead of sending it at full size', async ($, on) => {
    const w = world(on, { answers: ['Compact, then send'], contextTokens: 520_000, compactResult: () => ({ skip: 'a PreCompact hook blocked it' }) })
    await start($, w, true)
    await $.prompt.submit(typed('next step'))
    await w.clock.settle()
    expect(w.submits).toEqual([])
    expect(w.fills).toEqual(['next step'])
    expect(w.logs).toContainEqual('agent-usage-guard could not compact (a PreCompact hook blocked it), so your prompt is back in the input box.')
  })

  test('a compaction that fails puts the prompt back too', async ($, on) => {
    const w = world(on, {
      answers: ['Compact, then send'],
      contextTokens: 520_000,
      compactResult: () => {
        throw new Error('the summary request failed')
      },
    })
    await start($, w, true)
    await $.prompt.submit(typed('next step'))
    await w.clock.settle()
    expect(w.submits).toEqual([])
    expect(w.fills).toEqual(['next step'])
  })

  test('cancel puts the prompt back in the input box', async ($, on) => {
    const w = world(on, { answers: ['Cancel'], contextTokens: 520_000 })
    await start($, w, true)
    const result = (await $.prompt.submit(typed('next step'))) as Record<string, unknown>
    expect(result.drop).toBe('agent-usage-guard: cancelled; your prompt is back in the input box.')
    expect(w.fills).toEqual(['next step'])
  })

  test('dismissing the question also cancels', async ($, on) => {
    const w = world(on, { answers: [undefined], contextTokens: 520_000 })
    await start($, w, true)
    expect(String(((await $.prompt.submit(typed('x'))) as Record<string, unknown>).drop)).toMatch(/cancelled/)
  })

  test('a headless prompt at 520k is held with a reason', async ($, on) => {
    const w = world(on, { contextTokens: 520_000 })
    await start($, w, false)
    const result = (await $.prompt.submit(headless('go'))) as Record<string, unknown>
    expect(result.drop).toBe(
      'agent-usage-guard: this session holds 520k context tokens (limit 500k), and sending re-reads all of them. Compact the session first, or raise AGENT_GUARD_CONTEXT_HARD.',
    )
  })

  test('a background task\'s notification is never held', async ($, on) => {
    const w = world(on, { contextTokens: 520_000 })
    await start($, w, true)
    const note = { text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' }, wait: false } as never
    expect(await $.prompt.submit(note)).toMatchObject({ text: '<task-notification>done</task-notification>' })
    expect(w.questions).toEqual([])
  })
})

describe('dormant resume', () => {
  test('a heavy session resumed two hours after it was last active asks before re-writing its cache', async ($, on) => {
    const w = world(on, { answers: ['Send anyway'], contextTokens: 200_000 })
    await start($, w, true)
    await respond($, w, 200_000)
    await $.session.end({ reason: 'exit' } as never)
    await w.clock.advance(2 * HOUR)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl' } as never)
    expect(await $.prompt.submit(typed('continue'))).toEqual({ text: 'continue' })
    expect(w.questions[0]).toBe('This session was idle for 2 h, so its prompt cache has likely expired and this request re-writes about 200k tokens. Send this prompt?')
  })

  test('a light session, or one with no recorded response, is not asked', async ($, on) => {
    const w = world(on, { contextTokens: 100_000, store: { [`last-active:${SESSION_ID}`]: T0 - 2 * HOUR } })
    await start($, w, true)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl' } as never)
    expect(await $.prompt.submit(typed('continue'))).toEqual({ text: 'continue' })
    w.store.delete(`last-active:${SESSION_ID}`)
    w.setContext(200_000)
    expect(await $.prompt.submit(typed('continue'))).toEqual({ text: 'continue' })
    expect(w.questions).toEqual([])
  })

  test('headless: one heavy dormant resume per window on the machine', async ($, on) => {
    const peer = { v: 2, at: T0 - 60_000, running: 0, starts: [], agentTokens: [], dormantResumes: [T0 - 60_000] }
    const w = world(on, { contextTokens: 200_000, store: { 'peer:other': peer, [`last-active:${SESSION_ID}`]: T0 - 2 * HOUR } })
    await start($, w, false)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl' } as never)
    const result = (await $.prompt.submit(headless('continue'))) as Record<string, unknown>
    expect(String(result.drop)).toMatch(/1 heavy idle session already resumed on this machine in the last 10 min \(limit 1\)/)
  })
})

describe('context warning', () => {
  test('Claude is told once when the context passes 300k', async ($, on) => {
    const w = world(on, { contextTokens: 310_000 })
    await start($, w, true)
    const first = (await $.prompt.submit(typed('a'))) as Record<string, unknown>
    expect(first.context).toEqual([
      "agent-usage-guard: this session's context is 310k tokens. Keep this turn bounded, and recommend /compact to the user at the next natural break.",
    ])
    const second = (await $.prompt.submit(typed('b'))) as Record<string, unknown>
    expect(second.context).toBeUndefined()
  })

  test("a background task's notification leaves the warning for the next prompt the user types", async ($, on) => {
    const w = world(on, { contextTokens: 310_000 })
    await start($, w, true)
    const note = { text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' }, wait: false } as never
    expect(await $.prompt.submit(note)).toEqual({ text: '<task-notification>done</task-notification>' })
    const next = (await $.prompt.submit(typed('next'))) as Record<string, unknown>
    expect(next.context).toEqual([expect.stringMatching(/^agent-usage-guard: this session's context is 310k tokens\./)])
  })

  test('nothing is added below the threshold', async ($, on) => {
    const w = world(on, { contextTokens: 120_000 })
    await start($, w, true)
    expect(await $.prompt.submit(typed('a'))).toEqual({ text: 'a' })
  })
})

describe('switches', () => {
  test('AGENT_GUARD=0 turns every gate off', async ($, on) => {
    const w = world(on, { contextTokens: 900_000, env: { AGENT_GUARD: '0' } })
    await start($, w, false)
    expect(await $.prompt.submit(headless('go'))).toEqual({ text: 'go' })
    const status = await $.command.run({ command: 'agent-guard', args: '' } as never)
    expect(status.text).toBe('Off: AGENT_GUARD is set to turn it off.')
  })

  test('a malformed threshold keeps its default and shows up in the status', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_AGENT_MAX: 'lots' } })
    await start($, w, false)
    const status = await $.command.run({ command: 'agent-guard', args: 'status' } as never)
    expect(status.text).toMatch(/Config: AGENT_GUARD_AGENT_MAX=lots is not a number from 1 to 1000; using 4\./)
    expect(status.text).toMatch(/\(limit 4\)/)
  })

  test('every threshold variable is read', async ($, on) => {
    const w = world(on, { env: Object.fromEntries(SPECS.map((spec) => [spec.env, 'lots'])) })
    await start($, w, false)
    const status = await $.command.run({ command: 'agent-guard', args: 'status' } as never)
    for (const spec of SPECS) expect(status.text).toContain(`Config: ${spec.env}=lots is not a number`)
  })
})
