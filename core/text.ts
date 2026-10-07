// Formatting shared by every message the guard writes.

/** `1 agent`, `4 agents`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}

/** Local wall-clock time, `14:32:07`. */
export function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** Local time without seconds, `14:32`. */
export function shortClock(ms: number): string {
  return clock(ms).slice(0, 5)
}

/** `45 s`, `12 min`, `2 h 5 min`. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  spend_limit: 'spend',
}

export function windowName(kind: string): string {
  return WINDOW_NAMES[kind] ?? kind.replaceAll('_', ' ')
}

/** Coarse context bucket for the journal, never an exact figure. */
export function contextBucket(n: number | undefined): string | undefined {
  if (n === undefined) return undefined
  if (n < 150_000) return '<150k'
  if (n < 300_000) return '150-300k'
  if (n < 400_000) return '300-400k'
  if (n < 500_000) return '400-500k'
  return '>=500k'
}

/** FNV-1a over the text, as 13 base-36 digits. Identifies a call without storing it. */
export function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(36).padStart(13, '0')
}

/** JSON with sorted keys, so equal inputs give equal fingerprints. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
