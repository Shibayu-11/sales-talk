# salestalk CLI — Usage Guide

Headless interface to the sales-talk Electron app.
All subcommands print a single JSON object to stdout and exit with code 0 (ok) or 1 (error).

---

## Prerequisites

- Run `npm run build` once to produce `out/main/index.js` (electron-vite output).
- macOS 13+ with Screen Recording and Microphone granted for the app (required by `record` commands).

---

## Subcommands

### `salestalk record start [--product <id>]`

Start a live recording session (native audio capture via ScreenCaptureKit + AVAudioEngine).

```
salestalk record start
salestalk record start --product kenko_keiei
```

**Output (success):**
```json
{ "ok": true, "callId": "<uuid>", "productId": "real_estate" }
```

**Output (permission missing):**
```json
{ "ok": false, "error": "permission_required", "detail": "Missing permissions: screen. Grant them in System Settings > Privacy." }
```

---

### `salestalk record stop`

Stop the current recording session.

```
salestalk record stop
```

**Output:**
```json
{ "ok": true, "callId": "<uuid-or-null>" }
```

---

### `salestalk transcribe --file <path> [--product <id>]`

Import an audio file and run the batch STT pipeline (local-first: Apple SpeechAnalyzer → Deepgram fallback).

```
salestalk transcribe --file /path/to/meeting.m4a
salestalk transcribe --file /path/to/meeting.m4a --product hojokin
```

**Output (success):**
```json
{
  "ok": true,
  "callId": "<uuid>",
  "jobId": "<uuid>",
  "jobStatus": "completed",
  "transcriptCount": 42,
  "transcripts": [
    { "speaker": "counterpart", "text": "価格が高い気がします", "isFinal": true, "startMs": 1200 }
  ]
}
```

Transcripts are printed to stdout for the invoking agent/shell.
They are NOT written to Pino logs (PII safety per PRD §29).

---

### `salestalk minutes [--call-id <id>] [--product <id>]`

Generate meeting minutes for a call (LLM-powered via Claude Sonnet, with heuristic fallback).

Call resolution order: `--call-id` arg → active recording session → most-recent stored call.

```
salestalk minutes
salestalk minutes --call-id <uuid>
salestalk minutes --call-id <uuid> --product real_estate
```

**Output (success):**
```json
{
  "ok": true,
  "minute": {
    "id": "<uuid>",
    "callId": "<uuid>",
    "source": "uploaded_audio",
    "productId": "real_estate",
    "summary": "商談全体の概要...",
    "agreed": ["[02:14] 次回打ち合わせ日程を確定する"],
    "pending": ["[05:33] 価格については再検討"],
    "decisions": [],
    "numbers": [{ "label": "number_1", "value": "200万円" }],
    "complianceFindings": [],
    "generatedAt": "2026-06-14T10:00:00.000Z"
  }
}
```

---

### `salestalk --help`

Print usage text.

---

## Product IDs

| ID | 商材 |
|----|------|
| `real_estate` | 不動産 |
| `kenko_keiei` | 健康経営優良法人 |
| `hojokin` | 補助金・助成金 |

---

## Error shapes

All error responses share the same shape:
```json
{ "ok": false, "error": "<code>", "detail": "<human-readable message>" }
```

| `error` code | Meaning |
|---|---|
| `permission_required` | Screen Recording or Microphone not granted |
| `invalid_product` | `--product` value not in the allowed enum |
| `missing_file` | `--file` flag was omitted |
| `file_not_found` | The specified file path does not exist |
| `call_create_failed` | Could not create a call record (DB error) |
| `capture_start_failed` | Native audio capture module could not start |
| `capture_stop_failed` | Native audio capture could not be stopped |
| `import_failed` | Audio file could not be imported/copied |
| `stt_job_failed` | STT transcription job threw an error |
| `minutes_generation_failed` | LLM minutes generation threw an error |
| `no_calls` | No stored calls found (run `transcribe` or `record start` first) |
| `unknown_subcommand` | Unrecognised subcommand string |
| `unexpected_error` | Uncaught error — see `detail` field |

