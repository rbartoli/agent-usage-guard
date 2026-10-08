// The Claude Code adapter. It turns Claude Code's events into the core's facts
// and requests, asks the user when a verdict needs an answer, and keeps the
// cross-session records in $.store. Every decision lives in ../core.

import type { EngineInterface, On } from 'claude-code'

import {
  type Ask,
  type Config,
  HEADER,
  type JournalRow,
  MAIN,
  type PeerRecord,
  type PromptSource,
  type SessionState,
  SIGNATURE,
  type ToolRequest,
  type Verdict,
  DEFAULT_ALLOW_MINUTES,
  agentGate,
  applyOverride,
  canonical,
  contextBucket,
  contextNote,
  defaultConfig,
  expireAgents,
  expiredJournalKeys,
  heldForQuestion,
  fingerprint,
  formatReport,
  helpText,
  isJournalKey,
  isJournalRow,
  journalKey,
  journalKeysSince,
  livePeers,
  lockoutKind,
  markerScope,
  newSession,
  observeAgentActive,
  observeAgentRunEnd,
  observeCompaction,
  observeLimits,
  observeMainContext,
  observeResponse,
  observeSpawn,
  observeToolResult,
  observeTurnEnd,
  parseCommand,
  parseConfig,
  peerRecord,
  promptGate,
  prune,
  releaseStart,
  reserveStart,
  resolveAgentAsk,
  resolveHeavyAsk,
  resolvePromptAsk,
  resumeGuard,
  statusLine,
  statusReport,
  toolGate,
} from '../core/index.ts'

type Api = EngineInterface

const COMMAND = 'agent-guard'
const PEER_PREFIX = 'peer:'
const HEARTBEAT_MS = 60_000
/** Keeps one session's day of journal rows well inside the store's 4 MiB. */
const MAX_ROWS_PER_DAY = 2000
/** All journal days together stay below half the store, oldest dropped first. */
const JOURNAL_BUDGET_BYTES = 2_000_000
/** A peer record nobody refreshed for a day is from a session that is gone. */
const STALE_PEER_MS = 86_400_000
/** Keys of the tool call's envelope, not of the tool's own arguments. */
const ENVELOPE_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

