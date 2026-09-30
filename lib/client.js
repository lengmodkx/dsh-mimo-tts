/**
 * dsh-mimo-tts — browser half.
 *
 * Registers the market-style "MiMo 语音" page (a panel in the Plugins page and
 * a tab under Settings → Built-in plugins) and runs the player that speaks
 * whatever the host half queues: voice picker, auto-read toggle, a test box,
 * and "read the last answer" for the current session.
 *
 * Built by hand into the `__ModuleLoader__` factory bundle the host serves at
 * `./client`; react and react/jsx-runtime come from the host's module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mimo-tts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** The host's own mic glyph, when this host exposes it (else a text fallback). */
    let MicIcon
    let StopIcon
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      MicIcon = primitives?.IconMicrophoneOutlineRegular
      StopIcon = primitives?.IconStopFillRegular
    } catch {
      MicIcon = undefined
      StopIcon = undefined
    }    const reactNs = require('react')
    const React = reactNs && reactNs.default ? reactNs.default : reactNs
    const h = React.createElement

    /** Route prefix owned by the host half. */
    const API = '/dsh-mimo-tts'
    /** How often the player asks for newly queued speech. */
    const POLL_MS = 1200

    /** Player state shared by the page and the background poller. */
    const store = (() => {
      let state = { latest: 0, playing: false, lastTranscript: '', lastAt: 0, blocked: null, error: null, spoken: 0 }
      const listeners = new Set()
      return {
        get: () => state,
        set: (patch) => {
          state = { ...state, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    })()

    /** One JSON call against the host half. */
    async function call(path, init) {
      const response = await fetch(API + path, init)
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`响应不是 JSON：${text.slice(0, 120)}`)
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${String(response.status)}`)
      return payload
    }

    /** AudioContext, whichever name this Chromium exposes. */
    const AudioCtx = window.AudioContext || window.webkitAudioContext

    /**
     * Re-encode a recorded clip as 16 kHz mono wav.
     *
     * `MediaRecorder` only produces webm/opus (or mp4/aac), and MiMo ASR takes
     * mp3 or wav only — so the clip is decoded, resampled and written by hand.
     * @param blob - the recorded clip.
     * @param targetRate - sample rate to resample to.
     * @returns the wav bytes as a blob.
     */
    async function toWav(blob, targetRate = 16000) {
      const context = new AudioCtx()
      let decoded
      try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer())
      } finally {
        void context.close()
      }
      const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
      const offline = new OfflineAudioContext(1, frames, targetRate)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      const samples = rendered.getChannelData(0)
      const buffer = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(buffer)
      const text = (offset, value) => {
        for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
      }
      text(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, targetRate, true)
      view.setUint32(28, targetRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      let offset = 44
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    /** How long a quiet stretch ends a take on its own, and the hard ceiling. */
    const SILENCE_MS = 1400
    const MAX_TAKE_MS = 90000

    /**
     * Open the microphone and hand back a handle that stops and returns the clip.
     *
     * Click-to-talk needs an automatic end, so the mic is also watched with an
     * analyser: a stretch of silence (or the hard ceiling) finishes the take
     * exactly as the second click would.
     * @param options - `onSilence` fires when the take should end by itself.
     * @returns the stop/abort handle.
     */
    async function startRecording(options = {}) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
      const chunks = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      const stopped = new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
      })
      recorder.start()

      let watchdog
      let analysis
      try {
        analysis = new AudioCtx()
        const source = analysis.createMediaStreamSource(stream)
        const analyser = analysis.createAnalyser()
        analyser.fftSize = 2048
        source.connect(analyser)
        const frame = new Float32Array(analyser.fftSize)
        const startedAt = Date.now()
        let quietSince = Date.now()
        watchdog = setInterval(() => {
          analyser.getFloatTimeDomainData(frame)
          let peak = 0
          for (let index = 0; index < frame.length; index += 1) peak = Math.max(peak, Math.abs(frame[index]))
          if (peak > 0.02) quietSince = Date.now()
          const quiet = Date.now() - quietSince > SILENCE_MS
          const tooLong = Date.now() - startedAt > MAX_TAKE_MS
          if ((quiet && Date.now() - startedAt > 600) || tooLong) options.onSilence?.()
        }, 100)
      } catch {
        /* no analyser: the take simply waits for the next click */
      }

      const release = () => {
        if (watchdog !== undefined) clearInterval(watchdog)
        watchdog = undefined
        try {
          void analysis?.close()
        } catch {
          /* already closed */
        }
        for (const track of stream.getTracks()) track.stop()
      }

      return {
        stop: async () => {
          try {
            recorder.stop()
          } catch {
            /* already stopped */
          }
          const blob = await stopped
          release()
          return blob
        },
        abort: () => {
          try {
            recorder.stop()
          } catch {
            /* already stopped */
          }
          release()
        }
      }
    }

    /** Send one wav clip to the host half and return the transcript. */
    async function transcribe(blob) {
      const response = await fetch(`${API}/asr`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: blob
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${String(response.status)}`)
      return payload
    }

    /**
     * Put the transcript into the composer.
     *
     * The composer is a Lexical rich-text editor (`[data-conversation-region=
     * "composer"]` → `[contenteditable]`), not a textarea: writing `.value`
     * does nothing. So the text goes in the way a human would put it there —
     * `execCommand("insertText")` first, a synthetic paste event second.
     *
     * The two paths are strictly exclusive: Lexical commits to the DOM
     * asynchronously, so a synchronous read-back always looks like a failure
     * and running both paths inserts the sentence twice. Each attempt
     * therefore waits for the editor to actually contain the text.
     * @param value - text to place.
     * @returns which path worked: `editor`, `paste`, `textarea`, or `none`.
     */
    async function insertIntoComposer(value) {
      const region = document.querySelector('[data-conversation-region="composer"]')
      const editor =
        region?.querySelector('[contenteditable="true"]') ??
        [...document.querySelectorAll('[contenteditable="true"]')].filter((node) => node.offsetParent !== null).pop()
      if (editor !== undefined && editor !== null) {
        /** Poll until the editor's text contains what we asked for. */
        const settled = async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs
          for (;;) {
            if ((editor.textContent ?? '').includes(value)) return true
            if (Date.now() > deadline) return false
            await new Promise((resolve) => setTimeout(resolve, 40))
          }
        }
        try {
          editor.focus()
        } catch {
          /* focus is best effort */
        }
        try {
          document.execCommand('insertText', false, value)
        } catch {
          /* fall through to the paste path */
        }
        if (await settled(500)) return 'editor'
        try {
          const data = new DataTransfer()
          data.setData('text/plain', value)
          editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        } catch {
          /* fall through to the textarea path */
        }
        if (await settled(500)) return 'paste'
      }
      const areas = [...document.querySelectorAll('textarea')].filter((node) => !node.disabled && node.offsetParent !== null)
      const target = areas[areas.length - 1]
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (target === undefined || setter === undefined) return 'none'
      setter.call(target, value)
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.focus()
      return 'textarea'
    }

    /** The utterance playing right now, so a stop can actually cut it off. */
    let activeAudio = null
    /** Bumped by every stop: a drain loop from before the stop abandons the rest. */
    let stopEpoch = 0

    /** Play one utterance, reporting an autoplay refusal instead of swallowing it. */
    async function play(dataUrl, transcript) {
      const audio = new Audio(dataUrl)
      activeAudio = audio
      store.set({ playing: true })
      try {
        await audio.play()
        store.set({ lastTranscript: transcript ?? '', lastAt: Date.now(), blocked: null, error: null })
        await new Promise((resolve) => {
          audio.addEventListener('ended', resolve, { once: true })
          audio.addEventListener('error', resolve, { once: true })
        })
      } catch (error) {
        store.set({ blocked: { dataUrl, transcript }, error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (activeAudio === audio) activeAudio = null
        store.set({ playing: false })
      }
    }

    /**
     * Stop her mid-sentence and drop whatever is still queued: the browser
     * half pauses its own audio, the host half clears the queue, and the epoch
     * bump tells any in-flight drain loop to abandon the remaining items.
     * @returns how many queued utterances the host dropped.
     */
    async function stopSpeaking() {
      stopEpoch += 1
      const audio = activeAudio
      activeAudio = null
      if (audio !== null) {
        try {
          audio.pause()
          audio.currentTime = 0
        } catch {
          /* already finished */
        }
      }
      store.set({ playing: false, blocked: null })
      try {
        const payload = await call('/stop', { method: 'POST' })
        return typeof payload.cleared === 'number' ? payload.cleared : 0
      } catch {
        return 0
      }
    }

    /** Background poller: drains the host queue and speaks each item in order. */
    function startPlayer() {
      let cursor = null
      let disposed = false
      let busy = false
      const tick = async () => {
        if (disposed || busy) return
        busy = true
        try {
          const epoch = stopEpoch
          const payload = cursor === null ? await call('/pending') : await call(`/pending?since=${String(cursor)}`)
          if (cursor === null) {
            // First sync only: adopt the server's position so a reload never
            // replays what was already spoken.
            cursor = typeof payload.latest === 'number' ? payload.latest : 0
            return
          }
          for (const item of payload.items ?? []) {
            if (typeof item.seq === 'number') cursor = Math.max(cursor, item.seq)
            if (epoch !== stopEpoch) return
            store.set({ spoken: store.get().spoken + 1 })
            await play(item.audio, item.transcript)
            if (epoch !== stopEpoch) return
          }
        } catch (error) {
          store.set({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          busy = false
        }
      }
      const onKey = (event) => {
        if (event.key === 'Escape' && store.get().playing) void stopSpeaking()
      }
      window.addEventListener('keydown', onKey)
      const timer = setInterval(() => void tick(), POLL_MS)
      void tick()
      return () => {
        window.removeEventListener('keydown', onKey)
        disposed = true
        clearInterval(timer)
      }
    }

    const card = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      maxWidth: '760px',
      color: 'var(--dsw-alias-label-primary, inherit)'
    }
    const row = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }
    const button = (active) => ({
      font: 'inherit',
      fontSize: '13px',
      padding: '5px 12px',
      borderRadius: '8px',
      cursor: 'pointer',
      color: active ? 'var(--dsw-alias-label-primary, #111)' : 'var(--dsw-alias-label-secondary, #555)',
      background: active ? 'var(--dsw-alias-state-business-primary, #2f6fed)' : 'transparent',
      border: `1px solid ${active ? 'transparent' : 'var(--dsw-alias-border-l2, #d9d9d9)'}`
    })
    const hint = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', margin: 0 }
    const textarea = {
      font: 'inherit',
      fontSize: '13px',
      padding: '8px 10px',
      borderRadius: '8px',
      minHeight: '62px',
      resize: 'vertical',
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-base, transparent)',
      border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)'
    }

    /** The settings page: voice, auto-read, a test box and the player status. */
    function Panel(props) {
      const [, force] = React.useState(0)
      const [status, setStatus] = React.useState(null)
      const [draft, setDraft] = React.useState('今天也要好好吃饭，别又忙到忘记啦。')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [recording, setRecording] = React.useState(false)
      const clipRef = React.useRef(null)

      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])
      React.useEffect(() => {
        let alive = true
        call('/status')
          .then((payload) => {
            if (alive) setStatus(payload)
          })
          .catch((error) => {
            if (alive) setNote(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [])

      const player = store.get()
      const config = status?.config ?? { voice: '冰糖', autoRead: false }

      const patch = async (body, done) => {
        setBusy(true)
        setNote('')
        try {
          const payload = await call('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          setStatus((previous) => ({ ...(previous ?? {}), config: payload.config }))
          if (done !== undefined) done()
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const speak = async (text) => {
        setBusy(true)
        setNote('正在合成…')
        try {
          const payload = await call('/speak', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text })
          })
          setNote(`已合成 ${String(Math.round((payload.bytes ?? 0) / 1024))} KB / ${String(payload.ms ?? 0)} ms`)
          await play(payload.audio, payload.transcript)
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      /** Hold-to-talk: open the mic on press, transcribe and place the text on release. */
      const startTalk = async () => {
        if (recording) return
        setNote('正在打开麦克风…')
        try {
          clipRef.current = await startRecording()
          setRecording(true)
          setNote('录音中…松开结束')
        } catch (error) {
          clipRef.current = null
          setNote(`拿不到麦克风：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const stopTalk = async (cancel) => {
        const clip = clipRef.current
        clipRef.current = null
        setRecording(false)
        if (clip === null) return
        if (cancel === true) {
          clip.abort()
          setNote('已取消')
          return
        }
        setBusy(true)
        setNote('识别中…')
        try {
          const blob = await clip.stop()
          const wav = await toWav(blob)
          const result = await transcribe(wav)
          setDraft(result.text)
          const placed = await insertIntoComposer(result.text)
          setNote(
            placed === 'none'
              ? `听写完成：${result.text}（没找到输入框，已填在上面的试听框里）`
              : `听写完成（${String(result.ms)} ms）：${result.text} — 已放进输入框，回车发送`
          )
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      if (props?.view === 'summary') {
        return h(
          'span',
          null,
          `MiMo 语音 · 音色 ${config.voice} · 自动朗读${config.autoRead ? '开' : '关'}${status?.keyPresent === false ? ' · 未找到 API Key' : ''}`
        )
      }

      return h(
        'div',
        { style: card },
        h(
          'div',
          { style: row },
          h('strong', { style: { fontSize: '15px' } }, 'MiMo 语音'),
          h(
            'span',
            { style: { ...hint, color: status?.keyPresent === false ? '#d4483b' : hint.color } },
            status === null
              ? '读取中…'
              : status.keyPresent
                ? `Xiaomi Token Plan 已就绪 · ${status.model}`
                : '未找到 XIAOMI_TOKEN_PLAN_CN_API_KEY'
          ),
          player.playing ? h('span', { style: hint }, '· 正在朗读') : null,
          player.spoken > 0 ? h('span', { style: hint }, `· 已朗读 ${String(player.spoken)} 段`) : null
        ),
        h('p', { style: hint }, '她说话的声音。先用一个音色试听，满意了再打开自动朗读——打开后每条回复说完都会自动念出来。'),
        h(
          'div',
          { style: row },
          (status?.voices ?? ['冰糖']).map((voice) =>
            h(
              'button',
              {
                key: voice,
                type: 'button',
                disabled: busy,
                style: button(voice === config.voice),
                onClick: () => void patch({ voice }, () => void speak('这个音色听起来怎么样？喜欢的话我就一直用啦。'))
              },
              voice
            )
          )
        ),
        h(
          'div',
          { style: row },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              style: button(Boolean(config.autoRead)),
              onClick: () => void patch({ autoRead: !config.autoRead })
            },
            config.autoRead ? '自动朗读：开' : '自动朗读：关'
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              style: button(false),
              onClick: () => {
                setBusy(true)
                call('/speak-last', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({})
                })
                  .then((payload) => play(payload.audio, payload.transcript))
                  .catch((error) => setNote(error instanceof Error ? error.message : String(error)))
                  .finally(() => setBusy(false))
              }
            },
            '念最后一条回复'
          ),
          h(
            'button',
            { type: 'button', disabled: busy, style: button(false), onClick: () => void stopSpeaking() },
            '停止朗读'
          ),
          player.blocked !== null
            ? h(
                'button',
                {
                  type: 'button',
                  style: button(true),
                  onClick: () => {
                    const blocked = player.blocked
                    store.set({ blocked: null })
                    void play(blocked.dataUrl, blocked.transcript)
                  }
                },
                '浏览器拦下了自动播放，点这里出声'
              )
            : null
        ),
        h('textarea', {
          style: textarea,
          value: draft,
          onChange: (event) => setDraft(event.target.value),
          placeholder: '输入一句话试听，或者按住下面的麦克风直接说话'
        }),
        h(
          'div',
          { style: row },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              style: button(recording),
              onPointerDown: (event) => {
                event.preventDefault()
                void startTalk()
              },
              onPointerUp: () => void stopTalk(false),
              onPointerLeave: () => {
                if (clipRef.current !== null) void stopTalk(false)
              },
              onKeyDown: (event) => {
                if (event.key === ' ' || event.key === 'Enter') void startTalk()
              },
              onKeyUp: () => void stopTalk(false)
            },
            recording ? '● 松开结束' : '按住说话'
          ),
          h(
            'button',
            { type: 'button', disabled: busy || draft.trim() === '', style: button(true), onClick: () => void speak(draft) },
            busy ? '处理中…' : '试听'
          ),
          note !== '' ? h('span', { style: hint }, note) : null
        ),
        player.lastTranscript !== '' ? h('p', { style: hint }, `刚刚念的是：${player.lastTranscript.slice(0, 120)}`) : null,
        player.error !== null && note === '' ? h('p', { style: { ...hint, color: '#d4483b' } }, player.error) : null
      )
    }

    /**
     * The composer's own mic button: press and hold to talk, release to drop
     * the transcript into the input box. Lives in the input dock so it sits
     * next to the host's own composer controls instead of inside a page the
     * user has to go find.
     */
    function MicButton() {
      const [recording, setRecording] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [flash, setFlash] = React.useState('')
      const clip = React.useRef(null)

      const begin = async () => {
        if (recording || busy) return
        setFlash('')
        // Talking over her: opening the mic stops whatever she is saying and
        // drops the sentences still queued behind it.
        void stopSpeaking()
        try {
          // Click-to-talk: the take also ends by itself on a pause, so a
          // forgotten second click cannot record forever.
          clip.current = await startRecording({ onSilence: () => void end() })
          setRecording(true)
        } catch (error) {
          setFlash(`麦克风不可用：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const end = async () => {
        const handle = clip.current
        clip.current = null
        setRecording(false)
        if (handle === null) return
        setBusy(true)
        try {
          const wav = await toWav(await handle.stop())
          const result = await transcribe(wav)
          const placed = await insertIntoComposer(result.text)
          setFlash(placed === 'none' ? '识别到了，但没找到输入框（已复制到剪贴板）' : `已填入输入框（${placed}），回车发送`)
          if (placed === 'none' && navigator.clipboard) void navigator.clipboard.writeText(result.text)
        } catch (error) {
          setFlash(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
          setTimeout(() => setFlash(''), 4000)
        }
      }

      const label = recording ? '结束录音' : busy ? '识别中…' : '点击说话'
      const icon = (size, style) =>
        typeof MicIcon === 'function'
          ? h(MicIcon, { style: { width: `${String(size)}px`, height: `${String(size)}px`, ...style } })
          : h('span', { style: { fontSize: `${String(size)}px`, ...style } }, '🎙')
      return h(
        'div',
        { style: { position: 'relative', display: 'flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            title: flash !== '' ? flash : recording ? '点击结束，或直接停下不说话' : '点一下开始说话，再点一下结束',
            'aria-label': label,
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '30px',
              height: '30px',
              padding: 0,
              border: 'none',
              borderRadius: '8px',
              cursor: busy ? 'progress' : 'pointer',
              color: recording ? '#e5484d' : 'inherit',
              background: recording ? 'rgba(229,72,77,0.14)' : 'transparent',
              opacity: busy ? 0.6 : 1
            },
            onClick: () => {
              if (recording) void end()
              else void begin()
            }
          },
          icon(18)
        ),
        recording || flash !== ''
          ? h(
              'span',
              {
                style: {
                  position: 'absolute',
                  bottom: '36px',
                  right: 0,
                  whiteSpace: 'nowrap',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: 'var(--dsw-alias-label-primary, #111)',
                  background: 'var(--dsw-alias-bg-elevated, rgba(0,0,0,0.82))',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.25)'
                }
              },
              recording ? '● 录音中，点一下结束（停顿也会自动结束）' : flash
            )
          : null
      )
    }

    /**
     * The stop control that only exists while she is speaking: same spot as the
     * mic, same icon-button shape, so "cut her off" is one click (or Esc).
     */
    function StopButton() {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])
      if (!store.get().playing) return null
      const icon =
        typeof StopIcon === 'function'
          ? h(StopIcon, { style: { width: '18px', height: '18px' } })
          : h('span', { style: { fontSize: '15px' } }, '⏹')
      return h(
        'button',
        {
          type: 'button',
          title: '停止朗读（Esc）',
          'aria-label': '停止朗读',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '30px',
            height: '30px',
            padding: 0,
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            color: '#e5484d',
            background: 'rgba(229,72,77,0.14)'
          },
          onClick: () => void stopSpeaking()
        },
        icon
      )
    }

    /**
     * Mount the page in both surfaces the host exposes for plugin panels, the
     * mic button in the composer, and start the player.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      const options = { id: 'mimo-tts', order: 60, label: () => 'MiMo 语音' }
      ctx.effect(
        () => ctx.slots.inject('plugins.item', () => ctx.slots.register({ ...options, name: 'plugins.item' }, Panel)),
        'dsh-mimo-tts: plugins page'
      )
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'mimo-tts-stop', order: 14 }, StopButton)),
        'dsh-mimo-tts: composer stop'
      )
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register({ name: 'conversation.input.right', id: 'mimo-tts-mic', order: 15 }, MicButton)
          ),
        'dsh-mimo-tts: composer mic'
      )
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugins.tab', () =>
            ctx.slots.register({ ...options, name: 'settings.plugins.tab' }, Panel)
          ),
        'dsh-mimo-tts: settings tab'
      )
      ctx.effect(() => startPlayer(), 'dsh-mimo-tts: player')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
