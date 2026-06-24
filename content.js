// content.js —— 注入气泡 UI，监听划词，驱动流式翻译渲染
//
// 设计：
//   - 气泡用 Shadow DOM 完全隔离样式。
//   - 与 background 用 runtime.Port('translate') 长连接传输流式 chunk。
//   - 目标语言从 storage 读默认值，气泡内可临时切换并重译。

const api = typeof browser !== 'undefined' ? browser : chrome;
const STORAGE_KEY = 'aitConfig';

let currentBubble = null;   // 当前气泡 host 元素
let activePort = null;      // 当前进行中的 Port（用于切换语言时中断）
let lastSelection = null;   // { rect, text } 最近一次有效划词
let closeCooldown = 0;      // 关闭气泡的时间戳，防止 mouseup 立即重新弹出

// ── 目标语言列表（气泡内下拉）────────────────────────────
const LANGS = [
  '简体中文', '繁體中文', 'English', '日本語', '한국어',
  'Français', 'Deutsch', 'Español', 'Português', 'Русский', 'العربية',
];

// ── 选区检测 ─────────────────────────────────────────────
function getValidSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (!text || text.length > 5000) return null; // 超长截断保护
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  // 选区在视口外（滚动后）则忽略
  if (rect.width === 0 && rect.height === 0) return null;
  return { text, rect };
}

document.addEventListener('mouseup', (e) => {
  console.log('[AIT] mouseup, target:', e.target?.tagName, 'currentBubble存在:', !!currentBubble);
  // 略微延迟，让 selection 稳定
  setTimeout(() => {
    // 关闭气泡后 300ms 内跳过，防止点击 × 关闭后立即重新弹出
    if (Date.now() - closeCooldown < 300) return;
    // 选中气泡内文字（如复制部分译文）不触发翻译
    if (currentBubble && currentBubble.host.contains(e.target)) return;
    const sel = getValidSelection();
    if (!sel) return;
    lastSelection = sel;
    startTranslation(sel);
  }, 10);
});

// 兼容：右键菜单点击后由 background 发来消息
api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'translate-selection' && msg.text) {
    // 用当前光标位置或视口中央放置气泡
    const fake = {
      text: msg.text,
      rect: {
        left: window.innerWidth / 2 - 160,
        top: window.innerHeight / 2 - 40,
        width: 0,
        height: 0,
      },
    };
    lastSelection = fake;
    startTranslation(fake);
  }
});

// ── 读取默认目标语言 ─────────────────────────────────────
async function getDefaultLang() {
  try {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return stored?.[STORAGE_KEY]?.targetLang || '简体中文';
  } catch {
    return '简体中文';
  }
}

// ── 启动一次翻译（创建/复用气泡）────────────────────────
async function startTranslation(sel) {
  // 中断上一个进行中的流
  if (activePort) {
    try { activePort.disconnect(); } catch { /* ignore */ }
    activePort = null;
  }

  const lang = await getDefaultLang();
  renderBubble(sel.rect, '', { state: 'loading', lang });
  runStream(sel.text, lang);
}

// 用指定语言重译：复用当前气泡与下拉选择，不重建 DOM、不覆盖 select。
function retryWithLang(sel, lang) {
  if (activePort) {
    try { activePort.disconnect(); } catch { /* ignore */ }
    activePort = null;
  }
  if (!currentBubble) return;
  // 重置 body 为 loading 态
  const { body, copyBtn } = currentBubble;
  body.removeAttribute('data-state');
  body.textContent = '';
  body.innerHTML = '<span class="ait-dot"></span><span class="ait-dot"></span><span class="ait-dot"></span>';
  body.dataset.text = '';
  copyBtn.disabled = true;
  runStream(sel.text, lang);
}