let config: Config = defaultConfig()
let problems: string[] = []
let session: SessionState = newSession('', false)
let interactive = false
/** The session has no AskUserQuestion tool (`--tools` left it out), so nobody can be asked. */
let askUnavailable = false
let permissionMode: string | undefined
let transcriptPath: string | undefined
let peers: PeerRecord[] = []
let lastPublished = 0
let lastStatus: string | undefined
let compactAfterTurn = false
/** A Stop event happened and no prompt has started a new turn since. */
let stopSeen = false
let journalCache: { key: string; rows: JournalRow[] } | undefined
/** One question per family at a time: calls that trip while it is open are held back. */
const pending = new Map<string, Promise<unknown>>()

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    await loadConfig($)
    interactive = e.isInteractive
    await startSession($)
    $.clock.after(0, () => housekeeping($))
    try {
      await $.command.register({
        name: COMMAND,
        description: 'agent-usage-guard: status, allow, resume, report',
        argumentHint: '[status | allow [agents|context] [minutes] | pause [minutes] | resume | report [days] | help]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`agent-usage-guard could not add /${COMMAND}: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => failOpen($, 'session.start', next.error, () => next(e)))

  on('classic.SessionStart', async ($, e, next) => {
    transcriptPath = e.transcript_path
    if (e.source === 'compact') observeCompaction(session)
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') await startSession($)
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.SessionStart', next.error, () => next(e)))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    trackMode(e.permission_mode, e.agent_id)
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.UserPromptSubmit', next.error, () => next(e)))

  on('classic.PostToolUse', async ($, e, next) => {
    trackMode(e.permission_mode, e.agent_id)
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.PostToolUse', next.error, () => next(e)))

  on('classic.PostCompact', async ($, e, next) => {
    observeCompaction(session)
    await refreshStatus($)
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.PostCompact', next.error, () => next(e)))

  on('classic.Stop', async ($, e, next) => {
    trackMode(e.permission_mode, e.agent_id)
    stopSeen = true
    if (e.stop_hook_active) session.reopened = true
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.Stop', next.error, () => next(e)))

  on('classic.SubagentStart', async ($, e, next) => {
    if (session.agents[e.agent_id]) {
      observeAgentActive(session, e.agent_id)
      await publish($, await $.clock.now())
    } else if (e.agent_type && session.pendingStarts === 0) {
      // Started without an agent.spawn the guard could hold, such as a /subtask
      // fork the user ran: counted, never blocked. Claude Code's own internal
      // agents have no type and are left out.
      const now = await $.clock.now()
      observeSpawn(session, now, { agentId: e.agent_id, kind: e.agent_type === 'fork' ? 'fork' : 'subagent', depth: 1 })
      session.starts.push(now)
      await publish($, now)
    }
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.SubagentStart', next.error, () => next(e)))

  on('classic.StopFailure', async ($, e, next) => {
    if (config.enabled) {
      const text = `${e.error_details ?? ''} ${e.last_assistant_message ?? ''}`
      const kind = lockoutKind(e.error, text, Object.values(session.limits))
      if (kind) {
        const reading = session.limits[kind]
        await journal($, await $.clock.now(), { ev: 'lockout', kind, ...(reading ? { pct: reading.percent } : {}) })
      }
    }
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.StopFailure', next.error, () => next(e)))

  on('session.end', async ($, e, next) => {
    try {
      if (session.id) await $.store.delete(PEER_PREFIX + session.id)
    } catch {
      // The record expires on its own once its heartbeat is old.
    }
    return next(e)
  }).catch(($, e, next) => failOpen($, 'session.end', next.error, () => next(e)))

  on('session.measure', async ($, e, next) => {
    if (config.enabled) {
      const now = await $.clock.now()
      if (e.changed.includes('rateLimits')) {
        const readings = e.rateLimits.map((r) => ({
          at: now,
          kind: r.kind,
          percent: r.percentUsed,
          ...(r.resetsAt ? { resetsAt: Date.parse(r.resetsAt) } : {}),
        }))
        for (const { reading, threshold } of observeLimits(session, config, readings)) {
          await journal($, now, { ev: 'limit', kind: reading.kind, pct: reading.percent, rule: `${threshold}%` })
        }
        await publish($, now)
      }
      if (e.context.tokens !== undefined) observeMainContext(session, config, e.context.tokens)
      await refreshStatus($)
    }
    return next(e)
  }).catch(($, e, next) => failOpen($, 'session.measure', next.error, () => next(e)))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // A streaming hook fails open by hand: recording a response must never fail the request.
    try {
      if (config.enabled && result.usage) {
        const now = await $.clock.now()
        const loop = e.agentId ?? MAIN
        if (loop === MAIN && stopSeen) session.reopened = true
        observeResponse(session, config, now, loop, {
          input: result.usage.input_tokens,
          output: result.usage.output_tokens,
          cacheRead: result.usage.cache_read_input_tokens,
          cacheWrite: result.usage.cache_creation_input_tokens,
        })
        if (now - lastPublished >= HEARTBEAT_MS) await publish($, now)
      }
    } catch (error) {
      $.ui.log(`agent-usage-guard: could not record a response (${String(error)})`, { to: 'debug' })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!config.enabled) return result
    const now = await $.clock.now()
    if (e.agentId) {
      observeAgentRunEnd(session, e.agentId)
      await publish($, now)
      return result
    }
    observeTurnEnd(session)
    if (compactAfterTurn) {
      compactAfterTurn = false
      $.clock.after(0, async () => {
        try {
          await $.session.compact()
        } catch (error) {
          $.ui.log(`agent-usage-guard could not compact: ${String(error)}`)
        }
      })
    }
    await refreshStatus($)
    return result
  }).catch(($, e, next) => failOpen($, 'turn.complete', next.error, () => next(e)))

  on('prompt.submit', async ($, e, next) => {
    if (!config.enabled) return next(e)
    const now = await $.clock.now()
    const source = sourceOf(e.origin.kind)

    const scope = source === 'other' ? undefined : markerScope(e.text)
    if (scope) {
      const text = applyOverride(session, now, scope, DEFAULT_ALLOW_MINUTES)
      await journal($, now, { ev: 'override', rule: scope })
      await refreshStatus($)
      return { drop: `${SIGNATURE}: ${text}` }
    }

    await readMainContext($)
    const context = session.loops[MAIN]?.context
    if (context !== undefined && context >= Math.min(config.dormantContext, config.contextHard)) {
      await loadPeers($, now)
    }
    const verdict = promptGate(session, peers, config, now, { source, text: e.text, idleMs: await idleTime($, now) })
    if (session.dormantResumes.at(-1) === now) await publish($, now)
    stopSeen = false
    session.reopened = false

    if (verdict.kind === 'allow') {
      return verdict.note ? next({ ...e, context: [...(e.context ?? []), verdict.note] }) : next(e)
    }
    if (verdict.kind === 'drop') {
      await journal($, now, { ev: 'drop', rule: verdict.rule, ctx: contextBucket(context) })
      return { drop: verdict.message }
    }
    if (verdict.kind !== 'ask') return next(e)

    await journal($, now, { ev: 'ask', rule: verdict.trips[0]?.rule, ctx: contextBucket(context) })
    const { answer, unavailable } = await askUser($, verdict)
    const answered = await $.clock.now()
    if (unavailable) {
      await journal($, answered, { ev: 'answer', rule: verdict.trips[0]?.rule, answer: 'unavailable' })
      const alone = promptGate(session, peers, config, answered, { source, text: e.text, idleMs: await idleTime($, answered) })
      if (alone.kind === 'drop') return { drop: alone.message }
      return alone.kind === 'allow' && alone.note ? next({ ...e, context: [...(e.context ?? []), alone.note] }) : next(e)
    }
    const outcome = resolvePromptAsk(session, verdict, answer)
    await journal($, answered, { ev: 'answer', rule: verdict.trips[0]?.rule, answer: answerKind(outcome.kind, answer) })
    if (outcome.kind === 'allow') {
      const note = contextNote(session, config)
      return note ? next({ ...e, context: [...(e.context ?? []), note] }) : next(e)
    }
    if (outcome.kind === 'compact-then-send') {
      const resend = { text: e.text, ...(e.attachments ? { attachments: e.attachments } : {}) }
      $.clock.after(0, async () => {
        try {
          await $.session.compact()
        } catch (error) {
          $.ui.log(`agent-usage-guard could not compact: ${String(error)}`)
        }
        try {
          await $.prompt.submit({ ...resend, asUser: true })
        } catch (error) {
          $.ui.log(`agent-usage-guard could not resend your prompt: ${String(error)}`)
          await $.prompt.fill({ text: resend.text }).catch(() => undefined)
        }
      })
      return { drop: outcome.message }
    }
    await $.prompt.fill({ text: e.text }).catch(() => undefined)
    return { drop: outcome.kind === 'drop' ? outcome.message : 'agent-usage-guard: held this prompt.' }
  }).catch(($, e, next) => failOpen($, 'prompt.submit', next.error, () => next(e)))

  on('agent.spawn', async ($, e, next) => {
    if (!config.enabled) return next(e)
    trackMode(e.permissionMode, e.parentAgentId)
    const now = await $.clock.now()
    const loop = e.parentAgentId ?? MAIN
    const parentDepth = e.parentAgentId ? (session.agents[e.parentAgentId]?.depth ?? 1) : 0
    const request = { loop, depth: parentDepth + 1, resume: false }
    const { verdict, reservedAt } = await agentVerdict($, now, request)
    if (verdict.kind === 'deny') {
      await journal($, await $.clock.now(), { ev: 'deny', rule: verdict.rule, tool: 'Agent', n: refusalNumber(verdict.message) })
      return { deny: verdict.message }
    }
    let started = false
    try {
      const result = await next(e)
      started = !result.deny && Boolean(result.agentId)
      if (started && result.agentId) {
        const kind = e.isTeammate ? 'teammate' : e.workflow ? 'workflow' : e.fork ? 'fork' : 'subagent'
        observeSpawn(session, await $.clock.now(), { agentId: result.agentId, kind, depth: request.depth, ...(e.name ? { name: e.name } : {}) })
      }
      return result
    } finally {
      if (reservedAt !== undefined) releaseStart(session, reservedAt, started)
      await publish($, await $.clock.now())
    }
  }).catch(($, e, next) =>
    // An overrun before the agent started leaves it unjudged; starting it anyway
    // would let a stuck guard wave through every agent of a parallel batch.
    next.error?.kind === 'timeout' && !next.called
      ? { deny: `agent-usage-guard could not judge this agent in time. Start it again. [${SIGNATURE}]` }
      : failOpen($, 'agent.spawn', next.error, () => next(e)),
  )

  on('tool.call', async ($, e, next) => {
    if (!config.enabled) return next(e)
    const now = await $.clock.now()
    const loop = e.agentId ?? MAIN

    let resumed: { id: string; reservedAt: number | undefined } | undefined
    if (e.tool === 'SendMessage') {
      const target = resumeTarget(e.to, e.message)
      if (target) {
        const { verdict, reservedAt } = await agentVerdict($, now, { loop, depth: session.agents[target]!.depth, resume: true })
        if (verdict.kind === 'deny') {
          await journal($, await $.clock.now(), { ev: 'deny', rule: verdict.rule, tool: 'SendMessage', n: refusalNumber(verdict.message) })
          return { deny: verdict.message }
        }
        resumed = { id: target, reservedAt }
      }
    }

    const print = fingerprint(canonical(argumentsOf(e)))
    if (!resumed) {
      const label = loop === MAIN ? 'this conversation' : `agent ${session.agents[loop]?.name ?? loop.slice(0, 8)}`
      const request = { loop, tool: e.tool, fingerprint: print, label }
      let verdict = toolGate(session, config, now, request)
      if (verdict.kind === 'ask') verdict = await settleHeavy($, verdict, request)
      if (verdict.kind === 'deny') {
        await journal($, await $.clock.now(), {
          ev: 'deny',
          rule: verdict.rule,
          tool: e.tool,
          ctx: contextBucket(session.loops[loop]?.context),
          n: refusalNumber(verdict.message),
        })
        return { deny: verdict.message }
      }
    }

    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      result = await next(e)
    } finally {
      if (resumed) {
        const delivered = result !== undefined && !result.deny && !result.isError
        if (resumed.reservedAt !== undefined) releaseStart(session, resumed.reservedAt, delivered)
        if (delivered) observeAgentActive(session, resumed.id)
        await publish($, await $.clock.now())
      }
    }
    observeToolResult(session, await $.clock.now(), loop, print, Boolean(result.isError) && !result.deny)
    return result
  }).catch(($, e, next) => failOpen($, 'tool.call', next.error, () => next(e)))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const now = await $.clock.now()
    const command = parseCommand(e.args)
    if (command.action === 'help') return { text: helpText(command.error) }
    if (command.action === 'report') return { text: await report($, now, command.days) }
    if (command.action === 'allow') {
      const text = applyOverride(session, now, command.scope, command.minutes)
      await journal($, now, { ev: 'override', rule: command.scope })
      await refreshStatus($)
      return { text }
    }
    if (command.action === 'resume') {
      const text = resumeGuard(session)
      await refreshStatus($)
      return { text }
    }
    await loadPeers($, now)
    return { text: statusReport(session, peers, config, now, problems) }
  }).catch(($, e, next) => ({ text: `The command failed: ${next.error?.message ?? 'unknown error'}` }))
}

async function loadConfig($: Api): Promise<void> {
  const parsed = parseConfig({
    AGENT_GUARD: await $.env.get('AGENT_GUARD'),
    AGENT_GUARD_JOURNAL: await $.env.get('AGENT_GUARD_JOURNAL'),
    AGENT_GUARD_WINDOW_SECONDS: await $.env.get('AGENT_GUARD_WINDOW_SECONDS'),
    AGENT_GUARD_AGENT_MAX: await $.env.get('AGENT_GUARD_AGENT_MAX'),
    AGENT_GUARD_ROLLING_MAX: await $.env.get('AGENT_GUARD_ROLLING_MAX'),
    AGENT_GUARD_DEPTH_MAX: await $.env.get('AGENT_GUARD_DEPTH_MAX'),
    AGENT_GUARD_AGENT_TOKENS_MAX: await $.env.get('AGENT_GUARD_AGENT_TOKENS_MAX'),
    AGENT_GUARD_LIMIT_ASK_PERCENT: await $.env.get('AGENT_GUARD_LIMIT_ASK_PERCENT'),
    AGENT_GUARD_LIMIT_DENY_PERCENT: await $.env.get('AGENT_GUARD_LIMIT_DENY_PERCENT'),
    AGENT_GUARD_BURN_PERCENT: await $.env.get('AGENT_GUARD_BURN_PERCENT'),
    AGENT_GUARD_CONTEXT_WARN: await $.env.get('AGENT_GUARD_CONTEXT_WARN'),
    AGENT_GUARD_CONTEXT_HARD: await $.env.get('AGENT_GUARD_CONTEXT_HARD'),
    AGENT_GUARD_TOOL_CONTEXT: await $.env.get('AGENT_GUARD_TOOL_CONTEXT'),
    AGENT_GUARD_TOOL_MAX: await $.env.get('AGENT_GUARD_TOOL_MAX'),
    AGENT_GUARD_DORMANT_SECONDS: await $.env.get('AGENT_GUARD_DORMANT_SECONDS'),
    AGENT_GUARD_DORMANT_CONTEXT: await $.env.get('AGENT_GUARD_DORMANT_CONTEXT'),
    AGENT_GUARD_DORMANT_MAX: await $.env.get('AGENT_GUARD_DORMANT_MAX'),
    AGENT_GUARD_TOOL_FAILURE_MAX: await $.env.get('AGENT_GUARD_TOOL_FAILURE_MAX'),
    AGENT_GUARD_FUSE_MAX: await $.env.get('AGENT_GUARD_FUSE_MAX'),
    AGENT_GUARD_FUSE_SECONDS: await $.env.get('AGENT_GUARD_FUSE_SECONDS'),
    AGENT_GUARD_PEER_TTL_SECONDS: await $.env.get('AGENT_GUARD_PEER_TTL_SECONDS'),
    AGENT_GUARD_JOURNAL_DAYS: await $.env.get('AGENT_GUARD_JOURNAL_DAYS'),
  })
  config = parsed.config
  problems = parsed.problems
  for (const problem of problems) $.ui.log(`agent-usage-guard: ${problem}`, { to: 'debug' })
}

/** Starts fresh state for the session id Claude Code reports now. */
async function startSession($: Api): Promise<void> {
  const previous = session.id
  const id = await $.session.id()
  if (previous && previous !== id) await $.store.delete(PEER_PREFIX + previous).catch(() => undefined)
  session = newSession(id, canAsk())
  journalCache = undefined
  stopSeen = false
  compactAfterTurn = false
}

/** Drops journal days past their retention and records of sessions long gone. */
async function housekeeping($: Api): Promise<void> {
  try {
    const now = await $.clock.now()
    const keys = await $.store.keys()
    const expired = expiredJournalKeys(keys, now, config.journalDays)
    for (const key of expired) await $.store.delete(key)
    const days = keys.filter((k) => isJournalKey(k) && !expired.includes(k)).sort()
    const sizes = await Promise.all(days.map(async (k) => JSON.stringify((await $.store.get(k)) ?? null).length))
    let total = sizes.reduce((sum, n) => sum + n, 0)
    for (let i = 0; total > JOURNAL_BUDGET_BYTES && i < days.length; i++) {
      await $.store.delete(days[i]!)
      total -= sizes[i]!
    }
    for (const key of keys.filter((k) => k.startsWith(PEER_PREFIX))) {
      const record = (await $.store.get(key)) as { at?: unknown } | undefined
      if (typeof record?.at !== 'number' || now - record.at > STALE_PEER_MS) await $.store.delete(key)
    }
  } catch (error) {
    $.ui.log(`agent-usage-guard housekeeping failed: ${String(error)}`, { to: 'debug' })
  }
}

/** A person can answer a question: an interactive session not set to never ask. */
function canAsk(): boolean {
  return interactive && !askUnavailable && permissionMode !== 'dontAsk'
}

/** Follows the main loop's permission mode; a subagent's own mode says nothing about who can answer. */
function trackMode(mode: string | undefined, agentId: string | undefined): void {
  if (!mode || agentId) return
  permissionMode = mode
  session.canAsk = canAsk()
}

function sourceOf(kind: string): PromptSource {
  if (kind === 'composer' || kind === 'bridge') return 'user'
  if (kind === 'sdk') return 'headless'
  return 'other'
}

/** Publishes this session's counts for the other sessions on this machine. */
async function publish($: Api, now: number): Promise<void> {
  if (!session.id) return
  lastPublished = now
  expireAgents(session, now, config.peerTtlMs)
  prune(session, now, config.windowMs)
  try {
    await $.store.set(PEER_PREFIX + session.id, peerRecord(session, now, config.windowMs))
  } catch (error) {
    $.ui.log(`agent-usage-guard could not publish its counts: ${String(error)}`, { to: 'debug' })
  }
}

/** Reads the other sessions' records; a failure leaves the last ones read. */
async function loadPeers($: Api, now: number): Promise<void> {
  try {
    const own = PEER_PREFIX + session.id
    const keys = (await $.store.keys()).filter((k) => k.startsWith(PEER_PREFIX) && k !== own)
    const records = await Promise.all(keys.map((k) => $.store.get(k)))
    peers = livePeers(records, now, config.peerTtlMs)
  } catch (error) {
    $.ui.log(`agent-usage-guard could not read other sessions: ${String(error)}`, { to: 'debug' })
  }
}

/** The main context before a prompt, from Claude Code's own figure. */
async function readMainContext($: Api): Promise<void> {
  try {
    const usage = await $.session.usage()
    if (usage.context.tokens !== undefined) observeMainContext(session, config, usage.context.tokens)
  } catch {
    // Keep the last figure a response reported.
  }
}

/** Time since the last model response, or since the transcript last changed after a resume. */
async function idleTime($: Api, now: number): Promise<number | undefined> {
  const last = session.loops[MAIN]?.lastResponseAt
  if (last !== undefined) return now - last
  if (!transcriptPath) return undefined
  try {
    const stat = await $.fs.stat(transcriptPath)
    return now - stat.mtimeMs
  } catch {
    return undefined
  }
}

async function refreshStatus($: Api): Promise<void> {
  if (!interactive) return
  try {
    const now = await $.clock.now()
    const text = statusLine(session, peers, config, now)
    if (text === lastStatus) return
    lastStatus = text
    $.ui.status(text)
  } catch (error) {
    $.ui.log(`agent-usage-guard could not update its status line: ${String(error)}`, { to: 'debug' })
  }
}

type Asked = { answer: string | undefined; unavailable: boolean }

/**
 * Asks in Claude Code's own question dialog. `answer` is undefined when the
 * user dismissed it. `unavailable` means the question could not be asked at
 * all, because the session has no AskUserQuestion tool: from then on the
 * session counts as one nobody can answer, and the gate decides alone.
 */
async function askUser($: Api, ask: Ask): Promise<Asked> {
  try {
    return { answer: await $.ui.ask(ask.question, { options: ask.options, header: HEADER }), unavailable: false }
  } catch (error) {
    if (!/no tool named "AskUserQuestion"/.test(String(error))) return { answer: undefined, unavailable: false }
    askUnavailable = true
    session.canAsk = false
    return { answer: undefined, unavailable: true }
  }
}

/**
 * The agent gate, with one question at a time: calls that trip while a
 * question is open are held back at once, and the model starts them again
 * once it is answered. Waiting instead could outlast the hook's time limit.
 */
async function agentVerdict(
  $: Api,
  start: number,
  request: { loop: string; depth: number; resume: boolean },
): Promise<{ verdict: Verdict; reservedAt?: number }> {
  const now = start
  await loadPeers($, now)
  expireAgents(session, now, config.peerTtlMs)
  prune(session, now, config.windowMs)
  const verdict = agentGate(session, peers, config, now, request)
  if (verdict.kind === 'allow') return { verdict, reservedAt: reserveStart(session, now) }
  if (verdict.kind !== 'ask') return { verdict }
  // The check for an open question and the claim on it must not straddle an
  // await, or two parallel calls would each ask.
  if (pending.has('agents')) return { verdict: heldForQuestion('agents') }
  const asked = (async (): Promise<{ verdict: Verdict; reservedAt?: number }> => {
    await journal($, now, { ev: 'ask', rule: verdict.trips[0]?.rule })
    const { answer, unavailable } = await askUser($, verdict)
    const answeredAt = await $.clock.now()
    const resolved = unavailable
      ? agentGate(session, peers, config, answeredAt, request)
      : resolveAgentAsk(session, config, answeredAt, verdict, answer)
    const reservedAt = resolved.kind === 'allow' ? reserveStart(session, answeredAt) : undefined
    await journal($, answeredAt, { ev: 'answer', rule: verdict.trips[0]?.rule, answer: unavailable ? 'unavailable' : answer === undefined ? 'dismiss' : resolved.kind === 'allow' ? 'allow' : 'refuse' })
    await refreshStatus($)
    return { verdict: resolved, ...(reservedAt === undefined ? {} : { reservedAt }) }
  })()
  pending.set('agents', asked)
  try {
    return await asked
  } finally {
    pending.delete('agents')
  }
}

/** A heavy-context question, one per loop at a time; calls meanwhile are held back. */
async function settleHeavy($: Api, ask: Ask, request: ToolRequest): Promise<Verdict> {
  const key = `heavy:${ask.loop}`
  if (pending.has(key)) return heldForQuestion('heavy')
  const asked = (async (): Promise<Verdict> => {
    const now = await $.clock.now()
    await journal($, now, { ev: 'ask', rule: 'tool-budget', ctx: contextBucket(session.loops[ask.loop]?.context) })
    const { answer, unavailable } = await askUser($, ask)
    const answeredAt = await $.clock.now()
    if (unavailable) {
      await journal($, answeredAt, { ev: 'answer', rule: 'tool-budget', answer: 'unavailable' })
      return toolGate(session, config, answeredAt, request)
    }
    const outcome = resolveHeavyAsk(session, config, answeredAt, ask, answer)
    if (outcome.compactAfterTurn) compactAfterTurn = true
    const kind = answer === undefined ? 'dismiss' : outcome.compactAfterTurn ? 'compact' : outcome.verdict.kind === 'allow' ? 'allow' : 'refuse'
    await journal($, answeredAt, { ev: 'answer', rule: 'tool-budget', answer: kind })
    return outcome.verdict
  })()
  pending.set(key, asked)
  try {
    return await asked
  } finally {
    pending.delete(key)
  }
}

/** The agent a plain-text SendMessage would resume: a finished subagent of this session. */
function resumeTarget(to: unknown, message: unknown): string | undefined {
  if (typeof to !== 'string' || typeof message !== 'string') return undefined
  const agent = session.agents[to] ?? Object.values(session.agents).find((a) => a.name === to)
  if (!agent || agent.running || agent.kind === 'teammate') return undefined
  return agent.id
}

/** The tool's own arguments, for its fingerprint. */
function argumentsOf(e: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) if (!ENVELOPE_KEYS.has(key)) args[key] = value
  return { tool: e.tool, args }
}

/** The ladder rung a refusal's text carries, for the journal. */
function refusalNumber(message: string): number | undefined {
  const match = /refusal (\d+) at/.exec(message)
  return match ? Number(match[1]) : undefined
}

function answerKind(outcome: string, answer: string | undefined): string {
  if (answer === undefined) return 'dismiss'
  if (outcome === 'compact-then-send') return 'compact'
  if (outcome === 'allow') return 'allow'
  return 'cancel'
}

/** Appends a row to this session's journal key for the day. Never throws. */
async function journal($: Api, now: number, row: Omit<JournalRow, 't' | 's'>): Promise<void> {
  if (!config.journal || !session.id) return
  try {
    const key = journalKey(session.id, now)
    if (journalCache?.key !== key) {
      const stored = await $.store.get(key)
      journalCache = { key, rows: Array.isArray(stored) ? stored.filter(isJournalRow) : [] }
    }
    const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as Omit<JournalRow, 't' | 's'>
    journalCache.rows.push({ t: now, s: session.id.slice(0, 8), ...clean })
    if (journalCache.rows.length > MAX_ROWS_PER_DAY) journalCache.rows.splice(0, journalCache.rows.length - MAX_ROWS_PER_DAY)
    await $.store.set(key, journalCache.rows)
  } catch (error) {
    $.ui.log(`agent-usage-guard could not write its journal: ${String(error)}`, { to: 'debug' })
  }
}

async function report($: Api, now: number, days: number): Promise<string> {
  try {
    const keys = journalKeysSince((await $.store.keys()).filter(isJournalKey), now, days)
    const rows = (await Promise.all(keys.map((k) => $.store.get(k)))).flatMap((v) => (Array.isArray(v) ? v.filter(isJournalRow) : []))
    return formatReport(rows, now, days)
  } catch (error) {
    return `agent-usage-guard could not read its journal: ${String(error)}`
  }
}

/** A hook that throws or overruns lets the event go ahead: a broken guard must not break the session. */
function failOpen<T>($: Api, event: string, error: { kind?: string; message?: string } | undefined, proceed: () => T): T {
  $.ui.log(`agent-usage-guard: the ${event} hook failed, so the event went ahead (${error?.kind ?? 'error'}: ${error?.message ?? 'unknown'})`, { to: 'debug' })
  return proceed()
}
