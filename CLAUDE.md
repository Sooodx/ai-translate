# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**AI Translate** — a Manifest V3 browser extension (Firefox + Chrome) for AI-powered inline translation. Users select text on any webpage, a floating bubble appears with a streaming translation from their own AI API key. No build step, no dependencies, plain JavaScript.

## Development workflow

Load the extension unpacked to iterate:

- **Firefox:** `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → select `manifest.json`
- **Chrome:** `chrome://extensions` → Developer mode → "Load unpacked" → select the project directory

Edit files, then click the reload button in the extensions page. No watcher, no compilation, no server.

## Architecture

Four isolated contexts communicate via message passing:

```
Content Script (content.js)  ←→  Background SW (background.js)  →  AI API
                                      ↕ storage
                                 Popup (popup/popup.html)
```

- **`content.js`** — Injected into every page. Detects `mouseup` selection, renders a **Shadow DOM** bubble (fully style-isolated), opens a `runtime.Port` to background for streaming chunks, supports copy/close/language-switch. Caps selection at 5000 chars.
- **`background.js`** — Service worker (non-persistent). Registers right-click context menu on install, manages Port connections named `"translate"`, reads config from `storage.local`, routes to the selected provider. Uses an **idempotent guard** (`self.aitBg`) to survive MV3's worker restart without redeclaring top-level `const`s.
- **`popup/popup.js`** — Settings page: provider selection, base URL, API key (masked), model name, target language, test-connection button.
- **`providers/`** — Pluggable AI backend layer. Each provider file attaches to `self.<name>Provider`; `index.js` collects them into a `REGISTRY` and exposes `getProvider()` / `listProviders()` on `self.aitProviders`.
- **`content.css`** — Only styles the `.ait-host` wrapper element (fixed `z-index: 2147483646`). All bubble styling lives in the Shadow DOM's inline `<style>` in `content.js`.

### Data flow (streaming translation)

1. `content.js` detects selection → opens a `runtime.Port` named `"translate"`
2. Sends `{type: 'translate', text, to}` through the Port
3. `background.js` reads config from `storage.local`, calls `provider.translateStream({port, text, to, config})`
4. Provider does `fetch()` with `stream: true`, parses SSE lines, pushes `{type: 'chunk', text}` / `{type: 'done'}` / `{type: 'error', message}` back through the Port
5. `content.js` renders chunks with typewriter effect (blinking cursor via `::after { content: "▌" }`)

Port is used instead of `sendMessage` because streaming requires a long-lived bidirectional connection.

### Cross-browser compatibility pattern

All scripts use `const api = typeof browser !== 'undefined' ? browser : chrome;` at the top. Firefox uses the `browser` namespace with `background.scripts` array; Chrome uses `chrome` with `service_worker`. The background.js has dual loading logic: `importScripts` fallback for Chrome, `background.scripts` array for Firefox.

## Key patterns

### Idempotent guards (critical for MV3)

Both `background.js` and provider files guard top-level `const`/`function` declarations behind `if (!self.<flag>)` checks. This prevents redeclaration errors when the service worker restarts and scripts are re-evaluated. **Always follow this pattern when adding top-level declarations to any script loaded by the background.**

### Provider interface

To add a new AI provider:

1. Create `providers/<name>.js` — expose a `translateStream({port, text, to, config})` function, attach to `self.<providerName>Provider`
2. Register in `providers/index.js` `REGISTRY` object
3. Add the script to `manifest.json` `background.scripts` array (before `index.js`)

The `translateStream` function receives a live `runtime.Port` and must push messages on it: `{type: 'chunk', text}` for incremental content, `{type: 'done'}` on completion, `{type: 'error', message}` on failure.

### Shadow DOM isolation

Bubble UI is rendered inside a Shadow DOM attached to a `<div class="ait-host">` appended to `document.documentElement`. The `.ait-host` uses `all: initial` and `position: fixed` — no CSS leaks in or out. All bubble styles are in the `SHADOW_CSS` template literal in `content.js`, not in `content.css`.

### Storage key

All configuration is stored under a single key `'aitConfig'` in `browser.storage.local`:
```js
{ provider, baseUrl, apiKey, model, targetLang }
```

### Selection lifecycle

`content.js` keeps a module-level `currentBubble` (host element + shadow refs) and `activePort` (current streaming connection). Starting a new translation disconnects the previous port and removes the old bubble. Language switch in the bubble retriggers translation without rebuilding DOM.

### Base URL normalization

The OpenAI provider auto-appends `/v1` if the user's base URL doesn't already end with `/v<N>`. It also strips trailing slashes. This is shared logic — any new provider should do similar normalization.

### Error messages are in Chinese

User-facing error messages (in bubbles and popup feedback) are written in Chinese. New error messages should follow this convention.
