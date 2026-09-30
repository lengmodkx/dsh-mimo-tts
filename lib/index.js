/**
 * dsh-mimo-tts — host (Node) half.
 *
 * Bridges Xiaomi MiMo TTS into DeepSeek Harness:
 *
 * - `POST /dsh-mimo-tts/speak`  { text, voice? }        → synthesizes and answers with a playable data URL
 * - `POST /dsh-mimo-tts/speak-last` { sessionId? }      → speaks the last assistant answer of that session
 * - `GET  /dsh-mimo-tts/status`                         → key presence, voice list, current config
 * - `POST /dsh-mimo-tts/config` { voice?, autoRead? }   → persists preferences
 * - `GET  /dsh-mimo-tts/pending?since=N`                → drains the auto-read queue (client player polls this)
 *
 * Auto-read listens to the `agent/assistant-stream` feed, folds `text-delta`
 * chunks per session, and (when enabled) synthesizes the finished answer into
 * the queue the browser half plays.
 *
 * The API key comes from `XIAOMI_TOKEN_PLAN_CN_API_KEY`, or from the same
 * `refs:` section of `$DSH_HOME/.credentials.yaml` that the LLM providers read;
 * it never leaves this process.
 *
 * @module dsh-mimo-tts
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Plugin identity for cordis rows. */
export const name = 'dsh-mimo-tts'

/** Services required before mounting: only the webserver routes. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE = '/dsh-mimo-tts'

/** Token-plan CN host — the only host that accepts `tp-` keys. */
const ENDPOINT = 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions'

/** Built-in MiMo TTS model (voice clone / voice design stay on the CLI for now). */
const MODEL = 'mimo-v2.5-tts'

/** Built-in voices the model accepts. */
const VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']

/**
 * The cloned voice: `mimo-v2.5-tts-voiceclone` driven by a local reference
 * sample (`<state>/voice-clone.mp3`), so any 5–15 s of clean speech becomes a
 * selectable voice next to the built-in ones.
 */
export const CLONE_VOICE = '克隆音色'
const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
/** Configs written before the rename (and hand-written requests) may use these. */
const CLONE_ALIASES = ['御姐（克隆）', '克隆', 'clone', 'cloned']

/** Whether a voice value means "use the local reference sample". */
function isCloneVoice(voice) {
  return voice === CLONE_VOICE || CLONE_ALIASES.includes(voice)
}

/** Every voice the panel offers: the built-ins plus the clone slot. */
function voiceChoices() {
  return [...VOICES, CLONE_VOICE]
}

/** Where the clone reference lives. */
function cloneSamplePath() {
  return join(stateDir(), 'voice-clone.mp3')
}

/** Preference defaults. */
const DEFAULTS = { voice: '冰糖', autoRead: false, maxChars: 600, format: 'mp3' }

/** How many finished utterances stay queued for the browser player. */
const QUEUE_CAP = 24

/** Per-session accumulated answer, and how long silence finalizes it without an `end` frame. */
const SETTLE_MS = 1500
const BUFFER_CAP = 4000

/** MiMo answers a request with SSE chunks we do not use; TTS is one shot. */
const SPEAK_TIMEOUT_MS = 60000

/** Speech recognition: same host and key as the voices. */
const ASR_MODEL = 'mimo-v2.5-asr'

/** A held-to-talk clip, bounded before it reaches the heap. */
const ASR_MAX_BYTES = 12 * 1024 * 1024

/** Absolute path of the DSH home this process reads credentials from. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** State directory owned by this plugin. */
function stateDir() {
  return join(dshHome(), '.dsh-mimo-tts')
}

/** Preferences file owned by this plugin. */
function configFile() {
  return join(stateDir(), 'config.json')
}

/** Read preferences, falling back to defaults on every failure. */
function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8'))
    const merged = { ...DEFAULTS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
    if (CLONE_ALIASES.includes(merged.voice)) merged.voice = CLONE_VOICE
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

/** Persist a preference patch and return the merged value. */
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(configFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    /* a read-only home must not break speaking */
  }
  return next
}

