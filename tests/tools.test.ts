import { describe, expect, test } from 'claude-code/testing'

import { journalRows, respond, spawn, start, world } from './harness.ts'

const bash = (command: string) => ({ tool: 'Bash', command }) as never

describe('retry fuse', () => {
  test('the fourth identical failing call is refused; a different call still runs', async ($, on) => {
    const w = world(on, { toolResult: (e) => (e.command === 'npm test' ? { result: 'failed', isError: true } : { result: 'ok' }) })
    await start($, w, false)
    for (let i = 0; i < 3; i++) expect((await $.tool.call(bash('npm test'))).isError).toBe(true)
    const fourth = (await $.tool.call(bash('npm test'))) as Record<string, unknown>
    expect(String(fourth.deny)).toMatch(/This exact Bash call failed 3 times in a row/)
    expect(await $.tool.call(bash('npm run lint'))).toEqual({ result: 'ok' })
    expect(w.ran.filter((t) => t === 'Bash')).toHaveLength(4)
  })

  test('a success in between resets the count', async ($, on) => {
    let fail = true
    const w = world(on, { toolResult: () => (fail ? { result: 'failed', isError: true } : { result: 'ok' }) })
    await start($, w, false)
    await $.tool.call(bash('make'))
    await $.tool.call(bash('make'))
    fail = false
    await $.tool.call(bash('make'))
    fail = true
    await $.tool.call(bash('make'))
    await $.tool.call(bash('make'))
    expect((await $.tool.call(bash('make'))).isError).toBe(true)
  })

  test('a call the user refused at the permission prompt is not a failure', async ($, on) => {
    const w = world(on, { toolResult: () => ({ deny: 'The user refused this call.' }) })
    await start($, w, false)
    for (let i = 0; i < 4; i++) await $.tool.call(bash('rm -rf build'))
    expect(w.ran.filter((t) => t === 'Bash')).toHaveLength(4)
  })
})

describe('heavy-context tool budget', () => {
  test('past 20 calls at 450k the user is asked once; keep going lasts until the context shrinks', async ($, on) => {
    const w = world(on, { answers: ['Keep going'] })
    await start($, w, true)
    await respond($, w, 450_000)
    for (let i = 0; i < 20; i++) await $.tool.call(bash(`echo ${i}`))
    expect(w.questions).toEqual([])
    expect(await $.tool.call(bash('echo 20'))).toEqual({ result: 'ok' })
    expect(w.questions).toHaveLength(1)
    expect(w.questions[0]).toMatch(/^This conversation made 20 tool calls in the last 10 min above 400k context tokens, and each one re-reads the 450k\. Keep working at 450k context\?$/)
    expect(w.options[0]).toEqual(['Keep going', 'Compact after this turn', 'Stop this turn'])
    for (let i = 0; i < 30; i++) await $.tool.call(bash(`echo more ${i}`))
    expect(w.questions).toHaveLength(1)
  })

  test('stop this turn refuses the turn\'s remaining calls, and the next turn starts clean', async ($, on) => {
    const w = world(on, { answers: ['Stop this turn'], env: { AGENT_GUARD_TOOL_MAX: '2' } })
    await start($, w, true)
    await respond($, w, 450_000)
    await $.tool.call(bash('a'))
    await $.tool.call(bash('b'))
    const stopped = (await $.tool.call(bash('c'))) as Record<string, unknown>
    expect(String(stopped.deny)).toMatch(/The user stopped this turn at 450k context tokens\. End the turn now and recommend \/compact/)
    const next = (await $.tool.call(bash('d'))) as Record<string, unknown>
    expect(String(next.deny)).toMatch(/The user stopped this turn/)
    await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await respond($, w, 120_000)
    expect(await $.tool.call(bash('e'))).toEqual({ result: 'ok' })
  })

  test('compact after this turn lets the turn finish, then compacts', async ($, on) => {
    const w = world(on, { answers: ['Compact after this turn'], env: { AGENT_GUARD_TOOL_MAX: '1' } })
    await start($, w, true)
    await respond($, w, 450_000)
    await $.tool.call(bash('a'))
    expect(await $.tool.call(bash('b'))).toEqual({ result: 'ok' })
    expect(w.compactions).toBe(0)
    await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await w.clock.settle()
    expect(w.compactions).toBe(1)
  })

  test('a subagent is judged on its own context, not the main conversation\'s', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_TOOL_MAX: '2' } })
    await start($, w, false)
    await respond($, w, 450_000)
    const agent = String((await spawn($, w)).agentId)
    await respond($, w, 30_000, agent)
    for (let i = 0; i < 10; i++) {
      expect(await $.tool.call({ tool: 'Read', file_path: `/f${i}`, agentId: agent } as never)).toEqual({ result: 'ok' })
    }
  })

  test('a subagent\'s report and stop calls are never held', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_TOOL_MAX: '1' } })
    await start($, w, false)
    const agent = String((await spawn($, w)).agentId)
    await respond($, w, 450_000, agent)
    await $.tool.call({ tool: 'Read', file_path: '/a', agentId: agent } as never)
    expect(String(((await $.tool.call({ tool: 'Read', file_path: '/b', agentId: agent } as never)) as Record<string, unknown>).deny)).toMatch(
      /Nobody can approve more in this session\. Finish with what you have and report back/,
    )
    expect(await $.tool.call({ tool: 'SubagentHandback', message: 'report', agentId: agent } as never)).toEqual({ result: 'ok' })
    expect(await $.tool.call({ tool: 'TaskStop', task_id: 'x', agentId: agent } as never)).toEqual({ result: 'ok' })
  })

  test('a headless session refuses past the budget and journals the context bucket, not the figure', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_TOOL_MAX: '1' } })
    await start($, w, false)
    await respond($, w, 450_000)
    await $.tool.call(bash('a'))
    const refused = (await $.tool.call(bash('b'))) as Record<string, unknown>
    expect(String(refused.deny)).toMatch(/End the turn; the session needs \/compact/)
    expect(journalRows(w).find((r) => r.ev === 'deny')).toMatchObject({ rule: 'tool-budget', tool: 'Bash', ctx: '400-500k' })
    expect(JSON.stringify(journalRows(w))).not.toMatch(/echo|"b"/)
  })

  test('compaction clears the budget', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_TOOL_MAX: '1' } })
    await start($, w, false)
    await respond($, w, 450_000)
    await $.tool.call(bash('a'))
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: '' } as never)
    expect(await $.tool.call(bash('b'))).toEqual({ result: 'ok' })
  })
})

describe('a Stop hook that reopens the turn', () => {
  test('the second refusal hands the decision to the user instead of saying end the turn', async ($, on) => {
    const w = world(on, { toolResult: () => ({ result: 'failed', isError: true }) })
    await start($, w, false)
    for (let i = 0; i < 3; i++) await $.tool.call(bash('flaky'))
    await $.classic.Stop({ stop_hook_active: false } as never)
    await respond($, w, 10_000)
    await $.tool.call(bash('flaky'))
    const second = (await $.tool.call(bash('flaky'))) as Record<string, unknown>
    expect(String(second.deny)).toMatch(/A Stop hook reopened this turn, so ending the turn will not clear this\. Tell the user/)
  })
})
