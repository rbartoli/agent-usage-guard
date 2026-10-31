import { type Engine, describe, expect, test } from 'claude-code/testing'

import { SESSION_ID, T0, spawn, start, world } from './harness.ts'

/** The band above the prompt, as the terminal or desktop asks for it. */
async function band($: Engine, surface: 'terminal' | 'desktop'): Promise<string | undefined> {
  const ui = await $.ui.mount({
    plugin: 'agent-usage-guard',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  } as never)
  const text = (await ui.find({ type: 'Text', text: /^Usage guard/ } as never))?.text
  await ui.unmount()
  return text
}

describe('band', () => {
  test('nothing shows while the guard has nothing to say', async ($, on) => {
    const w = world(on)
    await start($, w, true)
    for (const surface of ['terminal', 'desktop'] as const) expect(await band($, surface)).toBeUndefined()
  })

  test('agents running and started, on this machine, show against their limits', async ($, on) => {
    const peer = { v: 2, at: T0, running: 1, starts: [T0 - 60_000], agentTokens: [], dormantResumes: [] }
    const w = world(on, { store: { 'peer:other-session': peer } })
    await start($, w, true)
    await spawn($, w)
    await spawn($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await band($, surface)).toBe('Usage guard · 3 of 4 agents running · 3 of 12 started in the last 10 min')
    }
  })

  test('an open question shows while it is asked, and a decline and the refusal show after it', async ($, on) => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = world(on, { answers: ["Don't start it"], questionHeld: () => held })
    await start($, w, true)
    for (let i = 0; i < 4; i++) await spawn($, w)
    const asking = spawn($, w)
    await w.clock.settle()
    expect(await band($, 'terminal')).toMatch(/· asking you about starting agents$/)
    release()
    await asking
    expect(await band($, 'terminal')).toMatch(/^Usage guard · 4 of 4 agents running · 4 of 12 started in the last 10 min · new agents declined until \d\d:\d\d · last refusal \d\d:\d\d: concurrency$/)
  })

  test('it clears on its own once what it shows has aged out, in a quiet session', async ($, on) => {
    const w = world(on)
    await start($, w, true)
    const agent = await spawn($, w)
    await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', agentId: String(agent.agentId) } as never)
    expect(await band($, 'terminal')).toBe('Usage guard · 0 of 4 agents running · 1 of 12 started in the last 10 min')
    await w.clock.advance(10 * 60_000)
    expect(await band($, 'terminal')).toBeUndefined()
    expect(w.store.has(`peer:${SESSION_ID}`)).toBe(true)
  })

  test('headless sessions draw no band', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await spawn($, w)
    expect(await band($, 'desktop')).toBeUndefined()
  })
})
