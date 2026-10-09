/**
 * Token Usage Monitor / 消息 Token 用量
 *
 * 在每条消息底部显示 API 上报的「入 / 缓存 / 出」token 数。
 *
 * 设计要点 —— **完全自包含，不依赖核心的任何改动**：
 *   1. 捕获：包装 window.fetch，只对 /api/backends/chat-completions/generate 介入。
 *      - 请求侧：流式请求补上 stream_options.include_usage=true（仅 custom / openai 渠道），
 *        否则多数服务商不会在流尾回传 usage。
 *      - 响应侧：克隆一份自行解析（流式取 SSE 尾包 / 非流式取 body.usage），
 *        原始 Response 原样返回，不碰应用的读取流程。
 *   2. 存盘：写进 chat[mesId].extra.token_usage（extra 是自由字段，随聊天存档持久化）。
 *   3. 渲染：写进消息底部已有的 .tokenCounterDisplay，不新增 DOM，避免与其他实现重复显示。
 *
 * 与本 fork 里已有的核心实现【共存】：
 *   - 核心若已写入 extra.token_usage，两边算出的值一致，覆盖无副作用；
 *   - 渲染复用同一个元素，谁后写谁生效，内容相同所以看不出差别；
 *   - ST 更新把核心那几个文件覆盖掉之后，本扩展依然独立工作。
 */

const MODULE_NAME = 'tokenUsageMonitor';
const EXTENSION_PATH = 'third-party/token-usage-monitor';
const GENERATE_URL = '/api/backends/chat-completions/generate';
/** 只有这两条渠道认 stream_options，其他渠道（claude / 原生 gemini 等）塞进去会被拒 */
const STREAM_OPTIONS_SOURCES = ['custom', 'openai'];
const NO_CACHE_DATA = '\u2014';

const defaultSettings = {
    enabled: true,
    showInput: true,
    showCache: true,
    showOutput: true,
    injectStreamOptions: true,
};

/** 已捕获但尚未落到某条消息上的用量：{ usage, baseline, requestedAt } */
let pending = null;
/**
 * 最近一次「确实产生了助手消息」的时间。
 * 同一个生成端点也被 JS-Slash-Runner 之类的扩展使用，那些请求不会产出聊天消息；
 * 用它把这类请求挡掉，避免把别人的用量错记到某条消息上。
 */
let lastAssistantMessageAt = 0;
let attachTimer = null;
let attachTries = 0;
let saveTimer = null;
let renderTimer = null;
let mounted = false;
let observedChat = null;

/* ---------------------------------------------------------------- 基础设施 */

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? {};
    } catch (error) {
        console.error('[TokenUsage] 无法取得上下文', error);
        return {};
    }
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings) {
        return { ...defaultSettings };
    }
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = {};
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    return settings;
}

function saveSettings() {
    ctx().saveSettingsDebounced?.();
}

function saveChatSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            ctx().saveChat?.();
        } catch (error) {
            console.debug('[TokenUsage] 保存聊天失败', error);
        }
    }, 800);
}

/* ------------------------------------------------------------ 用量归一化 */

/**
 * 与核心保持一致的口径：同时兼容 OpenAI 与 DeepSeek 系的缓存字段。
 * hasCache 用来区分「服务商报了 0」（真未命中）与「服务商压根没报」（未知）。
 */
function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const toNumber = value => {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
    };

    const prompt = toNumber(usage.prompt_tokens ?? usage.input_tokens);
    const completion = toNumber(usage.completion_tokens ?? usage.output_tokens);
    const rawCached = usage.prompt_tokens_details?.cached_tokens
        ?? usage.prompt_cache_hit_tokens
        ?? usage.cached_tokens
        ?? usage.input_tokens_details?.cached_tokens;
    // 必须判「存在性」而不是真假：上报的 0 是有意义的信息。
    const hasCache = rawCached !== undefined && rawCached !== null;
    const cached = toNumber(rawCached);

    if (!prompt && !completion && !cached) {
        return null;
    }

    return { prompt, completion, cached, hasCache };
}

/* -------------------------------------------------------------- 请求侧 */

/**
 * 流式请求需要显式索要 usage 尾包，否则上游通常不回传。
 * @returns {{init: RequestInit, stream: boolean}}
 */
