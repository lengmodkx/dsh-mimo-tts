/**
 * Smoke test for the host half — no network, no API key required.
 *
 * It mounts the plugin against a stub context, then drives the real router:
 * the voice roster, the text sanitizer, the browser-trust fence, the queue
 * cursor and the request validation. `node test/smoke.mjs` exits non-zero on
 * the first failed expectation.
 *
 * With `DSH_MIMO_TTS_LIVE=1` it additionally performs one real synthesis and
 * one real transcription (that part does need a token-plan key).
 */
import { apply, name, inject, speakableText, CLONE_VOICE, synthesize, transcribe } from '../lib/index.js'

let failures = 0

/** Assert one expectation and report it either way. */
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Mount the plugin and capture its route table. */
function mount() {
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    logger: { warn: () => {} },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      }
    }
  }
  apply(ctx)
  return routes
}

/** Call one route the way the host's webserver would. */
function call(handler, url, method = 'GET', headers = {}, body) {
  return new Promise((resolve) => {
    const req = {
      url,
      method,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(body)
      }
    }
    const res = {
      statusCode: 0,
      writeHead(code) {
        this.statusCode = code
      },
      end(text) {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
        resolve({ code: this.statusCode, body: parsed })
      }
    }
    void handler(req, res)
  })
}

const routes = mount()
const route = routes[0]
console.log(`${name} — ${String(routes.length)} route(s), inject ${JSON.stringify(inject)}`)
check('one prefix route is registered', routes.length === 1 && route.kind === 'prefix', JSON.stringify(routes.map((entry) => entry.path)))
check('route path is the plugin prefix', route.path === '/dsh-mimo-tts', route.path)

console.log('speakableText')
const spoken = speakableText('## 标题\n**粗体**与 `代码`\n\n```js\nx()\n```\n- 项目\n链接 https://a.b/c 结束')
check('markdown scaffolding is dropped', !spoken.includes('*') && !spoken.includes('#'), spoken)
check('code fences are announced, not read', spoken.includes('代码略过'), spoken)
check('urls are dropped', !spoken.includes('http'), spoken)

console.log('routes')
const status = await call(route.handler, '/dsh-mimo-tts/status')
check('status answers 200', status.code === 200, String(status.code))
check('status lists the clone slot', Array.isArray(status.body.voices) && status.body.voices.includes(CLONE_VOICE), JSON.stringify(status.body.voices))
check('status reports the clone sample path', typeof status.body.clone?.path === 'string', JSON.stringify(status.body.clone))
check('status reports the ASR model', typeof status.body.asrModel === 'string', JSON.stringify(status.body.asrModel))

console.log('browser-trust fence')
const evil = await call(route.handler, '/dsh-mimo-tts/status', 'GET', { origin: 'https://evil.example' })
check('a foreign origin is refused', evil.code === 403, `${String(evil.code)} ${JSON.stringify(evil.body)}`)
const local = await call(route.handler, '/dsh-mimo-tts/status', 'GET', { origin: 'http://127.0.0.1:19387' })
check('a loopback origin is allowed', local.code === 200, String(local.code))
const native = await call(route.handler, '/dsh-mimo-tts/status')
check('a caller without Origin is allowed', native.code === 200, String(native.code))

console.log('queue')
const stop = await call(route.handler, '/dsh-mimo-tts/stop', 'POST')
check('stop answers 200', stop.code === 200, String(stop.code))
const pending = await call(route.handler, '/dsh-mimo-tts/pending')
check('the first poll reports the cursor only', pending.code === 200 && Array.isArray(pending.body.items) && pending.body.items.length === 0, JSON.stringify(pending.body))
const badSince = await call(route.handler, '/dsh-mimo-tts/pending?since=abc')
check('a non-numeric cursor is refused', badSince.code === 400, String(badSince.code))
const unknown = await call(route.handler, '/dsh-mimo-tts/nope')
check('an unknown route is a 404', unknown.code === 404, String(unknown.code))

console.log('request validation')
const empty = await call(route.handler, '/dsh-mimo-tts/speak', 'POST', {}, JSON.stringify({ text: '  ' }))
check('empty text is refused before any request', empty.code === 400, `${String(empty.code)} ${JSON.stringify(empty.body)}`)
const badAudio = await call(route.handler, '/dsh-mimo-tts/asr', 'POST', { 'content-type': 'application/json' }, 'nope')
check('non-audio ASR bodies are refused', badAudio.code === 415, String(badAudio.code))

if (process.env.DSH_MIMO_TTS_LIVE === '1') {
  console.log('live MiMo round trip (needs a token-plan key)')
  const spokenOut = await synthesize('冒烟测试：我现在会说话了。', '冰糖')
  check('synthesis returns playable audio', spokenOut.audio.startsWith('data:audio/') && spokenOut.bytes > 2000, `${String(spokenOut.bytes)} bytes`)
  const wavOut = await synthesize('冒烟测试：把这句话再听回来。', '冰糖', 'wav')
  const heard = await transcribe(Buffer.from(wavOut.audio.split(',')[1], 'base64'), 'wav')
  check('transcription returns text', typeof heard.text === 'string' && heard.text.length > 0, heard.text)
  console.log(`       heard: ${heard.text}`)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
