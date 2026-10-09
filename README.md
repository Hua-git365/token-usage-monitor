# Token Usage Monitor · 消息 Token 用量

一个**完全自包含**的 SillyTavern 扩展：在每条消息底部显示服务商真实上报的「入 / 缓存 / 出」token 数。

不修改核心任何文件 —— 它自己包装 `window.fetch` 拦截生成请求与响应。**SillyTavern 升级覆盖核心文件后，本扩展依然照常工作。**

---

## 显示形态

每条回复底部一行：

```
入 5.9k / 缓存 5.7k / 出 138
```

### 缓存是三态，不是两态

这条是刻意的设计，也是很多 token 显示功能的盲区：

| 服务商上报 | 显示 | 含义 |
|---|---|---|
| 有缓存字段，且 `> 0` | `缓存 1.2k` | ✅ 命中 |
| 有缓存字段，且 `= 0` | `缓存 0` | ❌ 明确未命中 |
| **压根没有缓存字段** | `缓存 —` | ❓ **未知**（该渠道不报，不等于未命中） |

「不报」和「报了 0」是完全不同的两件事，混在一起会让人误判成「缓存坏了」。判定用的字段存在性检查：

```js
const hasCache = rawCached !== undefined && rawCached !== null;
```

兼容的缓存字段来源：`prompt_tokens_details.cached_tokens`（OpenAI 系）、`prompt_cache_hit_tokens` / `cached_tokens`（DeepSeek 系）、`input_tokens_details.cached_tokens`。

---

## 安装

在 SillyTavern 中打开 **Extensions（扩展）** 面板 → 点击 **Install Extension（安装扩展）** → 粘贴**下面任一地址** → 安装后**刷新页面**：

| 源 | 地址 |
|---|---|
| GitHub（主仓库） | `https://github.com/Hua-git365/token-usage-monitor` |
| Gitee（镜像，国内更快） | `https://gitee.com/lu-leihua/token-usage-monitor` |

两个地址是同一份代码的镜像，装哪个都一样；带不带 `.git` 后缀都能识别。

> **仓库名必须保持 `token-usage-monitor`。** 扩展代码里硬编码了设置面板路径 `third-party/token-usage-monitor`，SillyTavern 按仓库名建文件夹，改名会导致设置面板加载失败。

---

## 设置项

| 选项 | 默认 | 说明 |
|---|---|---|
| **启用** | 开 | 关掉后消息底部不再显示用量 |
| **显示「入」** | 开 | 输入（prompt）token |
| **显示「缓存」** | 开 | 缓存命中 token，三态显示 |
| **显示「出」** | 开 | 输出（completion）token |
| **流式自动索要用量** | 开 | 给流式请求注入 `stream_options.include_usage: true` |

### 关于「流式自动索要用量」

流式场景下，多数服务商**默认不会回传 usage**，必须在请求体里显式带上：

```json
{ "stream_options": { "include_usage": true } }
```

本扩展会自动注入，但**只对 `custom` / `openai` 两条渠道注入** —— 其他渠道（Claude 原生、Gemini 原生等）塞这个字段会被直接拒绝。关掉这个开关，流式下很可能就没有数据了。

设置面板底部还有一块统计区：当前聊天消息数、带用量记录的消息数、累计入/出、以及已报缓存消息的命中率。

---

## 工作原理

```
                     ┌─ 请求侧：流式请求补 stream_options.include_usage
window.fetch ────────┤
   (被包装)          └─ 响应侧：clone() 一份自行解析
                              ↓
                    流式 → 取 SSE 最后一个带 usage 的 data 包
                    非流式 → 取 body.usage
                              ↓
                    归一化 → 写入 chat[mesId].extra.token_usage
                              ↓
                    渲染进消息底部已有的 .tokenCounterDisplay
```

三个关键设计：

1. **原始 `Response` 原样返回**，只读 `clone()` 出来的副本。克隆是 tee，读副本不会影响应用自身的流。
2. **副本读到底** —— usage 在 SSE 的最后一个数据包里，中途放弃会让 tee 积压。
3. **不新增 DOM**，直接写进消息底部已有的 `.tokenCounterDisplay` 元素 —— 避免和核心自带的 token 显示产生两行重复。

### 归属判定：这份用量属于哪条消息？

生成端点 `/api/backends/chat-completions/generate` **不只被主生成流程使用** —— JS-Slash-Runner 之类的扩展也会直接打它，而那些请求不产出聊天消息。

处理方式：

- 请求发出的瞬间记下 `chat.length` 作为 `baseline`（局部量，随响应一起传递，避免两次请求交叠时互相覆盖）
- 收到 `CHARACTER_MESSAGE_RENDERED` / `MESSAGE_RECEIVED` / `MESSAGE_SWIPED` 时刷新 `lastAssistantMessageAt`
- 落盘前要求 `pending.requestedAt <= lastAssistantMessageAt`，否则判定为「不是本扩展该管的请求」，交给重试逻辑最终丢弃

区间取 `[baseline - 1, 末尾]`：普通生成时 `baseline - 1` 是用户消息（会被跳过）；重 roll（swipe）时它就是那条被重写的助手消息（正确命中）。

### 竞态处理

响应读完成与消息落盘/渲染之间存在竞态。解析完成后立刻试挂一次，之后按 **250ms × 20 次**重试兜住。

---

## 兼容性

- SillyTavern 1.12+（依赖 `globalThis.SillyTavern.getContext()` 与 `renderExtensionTemplateAsync`）
- **不修改任何核心文件**，随 ST 升级而自动保持可用
- 与核心自带的 token 显示**共存**：两边算出的值一致，复用同一个 DOM 节点，谁后写谁生效，内容相同看不出差别

---

## 许可

[MIT](LICENSE)
