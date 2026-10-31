// `/agent-guard simulate <rule>`: what a rule does, on made-up state, with the
// real gates. Nothing it builds touches the session's own state.

import { type AgentRequest, agentGate } from './agents.ts'
import type { Config } from './config.ts'
import { promptGate } from './prompts.ts'
import { type LimitReading, MAIN, loopOf, newSession } from './state.ts'
import { scheduleGate, toolGate } from './tools.ts'
import type { Verdict } from './verdict.ts'

export const SIMULATED = [
  'concurrency',
  'starts',
  'agent-tokens',
  'burn',
  'limit',
  'limit-deny',
  'schedule',
  'depth',
  'retry',
  'tool-budget',
  'prompt-context',
  'dormant',
] as const

export type SimulatedRule = (typeof SIMULATED)[number]

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The verdict `rule` gives on state built to trip it, as a session where `canAsk` holds would see it. */
export function simulate(rule: SimulatedRule, config: Config, now: number, canAsk: boolean): Verdict {
  const state = newSession('simulation', canAsk)
  const agent: AgentRequest = { loop: MAIN, depth: 1, resume: false }
  const fiveHour = (percent: number, at = now): LimitReading => ({ at, kind: 'five_hour', percent, resetsAt: now + 3 * HOUR })
  const main = loopOf(state, MAIN)
  switch (rule) {
    case 'concurrency':
      for (let i = 0; i < config.agentMax; i++) {
        state.agents[`simulated-${i}`] = { id: `simulated-${i}`, kind: 'subagent', depth: 1, running: true, startedAt: now }
      }
      return agentGate(state, [], config, now, agent)
    case 'starts':
      state.starts = Array.from({ length: config.rollingMax }, () => now - MINUTE)
      return agentGate(state, [], config, now, agent)
    case 'agent-tokens':
      state.agentTokens = [[now - MINUTE, config.agentTokensMax]]
      return agentGate(state, [], config, now, agent)
    case 'burn': {
      const low = fiveHour(30, now - 5 * MINUTE)
      state.limits.five_hour = fiveHour(30 + config.burnPercent)
      state.limitHistory = [low, state.limits.five_hour]
      return agentGate(state, [], config, now, agent)
    }
    case 'limit':
      state.limits.five_hour = fiveHour(config.limitAskPercent)
      return agentGate(state, [], config, now, agent)
    case 'limit-deny':
      state.limits.five_hour = fiveHour(config.limitDenyPercent)
      return agentGate(state, [], config, now, agent)
    case 'schedule':
      state.limits.five_hour = fiveHour(config.limitDenyPercent)
      return scheduleGate(state, [], config, now, { loop: MAIN, tool: 'ScheduleWakeup', fingerprint: 'simulated', label: 'this conversation' })
    case 'depth':
      return agentGate(state, [], config, now, { ...agent, depth: config.depthMax + 1 })
    case 'retry':
      state.failures.simulated = { count: config.failureMax, last: now - MINUTE, loop: MAIN }
      return toolGate(state, config, now, { loop: MAIN, tool: 'Bash', fingerprint: 'simulated', label: 'this conversation' })
    case 'tool-budget':
      main.context = config.toolContext + 50_000
      main.heavyCalls = Array.from({ length: config.toolMax }, () => now - MINUTE)
      return toolGate(state, config, now, { loop: MAIN, tool: 'Read', fingerprint: 'simulated', label: 'this conversation' })
    case 'prompt-context':
      main.context = config.contextHard + 20_000
      return promptGate(state, [], config, now, { source: 'user', text: '' })
    case 'dormant':
      main.context = Math.min(config.dormantContext + 10_000, config.contextHard - 1)
      state.dormantResumes = Array.from({ length: config.dormantMax }, () => now - MINUTE)
      return promptGate(state, [], config, now, { source: 'user', text: '', idleMs: config.dormantMs + HOUR })
  }
}
