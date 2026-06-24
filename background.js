// background.js —— MV3 后台脚本
//
// 加载方式兼容 Firefox 与 Chrome：
//   - Firefox（background.scripts 数组）：openai.js → index.js → background.js
//     依次加载到同一 background page 上下文，self.aitProviders 已就绪。
//   - Chrome（service_worker）：用 importScripts 按序加载。
//   - 若两处都未加载（防御）：再尝试 importScripts。
//
// 幂等守卫：Firefox 可能同时按 service_worker 与 scripts 加载本文件，
// 顶层 const 重复声明会报 redeclaration，故用 self.aitBg 标记只执行一次。
if (typeof importScripts === 'function' && typeof self.aitProviders === 'undefined') {
  importScripts('./providers/openai.js', './providers/index.js');
}

if (!self.aitBg) {
  self.aitBg = true;

  const { getProvider } = self.aitProviders;

  // Firefox 与 Chrome 的 API 兼容
  const api = typeof browser !== 'undefined' ? browser : chrome;

  // storage 中保存的配置对象键
  const STORAGE_KEY = 'aitConfig';

  // ── 翻译缓存 ──────────────────────────────────────────────
  const CACHE_STORAGE_KEY = 'aitTranslationCache';
  const MAX_CACHE_ENTRIES = 500;
  const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

  let translationCache = new Map(); // Map<hash, {text, timestamp}>

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  function getCacheKey(sourceText, targetLang, model) {
    return hash(sourceText + '\x00' + targetLang + '\x00' + model);
  }

  async function loadCache() {
    try {
      const stored = await api.storage.local.get(CACHE_STORAGE_KEY);
      const entries = stored[CACHE_STORAGE_KEY];
      if (Array.isArray(entries)) {
        const now = Date.now();
        for (const entry of entries) {
          if (entry.key && entry.text && entry.timestamp &&
              now - entry.timestamp < MAX_CACHE_AGE_MS) {
            translationCache.set(entry.key, { text: entry.text, timestamp: entry.timestamp });
          }
        }
      }
      console.log('[AIT] 翻译缓存已加载:', translationCache.size, '条');
    } catch {
      // 缓存不可读，静默降级
    }
  }

  async function saveCache() {
    const now = Date.now();
    const sorted = [];
    for (const [key, value] of translationCache) {
      if (now - value.timestamp < MAX_CACHE_AGE_MS) {
        sorted.push({ key, text: value.text, timestamp: value.timestamp });
      }
    }
    sorted.sort((a, b) => b.timestamp - a.timestamp);
    const payload = sorted.slice(0, MAX_CACHE_ENTRIES);
    try {
      await api.storage.local.set({ [CACHE_STORAGE_KEY]: payload });
    } catch (err) {
      console.log('[AIT] 缓存持久化失败，缩减后重试:', err?.message);
      try {
        await api.storage.local.set({ [CACHE_STORAGE_KEY]: sorted.slice(0, 100) });
      } catch {
        // 彻底失败，仅保留内存缓存
      }
    }
  }

  // Port 包装器：拦截 postMessage 累积译文，透传所有消息
  function createCachePortWrapper(realPort) {
    let accumulated = '';
    let success = false;
    return {
      postMessage(msg) {
        if (msg.type === 'chunk') accumulated += msg.text;
        if (msg.type === 'done') success = true;
        realPort.postMessage(msg);
      },
      get result() { return success ? accumulated : null; },
    };
  }

  // 启动时加载缓存（fire-and-forget）
  loadCache();

  // ── 右键菜单 ──────────────────────────────────────────────
  api.runtime.onInstalled.addListener(() => {
    try {
      api.contextMenus.create({
        id: 'ait-translate-selection',
        title: '翻译选中内容',
        contexts: ['selection'],
      });
    } catch {
      // 重复创建会抛错，忽略（已存在即可）
    }
  });

  api.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'ait-translate-selection') return;
    if (!info.selectionText || !tab?.id) return;
    // 通知当前 tab 的 content script 触发翻译（由 content 处理气泡）
    api.tabs.sendMessage(tab.id, {
      type: 'translate-selection',
      text: info.selectionText,
    });
  });

  // ── Port 长连接：流式翻译 ────────────────────────────────
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== 'translate') return;
    console.log('[AIT] Port 已连接');

    port.onMessage.addListener(async (msg) => {
      if (msg?.type !== 'translate') return;
      console.log('[AIT] 收到翻译请求:', msg.text?.slice(0, 30), '→', msg.to);

      const { text, to } = msg;
      if (!text) {
        port.postMessage({ type: 'error', message: '没有可翻译的文本。' });
        return;
      }

      // 读取配置
      const stored = await api.storage.local.get(STORAGE_KEY);
      const config = stored[STORAGE_KEY] || {};
      console.log('[AIT] 读取配置:', { provider: config.provider, model: config.model, baseUrl: config.baseUrl, hasKey: !!config.apiKey });

      const providerName = config.provider || 'openai';
      const targetLang = to || config.targetLang || '简体中文';
      const model = config.model || 'gpt-4o-mini';

      // ── 翻译缓存检查 ─────────────────────────────
      const cacheKey = getCacheKey(text, targetLang, model);
      const cached = translationCache.get(cacheKey);
      if (cached && cached.text) {
        console.log('[AIT] 缓存命中:', text.slice(0, 30));
        cached.timestamp = Date.now(); // LRU 提升
        port.postMessage({ type: 'chunk', text: cached.text });
        port.postMessage({ type: 'done' });
        return;
      }
      // ─────────────────────────────────────────────

      let provider;
      try {
        provider = getProvider(providerName);
      } catch (err) {
        console.log('[AIT] getProvider 失败:', err.message);
        port.postMessage({ type: 'error', message: err.message });
        return;
      }

      console.log('[AIT] 开始调用 provider.translateStream');
      const cacheWrapper = createCachePortWrapper(port);
      await provider.translateStream({
        port: cacheWrapper,
        text,
        to: targetLang,
        config,
      });
      console.log('[AIT] provider.translateStream 返回');

      // 缓存成功的翻译结果
      const result = cacheWrapper.result;
      if (result) {
        console.log('[AIT] 缓存保存:', text.slice(0, 30), '译文长度:', result.length);
        translationCache.set(cacheKey, { text: result, timestamp: Date.now() });
        saveCache(); // fire-and-forget
      }
    });
  });
}