// ── 建立 Port 跑流式 ─────────────────────────────────────
function runStream(text, lang) {
  const port = api.runtime.connect({ name: 'translate' });
  activePort = port;
  console.log('[AIT] content 已建 Port，发送 translate');

  let buffer = '';

  port.onMessage.addListener((msg) => {
    console.log('[AIT] content 收到消息:', msg.type, msg.text?.slice(0, 20) || msg.message || '');
    if (!currentBubble) return;
    switch (msg.type) {
      case 'chunk':
        buffer += msg.text;
        updateBubbleContent(buffer, 'streaming');
        break;
      case 'done':
        updateBubbleContent(buffer, 'done');
        port.disconnect();
        if (activePort === port) activePort = null;
        break;
      case 'error':
        updateBubbleError(msg.message);
        port.disconnect();
        if (activePort === port) activePort = null;
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
  });

  port.postMessage({ type: 'translate', text, to: lang });
}

// ── 气泡 DOM（Shadow DOM）────────────────────────────────
function renderBubble(rect, initialText, { state, lang }) {
  // 移除旧气泡
  removeBubble();

  const host = document.createElement('div');
  host.className = 'ait-host';
  // 定位：选区下方，向右偏移；越界则翻转到上方/左侧
  const top = rect.bottom + 8;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340));
  host.style.top = `${Math.min(top, window.innerHeight - 200)}px`;
  host.style.left = `${left}px`;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${SHADOW_CSS}</style>
    <div class="ait-bubble" part="bubble">
      <div class="ait-head">
        <select class="ait-lang">
          ${LANGS.map((l) => `<option ${l === lang ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="ait-actions">
          <button class="ait-copy" title="复制译文" disabled>复制</button>
          <button class="ait-close" title="关闭">×</button>
        </div>
      </div>
      <div class="ait-body"></div>
    </div>
  `;

  const body = shadow.querySelector('.ait-body');
  const copyBtn = shadow.querySelector('.ait-copy');
  const closeBtn = shadow.querySelector('.ait-close');
  const langSelect = shadow.querySelector('.ait-lang');

  if (state === 'loading') {
    body.innerHTML = '<span class="ait-dot"></span><span class="ait-dot"></span><span class="ait-dot"></span>';
  } else {
    body.textContent = initialText;
  }

  closeBtn.addEventListener('click', removeBubble);
  copyBtn.addEventListener('click', async () => {
    const txt = body.dataset.text || '';
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    } catch {
      copyBtn.textContent = '复制失败';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    }
  });
  langSelect.addEventListener('change', () => {
    if (!lastSelection) return;
    // 用用户所选语言重译（不读默认值，直接用当前下拉值）
    retryWithLang(lastSelection, langSelect.value);
  });

  // 点击气泡外关闭（下次 mousedown 时检测）
  setTimeout(() => {
    document.addEventListener('mousedown', onOutsideClick, true);
  }, 0);
  // Esc 关闭
  document.addEventListener('keydown', onEscKey, true);

  currentBubble = { host, shadow, body, copyBtn, langSelect, _lastLang: lang };
}

function updateBubbleContent(text, state) {
  if (!currentBubble) return;
  const { body, copyBtn } = currentBubble;
  body.textContent = text;
  body.dataset.text = text;
  body.setAttribute('data-state', state);
  if (state === 'done' && text) {
    copyBtn.disabled = false;
  }
}

function updateBubbleError(message) {
  if (!currentBubble) return;
  const { body, copyBtn } = currentBubble;
  body.textContent = message || '翻译失败';
  body.setAttribute('data-state', 'error');
  copyBtn.disabled = true;
}

function removeBubble() {
  console.log('[AIT] removeBubble 被调用，currentBubble 存在:', !!currentBubble);
  if (!currentBubble) return;
  currentBubble.host.remove();
  currentBubble = null;
  closeCooldown = Date.now();
  document.removeEventListener('mousedown', onOutsideClick, true);
  document.removeEventListener('keydown', onEscKey, true);
}

function onOutsideClick(e) {
  if (!currentBubble) return;
  const inside = currentBubble.host.contains(e.target);
  console.log('[AIT] onOutsideClick mousedown target:', e.target, 'inside:', inside);
  if (inside) return; // 点在气泡内
  removeBubble();
}

function onEscKey(e) {
  if (e.key === 'Escape') removeBubble();
}

// ── Shadow DOM 内样式 ────────────────────────────────────
const SHADOW_CSS = `
  :host, .ait-bubble { all: initial; }
  .ait-bubble {
    display: block;
    width: 320px;
    max-width: 90vw;
    background: #ffffff;
    border: 1px solid #e0ddd4;
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0,0,0,.18);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    color: #1a1a18;
    overflow: hidden;
  }
  .ait-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-bottom: 1px solid #f1efe8;
    background: #fafaf7;
  }
  .ait-lang {
    font: inherit;
    font-size: 12px;
    color: #5f5e5a;
    border: 1px solid #d8d5cc;
    border-radius: 6px;
    padding: 2px 6px;
    background: #fff;
    cursor: pointer;
  }
  .ait-actions { display: flex; gap: 6px; align-items: center; }
  .ait-actions button {
    font: inherit;
    font-size: 12px;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 2px 8px;
    cursor: pointer;
    background: #fff;
  }
  .ait-copy { color: #185fa5; border-color: #d8e6f6; }
  .ait-copy:hover:not(:disabled) { background: #e6f1fb; }
  .ait-copy:disabled { color: #b8b6af; cursor: default; background: #f5f4f0; }
  .ait-close {
    color: #888780; font-size: 16px; line-height: 1;
    width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
  }
  .ait-close:hover { background: #f1efe8; }
  .ait-body {
    padding: 12px 14px;
    line-height: 1.6;
    min-height: 24px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ait-body[data-state="error"] { color: #993c1d; }
  .ait-body[data-state="streaming"]::after {
    content: "▌";
    color: #185fa5;
    animation: ait-blink 1s steps(2) infinite;
  }
  @keyframes ait-blink { 50% { opacity: 0; } }
  .ait-dot {
    display: inline-block;
    width: 6px; height: 6px;
    margin: 0 2px;
    border-radius: 50%;
    background: #b8b6af;
    animation: ait-bounce 1.2s infinite ease-in-out;
  }
  .ait-dot:nth-child(2) { animation-delay: .15s; }
  .ait-dot:nth-child(3) { animation-delay: .3s; }
  @keyframes ait-bounce {
    0%, 80%, 100% { transform: translateY(0); opacity: .4; }
    40% { transform: translateY(-4px); opacity: 1; }
  }
`;
