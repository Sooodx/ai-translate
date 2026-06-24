// popup/popup.js —— 设置页逻辑：读写 storage、自动保存、获取模型列表、测试连接
// popup 是普通 HTML 页面（非 ES module），用全局 browser/chrome API。

const api = typeof browser !== 'undefined' ? browser : chrome;
const STORAGE_KEY = 'aitConfig';
const CUSTOM_MODEL_VALUE = '__custom__';

const DEFAULTS = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  triggerMode: 'click',
};

// 与 content.js 保持一致的语言列表
const LANGS = [
  '简体中文', '繁體中文', 'English', '日本語', '한국어',
  'Français', 'Deutsch', 'Español', 'Português', 'Русский', 'العربية',
];

const $ = (id) => document.getElementById(id);

// ── 模型下拉框 ──────────────────────────────────────────
// 获取当前实际模型值：下拉选中则取下拉值，"自定义…"则取文本框值
function getModelValue() {
  const sel = $('modelSelect');
  if (sel.value === CUSTOM_MODEL_VALUE) {
    return $('modelCustom').value.trim();
  }
  return sel.value;
}

// 设置模型下拉框的显示值：如果在列表中则选中对应项，否则切到自定义
function setModelValue(model) {
  const sel = $('modelSelect');
  const custom = $('modelCustom');
  // 检查下拉列表中是否有这个模型
  const found = Array.from(sel.options).some((opt) => opt.value === model);
  if (found) {
    sel.value = model;
    custom.style.display = 'none';
  } else {
    sel.value = CUSTOM_MODEL_VALUE;
    custom.value = model || '';
    custom.style.display = '';
  }
}

// 用模型列表填充下拉框
function populateModelList(models) {
  const sel = $('modelSelect');
  const currentModel = getModelValue(); // 保存当前选中的模型
  sel.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join('');
  // 追加"自定义…"选项
  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = '自定义模型…';
  sel.appendChild(customOpt);
  // 恢复之前选中的模型
  setModelValue(currentModel);
}

// ── 语言下拉 ────────────────────────────────────────────
function fillLangs() {
  const sel = $('targetLang');
  sel.innerHTML = LANGS.map((l) => `<option value="${l}">${l}</option>`).join('');
}

// ── 加载 ────────────────────────────────────────────────
async function load() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  const cfg = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
  $('provider').value = cfg.provider;
  $('baseUrl').value = cfg.baseUrl || '';
  $('apiKey').value = cfg.apiKey || '';
  fillLangs();
  $('targetLang').value = cfg.targetLang;
  $('triggerMode').value = cfg.triggerMode || DEFAULTS.triggerMode;

  // 恢复缓存的模型列表
  if (stored[STORAGE_KEY]?._modelCache?.length) {
    populateModelList(stored[STORAGE_KEY]._modelCache);
  }
  // 设置当前模型值（在 populateModelList 之后，确保下拉已填充）
  setModelValue(cfg.model || DEFAULTS.model);
}

// ── 收集配置 ────────────────────────────────────────────
function gatherConfig() {
  return {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    apiKey: $('apiKey').value.trim(),
    model: getModelValue() || DEFAULTS.model,
    targetLang: $('targetLang').value,
    triggerMode: $('triggerMode').value,
  };
}

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = kind || '';
}

// ── 持久化保存 ──────────────────────────────────────────
async function persist(cfg) {
  const stored = await api.storage.local.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY] || {};
  await api.storage.local.set({
    [STORAGE_KEY]: { ...cfg, _modelCache: existing._modelCache || [] },
  });
}

// ── 自动保存（debounce 600ms）────────────────────────────
let saveTimer = 0;
function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const cfg = gatherConfig();
    if (!cfg.apiKey) return;
    try { new URL(cfg.baseUrl); } catch { return; }
    await persist(cfg);
    setStatus('已自动保存', 'ok');
  }, 600);
}

async function save() {
  const cfg = gatherConfig();
  if (!cfg.apiKey) {
    setStatus('请填写 API Key。', 'err');
    return;
  }
  try {
    new URL(cfg.baseUrl);
  } catch {
    setStatus('Base URL 格式不正确。', 'err');
    return;
  }
  await persist(cfg);
  setStatus('已保存。', 'ok');
}

// ── 获取模型列表 ────────────────────────────────────────
async function fetchModels() {
  const cfg = gatherConfig();
  if (!cfg.apiKey) {
    setStatus('请先填写 API Key。', 'err');
    return;
  }
  let base = cfg.baseUrl.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(base)) base += '/v1';

  setStatus('获取模型列表中...', '');
  $('fetchModels').disabled = true;

  try {
    const resp = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        setStatus('获取失败：API Key 无效（401）。', 'err');
      } else {
        setStatus(`获取模型列表失败（HTTP ${resp.status}）。`, 'err');
      }
      return;
    }
    const data = await resp.json();
    let models = [];
    if (Array.isArray(data?.data)) {
      models = data.data
        .map((m) => m.id || m.model || m.name)
        .filter(Boolean)
        .sort();
    } else if (Array.isArray(data)) {
      models = data
        .map((m) => (typeof m === 'string' ? m : m.id || m.model || m.name))
        .filter(Boolean)
        .sort();
    }
    if (!models.length) {
      setStatus('未获取到模型列表，请手动输入。', 'err');
      return;
    }
    populateModelList(models);

    // 缓存到 storage
    const stored = await api.storage.local.get(STORAGE_KEY);
    const existing = stored[STORAGE_KEY] || {};
    await api.storage.local.set({
      [STORAGE_KEY]: { ...existing, _modelCache: models },
    });
    setStatus(`已获取 ${models.length} 个模型 ✓`, 'ok');
  } catch (err) {
    setStatus(`网络错误：${err?.message || err}`, 'err');
  } finally {
    $('fetchModels').disabled = false;
  }
}

// ── 测试连接 ────────────────────────────────────────────
async function testConnection() {
  const cfg = gatherConfig();
  if (!cfg.apiKey) {
    setStatus('请先填写 API Key。', 'err');
    return;
  }
  setStatus('测试中...', '');
  let base = cfg.baseUrl.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(base)) base += '/v1';
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    if (resp.ok) {
      setStatus('连接成功 ✓', 'ok');
    } else if (resp.status === 401) {
      setStatus('连接失败：API Key 无效（401）。', 'err');
    } else if (resp.status === 429) {
      setStatus('已连通，但被限流（429），稍后再试。', 'err');
    } else {
      setStatus(`连接失败（HTTP ${resp.status}）。`, 'err');
    }
  } catch (err) {
    setStatus(`网络错误：${err?.message || err}`, 'err');
  }
}

// ── 绑定事件 ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', load);

// 自动保存：所有字段变更时触发
['provider', 'baseUrl', 'apiKey', 'targetLang', 'triggerMode'].forEach((id) => {
  $(id).addEventListener('input', autoSave);
  $(id).addEventListener('change', autoSave);
});
$('modelSelect').addEventListener('change', () => {
  const custom = $('modelCustom');
  if ($('modelSelect').value === CUSTOM_MODEL_VALUE) {
    custom.style.display = '';
    custom.focus();
  } else {
    custom.style.display = 'none';
  }
  autoSave();
});
$('modelCustom').addEventListener('input', autoSave);

$('save').addEventListener('click', save);
$('test').addEventListener('click', testConnection);
$('fetchModels').addEventListener('click', fetchModels);
$('showKey').addEventListener('change', (e) => {
  $('apiKey').type = e.target.checked ? 'text' : 'password';
});
