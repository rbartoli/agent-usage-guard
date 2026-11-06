// The values this mod keeps in `$.state` for the session, which its band draws from.

export type Band = { text: string; alert: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-usage-guard': { band: Band | null }
  }
}