---

## Dev usage (npm run cli)

```bash
# Build first
npm run build

# Then run any subcommand
npm run cli -- record start --product real_estate
npm run cli -- record stop
npm run cli -- transcribe --file ~/Downloads/meeting.m4a --product kenko_keiei
npm run cli -- minutes --call-id <uuid>
npm run cli -- --help
```

The `npm run cli` script calls `scripts/salestalk-cli.mjs`, which spawns the Electron binary
against `out/main/index.js` with `--cli` prepended so the main process routes headlessly.

---

## macOS URL Scheme — `salestalk://`

Registered via `app.setAsDefaultProtocolClient('salestalk')` in GUI mode and declared in
`electron-builder.yml` (`mac.protocols`) so it is registered in the OS after DMG install.

### Supported URLs

| URL | Action |
|-----|--------|
| `salestalk://record/start` | Start recording (default product) |
| `salestalk://record/start?product=real_estate` | Start recording for real_estate |
| `salestalk://record/start?product=kenko_keiei` | Start recording for kenko_keiei |
| `salestalk://record/start?product=hojokin` | Start recording for hojokin |
| `salestalk://record/stop` | Stop current recording |

### Test from Terminal

```bash
open "salestalk://record/start?product=real_estate"
open "salestalk://record/stop"
```

### macOS Shortcut example

1. Open **Shortcuts.app**
2. New Shortcut → Add Action → **Open URLs**
3. URL: `salestalk://record/start?product=real_estate`
4. Add to Menu Bar or assign a keyboard shortcut
5. Optionally chain: Record Start → wait N minutes → Record Stop → Open URL `salestalk://record/stop`

### Spotlight / Alfred / Raycast

After DMG install, the scheme is registered system-wide.
In Raycast: **Script Commands** → shell script containing `open "salestalk://record/start"`.

---

## Agent Skill snippet

Use this in a Claude Agent Skill (`SKILL.md` task step) to call the CLI and parse its JSON result:

```bash
#!/usr/bin/env bash
# Run salestalk transcribe and capture structured output
set -euo pipefail

FILE="${1:?Usage: skill.sh <audio-file> [product]}"
PRODUCT="${2:-real_estate}"

RESULT=$(salestalk transcribe --file "$FILE" --product "$PRODUCT")

if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
  CALL_ID=$(echo "$RESULT" | jq -r '.callId')
  COUNT=$(echo "$RESULT" | jq -r '.transcriptCount')
  echo "Transcribed $COUNT segments for call $CALL_ID"

  # Generate minutes immediately
  MINUTES=$(salestalk minutes --call-id "$CALL_ID" --product "$PRODUCT")
  echo "$MINUTES" | jq '.minute.summary'
else
  echo "Error: $(echo "$RESULT" | jq -r '.detail')" >&2
  exit 1
fi
```

In an agent task YAML:

```yaml
- name: transcribe_and_minutes
  tool: bash
  args:
    command: |
      RESULT=$(salestalk transcribe --file "{{ audio_file }}" --product "{{ product_id }}")
      echo "$RESULT"
  parse_json: true
  on_ok:
    - name: generate_minutes
      tool: bash
      args:
        command: salestalk minutes --call-id "{{ result.callId }}"
```

---

## Single-instance / GUI coordination

When a GUI instance of sales-talk is running:

- **`transcribe` and `minutes`**: operate on stored local data only; they work correctly alongside a running GUI with no coordination needed.
- **`record start/stop`**: the CLI spawns its own headless Electron process and maintains its own native capture state, **independent of the GUI**. Running both simultaneously will attempt to start two ScreenCaptureKit sessions — the OS may allow this but audio data will not be merged. **Recommended**: use the GUI or the CLI for recording, not both at once. The protocol handler (`salestalk://record/start`) drives the GUI instance and is the preferred path when the app is already open.
- Second-instance detection: if you call `open salestalk://record/start` while the app is running, the `open-url` / `second-instance` handler in the GUI process receives the URL and starts capture there — no duplicate process is spawned.
