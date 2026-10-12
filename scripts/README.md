# scripts/

Optional helpers for a Windows desktop install. **Nothing here is part of the
plugin at runtime** — it is not in the published package (`files` in
`package.json` excludes it) and the plugin works without it. They exist because
two things about this setup are worth automating.

## `start-pet-if-needed.ps1`

Keeps the native Live2D pet window alive (`dsh-pet-live2d`, a separate plugin).

**Why it is needed.** Inside the Electron desktop app the page asks for the
pet's model assets through the app's own `dsh-app://` scheme, which answers 404
for plugin routes served under `/api/...` — the pet then shows *加载失败*. The
pet's own native window fetches the same files over plain HTTP and renders
fine, and while its heartbeat in `$DSH_HOME/pet-desktop.json` is fresh the
in-page copy stands down by itself. So the fix is simply "keep that window
running".

**Register the self-healing task** (logon + every 30 minutes; the exact command
is in the script's header comment):

```powershell
pwsh -File scripts/start-pet-if-needed.ps1                     # one-off
pwsh -File scripts/start-pet-if-needed.ps1 -Port 19387 -Profile desktop
```

It starts nothing when the window is already up, when the DSH host is not
listening yet, or when the pet is parked in page-only mode
(`"mode": "inline"` in `$DSH_HOME/pet-desktop.json`). Log:
`$DSH_HOME/dsh-pet-autostart.log`.

## `open-catalog-pr.ps1`

Submits this plugin to the curated list that
[dsh-market](https://github.com/dsh-market/dsh-market) reads
([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)).
One YAML file per plugin, and the plugin repository must be at least a day old —
this script checks that, refuses to submit early, and refuses to open a second
PR for the same branch.

Prepare the fork once (the entry file lives in the catalog repo, not here):

```powershell
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false
git clone --depth 1 --filter=blob:none --sparse https://github.com/<you>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git sparse-checkout set data/plugins
git checkout -b add/<you>-dsh-mimo-tts
# copy a filled-in entry (see the repository's contributing.md for the schema)
git add data/plugins/<you>__dsh-mimo-tts.yml && git commit -m "Add <you>/dsh-mimo-tts (voice)"
git push -u origin add/<you>-dsh-mimo-tts
```

Then either run the script by hand or register the one-shot task from its header
comment so it submits itself while nobody is at the machine. Log:
`$DSH_HOME/dsh-mimo-tts-catalog-pr.log`.
