// The Claude Code adapter. It turns Claude Code's events into the core's facts
// and requests, asks the user when a verdict needs an answer, and keeps the
// cross-session records in $.store. Every decision lives in ../core.

import type { EngineInterface, On, Timer } from 'claude-code'

import {
  type AgentRequest,
  type Ask,
  type Config,
  DEFAULT_ALLOW_MINUTES,
  type Deny,
  HEADER,
  type JournalRow,
  MAIN,
  type PeerRecord,
  type PromptSource,
  SIGNATURE,
  type SessionState,
  type SimulatedRule,
  type ToolRequest,
  type Verdict,
  agentGate,
  applyOverride,
  canonical,
  contextBucket,
  defaultConfig,
  expireAgents,
  fingerprint,
  formatReport,
  heldForQuestion,
  helpText,
  highestLimit,
  isHaiku,
  isJournalRow,
  isScheduling,
  journalKey,
  livePeers,
  lockoutKind,
  markerScope,
  newSession,
  observeAgentActive,
  observeAgentRunEnd,
  observeAgentStart,
  observeCompaction,
  observeLimits,
  observeMainContext,
  observeResponse,
  observeSpawn,
  observeToolResult,
  observeToolStart,
  observeTurnEnd,
  parseCommand,
  parseConfig,
  peerRecord,
  promptGate,
  promptNotes,
  prune,
  releaseStart,
  reserveStart,
  resolveAgentAsk,
  resolveHeavyAsk,
  resolvePromptAsk,
  resumeGuard,
  scheduleGate,
  simulate,
  splitJournalKeys,
  statusLine,
  statusLineExpiry,
  statusReport,
  toolGate,
} from '../core/index.ts'

type Api = EngineInterface

const COMMAND = 'agent-guard'
const PEER_PREFIX = 'peer:'
const LAST_ACTIVE_PREFIX = 'last-active:'
const HEARTBEAT_MS = 60_000
/** Keeps one session's day of journal rows well inside the store's 4 MiB. */
const MAX_ROWS_PER_DAY = 2000
/** All journal days together stay below half the store, oldest dropped first. */
const JOURNAL_BUDGET_BYTES = 2_000_000
/** A peer record nobody refreshed for a day is from a session that is gone. */
const STALE_PEER_MS = 86_400_000
/** When a session was last active outlives the session by a month, for a later resume. */
const LAST_ACTIVE_KEEP_MS = 30 * 86_400_000
/** A redraw waits at most a day, then times the rest: a JavaScript timer cannot wait past 24.8 days, and a window may reset later. */
const REDRAW_MAX_MS = 86_400_000
/** Prompts that start a turn on their own: a schedule or /loop firing, a relayed channel message, a Slack ping. */
const UNATTENDED: ReadonlySet<string> = new Set(['scheduled-trigger', 'channel', 'slack-ping'])
/** Keys of the tool call's envelope, not of the tool's own arguments. */
const ENVELOPE_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])
/** An agent name a question may show as it is. */
const PLAIN_NAME = /^[\w.-]{1,32}$/

