# dsh-mimo-tts

**MiMo voice for DeepSeek Harness** — read every answer aloud, talk to the composer, switch voices, and clone your own from a short recording.
[中文说明](README.zh.md)

The plugin speaks through **Xiaomi MiMo** TTS and listens through **MiMo ASR**, both on the token-plan endpoint, with the same key your LLM providers already use. Nothing is uploaded anywhere except to Xiaomi's own API.

## What it does

| | |
|---|---|
| 🔊 **Auto-read** | Every finished answer is spoken. Code fences, tables, links and markdown scaffolding are stripped first, and long answers are clipped so a wall of text cannot turn into three minutes of speech. |
| 🎙 **Click to talk** | A mic button sits in the composer's own control row (next to the model picker). Click to start, click again — or simply stop talking and it ends itself on the pause — and the transcript lands in the input box, ready for Enter. |
| ⏹ **Stop** | The moment she starts speaking, a stop button appears next to the mic; `Esc` does the same. Stopping also drops the sentences still queued behind the current one, and opening the mic cuts her off automatically. |
| 🗣 **Voices** | Nine built-in MiMo voices, plus a **cloned voice** slot driven by a local 5–15 s reference sample. |
| 🎛 **Panel** | *Plugins → MiMo voice* (and *Settings → Built-in plugins*): pick a voice and hear it immediately, toggle auto-read, type something to test, re-read the last answer, watch queue/status. |

## Requirements

- DeepSeek Harness **0.2.0-rc.1 or newer** (`engines.dsh`)
- A Xiaomi MiMo **token-plan** key, reachable either from
  - the `XIAOMI_TOKEN_PLAN_CN_API_KEY` environment variable, or
  - `refs:` in `$DSH_HOME/.credentials.yaml` — the same place the LLM providers read.
- The key is only sent to `token-plan-cn.xiaomimimo.com`. Note that a token-plan key is **not** accepted by the public `api.xiaomimimo.com` host, and vice versa.

## Install

```bash
dsh plugin --profile web add dsh-mimo-tts      # or --profile desktop
# restart the host (dsh web / the desktop app)
```

## Use

1. **Auto-read**: on by default after you switch it on once from the panel. Every finished answer is queued and played in order.
2. **Talk**: click the mic in the composer, speak, pause (or click again). The text appears in the input box — press Enter to send.
3. **Stop**: click the red stop button, or press `Esc`.

## Voices and cloning

Nine built-in voices: `mimo_default`, 冰糖, 茉莉, 苏打, 白桦, Mia, Chloe, Milo, Dean.

To use your own voice, drop a **5–15 second, clean, single-speaker** clip at

```
$DSH_HOME/.dsh-mimo-tts/voice-clone.mp3      # mp3 or wav
```

and select **「克隆音色」/ “Cloned voice”** in the panel. The host reads that file directly; it is never bundled with the plugin and never leaves your machine except as the per-request reference the MiMo API requires.

> Cloning costs latency: every request carries the reference sample (~105 KB for a 10 s clip), so a sentence takes ~3 s instead of ~1 s. Please only clone a voice you have the right to use.

## Configuration

`$DSH_HOME/.dsh-mimo-tts/config.json` (the panel writes this file):

```jsonc
{
  "voice": "冰糖",       // any built-in voice, or the clone slot
  "autoRead": true,      // speak every finished answer
  "maxChars": 600,       // clip long answers before speaking
  "format": "mp3"        // mp3 | wav
}
```

## HTTP surface

All routes live under `/dsh-mimo-tts` on the host's own webserver:

| Route | Purpose |
|---|---|
| `GET /status` | key presence, model names, voice roster, clone sample state, queue depth |
| `GET /voices` | the voice roster |
| `POST /config` | `{ voice?, autoRead?, maxChars? }` |
| `POST /speak` | `{ text, voice?, queue? }` → synthesized audio as a data URL |
| `POST /speak-last` | speak the last finished answer of a session |
| `POST /asr` | raw `audio/wav` (16 kHz mono) or `audio/mpeg` → `{ text }` |
| `GET /pending?since=N` | drain the auto-read queue (cursor based, nothing repeats) |
| `POST /stop` | stop now: the client pauses, the host drops the queue |

**Security**: requests carrying a cross-site `Origin` are refused with `403`; loopback, `dsh-app://`, `file://` and origin-less callers are allowed. `DSH_MIMO_TTS_ORIGINS` adds origins for deployments that serve the GUI from another host.

## Development

```bash
node test/smoke.mjs                 # offline: routes, fence, sanitizer, validation
DSH_MIMO_TTS_LIVE=1 node test/smoke.mjs   # adds one real synthesis + transcription
```

The browser half (`lib/client.js`) is a hand-written `__ModuleLoader__` bundle: no build step, React comes from the host's module table.

## License

MIT — see [LICENSE](LICENSE).
