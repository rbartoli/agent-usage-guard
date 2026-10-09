// Thresholds and switches. The core reads them from a plain record of strings
// so that any harness can supply them: environment variables, a settings file,
// or a test's literal object.

export type Config = {
  enabled: boolean
  /** Rolling window for agent starts, token burn, tool budgets and denials. */
  windowMs: number
  /** Agents running at once across every session on this machine. */
  agentMax: number
  /** Agent starts and resumes per window across every session on this machine. */
  rollingMax: number
  /** Subagent layers below the main conversation; 1 means subagents cannot spawn. */
  depthMax: number
  /** Tokens processed by subagent requests per window across this machine. */
  agentTokensMax: number
  /** Plan-window percentage at which new agents need the user's approval. */
  limitAskPercent: number
  /** Plan-window percentage at which new agents are refused. */
  limitDenyPercent: number
  /** Plan-window points burned within one window that make new agents ask. */
  burnPercent: number
  /** Context at which Claude is told, once, to keep the turn bounded. */
  contextWarn: number
  /** Context at which a prompt needs the user's approval before it is sent. */
  contextHard: number
  /** Context above which a loop's tool calls count against the tool budget. */
  toolContext: number
  /** Tool calls per window a loop may make above `toolContext`. */
  toolMax: number
  /** Idle time after which a heavy session's prompt cache has likely expired. */
  dormantMs: number
  /** Context at which a dormant session counts as heavy. */
  dormantContext: number
  /** Dormant heavy resumes per window on this machine when nobody can be asked. */
  dormantMax: number
  /** Identical consecutive tool failures before the identical retry is refused. */
  failureMax: number
  /** Refused agent calls per `fuseMs` that pause agent spawns for `fuseMs`. */
  fuseMax: number
  fuseMs: number
  /** How long another session's record, or an agent with no sign of activity, still counts. */
  peerTtlMs: number
  journal: boolean
  journalDays: number
}

type Field = Exclude<keyof Config, 'enabled' | 'journal'>

type Spec = {
  field: Field
  env: string
  default: number
  min: number
  max: number
  /** Multiplier from the variable's unit to the field's (seconds to milliseconds). */
  scale: number
}

const SECONDS = 1000

export const SPECS: readonly Spec[] = [
  { field: 'windowMs', env: 'AGENT_GUARD_WINDOW_SECONDS', default: 600, min: 60, max: 86_400, scale: SECONDS },
  { field: 'agentMax', env: 'AGENT_GUARD_AGENT_MAX', default: 4, min: 1, max: 1000, scale: 1 },
  { field: 'rollingMax', env: 'AGENT_GUARD_ROLLING_MAX', default: 12, min: 1, max: 10_000, scale: 1 },
  { field: 'depthMax', env: 'AGENT_GUARD_DEPTH_MAX', default: 1, min: 1, max: 10, scale: 1 },
  { field: 'agentTokensMax', env: 'AGENT_GUARD_AGENT_TOKENS_MAX', default: 10_000_000, min: 1, max: 1e12, scale: 1 },
  { field: 'limitAskPercent', env: 'AGENT_GUARD_LIMIT_ASK_PERCENT', default: 80, min: 1, max: 100, scale: 1 },
  { field: 'limitDenyPercent', env: 'AGENT_GUARD_LIMIT_DENY_PERCENT', default: 95, min: 1, max: 101, scale: 1 },
  { field: 'burnPercent', env: 'AGENT_GUARD_BURN_PERCENT', default: 20, min: 1, max: 101, scale: 1 },
  { field: 'contextWarn', env: 'AGENT_GUARD_CONTEXT_WARN', default: 300_000, min: 1, max: 1e9, scale: 1 },
  { field: 'contextHard', env: 'AGENT_GUARD_CONTEXT_HARD', default: 500_000, min: 1, max: 1e9, scale: 1 },
  { field: 'toolContext', env: 'AGENT_GUARD_TOOL_CONTEXT', default: 400_000, min: 1, max: 1e9, scale: 1 },
  { field: 'toolMax', env: 'AGENT_GUARD_TOOL_MAX', default: 20, min: 1, max: 100_000, scale: 1 },
  { field: 'dormantMs', env: 'AGENT_GUARD_DORMANT_SECONDS', default: 3600, min: 60, max: 30 * 86_400, scale: SECONDS },
  { field: 'dormantContext', env: 'AGENT_GUARD_DORMANT_CONTEXT', default: 150_000, min: 1, max: 1e9, scale: 1 },
  { field: 'dormantMax', env: 'AGENT_GUARD_DORMANT_MAX', default: 1, min: 0, max: 1000, scale: 1 },
  { field: 'failureMax', env: 'AGENT_GUARD_TOOL_FAILURE_MAX', default: 3, min: 1, max: 1000, scale: 1 },
  { field: 'fuseMax', env: 'AGENT_GUARD_FUSE_MAX', default: 5, min: 1, max: 1000, scale: 1 },
  { field: 'fuseMs', env: 'AGENT_GUARD_FUSE_SECONDS', default: 600, min: 10, max: 86_400, scale: SECONDS },
  { field: 'peerTtlMs', env: 'AGENT_GUARD_PEER_TTL_SECONDS', default: 900, min: 60, max: 86_400, scale: SECONDS },
  { field: 'journalDays', env: 'AGENT_GUARD_JOURNAL_DAYS', default: 90, min: 1, max: 3650, scale: 1 },
]

export const SWITCHES = { enabled: 'AGENT_GUARD', journal: 'AGENT_GUARD_JOURNAL' } as const

const OFF = new Set(['0', 'false', 'off', 'no'])

export function defaultConfig(): Config {
  const config = { enabled: true, journal: true } as Config
  for (const spec of SPECS) config[spec.field] = spec.default * spec.scale
  return config
}

/**
 * Builds the config from variables by name. Unset variables take their
 * defaults; a value that is not a number in range is reported in `problems`
 * and falls back to the default, so a typo never disables a protection.
 */
export function parseConfig(vars: Readonly<Record<string, string | undefined>>): {
  config: Config
  problems: string[]
} {
  const config = defaultConfig()
  const problems: string[] = []
  for (const [field, name] of Object.entries(SWITCHES) as [keyof typeof SWITCHES, string][]) {
    const raw = vars[name]?.trim().toLowerCase()
    if (raw) config[field] = !OFF.has(raw)
  }
  for (const spec of SPECS) {
    const raw = vars[spec.env]?.trim()
    if (!raw) continue
    const value = Number(raw.replaceAll('_', ''))
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
      problems.push(`${spec.env}=${raw} is not a number from ${spec.min} to ${spec.max}; using ${spec.default}`)
      continue
    }
    config[spec.field] = Math.round(value * spec.scale)
  }
  if (config.limitDenyPercent < config.limitAskPercent) {
    problems.push(
      `AGENT_GUARD_LIMIT_DENY_PERCENT is below AGENT_GUARD_LIMIT_ASK_PERCENT; new agents are refused from ${config.limitDenyPercent}%`,
    )
  }
  return { config, problems }
}