/**
 * The MiMo token-plan key: the process environment first, then the `refs:`
 * section of the DSH credentials file, which is where the desktop app keeps it.
 */
function apiKey() {
  const fromEnv = process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = /^\s*XIAOMI_TOKEN_PLAN_CN_API_KEY:\s*(\S+)\s*$/m.exec(text)
    if (match !== null) return match[1]
  } catch {
    /* no credentials file: reported as a missing key by /status */
  }
  return undefined
}

/**
 * Turn an answer into speech-friendly prose: code, tables, links and markdown
 * scaffolding are dropped so she does not read punctuation aloud.
 * @param text - raw assistant text.
 * @returns the text to synthesize.
 */
export function speakableText(text) {
  let out = String(text ?? '')
  out = out.replace(/```[\s\S]*?```/g, ' 代码略过 ')
  out = out.replace(/`([^`]*)`/g, '$1')
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/https?:\/\/\S+/g, '')
  out = out.replace(/^\s*\|.*\|\s*$/gm, '')
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  out = out.replace(/^\s*[-*+]\s+/gm, '')
  out = out.replace(/^\s*>\s?/gm, '')
  out = out.replace(/[*_~]/g, '')
  out = out.replace(/\s*\n\s*\n\s*/g, '。')
  out = out.replace(/\s+/g, ' ').trim()
  return out
}

/**
 * Synthesize one utterance through MiMo TTS.
 * @param text - text to speak.
 * @param voice - built-in voice id.
 * @param format - `mp3` (default) or `wav`.
 * @returns the base64 payload, its mime type, the model's transcript and timing.
 */
export async function synthesize(text, voice, format = 'mp3') {
  const key = apiKey()
  if (key === undefined) throw new Error('未找到 XIAOMI_TOKEN_PLAN_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）')
  const spoken = speakableText(text)
  if (spoken === '') throw new Error('文本为空，没什么可念的')
  // A cloned voice is the voiceclone model plus a local reference sample, sent
  // as a data URL on every request — MiMo has no server-side voice registry.
  const chosen = voice ?? DEFAULTS.voice
  let model = MODEL
  let voiceField = chosen
  if (isCloneVoice(chosen)) {
    let sample
    try {
      sample = readFileSync(cloneSamplePath())
    } catch {
      throw new Error(`没有找到克隆参考音频：${cloneSamplePath()}（放一段 5~15 秒的干净人声进去即可）`)
    }
    model = CLONE_MODEL
    voiceField = `data:audio/mpeg;base64,${sample.toString('base64')}`
  }
  const body = {
    model,
    messages: [{ role: 'assistant', content: spoken }],
    audio: { format, voice: voiceField }
  }
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS)
  let payload
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`MiMo TTS ${String(response.status)}: ${raw.slice(0, 300)}`)
    payload = JSON.parse(raw)
  } finally {
    clearTimeout(timer)
  }
  const audio = payload?.choices?.[0]?.message?.audio
  if (audio === undefined || typeof audio.data !== 'string' || audio.data === '') {
    throw new Error('MiMo TTS 没有返回音频数据')
  }
  const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg'
  return {
    audio: `data:${mime};base64,${audio.data}`,
    transcript: typeof audio.transcript === 'string' ? audio.transcript : spoken,
    bytes: Math.floor((audio.data.length * 3) / 4),
    ms: Date.now() - started,
    model: payload?.model ?? MODEL,
    voice: voice ?? DEFAULTS.voice
  }
}

/**
 * Transcribe one clip through MiMo ASR.
 *
 * The model takes mp3 or wav only, which is why the browser half re-encodes a
 * `MediaRecorder` clip to 16 kHz mono wav before posting it here.
 * @param buffer - the audio bytes.
 * @param format - `wav` or `mp3`.
 * @returns the recognized text and timing.
 */
export async function transcribe(buffer, format = 'wav') {
  const key = apiKey()
  if (key === undefined) throw new Error('未找到 XIAOMI_TOKEN_PLAN_CN_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）')
  if (buffer.length === 0) throw new Error('没有收到音频数据')
  if (buffer.length > ASR_MAX_BYTES) throw new Error('录音太长了')
  const mime = format === 'mp3' ? 'audio/mp3' : 'audio/wav'
  const body = {
    model: ASR_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: `data:${mime};base64,${buffer.toString('base64')}`, format } }
        ]
      }
    ],
    asr_options: { language: 'zh' }
  }
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS)
  let payload
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`MiMo ASR ${String(response.status)}: ${raw.slice(0, 300)}`)
    payload = JSON.parse(raw)
  } finally {
    clearTimeout(timer)
  }
  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('MiMo ASR 没有返回文本')
  return { text: text.trim(), ms: Date.now() - started, bytes: buffer.length, model: payload?.model ?? ASR_MODEL }
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** Read a JSON request body, bounded so a stuck client cannot grow the heap. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not JSON')
  }
}

/**
 * Host half body: the queue, the auto-read listener and the HTTP surface.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const queue = []
  let seq = 0
  const buffers = new Map()
  const lastText = new Map()

  /** Append a finished utterance to the browser player's queue. */
  const enqueue = (item) => {
    seq += 1
    const record = { seq, at: Date.now(), ...item }
    queue.push(record)
    if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP)
    return record
  }

  /** Synthesize and queue one finished answer, swallowing failures into the log. */
  const speakInto = async (sessionId, text) => {
    const clean = speakableText(text)
    if (clean === '') return
    const config = readConfig()
    const clipped = clean.length > config.maxChars ? `${clean.slice(0, config.maxChars)}…` : clean
    try {
      const result = await synthesize(clipped, config.voice, config.format)
      enqueue({ sessionId, audio: result.audio, transcript: result.transcript, bytes: result.bytes, ms: result.ms })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mimo-tts] 自动朗读失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const finalize = (sessionId) => {
    const buffer = buffers.get(sessionId)
    if (buffer === undefined) return
    buffers.delete(sessionId)
    if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    const text = buffer.text.trim()
    if (text === '') return
    lastText.set(sessionId, text)
    if (readConfig().autoRead) void speakInto(sessionId, text)
  }

  const off = ctx.on('agent/assistant-stream', (payload) => {
    const record = payload
    const frame = record?.frame
    if (frame === undefined) return
    const sessionId = record?.agent?.session?.id
    if (typeof sessionId !== 'string') return
    const type = frame.type
    if (type === 'end') {
      finalize(sessionId)
      return
    }
    if (type === 'start') {
      const existing = buffers.get(sessionId)
      if (existing?.timer !== undefined) clearTimeout(existing.timer)
      buffers.set(sessionId, { text: '', timer: undefined })
      return
    }
    if (type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
    const buffer = buffers.get(sessionId) ?? { text: '', timer: undefined }
    buffer.text = (buffer.text + chunk.text).slice(-BUFFER_CAP)
    if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    buffer.timer = setTimeout(() => finalize(sessionId), SETTLE_MS)
    buffers.set(sessionId, buffer)
  })
  ctx.effect(() => () => {
    off()
    for (const buffer of buffers.values()) if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    buffers.clear()
  }, 'dsh-mimo-tts: assistant stream listener')

  const router = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : '/'
    const method = req.method ?? 'GET'
    // Browser-trust fence: this route can spend the user's MiMo quota and read
    // back the transcription queue, so a page on the open internet must not be
    // able to call it. A cross-site request always carries an `Origin`; native
    // callers (the DSH renderer, curl, tests) either send a loopback origin or
    // none at all. `DSH_MIMO_TTS_ORIGINS` extends the allow-list when a
    // deployment serves the GUI from another host.
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      let allowed = false
      try {
        const parsed = new URL(origin)
        const extra = (process.env.DSH_MIMO_TTS_ORIGINS ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
        allowed =
          parsed.protocol === 'dsh-app:' ||
          parsed.protocol === 'file:' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === 'localhost' ||
          parsed.hostname === '[::1]' ||
          parsed.hostname === '::1' ||
          extra.includes(origin)
      } catch {
        allowed = false
      }
      if (!allowed) {
        sendJson(res, 403, { ok: false, error: 'forbidden origin' })
        return
      }
    }
    try {
      if (method === 'GET' && (route === '/status' || route === '/')) {
        sendJson(res, 200, {
          ok: true,
          version: '0.1.0',
          keyPresent: apiKey() !== undefined,
          model: MODEL,
          asrModel: ASR_MODEL,
          cloneModel: CLONE_MODEL,
          voices: voiceChoices(),
          clone: (() => {
            try {
              return { path: cloneSamplePath(), present: true, bytes: statSync(cloneSamplePath()).size }
            } catch {
              return { path: cloneSamplePath(), present: false, bytes: 0 }
            }
          })(),
          config: readConfig(),
          queued: queue.length,
          latest: seq,
          sessions: [...lastText.keys()]
        })
        return
      }
      if (method === 'GET' && route === '/voices') {
        sendJson(res, 200, { ok: true, voices: voiceChoices() })
        return
      }
      if (method === 'POST' && route === '/asr') {
        // Raw audio body: `audio/wav` (what the browser half sends after
        // re-encoding) or `audio/mpeg`. Anything else is refused, because the
        // model only accepts those two containers.
        const contentType = String(req.headers['content-type'] ?? '')
        const format = contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3' : 'wav'
        if (!contentType.includes('audio/')) {
          sendJson(res, 415, { ok: false, error: 'content-type must be audio/wav or audio/mpeg' })
          return
        }
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > ASR_MAX_BYTES) {
            sendJson(res, 413, { ok: false, error: '录音太长了' })
            return
          }
          chunks.push(chunk)
        }
        const result = await transcribe(Buffer.concat(chunks), format)
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (method === 'POST' && route === '/config') {
        const body = await readJsonBody(req)
        const patch = {}
        if (typeof body.voice === 'string' && voiceChoices().includes(body.voice)) patch.voice = body.voice
        if (typeof body.autoRead === 'boolean') patch.autoRead = body.autoRead
        if (typeof body.maxChars === 'number' && Number.isFinite(body.maxChars)) patch.maxChars = Math.max(60, Math.min(2000, Math.round(body.maxChars)))
        sendJson(res, 200, { ok: true, config: writeConfig(patch) })
        return
      }
      if (method === 'POST' && route === '/speak') {
        const body = await readJsonBody(req)
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'text is required' })
          return
        }
        const config = readConfig()
        const voice = typeof body.voice === 'string' && voiceChoices().includes(body.voice) ? body.voice : config.voice
        const result = await synthesize(body.text, voice, config.format)
        if (body.queue === true) enqueue({ sessionId: body.sessionId, ...result })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (method === 'POST' && route === '/speak-last') {
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : [...lastText.keys()].at(-1)
        const text = sessionId === undefined ? undefined : lastText.get(sessionId)
        if (text === undefined) {
          sendJson(res, 404, { ok: false, error: '这个会话还没有可朗读的回复' })
          return
        }
        const result = await synthesize(text, readConfig().voice, readConfig().format)
        if (body.queue === true) enqueue({ sessionId, ...result })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (method === 'GET' && route === '/pending') {
        const raw = url.searchParams.get('since')
        if (raw === null) {
          sendJson(res, 200, { ok: true, latest: seq, items: [] })
          return
        }
        const since = Number.parseInt(raw, 10)
        if (!Number.isFinite(since)) {
          sendJson(res, 400, { ok: false, error: 'since must be an integer' })
          return
        }
        sendJson(res, 200, { ok: true, latest: seq, items: queue.filter((item) => item.seq > since) })
        return
      }
      if (method === 'POST' && route === '/stop') {
        // Drop everything still queued: the player pauses its own audio, and
        // this makes sure the sentences behind it do not follow.
        const cleared = queue.length
        queue.length = 0
        sendJson(res, 200, { ok: true, cleared, latest: seq })
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${method} ${route}` })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: router }), 'dsh-mimo-tts: routes')
}