function patchRequestInit(init) {
    const result = { init, stream: false };
    if (!init || typeof init.body !== 'string') {
        return result;
    }

    let body;
    try {
        body = JSON.parse(init.body);
    } catch {
        return result;
    }
    if (!body || typeof body !== 'object') {
        return result;
    }

    result.stream = body.stream === true;

    if (!result.stream || !getSettings().injectStreamOptions) {
        return result;
    }
    if (!STREAM_OPTIONS_SOURCES.includes(body.chat_completion_source)) {
        return result;
    }

    const next = {
        ...body,
        stream_options: { ...(body.stream_options ?? {}), include_usage: true },
    };
    result.init = { ...init, body: JSON.stringify(next) };
    return result;
}

/* -------------------------------------------------------------- 响应侧 */

/** 从整段响应文本里抠出 usage：SSE 取最后一个带 usage 的 data 包，普通 JSON 取 .usage */
function extractUsage(text) {
    if (!text) {
        return null;
    }

    if (/^data:\s*\{/m.test(text)) {
        let usage = null;
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
                continue;
            }
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') {
                continue;
            }
            try {
                const parsed = JSON.parse(payload);
                if (parsed && parsed.usage) {
                    usage = parsed.usage;
                }
            } catch {
                // 被截断的半行，跳过
            }
        }
        return usage;
    }

    try {
        return JSON.parse(text)?.usage ?? null;
    } catch {
        return null;
    }
}

/**
 * @param {Response} response 原始响应（原样返回给应用，这里只读克隆副本）
 * @param {number} baseline 本次请求发出时的聊天长度，用于锁定归属消息
 * @param {number} requestedAt 请求发出的时间戳
 */
function tapResponse(response, baseline, requestedAt) {
    if (!response || typeof response.clone !== 'function') {
        return;
    }

    let clone;
    try {
        clone = response.clone();
    } catch (error) {
        console.debug('[TokenUsage] 无法克隆响应，本次跳过', error);
        return;
    }

    clone.text().then(text => {
        const normalized = normalizeUsage(extractUsage(text));
        if (!normalized) {
            return;
        }
        pending = { usage: normalized, baseline, requestedAt };
        attachTries = 0;
        attachPending();
        scheduleAttachRetries();
    }).catch(error => {
        // 用户点「停止」时副本也会中断，属正常情况
        console.debug('[TokenUsage] 读取响应副本结束', error);
    });
}

let originalFetch = null;

function installFetchHook() {
    if (originalFetch || typeof window.fetch !== 'function') {
        return;
    }
    originalFetch = window.fetch.bind(window);

    window.fetch = async function (input, init) {
        let url = '';
        try {
            url = typeof input === 'string' ? input : (input?.url ?? '');
        } catch {
            url = '';
        }

        if (!url || !url.includes(GENERATE_URL)) {
            return originalFetch(input, init);
        }

        const patched = patchRequestInit(init);
        // 记下本次生成开始前的聊天长度，用来锁定归属的消息。
        // 必须在这里取成局部量并随响应一起带下去 —— 用共享变量的话，
        // 两次请求交叠时会被后一次覆盖，导致归属判断错位。
        const chat = ctx().chat;
        const baseline = Array.isArray(chat) ? chat.length : -1;
        const requestedAt = Date.now();

        const response = await originalFetch(input, patched.init);
        try {
            tapResponse(response, baseline, requestedAt);
        } catch (error) {
            console.debug('[TokenUsage] 挂载响应解析失败', error);
        }
        return response;
    };

    console.debug('[TokenUsage] fetch 钩子已安装');
}

/* -------------------------------------------------------------- 归属与存盘 */

function attachPending() {
    if (!pending) {
        return false;
    }

    const chat = ctx().chat;
    if (!Array.isArray(chat) || !chat.length) {
        return false;
    }

    // 该请求发出之后并没有产生新的助手消息 —— 多半是别的扩展（如 JS-Slash-Runner）
    // 在借用同一个生成端点，这份用量不属于任何聊天消息，交由重试逻辑最终丢弃。
    if (pending.requestedAt > lastAssistantMessageAt) {
        return false;
    }

    // 从最新往回找，但不越过本次请求开始的位置：
    //  - 普通生成 / 续写：目标在 baseline 或更后（baseline-1 是用户消息，会被跳过）
    //  - 重 roll（swipe）：目标就是 baseline-1 那条助手消息
    const baseline = Number.isInteger(pending.baseline) && pending.baseline >= 0 ? pending.baseline : chat.length;
    const start = Math.max(0, baseline - 1);

    for (let i = chat.length - 1; i >= start; i--) {
        const message = chat[i];
        if (!message || typeof message !== 'object' || message.is_user || message.is_system) {
            continue;
        }

        const usage = pending.usage;
        message.extra = message.extra ?? {};
        message.extra.token_usage = usage;
        pending = null;
        clearTimeout(attachTimer);

        saveChatSoon();
        renderMessage(i);
        console.log('[TokenUsage] 已记录 #' + i + ' 的用量 ' + JSON.stringify(usage));
        return true;
    }

    return false;
}

