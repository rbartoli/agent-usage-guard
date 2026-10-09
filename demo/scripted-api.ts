// A scripted stand-in for the Anthropic Messages API, for the README demo.
// Claude Code talks to it instead of Claude, so the recording shows Claude
// Code's real interface and the guard's real questions, needs no account, and
// spends no usage. Each prompt below selects a script: the replies, tool calls
// and token counts Claude Code receives, one reply per model request.
//
//   node demo/scripted-api.ts <working directory>
//
// It listens on a free local port and prints the port.

import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'

type ToolCall = { name: string; input: Record<string, unknown> }
/** One model response. `context` is the input side Claude Code reports as the conversation's size. */
type Reply = { text?: string; tools?: ToolCall[]; context: number; delayMs?: number }
type Script = { prompt: string; replies: Reply[] }
type Block = { type: string; text?: string }
type Message = { role: string; content: string | Block[] }

const workdir = process.argv[2]
if (!workdir) throw new Error('usage: node demo/scripted-api.ts <working directory>')
const file = (path: string, more: Record<string, unknown> = {}): ToolCall => ({ name: 'Read', input: { file_path: `${workdir}/${path}`, ...more } })
const grep = (pattern: string): ToolCall => ({ name: 'Bash', input: { command: `grep -rn ${pattern} src`, description: `Find ${pattern}` } })
const agent = (description: string, prompt: string): ToolCall => ({ name: 'Agent', input: { description, prompt } })

const AUDITS = [
  ['Audit session cookies', 'Audit how src/auth.py sets session cookie flags.'],
  ['Audit cookie lifetime', 'Audit cookie lifetime handling in src/auth.py.'],
  ['Audit note lookup', 'Audit the note lookup query in src/database.py.'],
  ['Audit container hardening', 'Audit deploy/Dockerfile for container hardening.'],
  ['Audit README claims', 'Audit the security claims in README.md.'],
] as const

const RECHECKS = [
  ['Re-check the cookie flag', 'Re-check the Secure flag finding in src/auth.py.', 'src/auth.py'],
  ['Re-check the SQL query', 'Re-check the SQL injection finding in src/database.py.', 'src/database.py'],
  ['Re-check the container user', 'Re-check the root user finding in deploy/Dockerfile.', 'deploy/Dockerfile'],
  ['Re-check the README claim', 'Re-check the cookie claim in README.md.', 'README.md'],
] as const

