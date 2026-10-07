import { type Engine, describe, expect, test } from 'claude-code/testing'

import { SESSION_ID, T0, journalRows, respond, spawn, start, world } from './harness.ts'

const MINUTE = 60_000

describe('agent gate', () => {
  test('a headless session refuses the agent past the concurrency limit and tells the model to wait', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    for (let i = 0; i < 4; i++) expect((await spawn($, w)).agentId).toBeDefined()
    const fifth = await spawn($, w)
    expect(String(fifth.deny)).toMatch(/4 agents are running on this machine \(limit 4\)/)
    expect(String(fifth.deny)).toMatch(/Nobody can approve it in this session\. Wait for a running agent to finish/)
    expect(w.questions).toEqual([])
    expect(journalRows(w).some((r) => r.ev === 'deny' && r.rule === 'concurrency')).toBe(true)
  })

  test('a finished agent frees its slot', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    for (let i = 0; i < 4; i++) await spawn($, w)
    await $.turn.complete({ turnId: 'x', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'agent-1' } as never)
    expect((await spawn($, w)).agentId).toBeDefined()
  })

  test('approving the question lifts the limit for the window, so the next agent does not ask again', async ($, on) => {
    const w = world(on, { answers: ['Allow'] })
    await start($, w, true)
    for (let i = 0; i < 4; i++) await spawn($, w)
    expect((await spawn($, w)).agentId).toBeDefined()
    expect(w.questions).toHaveLength(1)
    expect(w.questions[0]).toMatch(/^4 agents are running on this machine \(limit 4\)\. Allowing lifts this limit until \d\d:\d\d\. Start this agent\?$/)
    expect(w.options[0]).toEqual(['Allow', "Don't start it"])
    expect((await spawn($, w)).agentId).toBeDefined()
    expect(w.questions).toHaveLength(1)
    const answers = journalRows(w).filter((r) => r.ev === 'answer')
    expect(answers).toEqual([expect.objectContaining({ rule: 'concurrency', answer: 'allow' })])
  })

  test('declining refuses this agent and the next without asking twice, and the wording escalates', async ($, on) => {
    const w = world(on, { answers: ["Don't start it"] })
    await start($, w, true)
    for (let i = 0; i < 4; i++) await spawn($, w)
    const refused = await spawn($, w)
    expect(String(refused.deny)).toMatch(/The user chose not to start it/)
    expect(String(refused.deny)).toMatch(/refusal 1 at/)
    const again = await spawn($, w)
    expect(String(again.deny)).toMatch(/The user declined new agents for now/)
    expect(String(again.deny)).toMatch(/has not changed since/)
    const third = await spawn($, w)
    expect(String(third.deny)).toMatch(/End the turn and tell the user what is blocked/)
    expect(w.questions).toHaveLength(1)
  })

  test('typed words in place of an answer reach the model', async ($, on) => {
    const w = world(on, { answers: ['use haiku agents instead'] })
    await start($, w, true)
    for (let i = 0; i < 4; i++) await spawn($, w)
    const refused = await spawn($, w)
    expect(String(refused.deny)).toMatch(/The user answered "use haiku agents instead"/)
  })

  test('agents started in parallel while a question is open share one question', async ($, on) => {
    const w = world(on, { answers: ['Allow'] })
    await start($, w, true)
    for (let i = 0; i < 4; i++) await spawn($, w)
    const results = await Promise.all([spawn($, w), spawn($, w), spawn($, w)])
    expect(results.every((r) => r.agentId !== undefined)).toBe(true)
    expect(w.questions).toHaveLength(1)
  })

  test('five agents started in one parallel batch let exactly four through', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    const results = await Promise.all([spawn($, w), spawn($, w), spawn($, w), spawn($, w), spawn($, w)])
    expect(results.filter((r) => r.agentId !== undefined)).toHaveLength(4)
    expect(results.filter((r) => r.deny !== undefined)).toHaveLength(1)
  })

  test('a subagent cannot start agents of its own', async ($, on) => {
    const w = world(on)
    await start($, w, true)
    const first = await spawn($, w)
    const nested = await spawn($, w, String(first.agentId))
    expect(String(nested.deny)).toMatch(/subagents may not start agents of their own here \(depth limit 1\)/)
    expect(w.questions).toEqual([])
  })

  test('AGENT_GUARD_DEPTH_MAX=2 allows one level of nesting', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_DEPTH_MAX: '2' } })
    await start($, w, true)
    const first = await spawn($, w)
    expect((await spawn($, w, String(first.agentId))).agentId).toBeDefined()
  })

  test('the 13th start in ten minutes trips the rolling budget, counting starts that have finished', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    for (let i = 1; i <= 12; i++) {
      await spawn($, w)
      await $.turn.complete({ turnId: 'x', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: `agent-${i}` } as never)
    }
    const thirteenth = await spawn($, w)
    expect(String(thirteenth.deny)).toMatch(/12 agents started on this machine in the last 10 min \(limit 12\)/)
    await w.clock.advance(10 * MINUTE)
    expect((await spawn($, w)).agentId).toBeDefined()
  })

  test('agents running in other sessions count against the limit; a stale record does not', async ($, on) => {
    const peer = (at: number) => ({ v: 1, at, running: 4, starts: [], agentTokens: 0, dormantResumes: [] })
    const w = world(on, { store: { 'peer:other-session': peer(T0 - MINUTE), 'peer:gone-session': peer(T0 - 60 * MINUTE) } })
    await start($, w, false)
    const refused = await spawn($, w)
    expect(String(refused.deny)).toMatch(/4 agents are running on this machine/)
    w.store.delete('peer:other-session')
    expect((await spawn($, w)).agentId).toBeDefined()
  })

  test('the session publishes its own counts and clears them when it ends', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await spawn($, w)
    expect(w.store.get(`peer:${SESSION_ID}`)).toMatchObject({ v: 1, running: 1, starts: [T0] })
    await $.session.end({ reason: 'other' } as never)
    expect(w.store.has(`peer:${SESSION_ID}`)).toBe(false)
  })

  test('subagent tokens past the window budget make the next agent ask', async ($, on) => {
    const w = world(on, { answers: ["Don't start it"], env: { AGENT_GUARD_AGENT_TOKENS_MAX: '1000000' } })
    await start($, w, true)
    const agent = await spawn($, w)
    await respond($, w, 600_000, String(agent.agentId))
    await respond($, w, 600_000, String(agent.agentId))
    await spawn($, w)
    expect(w.questions[0]).toMatch(/subagents processed 1\.2M tokens in the last 10 min \(limit 1M\)/i)
  })
})

