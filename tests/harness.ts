// Stubs for everything the mod asks Claude Code for, so each test drives the
// real hooks module with no session, model, network or disk.

import type { On } from 'claude-code'
import { type Engine, type MockClock, mock } from 'claude-code/testing'

export const T0 = Date.UTC(2027, 0, 15, 12, 0, 0)
export const SESSION_ID = 'sess-0001-aaaa'

type ToolEvent = Readonly<Record<string, unknown>> & { tool: string }

export type WorldOptions = {
  now?: number
  env?: Record<string, string>
  store?: Record<string, unknown>
  /** Answers for questions, in order; `undefined` dismisses the dialog. */
  answers?: Array<string | undefined>
  /** The session has no AskUserQuestion tool, as with `--tools Agent,Read`. */
  noQuestionTool?: boolean
  /** Claude Code's answer to a tool call the test fires. */
  toolResult?: (e: ToolEvent) => Record<string, unknown>
  /** What `$.session.usage()` reports for the main context. */
  contextTokens?: number
  transcriptMtime?: number
}

export type World = {
  clock: MockClock
  store: Map<string, unknown>
  questions: string[]
  options: string[][]
  logs: string[]
  statuses: Array<string | undefined>
  fills: string[]
  submits: Array<Record<string, unknown>>
  compactions: number
  ran: string[]
  setContext(tokens: number | undefined): void
  /** The usage the next model request reports. */
  nextUsage: Record<string, number> | undefined
}

export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: options.now ?? T0 })
  mock.env(on, options.env ?? {})
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const answers = [...(options.answers ?? [])]
  let contextTokens = options.contextTokens
  const w: World = {
    clock,
    store,
    questions: [],
    options: [],
    logs: [],
    statuses: [],
    fills: [],
    submits: [],
    compactions: 0,
    ran: [],
    setContext(tokens) {
      contextTokens = tokens
    },
    nextUsage: undefined,
  }

  on('store.get', ($, e) => ({ value: structuredClone(store.get(e.key)) }))
  on('store.set', ($, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 1_000_000, ...(contextTokens === undefined ? {} : { tokens: contextTokens }) }, rateLimits: [] },
  }))
  on('session.compact', () => {
    w.compactions += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 0, tokensAfter: 0 } as never
  })
  on('fs.stat', () =>
    options.transcriptMtime === undefined
      ? { deny: 'no such file' }
      : { value: { kind: 'file', size: 1, mtimeMs: options.transcriptMtime, isLink: false } },
  )
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true } as never
  })
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind === 'plugin') w.submits.push(e as Record<string, unknown>)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId: SESSION_ID }))
  for (const name of ['SessionStart', 'PostCompact', 'Stop', 'UserPromptSubmit', 'PostToolUse', 'SubagentStart', 'StopFailure'] as const) {
    on(`classic.${name}`, () => ({}))
  }
  on('turn.step', async function* ($, e) {
    const usage = w.nextUsage ? { ...w.nextUsage, model: 'claude-test' } : null
    w.nextUsage = undefined
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-test', agentId: `agent-${w.ran.filter((r) => r === 'spawn').length}` }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      if (options.noQuestionTool) return { deny: 'no tool named "AskUserQuestion" in this session' }
      const questions = e.questions as Array<{ question: string; options: Array<{ label: string }> }>
      const question = questions[0]!
      w.questions.push(question.question)
      w.options.push(question.options.map((o) => o.label))
      const answer = answers.shift()
      if (answer === undefined) return { deny: 'The user dismissed the question.' }
      return { result: { answers: { [question.question]: answer } } }
    }
    w.ran.push(e.tool)
    return (options.toolResult?.(e as ToolEvent) ?? { result: 'ok' }) as never
  })
  return w
}

/** Starts the session the way Claude Code does, then runs the housekeeping timer. */
export async function start($: Engine, w: World, interactive: boolean): Promise<void> {
  await $.session.start({ surface: interactive ? 'terminal' : null, isInteractive: interactive, cwd: '/work' })
  await w.clock.settle()
}

/** Fires one agent spawn from the main loop, or from `parent`. */
export async function spawn($: Engine, w: World, parent?: string): Promise<Record<string, unknown>> {
  w.ran.push('spawn')
  return (await $.agent.spawn({
    prompt: 'work',
    description: 'test agent',
    subagentType: 'general-purpose',
    ...(parent ? { parentAgentId: parent } : {}),
  } as never)) as Record<string, unknown>
}

/** Reports one finished model request whose input side is `context` tokens, in the main loop or `agentId`'s. */
export async function respond($: Engine, w: World, context: number, agentId?: string): Promise<void> {
  w.nextUsage = usageOf(context)
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}

export function usageOf(context: number): Record<string, number> {
  return { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: context - 10, cache_creation_input_tokens: 0 }
}

export function journalRows(w: World): Array<Record<string, unknown>> {
  return [...w.store.entries()].filter(([k]) => k.startsWith('journal:')).flatMap(([, v]) => v as Array<Record<string, unknown>>)
}
