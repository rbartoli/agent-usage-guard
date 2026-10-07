// The prompt gate. It never touches a prompt the user did not type, such as a
// background task's notification or another session's message: holding those
// loses results. It never holds a prompt over plan limits either; Claude Code
// waits at a limit and resumes on its own.

import type { Config } from './config.ts'
import { MAIN, type PeerRecord, type Scope, type SessionState, overrideCovers, within } from './state.ts'
import { duration, tokens } from './text.ts'
import { ALLOW, type Ask, type CompactThenSend, type Drop, type Rule, SIGNATURE, type Verdict } from './verdict.ts'

/** Who a prompt came from, as far as the guard cares. */
export type PromptSource = 'user' | 'headless' | 'other'

export type PromptRequest = {
  source: PromptSource
  text: string
  /** Time since the session's last model response, when known. */
  idleMs?: number
}

export const PROMPT_COMPACT = 'Compact, then send'
export const PROMPT_SEND = 'Send anyway'
export const PROMPT_CANCEL = 'Cancel'

const MARKERS: Readonly<Record<string, Scope>> = {
  '[allow-usage-guard]': 'all',
  '[allow-agent-burst]': 'agents',
}

/**
 * The bracket markers of earlier versions, when one is the whole prompt. They
 * act like `/usage-guard allow`: the prompt is not sent, so no model turn runs
 * and the model never reads the marker.
 */
export function markerScope(text: string): Scope | undefined {
  return MARKERS[text.trim().toLowerCase()]
}

export function promptGate(
  state: SessionState,
  peers: readonly PeerRecord[],
  config: Config,
  now: number,
  request: PromptRequest,
): Verdict {
  if (!config.enabled) return ALLOW
  const context = state.loops[MAIN]?.context
  if (request.source === 'other' || context === undefined || overrideCovers(state, now, 'context')) {
    return withWarning(state, config, context)
  }

  const hardLeased = state.leases['prompt-context'] !== undefined
  if (context >= config.contextHard && !hardLeased) {
    const detail = `this session holds ${tokens(context)} context tokens (limit ${tokens(config.contextHard)}), and sending re-reads all of them`
    if (state.canAsk && request.source === 'user') {
      return promptAsk('prompt-context', `This session holds ${tokens(context)} context tokens, and sending re-reads all of them; compacting first shrinks this request and every later one. Send this prompt?`, detail)
    }
    return drop('prompt-context', `${detail}. Compact the session first, or raise AGENT_GUARD_CONTEXT_HARD.`)
  }

  const idle = request.idleMs
  if (idle !== undefined && idle >= config.dormantMs && context >= config.dormantContext) {
    const detail = `this session was idle for ${duration(idle)}, so its prompt cache has likely expired and this request re-writes about ${tokens(context)} tokens`
    if (state.canAsk && request.source === 'user') {
      return promptAsk('dormant', `This session was idle for ${duration(idle)}, so its prompt cache has likely expired and this request re-writes about ${tokens(context)} tokens. Send this prompt?`, detail)
    }
    const recent =
      within(state.dormantResumes, now, config.windowMs).length +
      peers.reduce((sum, p) => sum + within(p.dormantResumes, now, config.windowMs).length, 0)
    if (recent >= config.dormantMax) {
      return drop(
        'dormant',
        `${detail}, and ${recent} heavy idle session${recent === 1 ? '' : 's'} already resumed on this machine in the last ${duration(config.windowMs)} (limit ${config.dormantMax}). Try again later, or compact the session first.`,
      )
    }
    state.dormantResumes.push(now)
  }
  return withWarning(state, config, context)
}

export type PromptOutcome = Verdict | CompactThenSend

/** Applies the user's answer to a prompt question. Dismissing it cancels. */
export function resolvePromptAsk(state: SessionState, ask: Ask, answer: string | undefined): PromptOutcome {
  const trip = ask.trips[0]!
  if (answer === PROMPT_COMPACT) {
    return { kind: 'compact-then-send', rule: trip.rule, message: `${SIGNATURE}: compacting first, because ${trip.detail}; your prompt is sent once that finishes.` }
  }
  if (answer === PROMPT_SEND) {
    if (trip.rule === 'prompt-context') state.leases['prompt-context'] = Number.MAX_SAFE_INTEGER
    return ALLOW
  }
  return drop(trip.rule, 'cancelled; your prompt is back in the input box.')
}

function promptAsk(rule: 'prompt-context' | 'dormant', question: string, detail: string): Ask {
  return {
    kind: 'ask',
    family: 'prompt',
    loop: MAIN,
    trips: [{ rule, detail, leaseKey: rule, leaseUntil: Number.MAX_SAFE_INTEGER }],
    question,
    options: [PROMPT_COMPACT, PROMPT_SEND, PROMPT_CANCEL],
  }
}

function drop(rule: Rule, reason: string): Drop {
  return { kind: 'drop', rule, message: `${SIGNATURE}: ${reason}` }
}

/** The warning for a prompt the user chose to send, if Claude has not had it yet. */
export function contextNote(state: SessionState, config: Config): string | undefined {
  const verdict = withWarning(state, config, state.loops[MAIN]?.context)
  return verdict.kind === 'allow' ? verdict.note : undefined
}

/** Tells Claude once, when the context first crosses the warning threshold. */
function withWarning(state: SessionState, config: Config, context: number | undefined): Verdict {
  if (context === undefined || context < config.contextWarn || state.warned) return ALLOW
  state.warned = true
  return {
    kind: 'allow',
    note: `${SIGNATURE}: this session's context is ${tokens(context)} tokens. Keep this turn bounded, and recommend /compact to the user at the next natural break.`,
  }
}