describe('plan-window gate', () => {
  const measure = (percent: number, resetsAt = '2027-01-15T15:00:00.000Z', kind = 'five_hour') => ({
    context: { window: 1_000_000 },
    rateLimits: [{ kind, percentUsed: percent, resetsAt }],
    changed: ['rateLimits'],
  })

  test('from 95% of the 5-hour window new agents are refused outright', async ($, on) => {
    const w = world(on, { answers: ['Allow'] })
    await start($, w, true)
    await $.session.measure(measure(96) as never)
    const refused = await spawn($, w)
    expect(String(refused.deny)).toMatch(/the 5-hour window is 96% used \(resets \d\d:\d\d\), and the guard keeps the rest of the window for the user/)
    expect(w.questions).toEqual([])
  })

  test('from 80% the user is asked once, and an approval lasts until the window resets', async ($, on) => {
    const w = world(on, { answers: ['Allow'] })
    await start($, w, true)
    await $.session.measure(measure(82) as never)
    expect((await spawn($, w)).agentId).toBeDefined()
    expect(w.questions[0]).toMatch(/the 5-hour window is 82% used/i)
    await $.session.measure(measure(90) as never)
    await w.clock.advance(30 * MINUTE)
    await $.turn.complete({ turnId: 'x', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'agent-1' } as never)
    expect((await spawn($, w)).agentId).toBeDefined()
    expect(w.questions).toHaveLength(1)
  })

  test('the weekly window counts too', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await $.session.measure(measure(97, '2027-01-18T12:00:00.000Z', 'seven_day') as never)
    expect(String((await spawn($, w)).deny)).toMatch(/the weekly window is 97% used/)
  })

  test('a window that already reset does not count', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await $.session.measure(measure(99, '2027-01-15T11:00:00.000Z') as never)
    expect((await spawn($, w)).agentId).toBeDefined()
  })

  test('a fast burn makes new agents ask before the window runs out', async ($, on) => {
    const w = world(on, { answers: ["Don't start it"] })
    await start($, w, true)
    await $.session.measure(measure(30) as never)
    await w.clock.advance(5 * MINUTE)
    await $.session.measure(measure(52) as never)
    await spawn($, w)
    expect(w.questions[0]).toMatch(/the 5-hour window rose 22 points in the last 10 min \(now 52%\)/i)
  })

  test('crossing a threshold is journaled once', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await $.session.measure(measure(79) as never)
    await $.session.measure(measure(81) as never)
    await $.session.measure(measure(83) as never)
    const crossings = journalRows(w).filter((r) => r.ev === 'limit')
    expect(crossings).toEqual([expect.objectContaining({ kind: 'five_hour', pct: 81, rule: '80%' })])
  })
})