/** 响应解析完成与消息落盘/渲染之间存在竞态，短时重试兜住 */
function scheduleAttachRetries() {
    clearTimeout(attachTimer);
    attachTries = 0;
    const tick = () => {
        if (!pending) {
            return;
        }
        attachPending();
        if (pending && ++attachTries < 20) {
            attachTimer = setTimeout(tick, 250);
        } else if (pending) {
            console.debug('[TokenUsage] 放弃挂载：找不到归属消息', pending);
            pending = null;
        }
    };
    attachTimer = setTimeout(tick, 250);
}

/* ---------------------------------------------------------------- 渲染 */

function formatUsage(extra) {
    const settings = getSettings();
    const usage = extra?.token_usage ?? null;
    if (!usage) {
        return '';
    }

    const compact = value => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
    const parts = [];

    if (settings.showInput) {
        parts.push(`入 ${compact(Number(usage.prompt ?? 0) || 0)}`);
    }
    if (settings.showCache) {
        const cached = Number(usage.cached ?? 0) || 0;
        if (usage.hasCache === false) {
            parts.push(`缓存 ${NO_CACHE_DATA}`);
        } else if (usage.hasCache === true || cached > 0) {
            parts.push(`缓存 ${compact(cached)}`);
        }
    }
    if (settings.showOutput) {
        parts.push(`出 ${compact(Number(usage.completion ?? 0) || 0)}`);
    }

    return parts.join(' / ');
}

function applyToElement(element, extra) {
    const target = element.querySelector('.tokenCounterDisplay');
    if (!target) {
        return;
    }
    const text = formatUsage(extra);
    if (target.textContent !== text) {
        target.textContent = text;
    }
}

function renderMessage(messageId) {
    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (element) {
        applyToElement(element, ctx().chat?.[messageId]?.extra);
    }
}

function renderAll() {
    const settings = getSettings();
    const chat = ctx().chat ?? [];

    document.body.classList.toggle('sctu-on', settings.enabled !== false);
    if (settings.enabled === false) {
        return;
    }

    document.querySelectorAll('#chat .mes[mesid]').forEach(element => {
        const id = Number(element.getAttribute('mesid'));
        if (!Number.isInteger(id)) {
            return;
        }
        applyToElement(element, chat[id]?.extra);
    });
}

function scheduleRenderAll(delay = 150) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, delay);
}

/* ---------------------------------------------------------------- 事件 */

const RENDER_EVENTS = [
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_RECEIVED',
    'MESSAGE_SWIPED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'CHAT_CHANGED',
];

/** 这几个事件代表「确实有一条助手消息落到了聊天里」 */
const ASSISTANT_EVENTS = ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED'];

function wireEvents() {
    const { eventSource, eventTypes } = ctx();
    if (!eventSource || !eventTypes) {
        console.warn('[TokenUsage] 事件系统不可用');
        return;
    }

    for (const name of RENDER_EVENTS) {
        const type = eventTypes[name];
        if (type === undefined) {
            continue;
        }
        const marksAssistant = ASSISTANT_EVENTS.includes(name);
        eventSource.on(type, () => {
            if (marksAssistant) {
                lastAssistantMessageAt = Date.now();
            }
            attachPending();
            scheduleRenderAll();
        });
    }

    console.debug('[TokenUsage] 事件已绑定');
}

/**
 * 只观察 #chat 的直接子节点增删：
 * 载入聊天 / redisplayChat 会整体重建消息节点，而流式打字只改消息内部文本，
 * 不会命中这里 —— 既不漏，也不会在生成时被高频触发。
 */
