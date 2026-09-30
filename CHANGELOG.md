# Changelog

## 0.1.0 — first release

- **Auto-read**: every finished answer is spoken; code fences, tables, links and
  markdown scaffolding are stripped first, and long answers are clipped
  (`maxChars`).
- **Click to talk**: composer mic button that records, ends on the pause (1.4 s
  of silence) or on a second click, transcribes through MiMo ASR and drops the
  text into the composer.
- **Stop**: stop button + `Esc`; stopping also clears the queued sentences, and
  opening the mic cuts the current utterance off.
- **Voices**: nine built-in MiMo voices plus a cloned-voice slot driven by
  `$DSH_HOME/.dsh-mimo-tts/voice-clone.mp3`.
- **Panel**: voice picker with instant preview, auto-read toggle, test box,
  “re-read the last answer”, queue and status readout.
- **HTTP surface** under `/dsh-mimo-tts`, protected by a browser-trust fence
  (cross-site origins are refused).
- Offline smoke test (`node test/smoke.mjs`).