let config: Config = defaultConfig()
let problems: string[] = []
let session: SessionState = newSession('', false)
let interactive = false
/** The session has no AskUserQuestion tool (`--tools` left it out), so nobody can be asked. */
let askUnavailable = false
let permissionMode: string | undefined
let peers: PeerRecord[] = []
/** Agents a SendMessage call already judged as resumes, while that call runs. */
const gatedResumes = new Set<string>()
let lastPublished = 0
/** The last-active time this process last stored, so a heartbeat does not rewrite it. */
let lastActiveKept: number | undefined
let lastStatus: string | undefined
/** Why the last write to the store failed, while no write has worked since. */
let storeFailure: string | undefined
/** The pending redraw of the status line, and the time it is for. */
let redraw: { at: number; timer: Timer } | undefined
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
    const now = await $.clock.now()
    if (observeAgentStart(session, now, e.agent_id, e.agent_type)) await publish($, now)
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.SubagentStart', next.error, () => next(e)))

  on('classic.StopFailure', async ($, e, next) => {
    if (config.enabled) {
      // On StopFailure, last_assistant_message is the failed request's own
      // error message, the text Claude Code shows, not Claude's earlier prose.
      const text = `${e.error_details ?? ''} ${e.last_assistant_message ?? ''}`
      const kind = lockoutKind(e.error, text, Object.values(session.limits))
      if (kind) {
        const now = await $.clock.now()
        const reading = session.limits[kind]
        // A current reading's reset time names the window, so the report counts each lockout once.
        const resets = reading?.resetsAt !== undefined && reading.resetsAt > now ? reading.resetsAt : undefined
        await journal($, now, { ev: 'lockout', kind, ...(reading ? { pct: reading.percent } : {}), ...(resets === undefined ? {} : { resets }) })
      }
    }
    return next(e)
  }).catch(($, e, next) => failOpen($, 'classic.StopFailure', next.error, () => next(e)))

  on('session.end', async ($, e, next) => {
    await keepLastActive($)
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
        const failed = await compact($)
        if (failed !== undefined) $.ui.log(`agent-usage-guard could not compact (${failed}).`)
      })
    }
    await refreshStatus($)
    return result
  }).catch(($, e, next) => failOpen($, 'turn.complete', next.error, () => next(e)))

  on('prompt.submit', async ($, e, next) => {
    if (!config.enabled) return next(e)
    const now = await $.clock.now()
    const source = sourceOf(e.origin.kind)

    const scope = fromPerson(e.origin.kind) ? markerScope(e.text) : undefined
    if (scope) {
      const text = applyOverride(session, now, scope, DEFAULT_ALLOW_MINUTES)
      await journal($, now, { ev: 'override', rule: scope })
      await refreshStatus($)
      return { drop: `${SIGNATURE}: ${text}` }
    }

    await readMainContext($)
    const context = session.loops[MAIN]?.context
    // Other sessions' plan readings are fresher than an idle session's own.
    if (source !== 'other') await loadPeers($, now)
    const gate = async (at: number): Promise<Verdict> =>
      promptGate(session, peers, config, at, { source, text: e.text, idleMs: await idleTime($, at) })
    const woundDown = session.windDown
    const send = async (note: string | undefined) => {
      if (session.windDown && !woundDown) {
        const limit = highestLimit(session, peers, now)
        await journal($, now, { ev: 'note', rule: 'wind-down', ...(limit ? { kind: limit.kind, pct: limit.percent } : {}) })
      }
      return note ? next({ ...e, context: [...(e.context ?? []), note] }) : next(e)
    }
    const verdict = await gate(now)
    if (session.dormantResumes.at(-1) === now) await publish($, now)
    stopSeen = false
    session.reopened = false

    if (verdict.kind === 'allow') return send(verdict.note)
    if (verdict.kind === 'drop') {
      await journal($, now, { ev: 'drop', rule: verdict.rule, ctx: contextBucket(context) })
      return { drop: verdict.message }
    }
    if (verdict.kind !== 'ask') return next(e)

    const asked = await askUser($, verdict, contextBucket(context))
    if (asked.unavailable) {
      await journalAnswer($, verdict, asked)
      const alone = await gate(asked.at)
      if (alone.kind === 'drop') return { drop: alone.message }
      return send(alone.kind === 'allow' ? alone.note : undefined)
    }
    const outcome = resolvePromptAsk(session, verdict, asked.answer)
    await journalAnswer($, verdict, asked, outcome.kind === 'compact-first' ? 'compact' : outcome.kind === 'allow' ? 'allow' : 'cancel')
    if (outcome.kind === 'allow') return send(promptNotes(session, peers, config, asked.at))
    // Claude Code puts a dropped prompt back in the input box, where it waits through a compaction.
    if (outcome.kind === 'compact-first') {
      $.clock.after(0, async () => {
        const failed = await compact($)
        if (failed !== undefined) $.ui.log(`agent-usage-guard could not compact (${failed}); your prompt is still in the input box.`)
      })
    }
    return { drop: outcome.message }
  }).catch(($, e, next) => failOpen($, 'prompt.submit', next.error, () => next(e)))

  on('agent.spawn', async ($, e, next) => {
    if (!config.enabled) return next(e)
    trackMode(e.permissionMode, e.parentAgentId)
    const now = await $.clock.now()
    const loop = e.parentAgentId ?? MAIN
    // Since 2.1.299 a resume raises agent.spawn too, inside the SendMessage call that judged and counted it.
    const resumed = e.resume?.agentId
    if (resumed !== undefined && gatedResumes.has(resumed)) return next(e)
    const known = resumed === undefined ? undefined : session.agents[resumed]
    const parentDepth = e.parentAgentId ? (session.agents[e.parentAgentId]?.depth ?? 1) : 0
    // A fork runs on its parent's model; any other agent on the one it names, else its own definition's or its parent's.
    const asked = config.haikuExempt && isHaiku(e.fork ? e.parentModel : e.model)
    const request = { loop, depth: known?.depth ?? parentDepth + 1, resume: resumed !== undefined, cheap: known?.cheap ?? asked }
    const { verdict, reservedAt } = await agentVerdict($, now, request)
    if (verdict.kind === 'deny') {
      await journalDenial($, verdict, 'Agent')
      return { deny: verdict.message }
    }
    let started: string | undefined
    let cheap = request.cheap
    try {
      const result = await next(e)
      if (!result.deny && result.agentId) {
        started = result.agentId
        const kind = e.isTeammate ? 'teammate' : e.workflow ? 'workflow' : e.fork ? 'fork' : 'subagent'
        // The model it runs on is known only now: an agent's own definition may pick Haiku.
        if (!known) cheap = config.haikuExempt && isHaiku(result.model)
        if (known) observeAgentActive(session, started)
        else observeSpawn(session, await $.clock.now(), { agentId: started, kind, depth: request.depth, cheap, ...(e.name ? { name: e.name } : {}) })
      }
      return result
    } finally {
      if (reservedAt !== undefined) releaseStart(session, reservedAt, started, cheap)
      await publish($, await $.clock.now())
    }
  }).catch(($, e, next) =>
    // A failure before the agent started leaves it unjudged; starting it anyway
    // would let a broken guard wave through every agent of a parallel batch.
    next.called
      ? failOpen($, 'agent.spawn', next.error, () => next(e))
      : { deny: `agent-usage-guard could not judge this agent${next.error?.kind === 'timeout' ? ' in time' : ''}. Start it again. [${SIGNATURE}]` },
  )

  on('tool.call', async ($, e, next) => {
    if (!config.enabled) return next(e)
    const now = await $.clock.now()
    const loop = e.agentId ?? MAIN

    let resumed: { id: string; reservedAt: number | undefined } | undefined
    if (e.tool === 'SendMessage') {
      const target = resumeTarget(e.to, e.message)
      if (target) {
        const agent = session.agents[target]!
        const { verdict, reservedAt } = await agentVerdict($, now, { loop, depth: agent.depth, resume: true, cheap: agent.cheap === true })
        if (verdict.kind === 'deny') {
          await journalDenial($, verdict, 'SendMessage')
          return { deny: verdict.message }
        }
        resumed = { id: target, reservedAt }
        gatedResumes.add(target)
      }
    }

    const print = fingerprint(canonical(argumentsOf(e)))
    if (!resumed) {
      const label = loop === MAIN ? 'this conversation' : agentLabel(loop)
      const request = { loop, tool: e.tool, fingerprint: print, label }
      if (isScheduling(e.tool)) await loadPeers($, now)
      let verdict = scheduleGate(session, peers, config, now, request)
      if (verdict.kind === 'allow') verdict = toolGate(session, config, now, request)
      if (verdict.kind === 'ask') verdict = await settleHeavy($, verdict, request)
      if (verdict.kind === 'deny') {
        await journalDenial($, verdict, e.tool, contextBucket(session.loops[loop]?.context))
        return { deny: verdict.message }
      }
    }

    observeToolStart(session, loop)
    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      result = await next(e)
      return result
    } finally {
      observeToolResult(session, await $.clock.now(), loop, print, Boolean(result?.isError) && !result?.deny)
      if (resumed) {
        gatedResumes.delete(resumed.id)
        const delivered = result !== undefined && !result.deny && !result.isError
        if (resumed.reservedAt !== undefined) releaseStart(session, resumed.reservedAt, delivered ? resumed.id : undefined, session.agents[resumed.id]?.cheap === true)
        if (delivered) observeAgentActive(session, resumed.id)
        await publish($, await $.clock.now())
      }
    }
  }).catch(($, e, next) => failOpen($, 'tool.call', next.error, () => next(e)))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const now = await $.clock.now()
    const command = parseCommand(e.args)
    if (command.action === 'help') return { text: helpText(command.error) }
    if (command.action === 'report') return { text: await report($, now, command.days) }
    if (command.action === 'allow') {
      // Only the person lifts limits: another plugin's $.command.run reaches this hook too.
      if (!fromPerson(e.origin.kind)) {
        const from = e.origin.kind === 'plugin' ? `the ${e.origin.name} plugin` : `a ${e.origin.kind} prompt`
        $.ui.log(`agent-usage-guard refused /${COMMAND} ${e.args.trim()} from ${from}.`)
        return { text: `Only you can lift the guard's limits, and this came from ${from}, so nothing changed. Type /${COMMAND} ${e.args.trim()} to lift them.` }
      }
      const text = applyOverride(session, now, command.scope, command.minutes)
      await journal($, now, { ev: 'override', rule: command.scope })
      await refreshStatus($)
      return { text }
    }
    if (command.action === 'simulate') return { text: await simulation($, command.rule, now) }
    if (command.action === 'resume') {
      const text = resumeGuard(session)
      await refreshStatus($)
      return { text }
    }
    await loadPeers($, now)
    return { text: statusReport(session, peers, config, now, problems, await pluginVersion($), storeFailure) }
  }).catch(($, e, next) => ({ text: `The command failed: ${next.error?.message ?? 'unknown error'}` }))
}

