// The harness-agnostic core of agent-usage-guard. It performs no I/O and reads
// no clock: an adapter reports facts, asks for verdicts, and carries them out.
// See docs/architecture.md for the contract an adapter keeps.

export { AGENT_ALLOW, AGENT_REFUSE, type AgentRequest, agentGate, heldForQuestion, highestLimit, resolveAgentAsk } from './agents.ts'
export { type Command, DEFAULT_ALLOW_MINUTES, applyOverride, helpText, parseCommand, resumeGuard } from './commands.ts'
export { type Config, SPECS, SWITCHES, defaultConfig, parseConfig } from './config.ts'
export {
  type JournalEvent,
  type JournalRow,
  expiredJournalKeys,
  formatReport,
  isJournalKey,
  isJournalRow,
  journalKey,
  journalKeysSince,
} from './journal.ts'
export { lockoutKind } from './lockout.ts'
export {
  type SpawnFacts,
  type TokenUsage,
  contextOf,
  expireAgents,
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
  releaseStart,
  reserveStart,
} from './observe.ts'
export {
  PROMPT_CANCEL,
  PROMPT_COMPACT,
  PROMPT_SEND,
  type PromptOutcome,
  type PromptRequest,
  type PromptSource,
  contextNote,
  markerScope,
  promptGate,
  resolvePromptAsk,
} from './prompts.ts'
export {
  type AgentKind,
  type AgentRecord,
  type LimitReading,
  type LoopId,
  MAIN,
  type PeerRecord,
  type Scope,
  type SessionState,
  livePeers,
  newSession,
  peerRecord,
  prune,
} from './state.ts'
export { USAGE, statusLine, statusReport } from './status.ts'
export { canonical, contextBucket, fingerprint } from './text.ts'
export {
  EXEMPT_TOOLS,
  HEAVY_COMPACT,
  HEAVY_CONTINUE,
  HEAVY_STOP,
  HEAVY_STOP_AGENT,
  type HeavyOutcome,
  type ToolRequest,
  resolveHeavyAsk,
  toolGate,
} from './tools.ts'
export { type Ask, type Family, HEADER, type Rule, SIGNATURE, type Verdict } from './verdict.ts'
