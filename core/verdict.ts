// What a gate decides, and the denial ladder every model-facing refusal goes
// through, so no two refusals read the same and a retry loop ends.

import type { Config } from './config.ts'
import type { LoopId, SessionState } from './state.ts'
import { clock, duration, shortClock } from './text.ts'

export type Rule =
  // Agents, never asked: structure and runaway loops.
  | 'depth'
  | 'fuse'
  | 'limit-deny'
  // Agents, asked when someone can answer.
  | 'concurrency'
  | 'starts'
  | 'agent-tokens'
  | 'burn'
  | 'limit'
  // A question about it is already open.
  | 'asking'
  // Tool calls.
  | 'retry'
  | 'stopped'
  | 'tool-budget'
  // Prompts.
  | 'prompt-context'
  | 'dormant'

/** One condition that tripped, and how long an approval of it lasts. */
export type Trip = {
  rule: Rule
  detail: string
  leaseKey: string
  leaseUntil: number
}

export type Family = 'agents' | 'heavy' | 'prompt'

export type Allow = { kind: 'allow'; note?: string }
export type Deny = { kind: 'deny'; rule: Rule; message: string }
export type Drop = { kind: 'drop'; rule: Rule; message: string }
export type Ask = {
  kind: 'ask'
  family: Family
  loop: LoopId
  trips: Trip[]
  question: string
  options: readonly string[]
}
export type CompactThenSend = { kind: 'compact-then-send'; rule: Rule; message: string }

export type Verdict = Allow | Deny | Drop | Ask

export const ALLOW: Allow = { kind: 'allow' }

/** The chip AskUserQuestion draws beside every question the guard asks. */
export const HEADER = 'Usage guard'

export const SIGNATURE = 'agent-usage-guard'

/**
 * Words a refusal for the model. The first refusal of a condition states it;
 * the second says it has not changed; from the third, the model is told to end
 * the turn, or, when a Stop hook keeps reopening the turn, to hand the decision
 * to the user. Each carries its number and the time, so none is byte-identical.
 *
 * Refused agent calls also feed the fuse: `fuseMax` of them within `fuseMs`
 * pause every agent spawn in the session for `fuseMs`.
 */
export function refuse(
  state: SessionState,
  config: Config,
  now: number,
  rule: Rule,
  key: string,
  base: string,
  agent: boolean,
): Deny {
  const earlier = state.denials.filter((d) => d.key === key && now - d.at < config.windowMs)
  const n = earlier.length + 1
  state.denials.push({ at: now, key, agent })
  const parts = [base]
  if (n >= 2 && state.reopened) {
    parts.push(
      'A Stop hook reopened this turn, so ending the turn will not clear this. Tell the user that agent-usage-guard is holding it and that /usage-guard allow lifts it, then wait for their answer.',
    )
  } else if (n === 2) {
    parts.push(`This has not changed since ${clock(earlier[0]!.at)}, so the same call fails again. Do something different.`)
  } else if (n >= 3) {
    parts.push('Retrying keeps failing, and every retry re-sends the whole context. End the turn and tell the user what is blocked.')
  }
  if (agent && state.fuseUntil === undefined) {
    const agentDenials = state.denials.filter((d) => d.agent && now - d.at < config.fuseMs).length
    if (agentDenials >= config.fuseMax) {
      state.fuseUntil = now + config.fuseMs
      parts.push(
        `That is ${agentDenials} refused agent calls in ${duration(config.fuseMs)}, so agent spawns in this session are paused until ${shortClock(state.fuseUntil)}.`,
      )
    }
  }
  parts.push(`[${SIGNATURE} · refusal ${n} at ${clock(now)}]`)
  return { kind: 'deny', rule, message: parts.join(' ') }
}

/** Lists details as prose: "a", "a and b", "a, b and c". */
export function join(details: readonly string[]): string {
  if (details.length <= 1) return details.join('')
  return `${details.slice(0, -1).join(', ')} and ${details.at(-1)}`
}

/** Capitalises the first letter of a sentence assembled from parts. */
export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