const SCRIPTS: Script[] = [
  // Scene 1: a long session, resumed two hours later.
  {
    prompt: 'Map how session cookies flow through the auth code',
    replies: [
      { text: "I'll trace the cookie path from sign-in to response.", tools: [file('src/auth.py'), file('src/database.py')], context: 481_200 },
      { tools: [file('README.md'), grep('secure')], context: 483_600 },
      {
        text: [
          'Cookies come from build_session_cookie() in src/auth.py:',
          '- secure is hard-coded to False, so CookieSettings.secure_cookies is never read.',
          '- The lifetime comes from CookieSettings.lifetime_seconds, 3600 by default.',
          '- src/database.py never touches sessions.',
          '- README.md says cookies are always Secure, which is false today.',
        ].join('\n'),
        context: 484_700,
      },
    ],
  },
  {
    prompt: 'Which tests cover it?',
    replies: [
      { tools: [file('tests/test_auth.py')], context: 485_300 },
      { text: 'Only tests/test_auth.py. It expects a Secure cookie when secure_cookies is True, so it fails until the flag is wired through.', context: 485_600 },
    ],
  },
  {
    prompt: 'Wire secure_cookies through',
    replies: [{ text: 'build_session_cookie() now takes secure from CookieSettings.secure_cookies, and the README says cookies are Secure only when it is set.', context: 23_400 }],
  },

  // Scene 2: five parallel audits against a limit of four.
  {
    prompt: 'What does this release candidate change',
    replies: [
      { tools: [file('src/auth.py'), file('src/database.py'), file('deploy/Dockerfile'), file('README.md')], context: 58_300 },
      {
        text: [
          'Four areas changed:',
          '- src/auth.py issues a session cookie at sign-in.',
          '- src/database.py loads a note by owner and id.',
          '- deploy/Dockerfile builds the API on python:3.13-slim.',
          '- README.md adds a claim that cookies are always Secure.',
        ].join('\n'),
        context: 61_900,
      },
    ],
  },
  {
    prompt: 'Which of those areas have tests?',
    replies: [{ text: 'Only session cookies, through tests/test_auth.py. Note lookup, the container image\nand the README claims have none.', context: 62_400 }],
  },
  {
    prompt: 'Anything risky in the database change?',
    replies: [{ text: 'Yes: load_note() builds its SQL with an f-string, so owner_id and note_id are\ninjectable.', context: 62_600 }],
  },
  {
    prompt: 'Audit the release candidate',
    replies: [
      { text: 'Starting one audit per area, in parallel.', tools: AUDITS.map(([d, p]) => agent(d, p)), context: 62_800 },
      { text: 'Four audits are running. You held the README audit; I will start it when one of them finishes.', context: 71_500 },
    ],
  },
  // The audits are still running when the scene ends, as the reply above says.
  ...AUDITS.map(([, prompt]): Script => ({
    prompt,
    replies: [
      { tools: [file(prompt.includes('Dockerfile') ? 'deploy/Dockerfile' : prompt.includes('database') ? 'src/database.py' : prompt.includes('README') ? 'README.md' : 'src/auth.py')], context: 9_400, delayMs: 1_500 },
      { text: 'Done: one finding, reported to the main conversation.', context: 10_900, delayMs: 30_000 },
    ],
  })),

  // Scene 3: a run of tool calls at 431k context.
  {
    prompt: 'List every cookie attribute the code sets',
    replies: [
      { tools: [file('src/auth.py'), file('src/database.py')], context: 428_900 },
      {
        text: [
          'build_session_cookie() in src/auth.py sets five attributes:',
          '- value: the session token',
          '- httponly: True',
          '- secure: False, hard-coded',
          '- samesite: "lax"',
          '- max_age: CookieSettings.lifetime_seconds',
        ].join('\n'),
        context: 430_700,
      },
    ],
  },
  {
    prompt: 'Where is CookieSettings constructed?',
    replies: [
      { tools: [grep('CookieSettings')], context: 430_900 },
      { text: 'Only in tests/test_auth.py. The app never builds one, so the defaults always apply.', context: 431_000 },
    ],
  },
  {
    prompt: 'Is samesite set anywhere else?',
    replies: [{ text: 'No. build_session_cookie() is the only place, and it fixes samesite to "lax".', context: 431_100 }],
  },
  {
    prompt: 'Check every caller before we change the cookie flags',
    replies: [
      ...['cookie', 'secure', 'samesite', 'httponly', 'max_age', 'lifetime', 'session', 'token', 'CookieSettings', 'build_session_cookie'].flatMap((pattern, i) => [
        { tools: [grep(pattern)], context: 431_000 + i * 240, delayMs: 100 },
        { tools: [file(i % 2 ? 'src/database.py' : 'src/auth.py', { offset: 1 + (i % 4) * 5, limit: 6 })], context: 431_120 + i * 240, delayMs: 100 },
      ]),
      { tools: [file('README.md')], context: 433_500 },
      { text: 'Every caller goes through build_session_cookie(), so the change stays in src/auth.py.', context: 433_800 },
    ],
  },

  // Scene 4: four agents process 10.9M tokens, and Claude asks for one more.
  {
    prompt: 'Summarise the security review so far.',
    replies: [
      {
        text: [
          'Four findings so far:',
          '- Session cookies are never Secure (src/auth.py).',
          '- load_note() builds its SQL with an f-string (src/database.py).',
          '- The container runs as root (deploy/Dockerfile).',
          '- README.md overstates cookie security.',
          '',
          'Each one sits in a single file.',
        ].join('\n'),
        context: 212_400,
      },
    ],
  },
  { prompt: 'Which of them are confirmed?', replies: [{ text: 'All four, each by reading the code.\nNone has a fix yet.', context: 212_900 }] },
  { prompt: 'Is anything still unreviewed?', replies: [{ text: 'Only deploy settings outside the Dockerfile,\nand this repository has none.', context: 213_300 }] },
  {
    prompt: 'Re-check each finding with its own agent',
    replies: [
      { text: 'Re-checking the four findings in parallel.', tools: RECHECKS.map(([d, p]) => agent(d, p)), context: 214_100 },
      { text: 'All four are confirmed. Starting one more agent to draft the fixes.', tools: [agent('Draft the fixes', 'Draft a fix for each confirmed finding.')], context: 221_800, delayMs: 3_200 },
      { text: 'Holding off on the fixes agent. The four findings are confirmed, so pick the first fix and I will draft it here.', context: 222_600 },
    ],
  },
  ...RECHECKS.map(([, prompt, path]): Script => ({
    prompt,
    replies: [
      ...[300_000, 380_000, 440_000, 500_000, 540_000].map((context, i) => ({ tools: [file(path, { offset: 1 + i * 4, limit: 8 })], context, delayMs: 250 })),
      { text: 'Confirmed: the finding stands.', context: 560_000, delayMs: 250 },
    ],
  })),
]