describe('agent fuse and overrides', () => {
  test('five refused agent calls pause spawns for the fuse period without asking', async ($, on) => {
    const w = world(on)
    await start($, w, true)
    const first = await spawn($, w)
    for (let i = 0; i < 4; i++) await spawn($, w, String(first.agentId))
    const fifth = await spawn($, w, String(first.agentId))
    expect(String(fifth.deny)).toMatch(/agent spawns in this session are paused until \d\d:\d\d/)
    const fromMain = await spawn($, w)
    expect(String(fromMain.deny)).toMatch(/Agent spawns in this session are paused until/)
    expect(w.questions).toEqual([])
    await w.clock.advance(10 * 60_000)
    expect((await spawn($, w)).agentId).toBeDefined()
  })

  test('/usage-guard allow lifts agent limits and the fuse; resume restores them', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    for (let i = 0; i < 4; i++) await spawn($, w)
    const lifted = await $.command.run({ command: 'usage-guard', args: 'allow agents 15' } as never)
    expect(lifted.text).toMatch(/^Agent limits lifted for 15 min, until \d\d:\d\d\./)
    expect((await spawn($, w)).agentId).toBeDefined()
    expect((await $.command.run({ command: 'usage-guard', args: 'resume' } as never)).text).toBe('Limits apply again.')
    expect(String((await spawn($, w)).deny)).toMatch(/agents are running on this machine/)
    expect(journalRows(w).some((r) => r.ev === 'override' && r.rule === 'agents')).toBe(true)
  })

  test('the old bracket marker sent alone lifts the limits without a model turn', async ($, on) => {
    const w = world(on)
    await start($, w, true)
    const result = await $.prompt.submit({ text: '[allow-agent-burst]', origin: { kind: 'composer' }, wait: false } as never)
    expect(result).toEqual({ drop: expect.stringMatching(/^agent-usage-guard: Agent limits lifted for 10 min/) })
  })

  test('a marker inside other text is an ordinary prompt', async ($, on) => {
    const w = world(on)
    await start($, w, true)
    const result = await $.prompt.submit({ text: '[allow-usage-guard] continue', origin: { kind: 'composer' }, wait: false } as never)
    expect(result).toEqual({ text: '[allow-usage-guard] continue' })
  })
})

describe('resumed agents', () => {
  const send = ($: Engine, to: string) =>
    $.tool.call({ tool: 'SendMessage', to, message: 'carry on' } as never) as Promise<Record<string, unknown>>

  test('a plain message to a finished subagent counts as a start and is gated', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_ROLLING_MAX: '2' } })
    await start($, w, false)
    await spawn($, w)
    await $.turn.complete({ turnId: 'x', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'agent-1' } as never)
    expect(await send($, 'agent-1')).toEqual({ result: 'ok' })
    await $.turn.complete({ turnId: 'x', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'agent-1' } as never)
    const third = await send($, 'agent-1')
    expect(String(third.deny)).toMatch(/2 agents started on this machine in the last 10 min \(limit 2\)/)
  })

  test('a message to a running agent or an unknown name is not a start', async ($, on) => {
    const w = world(on, { env: { AGENT_GUARD_ROLLING_MAX: '1' } })
    await start($, w, false)
    await spawn($, w)
    expect(await send($, 'agent-1')).toEqual({ result: 'ok' })
    expect(await send($, 'main')).toEqual({ result: 'ok' })
  })
})