/** Each variable is named in full, so `claude plugin validate` can list every one the mod reads. */
async function loadConfig($: Api): Promise<void> {
  const parsed = parseConfig({
    AGENT_GUARD: await $.env.get('AGENT_GUARD'),
    AGENT_GUARD_JOURNAL: await $.env.get('AGENT_GUARD_JOURNAL'),
    AGENT_GUARD_HAIKU_EXEMPT: await $.env.get('AGENT_GUARD_HAIKU_EXEMPT'),
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
  if (previous && previous !== id) {
    await keepLastActive($)
    await $.store.delete(PEER_PREFIX + previous).catch(() => undefined)
  }
  session = newSession(id, canAsk())
  lastActiveKept = undefined
  journalCache = undefined
  stopSeen = false
  compactAfterTurn = false
}

/** Drops journal days past their retention and records of sessions long gone. */
async function housekeeping($: Api): Promise<void> {
  try {
    const now = await $.clock.now()
    const keys = await $.store.keys()
    const { recent, expired } = splitJournalKeys(keys, now, config.journalDays)
    for (const key of expired) await $.store.delete(key)
    const days = recent.sort()
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
    for (const key of keys.filter((k) => k.startsWith(LAST_ACTIVE_PREFIX))) {
      const at = await $.store.get(key)
      if (typeof at !== 'number' || now - at > LAST_ACTIVE_KEEP_MS) await $.store.delete(key)
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

/**
 * Who a prompt is from, for the prompt gate. Scheduled prompts, channel
 * messages and Slack pings start a turn with nobody at the keyboard to answer,
 * so the gate holds a heavy one with the reason, as in `claude -p`.
 */
function sourceOf(kind: string): PromptSource {
  if (kind === 'composer' || kind === 'bridge') return 'user'
  if (kind === 'sdk' || UNATTENDED.has(kind)) return 'headless'
  return 'other'
}

/** A person sent it from the prompt, Remote Control or the SDK: only they lift limits. */
function fromPerson(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

/** Publishes this session's counts for the other sessions on this machine. */
async function publish($: Api, now: number): Promise<void> {
  if (!session.id) return
  lastPublished = now
  expireAgents(session, now, config.peerTtlMs)
  prune(session, now, config.windowMs)
  try {
    await save($, PEER_PREFIX + session.id, peerRecord(session, now, config.windowMs))
  } catch (error) {
    $.ui.log(`agent-usage-guard could not publish its counts: ${String(error)}`, { to: 'debug' })
  }
  await keepLastActive($)
}

/**
 * Stores when the main conversation was last active, so a later process
 * that resumes the session knows how long it sat idle. The transcript cannot
 * say: Claude Code rewrites its modification time on resume, and hourly while
 * the session is open.
 */
async function keepLastActive($: Api): Promise<void> {
  const last = session.loops[MAIN]?.activeAt
  if (!session.id || last === undefined || last === lastActiveKept) return
  try {
    await save($, LAST_ACTIVE_PREFIX + session.id, last)
    lastActiveKept = last
  } catch (error) {
    $.ui.log(`agent-usage-guard could not store when the session was last active: ${String(error)}`, { to: 'debug' })
  }
}

/**
 * Writes to the store and keeps track of whether writes work: when they stop,
 * other sessions no longer see this one's counts, and the status says so.
 */
async function save($: Api, key: string, value: unknown): Promise<void> {
  const before = storeFailure
  try {
    await $.store.set(key, value)
    storeFailure = undefined
  } catch (error) {
    storeFailure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if ((before === undefined) !== (storeFailure === undefined)) await refreshStatus($)
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

/** Time since the main conversation was last active: in this process, or, after a resume, in the one before. */
async function idleTime($: Api, now: number): Promise<number | undefined> {
  const last = session.loops[MAIN]?.activeAt
  if (last !== undefined) return now - last
  try {
    const kept = await $.store.get(LAST_ACTIVE_PREFIX + session.id)
    return typeof kept === 'number' ? now - kept : undefined
  } catch {
    return undefined
  }
}

async function refreshStatus($: Api): Promise<void> {
  if (!interactive) return
  try {
    const now = await $.clock.now()
    redrawAt($, statusLineExpiry(session, peers, config, now), now)
    const parts = [statusLine(session, peers, config, now), storeFailure === undefined || !config.enabled ? undefined : "store not saving: other sessions can't count this one"]
    const text = parts.filter((p) => p !== undefined).join(' · ') || undefined
    if (text === lastStatus) return
    lastStatus = text
    $.ui.status(text)
  } catch (error) {
    $.ui.log(`agent-usage-guard could not update its status line: ${String(error)}`, { to: 'debug' })
  }
}

/** Redraws the status line at `at`, when something it shows runs out: a quiet session has no event that would. */
function redrawAt($: Api, at: number | undefined, now: number): void {
  if (redraw?.at === at) return
  redraw?.timer.cancel()
  redraw = undefined
  if (at === undefined) return
  const timer = $.clock.after(Math.min(at - now, REDRAW_MAX_MS), () => {
    redraw = undefined
    return refreshStatus($)
  })
  redraw = { at, timer }
}

type Asked = { answer: string | undefined; unavailable: boolean; at: number }

/**
 * Journals a question and asks it in Claude Code's own question dialog.
 * `answer` is undefined when the dialog came back without one. That counts as
 * a dismissal, whatever ended it: the user dismissed it, or interrupted the
 * turn, or the dialog failed. A question with no answer is never a yes.
 * `unavailable` means the question could not be asked at all, because the
 * session has no AskUserQuestion tool: from then on the session counts as one
 * nobody can answer, and the gate decides alone. `at` is when the question
 * ended.
 */
async function askUser($: Api, ask: Ask, ctx?: string): Promise<Asked> {
  await journal($, await $.clock.now(), { ev: 'ask', rule: ask.trips[0]?.rule, ctx })
  let answer: string | undefined
  let unavailable = false
  try {
    answer = await $.ui.ask(ask.question, { options: ask.options, header: HEADER })
  } catch (error) {
    const text = String(error)
    if (/no tool named "AskUserQuestion"/.test(text)) {
      askUnavailable = true
      session.canAsk = false
      unavailable = true
    } else if (!/\$\.ui\.ask: no answer\b/.test(text)) {
      $.ui.log(`agent-usage-guard: the question ended without an answer (${text}), so it counts as dismissed.`, { to: 'debug' })
    }
  }
  return { answer, unavailable, at: await $.clock.now() }
}

/** Journals how a question ended: the user's `choice`, a dismissal, or no dialog at all. */
async function journalAnswer($: Api, ask: Ask, asked: Asked, choice?: string): Promise<void> {
  const answer = asked.unavailable ? 'unavailable' : asked.answer === undefined ? 'dismiss' : choice
  await journal($, asked.at, { ev: 'answer', rule: ask.trips[0]?.rule, answer })
}

/**
 * One question per key at a time: a call that trips while its question is
 * open is held back at once, and the model makes it again once it is
 * answered. Waiting instead could outlast the hook's time limit.
 */
async function oneAtATime<T>(key: string, held: () => T, run: () => Promise<T>): Promise<T> {
  // The check for an open question and the claim on it must not straddle an
  // await, or two parallel calls would each ask.
  if (pending.has(key)) return held()
  const asking = run()
  pending.set(key, asking)
  try {
    return await asking
  } finally {
    pending.delete(key)
  }
}

/**
 * Shows what a rule does on made-up state: the real question in the dialog
 * where someone can answer, else the refusal or the held prompt's reason. The
 * reply opens by saying it is a simulation, because Claude reads it too.
 */
async function simulation($: Api, rule: SimulatedRule, now: number): Promise<string> {
  const verdict = simulate(rule, config, now, canAsk())
  const opening = `Simulation of ${rule}`
  const aside = `${opening}: nothing was held, and none of this applies to the current work.`
  if (verdict.kind === 'ask') {
    if (canAsk()) {
      try {
        const answer = await $.ui.ask(`Simulation, nothing changes: ${verdict.question}`, { options: verdict.options, header: HEADER })
        return `${opening}: you answered "${answer}". Nothing was held, nothing changed and no usage was spent.`
      } catch {
        // Dismissed, or the dialog could not open: show the question instead.
      }
    }
    return `${aside} The guard would ask:\n\n${verdict.question}\nOptions: ${verdict.options.join(' · ')}`
  }
  if (verdict.kind === 'deny') return `${aside} Claude would read this refusal:\n\n${verdict.message}`
  if (verdict.kind === 'drop') return `${aside} A prompt you send would be held:\n\n${verdict.message}`
  return `${opening}: with your settings, this rule would not trip.`
}

/** Compacts the conversation. Returns why it did not, or undefined once it has. */
async function compact($: Api): Promise<string | undefined> {
  try {
    return (await $.session.compact()).skip
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A verdict on an agent, and the slot it holds when allowed, for `releaseStart`. */
type AgentVerdict = { verdict: Verdict; reservedAt?: number }

/** The agent gate, asking at most one question about agents at a time. */
async function agentVerdict($: Api, now: number, request: AgentRequest): Promise<AgentVerdict> {
  await loadPeers($, now)
  expireAgents(session, now, config.peerTtlMs)
  prune(session, now, config.windowMs)
  const verdict = agentGate(session, peers, config, now, request)
  if (verdict.kind === 'allow') return { verdict, reservedAt: reserveStart(session, now) }
  if (verdict.kind !== 'ask') return { verdict }
  return oneAtATime<AgentVerdict>('agents', () => ({ verdict: heldForQuestion('agents') }), async () => {
    const asked = await askUser($, verdict)
    const resolved = asked.unavailable
      ? agentGate(session, peers, config, asked.at, request)
      : resolveAgentAsk(session, config, asked.at, verdict, asked.answer, request.resume)
    const reservedAt = resolved.kind === 'allow' ? reserveStart(session, asked.at) : undefined
    await journalAnswer($, verdict, asked, resolved.kind === 'allow' ? 'allow' : 'refuse')
    await refreshStatus($)
    return { verdict: resolved, ...(reservedAt === undefined ? {} : { reservedAt }) }
  })
}

/** The heavy-context question, one per loop at a time. */
async function settleHeavy($: Api, ask: Ask, request: ToolRequest): Promise<Verdict> {
  return oneAtATime(`heavy:${ask.loop}`, () => heldForQuestion('heavy'), async () => {
    const asked = await askUser($, ask, contextBucket(session.loops[ask.loop]?.context))
    if (asked.unavailable) {
      await journalAnswer($, ask, asked)
      return toolGate(session, config, asked.at, request)
    }
    const outcome = resolveHeavyAsk(session, config, asked.at, ask, asked.answer)
    if (outcome.compactAfterTurn) compactAfterTurn = true
    await journalAnswer($, ask, asked, outcome.compactAfterTurn ? 'compact' : outcome.verdict.kind === 'allow' ? 'allow' : 'refuse')
    return outcome.verdict
  })
}

/** The agent a plain-text SendMessage would resume: a finished subagent of this session. */
function resumeTarget(to: unknown, message: unknown): string | undefined {
  if (typeof to !== 'string' || typeof message !== 'string') return undefined
  const agent = session.agents[to] ?? Object.values(session.agents).find((a) => a.name === to)
  if (!agent || agent.running || agent.kind === 'teammate') return undefined
  return agent.id
}

/**
 * How a question names an agent. Claude picks an agent's name, and the question
 * shows under the guard's header, so only a plain name is shown, in quotes;
 * any other is replaced by the start of the agent's id.
 */
function agentLabel(id: string): string {
  const name = session.agents[id]?.name
  return name !== undefined && PLAIN_NAME.test(name) ? `agent "${name}"` : `agent ${id.slice(0, 8)}`
}

/** The tool's own arguments, for its fingerprint. */
function argumentsOf(e: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) if (!ENVELOPE_KEYS.has(key)) args[key] = value
  return { tool: e.tool, args }
}

/** Journals a refusal the model reads. */
async function journalDenial($: Api, verdict: Deny, tool: string, ctx?: string): Promise<void> {
  await journal($, await $.clock.now(), { ev: 'deny', rule: verdict.rule, tool, ctx, n: verdict.n })
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
    await save($, key, journalCache.rows)
  } catch (error) {
    $.ui.log(`agent-usage-guard could not write its journal: ${String(error)}`, { to: 'debug' })
  }
}

/** The version in the loaded copy's own manifest, so the status shows which copy runs. */
async function pluginVersion($: Api): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    const version = (manifest as { version?: unknown } | null)?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

async function report($: Api, now: number, days: number): Promise<string> {
  try {
    const { recent } = splitJournalKeys(await $.store.keys(), now, days)
    const rows = (await Promise.all(recent.map((k) => $.store.get(k)))).flatMap((v) => (Array.isArray(v) ? v.filter(isJournalRow) : []))
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