const SUMMARY = [
  '<analysis>The user is refactoring session cookies in a small API.</analysis>',
  '<summary>',
  'The user is refactoring how the fictional Northstar Notes API sets session cookies.',
  'build_session_cookie() in src/auth.py hard-codes secure=False and ignores CookieSettings.secure_cookies.',
  'README.md claims cookies are always Secure.',
  '</summary>',
].join('\n')

function textOf(content: string | Block[]): string {
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
}

/** The reply for a request: by the latest user prompt a script knows, and how many replies followed it. */
function replyFor(messages: Message[]): Reply {
  const asked = messages.findLast((m) => m.role === 'user')
  if (asked && textOf(asked.content).includes('CRITICAL: Respond with TEXT ONLY')) return { text: SUMMARY, context: 18_600, delayMs: 2_000 }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const text = textOf(message.content)
    const script = SCRIPTS.find((s) => text.includes(s.prompt))
    if (!script) continue
    const step = messages.slice(i + 1).filter((m) => m.role === 'assistant').length
    return script.replies[Math.min(step, script.replies.length - 1)]!
  }
  return { text: 'OK.', context: 2_000 }
}

let ids = 0
/** The reply as a Messages API message. */
function message(reply: Reply, model: string) {
  const content: Array<Record<string, unknown>> = []
  if (reply.text) content.push({ type: 'text', text: reply.text })
  for (const tool of reply.tools ?? []) content.push({ type: 'tool_use', id: `toolu_demo_${++ids}`, name: tool.name, input: tool.input })
  return {
    id: `msg_demo_${++ids}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: reply.tools?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1_400, cache_creation_input_tokens: 600, cache_read_input_tokens: reply.context - 2_000, output_tokens: 160 },
  }
}

/** The same message as the stream of server-sent events Claude Code reads. */
function events(m: ReturnType<typeof message>): string {
  const out: Array<Record<string, unknown>> = [{ type: 'message_start', message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } }]
  m.content.forEach((block, index) => {
    const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    out.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
    out.push({ type: 'content_block_delta', index, delta })
    out.push({ type: 'content_block_stop', index })
  })
  out.push({ type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } })
  out.push({ type: 'message_stop' })
  return out.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const request = await body(req)
  if (path === '/v1/messages/count_tokens') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 2_000 }))
    return
  }
  if (path !== '/v1/messages') {
    res.writeHead(404).end()
    return
  }
  const reply = replyFor((request.messages as Message[] | undefined) ?? [])
  // DEMO_API_LOG=<file> records what each request was answered with.
  if (process.env.DEMO_API_LOG) appendFileSync(process.env.DEMO_API_LOG, `${JSON.stringify({ reply: reply.text?.slice(0, 60) ?? reply.tools?.map((t) => t.name) })}\n`)
  if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
  const m = message(reply, String(request.model))
  if (request.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events(m))
  else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(m))
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log(typeof address === 'object' && address ? address.port : '')
})
