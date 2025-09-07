Meeting App (Audio Record + Transcribe)

What’s included
- Frontend in `meeting-app/` (HTML/CSS/JS) that matches the provided snapshot: big timer, record button, Language + Template cards, and a bottom tab bar (Past, Upcoming, Record, Files).
- Offline features: microphone recording (Web Audio/MediaRecorder), timer, local save to `localStorage`, playback and download of `.webm` files.
- Optional server in `server/server.js` (no external packages) that proxies to OpenAI for transcription and meeting notes. It expects an `OPENAI_API_KEY` environment variable.

Prerequisites
- Node.js 18+ (provides global `fetch`, `FormData`, `Blob`).
- A valid OpenAI API key (Project key). Do NOT embed keys in the browser; use the server.

Quick start
1) Set your API key (PowerShell example):
   `$Env:OPENAI_API_KEY = Get-Content -Raw 'API Key.txt'`
   or paste the key directly: `$Env:OPENAI_API_KEY = 'sk-...'`.

2) Start the server (from repo root):
   `npm start`

3) Open the app:
   - Visit `http://localhost:5173` in your browser.

4) Use it
   - Click RECORD to start/stop. A session card appears with Download and Transcribe.
   - Language and Template selectors are saved with each recording.
   - Past tab displays saved recordings (persisted locally). Files tab gives quick downloads.

Notes
- If you run without `OPENAI_API_KEY`, the app still records and saves locally; transcription buttons will return a server error until the key is set.
- The server uses endpoints:
- POST `/api/transcribe` with JSON `{ audioB64, mimeType, language, template, durationSec }`
  - Returns `{ transcript, summary, detectedLanguage }`.
  - Transcription uses `whisper-1` (robust multilingual). Language is auto-detected when you choose Auto.
  - POST `/api/summary-all` with JSON `{ items: Array<recording> }` where each recording can include `{ transcript? , audioB64, language, template, durationSec, createdAt }`. The server will transcribe missing recordings and return `{ combined, categories, itemCategories }` where:
    - `combined` is the overall brief + action plan.
    - `categories` groups meetings into project/module “folders” with per-category summary and actions.
    - `itemCategories[i]` lists the category labels for the i-th item, which the client stores back into local storage and displays as tags.

Exports
- After “Summarize All”, each category card in the Past tab includes Export buttons:
  - Export .md: Markdown summary plus an action-items table.
  - Export .csv: Action plan as CSV (Category, Language, Owner, Task, Due, Priority, Meetings).
- Also available: Export All (.md/.csv) from the summary header to download a combined brief and a consolidated CSV of all actions across folders. The consolidated CSV includes a Language column inferred per folder from its meetings.

Sharing
- From the Past summary header you can Share Brief (WhatsApp) or Email Brief. This sends only the combined brief and top action items (no raw transcripts).
- To change models, edit `server/server.js`.

Security
- Keep your API key on the server side only. The browser never sees it.

Language detection
- Choose `Auto (Cantonese/Hokkien/Chinese)` to let the server detect speech after transcription. The detected language is shown as a badge in the Past list and used in shares/exports.
