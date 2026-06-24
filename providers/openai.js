// providers/openai.js
// OpenAI Chat Completions（及任何 OpenAI 兼容端点）的流式翻译实现。
//
// 协议：通过传入的 runtime.Port 回推消息：
//   {type:'chunk', text}   —— 每段增量译文（打字机效果）
//   {type:'done'}          —— 流正常结束
//   {type:'error', message}—— 任何失败（网络 / HTTP 非 2xx / Key 无效 / 解析错误）

// 幂等守卫：避免重复加载时顶层 const/function 重复声明报错。
if (!self.openaiProvider) {
  const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
  const DEFAULT_MODEL = 'gpt-4o-mini';

  function buildSystemPrompt(to) {
  return `你是专业翻译助手。将用户发送的内容翻译成${to}，只返回译文，不要解释，不要加引号。`;
}

// 从 SSE 字节流中逐行解析并推送 chunk。
// 传入一个 buffer 状态对象（{s:''}），跨 read() 调用保持未完成的行。
async function pumpReader(reader, port, buffer) {
  let result;
  let totalBytes = 0;       // 读取到的总字节数（诊断用）
  let chunkCount = 0;       // 推送给气泡的 chunk 数（诊断用）
  // 循环读取，直到流关闭
  while (!(result = await reader.read()).done) {
    totalBytes += result.value.byteLength || 0;
    // 将字节解码为文本并拼到 buffer
    const textChunk = new TextDecoder('utf-8').decode(result.value, { stream: true });
    buffer.s += textChunk;

    // 按行切分；最后一行可能不完整，保留在 buffer
    const lines = buffer.s.split('\n');
    buffer.s = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.trimStart();
      if (!line || !line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        console.log('[AIT] 流结束 [DONE]，总字节:', totalBytes, '推送 chunk 数:', chunkCount);
        port.postMessage({ type: 'done' });
        return;
      }

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        // 跳过无法解析的行（心跳、注释等），不中断流
        continue;
      }

      // 诊断：打印首个 delta 的结构，确认字段名
      if (totalBytes < 2000 && chunkCount === 0) {
        const d = json?.choices?.[0]?.delta;
        if (d) console.log('[AIT] 首个 delta keys:', Object.keys(d), '| content:', d.content, '| reasoning:', d.reasoning_content?.slice(0, 20));
      }

      // 只取真正的译文 delta.content。
      // 部分模型（如 qwen3.5-flash）会先输出 reasoning_content（思考过程），
      // 用户不需要，这里直接忽略；模型思考结束后 content 才会带译文。
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) {
        chunkCount++;
        port.postMessage({ type: 'chunk', text: delta });
      }
    }
  }

  console.log('[AIT] 流自然结束，总字节:', totalBytes, '推送 chunk 数:', chunkCount);
  // 流自然结束（未收到 [DONE]）：仍视为完成
  if (buffer.s.trim().startsWith('data:')) {
    // 处理缓冲区里最后一行
    const data = buffer.s.trim().slice(5).trim();
    if (data && data !== '[DONE]') {
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) port.postMessage({ type: 'chunk', text: delta });
      } catch { /* ignore */ }
    }
  }
  port.postMessage({ type: 'done' });
}

async function translateStream({ port, text, to, config }) {
  let baseUrl = (config?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  // 容错：用户常填 "https://xxx.com" 漏掉 "/v1"。
  // 若末尾不是版本段（如 /v1、/v2），则自动补 /v1（OpenAI 及多数兼容端点的标准路径）。
  if (!/\/v\d+$/.test(baseUrl)) {
    baseUrl += '/v1';
  }
  const apiKey = config?.apiKey;
  const model = config?.model || DEFAULT_MODEL;

  if (!apiKey) {
    port.postMessage({ type: 'error', message: '未配置 API Key，请在设置中填写。' });
    return;
  }

  const url = `${baseUrl}/chat/completions`;
  console.log('[AIT] fetch →', url, 'model:', model, 'enable_thinking:false');
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        // 关闭思考过程（通义 qwen3.x 系列参数 enable_thinking:false）。
        // 默认开启：目标端点多为中文兼容中转，思考型模型会先吐 30s+ reasoning_content，
        // 关掉后直接输出译文。官方 OpenAI 会忽略此未知字段，不影响。
        // config.disableThinking === false 时才不发送（即允许思考）。
        ...(config?.disableThinking === false ? {} : { enable_thinking: false }),
        messages: [
          { role: 'system', content: buildSystemPrompt(to) },
          { role: 'user', content: text },
        ],
      }),
    });
  } catch (err) {
    console.log('[AIT] fetch 抛错:', err?.message || err);
    port.postMessage({
      type: 'error',
      message: `网络请求失败：${err?.message || err}。请检查端点 URL 与网络。`,
    });
    return;
  }

  console.log('[AIT] response.status =', response.status, 'hasBody =', !!response.body);

  if (!response.ok) {
    // 解析错误体，给出友好提示
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      try { detail = await response.text(); } catch { /* ignore */ }
    }
    const hint =
      response.status === 401
        ? 'API Key 无效或已过期。'
        : response.status === 429
          ? '请求被限流（429），请稍后重试。'
          : '';
    port.postMessage({
      type: 'error',
      message: `请求失败（HTTP ${response.status}）。${hint}${detail ? ' 详情：' + detail : ''}`,
    });
    return;
  }

  if (!response.body) {
    port.postMessage({ type: 'error', message: '响应没有可读流（response.body 为空）。' });
    return;
  }

  try {
    await pumpReader(response.body.getReader(), port, { s: '' });
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: `流式读取中断：${err?.message || err}`,
    });
  }
}

  // 非 ES module 方案：把本 provider 注册到全局，供 providers/index.js 收集。
  // Firefox background page 与 Chrome service worker 均可访问 self。
  self.openaiProvider = { translateStream };
}
