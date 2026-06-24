# AI Translate

A lightweight browser extension (Firefox + Chrome) that lets you select text on any webpage and get an instant AI-powered streaming translation. You bring your own API key — no intermediary server, all data stays local.

## Features

- **Inline translation bubble** — select text, release mouse, translation appears in a floating bubble
- **Streaming output** — typewriter effect, tokens appear as the AI generates them
- **11 languages** — Simplified/Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Russian, Arabic
- **Right-click menu** — "翻译选中内容" on any selected text
- **Copy to clipboard** — one-click copy of translated text
- **Translation cache** — repeated text skips API call, instant return
- **Shadow DOM isolation** — bubble styles never leak into or from the host page
- **OpenAI-compatible** — any endpoint that speaks the OpenAI chat/completions API (OpenAI, Azure, Groq, Ollama, vLLM, etc.)
- **Model list fetching** — auto-populate model dropdown from your API endpoint

## Quick Start

1. Grab your AI API key (OpenAI, or any compatible service)
2. Load the extension unpacked:
   - **Firefox:** `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.json`
   - **Chrome:** `chrome://extensions` → Developer mode → "Load unpacked" → select project folder
3. Click the extension icon → fill in your API key, base URL, and model → save
4. Navigate to any webpage, select some text, and watch the translation bubble appear

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| API Endpoint | Your AI API base URL | `https://api.openai.com/v1` |
| API Key | Your API key (stored locally only) | — |
| Model | Model name (can fetch list from endpoint) | `gpt-4o-mini` |
| Target Language | Default translation target | 简体中文 |

All settings are saved to `browser.storage.local`. Your API key never leaves your browser except to the API endpoint you configure.

## Architecture

```
Content Script (content.js)  ←→  Background SW (background.js)  →  AI API
                                      ↕ storage
                                 Popup (popup/popup.html)
```

Four isolated contexts communicate via message passing:

- **content.js** — Injected into every page. Detects text selection, renders Shadow DOM bubble, opens `runtime.Port` for streaming chunks.
- **background.js** — Service worker. Routes translation requests to the selected AI provider, manages translation cache.
- **providers/** — Pluggable backend layer. Each provider handles its own API protocol.
- **popup/** — Settings page for API configuration.

Streaming uses a persistent `runtime.Port` connection — `chrome.runtime.sendMessage` is one-shot, but translation streams need long-lived bidirectional communication.

## Adding a New AI Provider

1. Create `providers/<name>.js` — implement `translateStream({port, text, to, config})`, attach to `self.<name>Provider`
2. Register in `providers/index.js` `REGISTRY` object
3. Add the script to `manifest.json` → `background.scripts` array (before `index.js`)

The `translateStream` function receives a live `runtime.Port` and must push JSON messages:

| Type | Payload | When |
|------|---------|------|
| `chunk` | `{text: string}` | Each incremental token |
| `done` | — | Stream completed |
| `error` | `{message: string}` | Any failure |

## Development

No build step. No dependencies. Edit files → reload extension in browser.

```
ai-translate/
├── manifest.json
├── background.js          # Service worker hub
├── content.js             # Bubble UI + selection detection
├── content.css            # Host element styles
├── providers/
│   ├── index.js           # Provider registry
│   └── openai.js          # OpenAI-compatible streaming
├── popup/
│   ├── popup.html         # Settings page
│   └── popup.js           # Settings logic
└── icons/
    ├── icon-48.png
    └── icon-96.png
```

## Privacy

- Your API key is stored in your browser's local storage and never sent anywhere except the API endpoint you configure.
- All translation requests go directly from your browser to your AI provider — no intermediary.
- No analytics, no tracking, no data collection of any kind.

## License

MIT