function observeChat() {
    const chatElement = document.getElementById('chat');
    if (!chatElement || observedChat === chatElement) {
        return;
    }
    observedChat = chatElement;
    new MutationObserver(() => scheduleRenderAll(120))
        .observe(chatElement, { childList: true });
    console.debug('[TokenUsage] 已监听 #chat 的子节点变化');
}

/* ---------------------------------------------------------------- 设置面板 */

function updateControlState() {
    const settings = getSettings();
    const off = settings.enabled === false;

    $('#sctu_enabled').prop('checked', !off);
    $('#sctu_show_input').prop('checked', settings.showInput !== false);
    $('#sctu_show_cache').prop('checked', settings.showCache !== false);
    $('#sctu_show_output').prop('checked', settings.showOutput !== false);
    $('#sctu_inject').prop('checked', settings.injectStreamOptions !== false);
    $('#sctu_show_input, #sctu_show_cache, #sctu_show_output, #sctu_inject').prop('disabled', off);
    $('#sctu_settings').toggleClass('sctu-disabled', off);
}

function refreshStatus() {
    const chat = ctx().chat ?? [];
    let withUsage = 0;
    let cached = 0;
    let cacheKnown = 0;
    let prompt = 0;
    let completion = 0;

    for (const message of chat) {
        const usage = message?.extra?.token_usage;
        if (!usage) {
            continue;
        }
        withUsage++;
        prompt += Number(usage.prompt ?? 0) || 0;
        completion += Number(usage.completion ?? 0) || 0;
        if (usage.hasCache === true) {
            cacheKnown++;
            cached += Number(usage.cached ?? 0) || 0;
        }
    }

    const rate = prompt > 0 && cacheKnown > 0 ? ` · 已报缓存的消息命中率 ${Math.round((cached / prompt) * 100)}%` : '';
    $('#sctu_status').html(
        `<div><b>当前聊天消息数</b><span>${chat.length}</span></div>` +
        `<div><b>带用量记录</b><span>${withUsage}</span></div>` +
        `<div><b>累计入 / 出</b><span>${prompt.toLocaleString('en-US')} / ${completion.toLocaleString('en-US')}</span></div>` +
        `<div><b>缓存</b><span>${cacheKnown > 0 ? cached.toLocaleString('en-US') : '本渠道未上报'}</span></div>` +
        `<div><b>备注</b><span>${rate || '—'}</span></div>`,
    );
}

function bindUi() {
    $('#sctu_enabled').on('input', () => {
        getSettings().enabled = $('#sctu_enabled').prop('checked');
        saveSettings();
        updateControlState();
        if (getSettings().enabled === false) {
            document.body.classList.remove('sctu-on');
        }
        renderAll();
        refreshStatus();
    });

    const simpleToggles = [
        ['#sctu_show_input', 'showInput'],
        ['#sctu_show_cache', 'showCache'],
        ['#sctu_show_output', 'showOutput'],
        ['#sctu_inject', 'injectStreamOptions'],
    ];
    for (const [selector, key] of simpleToggles) {
        $(selector).on('input', () => {
            getSettings()[key] = $(selector).prop('checked');
            saveSettings();
            updateControlState();
            renderAll();
        });
    }

    $('#sctu_refresh').on('click', () => {
        renderAll();
        refreshStatus();
    });
}

async function mountSettings() {
    if (mounted || document.getElementById('sctu_settings')) {
        mounted = true;
        return;
    }

    const { renderExtensionTemplateAsync } = ctx();
    if (typeof renderExtensionTemplateAsync !== 'function') {
        console.warn('[TokenUsage] renderExtensionTemplateAsync 不可用，跳过设置面板挂载');
        return;
    }

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        if (!container.length) {
            console.warn('[TokenUsage] 找不到设置面板容器');
            return;
        }
        container.append(html);
        mounted = true;
        bindUi();
        updateControlState();
        refreshStatus();
    } catch (error) {
        console.error('[TokenUsage] 设置面板挂载失败', error);
    }
}

/* ---------------------------------------------------------------- 启动 */

// 钩子必须在任何一次生成之前装好，所以模块加载时立刻生效，不等 DOM。
installFetchHook();

jQuery(async () => {
    await mountSettings();
    wireEvents();
    observeChat();
    renderAll();
    setTimeout(renderAll, 500);
    setTimeout(renderAll, 2000);
});
