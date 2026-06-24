# AI Translate

一款轻量级浏览器翻译扩展（Firefox + Chrome 双平台），支持在任意网页上划词翻译，调用你自己配置的 AI API 进行流式翻译。无需后端服务器，所有数据均在本地处理。

## 功能

- **划词弹出气泡** — 选中文字松手即译，浮动气泡就近显示在选区下方
- **流式打字机效果** — AI 逐字返回译文，无需等待全部完成
- **11 种目标语言** — 简中、繁中、英、日、韩、法、德、西、葡、俄、阿
- **右键菜单翻译** — 右键选中文字 → 翻译选中内容
- **一键复制译文** — 气泡内置复制按钮
- **翻译缓存** — 重复内容不重复调用 API，命中缓存瞬间返回
- **Shadow DOM 样式隔离** — 气泡样式与宿主页面完全隔离，互不污染
- **兼容所有 OpenAI 端点** — 支持 OpenAI、Azure、Groq、Ollama、vLLM 等任何 OpenAI 兼容接口
- **模型列表获取** — 填好 API 地址和 Key 后一键拉取可用模型，下拉选择

## 快速开始

1. 准备好你的 AI API Key（OpenAI 或任意兼容服务）
2. 加载扩展：
   - **Firefox:** 地址栏输入 `about:debugging#/runtime/this-firefox` → "临时载入附加组件" → 选择 `manifest.json`
   - **Chrome:** 地址栏输入 `chrome://extensions` → 开启开发者模式 → "加载已解压的扩展程序" → 选择项目目录
3. 点击工具栏扩展图标 → 填写 API 端点、Key 和模型 → 保存
4. 打开任意网页，选中一段文字，看到翻译气泡弹出即可使用

## 配置说明

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| API 端点 | AI API 的基础地址 | `https://api.openai.com/v1` |
| API Key | 你的 API 密钥（仅存本地） | — |
| 模型 | 使用的模型名称（可从接口拉取列表） | `gpt-4o-mini` |
| 默认目标语言 | 翻译的目标语言 | 简体中文 |

所有设置存储在 `browser.storage.local`，API Key 仅在你配置的 API 端点之间传输，不会上传到任何第三方服务器。

## 架构

```
Content Script (content.js)  ←→  Background SW (background.js)  →  AI API
                                      ↕ storage
                                 Popup (popup/popup.html)
```

四个独立上下文通过消息传递（Message Passing）通信：

- **content.js** — 注入到每个网页，检测选区、渲染 Shadow DOM 气泡、建立 Port 长连接接收流式数据
- **background.js** — 后台 Service Worker，负责路由翻译请求到指定 Provider、管理翻译缓存
- **providers/** — 可插拔的 AI 后端层，每个厂商一个文件，统一 `translateStream()` 接口
- **popup/** — 设置页面，配置 API 端点、Key、模型和默认语言

流式翻译使用 `runtime.Port` 长连接而非 `sendMessage`，因为流式传输需要持续的、双向的消息通道。

## 新增 AI 厂商

1. 创建 `providers/<名称>.js` — 实现 `translateStream({port, text, to, config})`，挂载到 `self.<名称>Provider`
2. 在 `providers/index.js` 的 `REGISTRY` 中注册
3. 在 `manifest.json` 的 `background.scripts` 数组中加入新文件（放在 `index.js` 之前）

`translateStream` 函数接收一个 `runtime.Port` 对象，需要通过它推送消息：

| 消息类型 | 数据 | 触发时机 |
|----------|------|----------|
| `chunk` | `{text: string}` | 每个增量 token |
| `done` | — | 流正常结束 |
| `error` | `{message: string}` | 任何失败（网络/认证/解析错误） |

## 开发

无需构建工具，无需依赖。编辑文件 → 浏览器扩展管理页点击重新加载。

```
ai-translate/
├── manifest.json            # MV3 扩展清单
├── background.js            # 后台 Service Worker
├── content.js               # 气泡 UI + 选区检测
├── content.css              # 宿主元素样式
├── providers/
│   ├── index.js             # Provider 注册中心
│   └── openai.js            # OpenAI 兼容流式实现
├── popup/
│   ├── popup.html           # 设置页面
│   └── popup.js             # 设置页逻辑
└── icons/
    ├── icon-48.png
    └── icon-96.png
```

## 隐私说明

- API Key 仅存储在浏览器本地 `storage.local` 中，不会被上传到任何第三方服务器
- 翻译请求直接从你的浏览器发送到你配置的 AI 端点，不经过任何中间服务器
- 无埋点、无追踪、不收集任何用户数据

## License

MIT
