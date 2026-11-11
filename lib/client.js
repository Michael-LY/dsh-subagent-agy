/**
 * dsh-subagent-agy —— Gemini 网页 Deep Research 侧边栏面板（浏览器端）。
 *
 * 客户端是 DSH 的 lazy-CJS 包：只注册工厂，模块体副作用在首次物化时执行。
 * 面板注册到 root 作用域的 `main` keyed slot，并在 `sidebar.panellist`
 * 注册同名 entry；点击侧边栏的「Gemini 调研」即可打开。
 *
 * 所有耗时操作都走主机侧 /api/dsh-gemini-research/* 桥接，浏览器端不直接
 * 启动进程，也不接触登录态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-agy',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');

    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var PANEL_ID = 'gemini-research';
    var PANEL_ID_CHAT = 'gemini-chat';
    var API = '/api/dsh-gemini-research';
    var STYLE_ID = 'dsh-gemini-research-styles';

    var CSS = [
      '.dgr-page{box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;padding:28px 28px 48px;color:var(--dsw-alias-label-primary,inherit);font:inherit}',
      '.dgr-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}',
      '.dgr-headText{flex:1;min-width:0}',
      '.dgr-title{font-size:20px;line-height:28px;font-weight:650;margin:0}',
      '.dgr-sub{margin-top:4px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
      '.dgr-badge{flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit)}',
      '.dgr-dot{width:7px;height:7px;border-radius:50%;background:#8a8f99}',
      '.dgr-dot.ok{background:#22a06b}.dgr-dot.run{background:#4c8dff}.dgr-dot.bad{background:#e5484d}',
      '.dgr-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:14px;background:var(--dsw-alias-bg-layer-2,transparent);padding:16px;margin-bottom:14px}',
      '.dgr-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dgr-col{display:flex;flex-direction:column;gap:10px}',
      '.dgr-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
      '.dgr-input{box-sizing:border-box;width:100%;min-height:92px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13.5px;line-height:21px;outline:none}',
      '.dgr-input:focus{border-color:#4c8dff}',
      '.dgr-select{box-sizing:border-box;min-height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px;outline:none}',
      '.dgr-btn{appearance:none;min-height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-fill-elevated,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.dgr-btn:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.16))}',
      '.dgr-btn:disabled{opacity:.5;cursor:default}',
      '.dgr-btn.primary{border-color:#4c8dff;background:#4c8dff;color:#fff}',
      '.dgr-btn.danger{border-color:#e5484d;color:#e5484d;background:transparent}',
      '.dgr-status{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;line-height:20px}',
      '.dgr-kv{display:flex;gap:6px;align-items:baseline}.dgr-kv b{font-weight:600}',
      '.dgr-note{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,inherit);opacity:.82}',
      '.dgr-warn{border:1px solid rgba(220,140,0,.45);background:rgba(220,140,0,.08);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:20px}',
      '.dgr-report{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:22px;max-height:60vh;overflow:auto;padding:14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
      '.dgr-log{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:17px;max-height:180px;overflow:auto;opacity:.7}',
      '.dgr-empty{padding:26px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,inherit);opacity:.72}',
      '.dgr-icon{display:block}',
      '.dgr-chatList{display:flex;flex-direction:column;gap:10px;min-height:220px;max-height:52vh;overflow:auto;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
      '.dgr-msg{display:flex;flex-direction:column;gap:4px;max-width:88%}',
      '.dgr-msg.user{align-self:flex-end;align-items:flex-end}',
      '.dgr-msg.assistant{align-self:flex-start}',
      '.dgr-msgRole{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,inherit);opacity:.7}',
      '.dgr-msgBody{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:21px;padding:9px 12px;border-radius:12px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12))}',
      '.dgr-msg.user .dgr-msgBody{background:#4c8dff;color:#fff}',
      '.dgr-chatInput{box-sizing:border-box;width:100%;min-height:64px;max-height:180px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13.5px;line-height:21px;outline:none}',
      '.dgr-chatInput:focus{border-color:#4c8dff}',
      '.dgr-chatEmpty{padding:36px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,inherit);opacity:.72}',
      '@media (max-width:700px){.dgr-page{padding:20px 16px 40px}}',
      '.das-page{box-sizing:border-box;width:100%;max-width:760px;margin:0 auto;padding:6px 2px 40px;color:var(--dsw-alias-label-primary,inherit);font:inherit}',
      '.das-head{margin-bottom:16px}',
      '.das-title{margin:0;font-size:18px;line-height:26px;font-weight:600}',
      '.das-sub{margin-top:6px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.das-banner{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.08));border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:20px;margin-bottom:14px}',
      '.das-banner.warn{border-color:rgba(220,140,0,.45);background:rgba(220,140,0,.08)}',
      '.das-banner.error{border-color:rgba(229,72,77,.5);background:rgba(229,72,77,.08);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.das-group{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:14px;background:var(--dsw-alias-bg-layer-2,transparent);padding:16px 16px 4px;margin-bottom:14px}',
      '.das-groupTitle{margin:0 0 2px;font-size:15px;line-height:22px;font-weight:600}',
      '.das-groupHint{margin:0 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);opacity:.85}',
      '.das-row{display:flex;flex-wrap:wrap;gap:8px 20px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14))}',
      '.das-row:first-of-type{border-top:none}',
      '.das-rowMain{flex:1 1 220px;min-width:0}',
      '.das-rowHead{display:flex;align-items:center;gap:8px;margin-bottom:5px}',
      '.das-label{font-size:13px;line-height:20px;font-weight:500}',
      '.das-badge{flex:none;font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,inherit)}',
      '.das-reset{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:8px;cursor:pointer}',
      '.das-reset:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.16))}',
      '.das-reset:disabled{opacity:.4;cursor:default}',
      '.das-field{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.das-input,.das-select,.das-textarea{box-sizing:border-box;width:100%;min-height:34px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;line-height:20px;outline:none}',
      '.das-textarea{min-height:88px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12.5px;line-height:19px}',
      '.das-input:focus,.das-select:focus,.das-textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4c8dff)}',
      '.das-input:disabled,.das-select:disabled,.das-textarea:disabled{opacity:.6;cursor:default}',
      '.das-input.invalid,.das-textarea.invalid{border-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.das-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;cursor:pointer;min-height:34px}',
      '.das-check input{width:16px;height:16px}',
      '.das-hint{margin-top:2px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,inherit);opacity:.75}',
      '.das-invalid{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.das-empty{padding:24px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}',
      '@media (max-width:700px){.das-row{flex-direction:column}.das-field{flex-basis:auto;width:100%}}',
    ].join('');

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-subagent-agy';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------------
    // Settings page (settings.section): constants, field table, pure helpers and
    // the minimal form controller. Kept React-free so node tests can exercise it
    // through exports.__settings (see test/settings-ui.test.js).
    // ---------------------------------------------------------------------------
    var SETTINGS_NS = 'subagent-antigravity';
    var SECTION_ID = 'subagent-antigravity';
    var SECTION_ORDER = 50;

    var LABELS = {
      title: 'Antigravity 设置',
      intro: '配置 Antigravity 子智能体、Gemini 网页与并发团队；修改即时生效并写入 profile 配置。',
      loading: '正在读取配置…',
      unavailable: '该配置未由当前 Host 提供，暂时无法编辑。',
      readOnly: '本部署的设置为只读，无法修改。',
      reset: '恢复默认',
      overridden: '已覆盖',
      saving: '保存中…',
      saveFailed: '本次修改未生效：',
      rejected: '本次修改未被接受，已刷新为最新值。',
      empty: '暂无可用字段。',
      hintTeamName: '必须不同于上面的「提供商名称」，否则插件启动会失败。',
      hintDanger: 'auto 在 print 模式下工具确认会被软拒，仅适合无需工具的 prompt。',
      hintStreamOnly: '仅当「传输方式」= stream-json 时生效。',
      hintScrub: 'CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / GEMINI_CLI / ANTIGRAVITY_SESSION_ID 会被进程显式覆盖为空，此处设置无效。',
      hintEnv: '每行一个 KEY=VALUE；按第一个 = 切分，值保留原样。',
      hintList: '每行一个值。',
    };

    var GROUPS = [
      { id: 'basic', title: '基础', hint: 'Provider、可执行文件、模型与传输方式。' },
      { id: 'acp', title: '传输与 ACP', hint: '仅 transport = acp 时生效的握手、超时与权限设置。' },
      { id: 'gemini', title: 'Gemini 网页', hint: '浏览器 profile 与超时；修改会重启 worker，可能中断正在进行的任务。' },
      { id: 'team', title: '团队与并发', hint: '并行团队 provider 与批量并发委派工具。' },
      { id: 'advanced', title: '高级', hint: '环境变量、额外参数、附加目录与重试等底层设置。' },
    ];

    // Model catalog mirrored from `agy models` (base id + supported effort levels).
    var MODEL_CATALOG = [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', efforts: ['medium'] },
    ];
    var EFFORT_OPTIONS = ['low', 'medium', 'high'];

    function modelOptions() {
      return MODEL_CATALOG.map(function (item) { return { value: item.id, label: item.label }; });
    }

    function effortsForModel(modelId) {
      for (var i = 0; i < MODEL_CATALOG.length; i += 1) {
        if (MODEL_CATALOG[i].id === modelId) return MODEL_CATALOG[i].efforts.slice();
      }
      return EFFORT_OPTIONS.slice();
    }

    var FIELDS = [
      { key: 'providerName', group: 'basic', control: 'text', label: '提供商名称', default: 'antigravity', placeholder: 'antigravity' },
      { key: 'executable', group: 'basic', control: 'text', label: 'agy 可执行文件', default: '%USERPROFILE%\\.gemini\\bin\\agy.exe', placeholder: '%USERPROFILE%\\.gemini\\bin\\agy.exe', hint: '改错会在启动时报 CLI not found。' },
      { key: 'model', group: 'basic', control: 'select', label: '模型', default: 'gemini-3.8-flash', options: modelOptions(), hint: '来自 agy models 的基础模型；思考强度单独选择。' },
      { key: 'effort', group: 'basic', control: 'select', label: '思考强度', default: 'medium', options: EFFORT_OPTIONS, hint: 'ACP 下会拼到模型名后缀（如 gemini-3.8-flash-medium）。' },
      { key: 'permissionMode', group: 'basic', control: 'select', label: '权限模式', default: 'dangerously-skip-permissions', options: ['dangerously-skip-permissions', 'auto'], hint: LABELS.hintDanger },
      { key: 'transport', group: 'basic', control: 'select', label: '传输方式', default: 'acp', options: ['acp', 'stream-json'], hint: '默认 acp；握手失败可按 acpFallbackToStreamJson 自动回退 stream-json。' },

      { key: 'acpProtocolVersion', group: 'acp', control: 'number', label: 'ACP 协议版本', default: 1, min: 1, integer: true },
      { key: 'acpRequestTimeoutMs', group: 'acp', control: 'number', label: 'ACP 握手超时(ms)', default: 30000, min: 1000, integer: true },
      { key: 'acpPromptTimeoutMs', group: 'acp', control: 'number', label: 'ACP 单轮超时(ms，0=不限)', default: 0, min: 0, integer: true },
      { key: 'acpPermissionPolicy', group: 'acp', control: 'select', label: 'ACP 权限策略', default: 'auto-approve', options: ['auto-approve', 'first-allow', 'reject', 'manual'], hint: 'permissionMode=dangerously-skip-permissions 时 host 强制 auto-approve。' },
      { key: 'acpFallbackToStreamJson', group: 'acp', control: 'checkbox', label: 'ACP 失败回退到 stream-json', default: true },
      { key: 'acpExtraArgs', group: 'acp', control: 'list', label: 'ACP 额外参数', default: [], placeholder: '每行一个 argv', hint: LABELS.hintList },

      { key: 'geminiProfileDir', group: 'gemini', control: 'text', label: '浏览器 profile 目录', placeholder: '留空=使用默认 ~/.dsh/gemini-web-research/browser-profile' },
      { key: 'geminiPython', group: 'gemini', control: 'text', label: 'Python 可执行文件', default: 'python', placeholder: 'python' },
      { key: 'geminiHeadless', group: 'gemini', control: 'checkbox', label: '无头运行浏览器', default: true, hint: '登录初始化始终有头，与此无关。' },
      { key: 'geminiTimeoutMs', group: 'gemini', control: 'number', label: '调研任务超时(ms)', default: 900000, min: 1, integer: true },
      { key: 'geminiChatTimeoutMs', group: 'gemini', control: 'number', label: '对话超时(ms)', default: 180000, min: 1000, integer: true },
      { key: 'geminiWorkerIdleMs', group: 'gemini', control: 'number', label: 'worker 空闲回收(ms)', default: 600000, min: 0, integer: true },
      { key: 'geminiWorkerMode', group: 'gemini', control: 'select', label: 'worker 模式', default: 'persistent', options: ['persistent', 'oneshot'] },
      { key: 'geminiDefaultModel', group: 'gemini', control: 'text', label: '默认模型', default: '', placeholder: '留空=无偏好；如 flash / flash-lite / pro / argon' },
      { key: 'geminiDefaultThinking', group: 'gemini', control: 'text', label: '默认思考等级', default: '', placeholder: '留空 / low / medium / high' },

      { key: 'teamProviderName', group: 'team', control: 'text', label: '团队 provider 名', default: 'antigravity-team', placeholder: 'antigravity-team', hint: LABELS.hintTeamName },
      { key: 'teamEnabled', group: 'team', control: 'checkbox', label: '启用团队 provider', default: true },
      { key: 'parallelToolName', group: 'team', control: 'text', label: '并发工具名', default: 'subagent_agy_parallel', placeholder: 'subagent_agy_parallel' },
      { key: 'parallelMaxTasks', group: 'team', control: 'number', label: '并发上限', default: 8, min: 1, max: 8, integer: true },

      { key: 'env', group: 'advanced', control: 'keyvalue', label: '环境变量', default: {}, placeholder: 'KEY=VALUE', hint: LABELS.hintEnv + ' ' + LABELS.hintScrub },
      { key: 'extraArgs', group: 'advanced', control: 'list', label: '额外 CLI 参数', default: [], placeholder: '每行一个 argv', hint: LABELS.hintList },
      { key: 'addDirs', group: 'advanced', control: 'list', label: '附加工作目录', default: [], placeholder: '每行一个路径', hint: LABELS.hintList },
      { key: 'newProject', group: 'advanced', control: 'checkbox', label: '每次新建项目', default: false, hint: 'ACP 下被忽略。' },
      { key: 'projectName', group: 'advanced', control: 'text', label: '项目名', default: '', placeholder: '可选，优先于 newProject', hint: 'ACP 下被忽略。' },
      { key: 'printTimeout', group: 'advanced', control: 'text', label: '打印超时', placeholder: '如 180s / 10m', hint: LABELS.hintStreamOnly },
      { key: 'jsonSchema', group: 'advanced', control: 'textarea', label: '结果 JSON Schema', placeholder: '内联 JSON 或文件路径', hint: LABELS.hintStreamOnly },
      { key: 'fallbackModel', group: 'advanced', control: 'text', label: '备用模型', placeholder: '留空=禁用；限流时重试一次' },
      { key: 'retryOnRateLimit', group: 'advanced', control: 'checkbox', label: '限流重试一次', default: false, hint: '默认关闭，勿默认开启。' },
      { key: 'disposeGraceMs', group: 'advanced', control: 'number', label: '进程回收宽限(ms)', default: 3000, min: 1, max: 600000, integer: true },
    ];

    function findField(field) {
      for (var i = 0; i < FIELDS.length; i += 1) if (FIELDS[i].key === field) return FIELDS[i];
      return null;
    }

    function projectFieldDefaults(field) {
      var meta = findField(field);
      if (!meta) return undefined;
      if (meta.default !== undefined) return meta.default;
      if (meta.control === 'checkbox') return false;
      if (meta.control === 'list') return [];
      if (meta.control === 'keyvalue') return {};
      if (meta.control === 'number') return undefined;
      return '';
    }

    function parseNumberField(text, options) {
      var opts = options || {};
      var raw = text === undefined || text === null ? '' : String(text).trim();
      if (raw === '') return { kind: 'unset' };
      var value = Number(raw);
      if (!isFinite(value)) return { kind: 'invalid', reason: '请输入数字' };
      if (opts.integer && !Number.isSafeInteger(value)) return { kind: 'invalid', reason: '请输入整数' };
      if (opts.min !== undefined && value < opts.min) return { kind: 'invalid', reason: '不能小于 ' + opts.min };
      if (opts.max !== undefined && value > opts.max) return { kind: 'invalid', reason: '不能大于 ' + opts.max };
      return { kind: 'set', value: value };
    }

    function parseListText(text) {
      if (text === undefined || text === null) return [];
      var lines = String(text).split(/\r?\n/);
      var out = [];
      for (var i = 0; i < lines.length; i += 1) {
        var item = lines[i].trim();
        if (item) out.push(item);
      }
      return out;
    }

    function parseEnvText(text) {
      var out = {};
      if (text === undefined || text === null) return { ok: true, value: out };
      var lines = String(text).split(/\r?\n/);
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        var trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === '#') continue;
        var eq = line.indexOf('=');
        if (eq < 0) return { ok: false, line: i + 1, reason: '第 ' + (i + 1) + " 行缺少 '='" };
        var key = line.slice(0, eq).trim();
        if (!key) return { ok: false, line: i + 1, reason: '第 ' + (i + 1) + ' 行 key 为空' };
        out[key] = line.slice(eq + 1);
      }
      return { ok: true, value: out };
    }

    function serializeList(value) {
      return Array.isArray(value) ? value.join('\n') : '';
    }

    function serializeEnv(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
      var keys = Object.keys(value).sort();
      var lines = [];
      for (var i = 0; i < keys.length; i += 1) {
        var v = value[keys[i]];
        lines.push(keys[i] + '=' + (v === undefined || v === null ? '' : String(v)));
      }
      return lines.join('\n');
    }

    function isFieldOverridden(user, field) {
      return !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field);
    }

    function normalizeEmptyValue(value) {
      if (value === undefined || value === null || value === '') return undefined;
      if (Array.isArray(value)) return value.length === 0 ? undefined : value;
      if (typeof value === 'object' && Object.keys(value).length === 0) return undefined;
      return value;
    }

    function valuesEqual(left, right) {
      if (left === right) return true;
      if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) return false;
        for (var i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
        return true;
      }
      if (left && right && typeof left === 'object' && typeof right === 'object') {
        var lk = Object.keys(left);
        if (lk.length !== Object.keys(right).length) return false;
        for (var j = 0; j < lk.length; j += 1) {
          var k = lk[j];
          if (!Object.prototype.hasOwnProperty.call(right, k) || String(left[k]) !== String(right[k])) return false;
        }
        return true;
      }
      return false;
    }

    // ---------------------------------------------------------------------------
    // Minimal settings controller: projects ConfigForm snapshots into a plain
    // store that the slot renderer wraps as useAntigravitySettings(selector).
    // ---------------------------------------------------------------------------
    function createSettingsController(form) {
      var state = project();
      var listeners = new Set();
      var pending = 0;
      var error = '';

      function notify() { listeners.forEach(function (fn) { fn(); }); }

      function project() {
        var s = form.getSnapshot();
        return {
          status: s.status,
          writable: s.writable === true,
          values: s.value || {},
          user: s.user || {},
          pending: pending,
          error: error,
        };
      }

      var unsubscribe = form.subscribe(function () {
        state = project();
        notify();
      });

      function commit(run) {
        pending += 1;
        error = '';
        state = project();
        notify();
        var task;
        try {
          task = run();
        } catch (err) {
          task = Promise.reject(err);
        }
        Promise.resolve(task).then(function (ok) {
          pending -= 1;
          if (ok === false) error = LABELS.rejected;
          state = project();
          notify();
        }, function (err) {
          pending -= 1;
          error = LABELS.saveFailed + (err && err.message ? err.message : String(err));
          state = project();
          notify();
        });
      }

      return {
        store: {
          getSnapshot: function () { return state; },
          subscribe: function (fn) {
            listeners.add(fn);
            return function () { listeners.delete(fn); };
          },
        },
        inject: function () {
          return {
            hooks: { antigravitySettings: this.store },
            editField: function (field, value) {
              commit(function () { return form.set(field, value); });
            },
            resetField: function (field) {
              commit(function () { return form.unset(field); });
            },
          };
        },
        dispose: function () {
          unsubscribe();
          listeners.clear();
        },
      };
    }

    function getJson(path) {
      return fetch(API + path, { method: 'GET', headers: { accept: 'application/json' } }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && (body.message || body.code)) || ('HTTP ' + res.status));
          return body;
        });
      });
    }

    function postJson(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        return res.json().then(function (payload) {
          if (!res.ok) throw new Error((payload && (payload.message || payload.code)) || ('HTTP ' + res.status));
          return payload;
        });
      });
    }

    function fmtTime(value) {
      if (!value) return '—';
      try {
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleString();
      } catch (error) {
        return '—';
      }
    }

    function elapsed(job) {
      if (!job || !job.startedAt) return '—';
      var end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
      var start = new Date(job.startedAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
      var seconds = Math.max(0, Math.round((end - start) / 1000));
      var minutes = Math.floor(seconds / 60);
      return minutes > 0 ? minutes + ' 分 ' + (seconds % 60) + ' 秒' : seconds + ' 秒';
    }

    var STATUS_TEXT = {
      queued: '排队中',
      running: '调研中',
      done: '已完成',
      error: '失败',
    };

    function statusTone(job) {
      if (!job) return '';
      if (job.status === 'done') return 'ok';
      if (job.status === 'running' || job.status === 'queued') return 'run';
      if (job.status === 'error') return 'bad';
      return '';
    }

    var FALLBACK_MODELS = [
      { id: 'flash-lite', label: 'Flash-Lite', displayName: 'Flash-Lite', thinkingLevels: ['low', 'medium', 'high'] },
      { id: 'flash', label: 'Flash', displayName: 'Flash', thinkingLevels: ['low', 'medium', 'high'] },
      { id: 'pro', label: 'Pro', displayName: 'Pro', thinkingLevels: ['low', 'medium', 'high'] },
      { id: 'argon', label: 'Argon', displayName: '4 Argon', thinkingLevels: ['low', 'medium', 'high'] },
    ];
    var FALLBACK_THINKING = [
      { id: 'low', label: '低（快速高效）' },
      { id: 'medium', label: '中（深度适中）' },
      { id: 'high', label: '高（超级详尽）' },
    ];

    function readPref(key) {
      try {
        return window.localStorage ? window.localStorage.getItem(key) || '' : '';
      } catch (error) {
        return '';
      }
    }

    function writePref(key, value) {
      try {
        if (window.localStorage) window.localStorage.setItem(key, value || '');
      } catch (error) {
        // Local storage can be unavailable in restricted webviews; ignore.
      }
    }

    function loadModelCatalog(mode, live, refresh) {
      return getJson('/models?mode=' + encodeURIComponent(mode) + (live ? '&live=1' : '&live=0') + (refresh ? '&refresh=1' : '')).catch(function () {
        return { ok: true, models: FALLBACK_MODELS, thinking: FALLBACK_THINKING, defaults: { model: '', thinking: '' }, source: 'fallback' };
      });
    }

    function thinkingOptionsFor(catalog, modelId) {
      var levels = catalog && catalog.thinking ? catalog.thinking : FALLBACK_THINKING;
      if (!modelId || !catalog || !catalog.models) return levels;
      var selected = null;
      for (var i = 0; i < catalog.models.length; i += 1) {
        if (catalog.models[i].id === modelId) selected = catalog.models[i];
      }
      if (!selected || !selected.thinkingLevels || selected.thinkingLevels.length === 0) return levels;
      return levels.filter(function (level) { return selected.thinkingLevels.indexOf(level.id) >= 0; });
    }

    function modelSelectRow(models, model, setModel, thinkingOptions, thinking, setThinking, running, onRefresh) {
      return h(
        'div',
        { className: 'dgr-row', style: { marginBottom: '10px' } },
        h('label', { className: 'dgr-row', style: { gap: '6px' } },
          h('span', { className: 'dgr-label' }, '模型'),
          h('select', {
            className: 'dgr-select',
            value: model,
            disabled: running,
            onChange: function (event) { setModel(event.target.value); },
          },
            h('option', { value: '' }, '默认'),
            models.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.displayName || item.label);
            })
          )
        ),
        h('label', { className: 'dgr-row', style: { gap: '6px' } },
          h('span', { className: 'dgr-label' }, '思考强度'),
          h('select', {
            className: 'dgr-select',
            value: thinking,
            disabled: running || thinkingOptions.length === 0,
            onChange: function (event) { setThinking(event.target.value); },
          },
            h('option', { value: '' }, '默认'),
            thinkingOptions.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.label);
            })
          )
        ),
        typeof onRefresh === 'function'
          ? h('button', { className: 'dgr-btn', type: 'button', onClick: onRefresh, disabled: running, style: { minHeight: '30px', padding: '0 10px' } }, '刷新模型')
          : null
      );
    }

    function GeminiIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18;
      return h(
        'svg',
        {
          className: 'dgr-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M12 2.6l1.9 5.9 5.9 1.9-5.9 1.9L12 18.2l-1.9-5.9L4.2 10.4l5.9-1.9L12 2.6z',
          fill: 'currentColor',
          opacity: '0.92',
        }),
        h('path', { d: 'M19 15.2l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7z', fill: 'currentColor', opacity: '0.55' })
      );
    }

    function ChatIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18;
      return h(
        'svg',
        {
          className: 'dgr-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
          fill: 'currentColor',
          opacity: '0.92',
        }),
        h('path', {
          d: 'M7 9h10M7 12.5h7',
          stroke: 'currentColor',
          'stroke-width': '1.6',
          'stroke-linecap': 'round',
          opacity: '0.5',
        })
      );
    }

    function GeminiResearchPanel() {
      var topicState = useState('');
      var statusState = useState(null);
      var jobState = useState(null);
      var errorState = useState('');
      var noticeState = useState('');
      var busyState = useState(false);
      var catalogState = useState(null);
      var modelState = useState('');
      var thinkingState = useState('');

      var topic = topicState[0];
      var setTopic = topicState[1];
      var status = statusState[0];
      var setStatus = statusState[1];
      var job = jobState[0];
      var setJob = jobState[1];
      var error = errorState[0];
      var setError = errorState[1];
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var busy = busyState[0];
      var setBusy = busyState[1];
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var model = modelState[0];
      var setModel = modelState[1];
      var thinking = thinkingState[0];
      var setThinking = thinkingState[1];
      var jobIdRef = useRef(null);

      function changeModel(value) {
        setModel(value);
        writePref('dsh.gemini.research.model', value);
        var levels = thinkingOptionsFor(catalog, value);
        if (thinking && !levels.some(function (item) { return item.id === thinking; })) {
          setThinking('');
          writePref('dsh.gemini.research.thinking', '');
        }
      }

      function changeThinking(value) {
        setThinking(value);
        writePref('dsh.gemini.research.thinking', value);
      }

      function refreshModels() {
        loadModelCatalog('research', true, true).then(function (data) {
          setCatalog(data);
          setNotice('模型目录已刷新');
        }).catch(function (err) {
          setError(String(err && err.message ? err.message : err));
        });
      }

      function refresh() {
        return getJson('/status')
          .then(function (data) {
            setStatus(data);
            if (data && data.job) {
              jobIdRef.current = data.job.id;
              setJob(function (previous) {
                if (previous && previous.id === data.job.id) {
                  return Object.assign({}, data.job, { result: previous.result, logTail: previous.logTail });
                }
                return data.job;
              });
            }
            return data;
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          });
      }

      function refreshJob() {
        var id = jobIdRef.current;
        if (!id) return Promise.resolve(null);
        return getJson('/job?id=' + encodeURIComponent(id))
          .then(function (data) {
            if (data && data.job) setJob(data.job);
            return data && data.job;
          })
          .catch(function () {
            return null;
          });
      }

      useEffect(function () {
        refresh();
        var timer = setInterval(function () {
          refreshJob().then(function (current) {
            if (current && (current.status === 'done' || current.status === 'error')) {
              clearInterval(timer);
            }
          });
          getJson('/status').then(setStatus).catch(function () {});
        }, 2500);
        return function () {
          clearInterval(timer);
        };
      }, []);

      useEffect(function () {
        loadModelCatalog('research').then(function (data) {
          setCatalog(data);
          var savedModel = readPref('dsh.gemini.research.model');
          var savedThinking = readPref('dsh.gemini.research.thinking');
          setModel(savedModel || (data.defaults && data.defaults.model) || '');
          setThinking(savedThinking || (data.defaults && data.defaults.thinking) || '');
        }).catch(function () {});
      }, []);

      function startResearch() {
        var text = topic.trim();
        if (text.length === 0) {
          setError('先写调研主题');
          return;
        }
        setError('');
        setNotice('');
        setBusy(true);
        postJson('/run', {
          topic: text,
          model: model || undefined,
          thinking: thinking || undefined,
        })
          .then(function (data) {
            jobIdRef.current = data.jobId;
            setNotice('已提交，任务会自动排队执行。');
            return refreshJob();
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function initLogin() {
        setError('');
        setNotice('');
        setBusy(true);
        postJson('/login/init', {})
          .then(function () {
            setNotice('已打开登录窗口：请在弹出的系统默认浏览器里登录 Google 账号，登录完成后窗口会自动关闭。');
            return refresh();
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function copyReport() {
        var text = job && job.result ? job.result : '';
        if (!text) return;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () {
            setNotice('报告已复制到剪贴板');
          }).catch(function () {
            setError('复制失败，请手动选择报告文本');
          });
        } else {
          setError('当前环境不支持剪贴板');
        }
      }

      var running = !!(job && (job.status === 'running' || job.status === 'queued'));
      var loginReady = status && status.loginReady === true;
      var loginSaved = status && status.loginSaved === true;
      var models = catalog && catalog.models ? catalog.models : FALLBACK_MODELS;
      var thinkingOptions = thinkingOptionsFor(catalog, model);

      return h(
        'div',
        { className: 'dgr-page' },
        h(
          'div',
          { className: 'dgr-head' },
          h('div', { className: 'dgr-headText' },
            h('h1', { className: 'dgr-title' }, 'Gemini 网页调研'),
            h('div', { className: 'dgr-sub' }, '用 Google AI Pro 网页端的 Deep Research 做多步调研，结果回到这里；单次通常 5–10 分钟。')
          ),
          h('span', { className: 'dgr-badge' },
            h('span', { className: 'dgr-dot ' + (loginReady ? 'ok' : (loginSaved ? 'run' : '')) }),
            loginReady ? '登录态已验证' : (loginSaved ? '登录态待验证' : '待初始化登录')
          )
        ),

        status === null
          ? h('div', { className: 'dgr-empty' }, '正在读取服务状态…')
          : h(
              'div',
              { className: 'dgr-card' },
              h('div', { className: 'dgr-status' },
                h('span', { className: 'dgr-kv' }, h('b', null, '运行状态'), running ? '调研中' : '空闲'),
                h('span', { className: 'dgr-kv' }, h('b', null, '登录进程'), status.loginRunning ? '运行中' : '未运行'),
                h('span', { className: 'dgr-kv' }, h('b', null, '登录态'), loginReady ? '已验证' : (loginSaved ? '待验证' : '未就绪')),
                h('span', { className: 'dgr-kv' }, h('b', null, 'Profile'), status.profileExists ? '已创建' : '未创建')
              ),
              !loginReady && !loginSaved
                ? h('div', { className: 'dgr-warn', style: { marginTop: '12px' } },
                    '还没有可用的 Gemini 登录态。先点「初始化登录」，在弹出的系统默认浏览器里完成 Google 登录；登录态会保存在本机 profile 里。'
                  )
                : null,
              !loginReady && loginSaved
                ? h('div', { className: 'dgr-note', style: { marginTop: '12px' } },
                    '检测到上次登录文件，但当前未验证；发起任务时会自动验证，如失败请重新初始化登录。'
                  )
                : null
            ),

        h(
          'div',
          { className: 'dgr-card dgr-col' },
          modelSelectRow(models, model, changeModel, thinkingOptions, thinking, changeThinking, running, refreshModels),
          h('div', { className: 'dgr-label' }, '调研主题'),
          h('textarea', {
            className: 'dgr-input',
            placeholder: '例如：调研 2026 年 GT3 组别对 e-Fuel 的技术规范与引入时间表，要求列出关键数据、多方观点与来源链接',
            value: topic,
            onChange: function (event) { setTopic(event.target.value); },
            disabled: running,
          }),
          h('div', { className: 'dgr-row' },
            h('button', { className: 'dgr-btn primary', type: 'button', onClick: startResearch, disabled: busy || running }, running ? '调研进行中…' : '开始 Deep Research'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: initLogin, disabled: busy }, '初始化登录'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: refresh, disabled: busy }, '刷新状态')
          ),
          h('div', { className: 'dgr-note' }, '额度提示：Google AI Pro 的 Deep Research 约为每天 20 次；同一时间只跑一个任务（浏览器 profile 单实例锁）。Deep Research 内模型/思考选择可能不生效，以实际报告为准。')
        ),

        error ? h('div', { className: 'dgr-warn', style: { marginBottom: '14px' } }, error) : null,
        notice ? h('div', { className: 'dgr-note', style: { marginBottom: '14px' } }, notice) : null,

        job
          ? h(
              'div',
              { className: 'dgr-card' },
              h('div', { className: 'dgr-status', style: { marginBottom: '10px' } },
                h('span', { className: 'dgr-kv' }, h('b', null, '任务'), job.id ? job.id.slice(0, 8) : '—'),
                h('span', { className: 'dgr-kv' }, h('b', null, '状态'), STATUS_TEXT[job.status] || job.status),
                h('span', { className: 'dgr-kv' }, h('b', null, '耗时'), elapsed(job)),
                h('span', { className: 'dgr-kv' }, h('b', null, '创建'), fmtTime(job.createdAt))
              ),
              job.topic ? h('div', { className: 'dgr-note', style: { marginBottom: '10px' } }, '主题：' + job.topic) : null,
              job.model || job.thinking
                ? h('div', { className: 'dgr-note', style: { marginBottom: '10px' } },
                    '模型：' + (job.model || '默认') + ' · 思考：' + (job.thinking || '默认') +
                    ((job.model && job.modelApplied === false) || (job.thinking && job.thinkingApplied === false) ? '（网页未应用，已用默认）' : '')
                  )
                : null,
              job.status === 'done' && job.result
                ? h('div', { className: 'dgr-col' },
                    h('div', { className: 'dgr-row' },
                      h('div', { className: 'dgr-label', style: { flex: '1' } }, '调研报告'),
                      h('button', { className: 'dgr-btn', type: 'button', onClick: copyReport }, '复制报告')
                    ),
                    h('pre', { className: 'dgr-report' }, job.result)
                  )
                : null,
              job.status === 'error'
                ? h('div', { className: 'dgr-warn' }, '调研失败：' + (job.error || '未知错误'))
                : null,
              job.logTail
                ? h('details', { style: { marginTop: '10px' } },
                    h('summary', { className: 'dgr-label' }, '运行日志'),
                    h('pre', { className: 'dgr-log' }, job.logTail)
                  )
                : null
            )
          : h('div', { className: 'dgr-empty' }, '还没有任务。填好主题后点「开始 Deep Research」。')
      );
    }

    function GeminiChatPanel() {
      var messagesState = useState([]);
      var inputState = useState('');
      var statusState = useState(null);
      var errorState = useState('');
      var noticeState = useState('');
      var busyState = useState(false);
      var catalogState = useState(null);
      var modelState = useState('');
      var thinkingState = useState('');
      var jobIdRef = useRef(null);
      var listRef = useRef(null);
      var pollFailRef = useRef(0);
      var pollInFlightRef = useRef(false);
      var doneJobRef = useRef(null);

      var messages = messagesState[0];
      var setMessages = messagesState[1];
      var input = inputState[0];
      var setInput = inputState[1];
      var status = statusState[0];
      var setStatus = statusState[1];
      var error = errorState[0];
      var setError = errorState[1];
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var busy = busyState[0];
      var setBusy = busyState[1];
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var model = modelState[0];
      var setModel = modelState[1];
      var thinking = thinkingState[0];
      var setThinking = thinkingState[1];

      function changeModel(value) {
        setModel(value);
        writePref('dsh.gemini.chat.model', value);
        var levels = thinkingOptionsFor(catalog, value);
        if (thinking && !levels.some(function (item) { return item.id === thinking; })) {
          setThinking('');
          writePref('dsh.gemini.chat.thinking', '');
        }
      }

      function changeThinking(value) {
        setThinking(value);
        writePref('dsh.gemini.chat.thinking', value);
      }

      function refreshModels() {
        loadModelCatalog('chat', true, true).then(function (data) {
          setCatalog(data);
          setNotice('模型目录已刷新');
        }).catch(function (err) {
          setError(String(err && err.message ? err.message : err));
        });
      }

      function refreshStatus() {
        return getJson('/status')
          .then(function (data) {
            setStatus(data);
            var chatJob = data && data.chat && data.chat.job ? data.chat.job : null;
            // Recover polling after the panel is remounted while a job runs.
            if (chatJob && (chatJob.status === 'queued' || chatJob.status === 'running')) {
              if (!jobIdRef.current) jobIdRef.current = chatJob.id;
              setBusy(true);
            }
            return data;
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          });
      }

      function pollChatJob(id) {
        if (!id || doneJobRef.current === id) return Promise.resolve(null);
        if (pollInFlightRef.current) return Promise.resolve(null);
        pollInFlightRef.current = true;
        return getJson('/chat/job?id=' + encodeURIComponent(id))
          .then(function (data) {
            pollFailRef.current = 0;
            var job = data && data.job ? data.job : null;
            if (!job) return null;
            if (jobIdRef.current !== id && doneJobRef.current !== id) return null;
            if (job.status === 'done') {
              doneJobRef.current = id;
              setMessages(function (previous) {
                var next = previous.slice();
                var duplicate = next.some(function (item) { return item.jobId === id; });
                if (job.reply && !duplicate) next.push({ role: 'assistant', text: job.reply, jobId: id });
                return next;
              });
              jobIdRef.current = null;
              setBusy(false);
              refreshStatus();
            } else if (job.status === 'error') {
              setError(job.error || '对话失败');
              jobIdRef.current = null;
              setBusy(false);
              refreshStatus();
            }
            return job;
          })
          .catch(function (err) {
            pollFailRef.current += 1;
            if (pollFailRef.current >= 3) {
              setError(String(err && err.message ? err.message : err));
              jobIdRef.current = null;
              setBusy(false);
            }
            return null;
          })
          .finally(function () {
            pollInFlightRef.current = false;
          });
      }

      useEffect(function () {
        refreshStatus();
        var timer = setInterval(function () {
          var id = jobIdRef.current;
          if (id) pollChatJob(id);
          else refreshStatus();
        }, 2000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      useEffect(function () {
        loadModelCatalog('chat').then(function (data) {
          setCatalog(data);
          var savedModel = readPref('dsh.gemini.chat.model');
          var savedThinking = readPref('dsh.gemini.chat.thinking');
          setModel(savedModel || (data.defaults && data.defaults.model) || '');
          setThinking(savedThinking || (data.defaults && data.defaults.thinking) || '');
        }).catch(function () {});
      }, []);

      useEffect(function () {
        var node = listRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages.length, busy]);

      function send() {
        var text = input.trim();
        if (text.length === 0) {
          setError('先输入内容');
          return;
        }
        setError('');
        setNotice('');
        setBusy(true);
        var optimistic = { role: 'user', text: text };
        setMessages(messages.concat([optimistic]));
        setInput('');
        doneJobRef.current = null;
        postJson('/chat/send', {
          message: text,
          model: model || undefined,
          thinking: thinking || undefined,
        })
          .then(function (data) {
            jobIdRef.current = data.jobId;
            return pollChatJob(data.jobId);
          })
          .catch(function (err) {
            // The request never reached the queue: roll back the optimistic
            // bubble and restore the draft instead of losing it.
            setMessages(function (previous) {
              return previous.filter(function (item) { return item !== optimistic; });
            });
            setInput(text);
            setError(String(err && err.message ? err.message : err));
            setBusy(false);
          });
      }

      function newChat() {
        setError('');
        setNotice('');
        setBusy(true);
        postJson('/chat/new', {})
          .then(function () {
            jobIdRef.current = null;
            doneJobRef.current = null;
            setMessages([]);
            setNotice('已开新对话');
            return refreshStatus();
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (!busy) send();
        }
      }

      var chatJob = status && status.chat && status.chat.job ? status.chat.job : null;
      var running = busy || !!(chatJob && (chatJob.status === 'queued' || chatJob.status === 'running'));
      var loginReady = status && status.loginReady === true;
      var loginSaved = status && status.loginSaved === true;
      var models = catalog && catalog.models ? catalog.models : FALLBACK_MODELS;
      var thinkingOptions = thinkingOptionsFor(catalog, model);

      return h(
        'div',
        { className: 'dgr-page' },
        h(
          'div',
          { className: 'dgr-head' },
          h('div', { className: 'dgr-headText' },
            h('h1', { className: 'dgr-title' }, 'Gemini 对话'),
            h('div', { className: 'dgr-sub' }, '直接和 Gemini 网页端对话，同一浏览器多轮上下文；与 Deep Research 分开队列，可同时使用。')
          ),
          h('span', { className: 'dgr-badge' },
            h('span', { className: 'dgr-dot ' + (loginReady ? 'ok' : (loginSaved ? 'run' : '')) }),
            loginReady ? '登录态已验证' : (loginSaved ? '登录态待验证' : '未登录')
          )
        ),
        status === null ? h('div', { className: 'dgr-empty' }, '正在读取服务状态…') : null,
        status !== null
          ? h('div', { className: 'dgr-card' },
              h('div', { className: 'dgr-status' },
                h('span', { className: 'dgr-kv' }, h('b', null, 'Worker'), status.worker && status.worker.running ? (status.worker.ready ? '在线' : '启动中') : '未启动'),
                h('span', { className: 'dgr-kv' }, h('b', null, '对话'), running ? '进行中' : '空闲'),
                h('span', { className: 'dgr-kv' }, h('b', null, '登录态'), loginReady ? '已验证' : (loginSaved ? '待验证' : '未就绪'))
              ),
              !loginReady && !loginSaved
                ? h('div', { className: 'dgr-warn', style: { marginTop: '12px' } }, '还没有 Gemini 登录态。可以先用未登录模式对话（无历史），Deep Research 需要先点「初始化登录」。')
                : null,
              !loginReady && loginSaved
                ? h('div', { className: 'dgr-note', style: { marginTop: '12px' } }, '检测到上次登录文件，但当前未验证；发起对话时会自动验证，失败请重新初始化登录。')
                : null
            )
          : null,
        h(
          'div',
          { className: 'dgr-card dgr-col' },
          modelSelectRow(models, model, changeModel, thinkingOptions, thinking, changeThinking, running, refreshModels),
          h('div', { className: 'dgr-chatList', ref: listRef },
            messages.length === 0 && !running
              ? h('div', { className: 'dgr-chatEmpty' }, '还没有消息。输入内容开始对话。')
              : messages.map(function (item, index) {
                  return h('div', { className: 'dgr-msg ' + (item.role === 'user' ? 'user' : 'assistant'), key: 'm' + index },
                    h('div', { className: 'dgr-msgRole' }, item.role === 'user' ? '你' : 'Gemini'),
                    h('div', { className: 'dgr-msgBody' }, item.text)
                  );
                }),
            running
              ? h('div', { className: 'dgr-msg assistant' },
                  h('div', { className: 'dgr-msgRole' }, 'Gemini'),
                  h('div', { className: 'dgr-msgBody' }, chatJob && chatJob.status === 'queued' ? '排队中…' : '正在生成…')
                )
              : null
          ),
          h('div', { className: 'dgr-label' }, '消息'),
          h('textarea', {
            className: 'dgr-chatInput',
            placeholder: '输入消息，Enter 发送，Shift+Enter 换行',
            value: input,
            onChange: function (event) { setInput(event.target.value); },
            onKeyDown: onKeyDown,
            disabled: running,
          }),
          h('div', { className: 'dgr-row' },
            h('button', { className: 'dgr-btn primary', type: 'button', onClick: send, disabled: busy || running }, running ? '生成中…' : '发送'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: newChat, disabled: busy || running }, '新对话'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: refreshStatus, disabled: busy }, '刷新状态')
          ),
          h('div', { className: 'dgr-note' }, '提示：普通对话和 Deep Research 共用同一个浏览器 profile，但分属两个队列、各自占一个标签页，可同时执行。模型/思考选择按消息生效；网页不支持时会保持默认。')
        ),
        error ? h('div', { className: 'dgr-warn', style: { marginBottom: '14px' } }, error) : null,
        notice ? h('div', { className: 'dgr-note', style: { marginBottom: '14px' } }, notice) : null
      );
    }

    // ---------------------------------------------------------------------------
    // Settings page components (React.createElement, no JSX).
    // ---------------------------------------------------------------------------
    function fieldDraftText(meta, value) {
      if (meta.control === 'list') return serializeList(value);
      if (meta.control === 'keyvalue') return serializeEnv(value);
      if (meta.control === 'select' || meta.control === 'checkbox') return '';
      return value === undefined || value === null ? '' : String(value);
    }

    function FieldRow(props) {
      var meta = props.meta;
      var value = props.value;
      var control = meta.control;
      var disabled = props.disabled === true;
      var id = 'antigravity-field-' + meta.key;
      var draftState = useState(function () { return fieldDraftText(meta, value); });
      var draft = draftState[0];
      var setDraft = draftState[1];
      var editingState = useState(false);
      var editing = editingState[0];
      var setEditing = editingState[1];
      var invalidState = useState('');
      var invalid = invalidState[0];
      var setInvalid = invalidState[1];

      useEffect(function () {
        if (!editing) setDraft(fieldDraftText(meta, value));
      }, [value, meta.control, editing]);

      function commitOrReset(next, current) {
        var desired = normalizeEmptyValue(next);
        var baseline = normalizeEmptyValue(current);
        if (valuesEqual(desired, baseline)) return; // untouched: never write / live-reload
        if (desired === undefined) props.onReset();
        else props.onCommit(desired);
      }

      function commitNow() {
        if (control === 'text' || control === 'textarea') {
          var trimmed = draft.trim();
          setInvalid('');
          if (meta.key === 'teamProviderName' && props.siblings && trimmed !== '' && trimmed === props.siblings.providerName) {
            setInvalid('必须不同于「提供商名称」，否则插件启动会失败');
            return;
          }
          commitOrReset(trimmed === '' ? undefined : trimmed, value);
          return;
        }
        if (control === 'number') {
          var parsed = parseNumberField(draft, { min: meta.min, max: meta.max, integer: meta.integer });
          if (parsed.kind === 'invalid') { setInvalid(parsed.reason); return; }
          setInvalid('');
          commitOrReset(parsed.kind === 'unset' ? undefined : parsed.value, value);
          return;
        }
        if (control === 'list') {
          var array = parseListText(draft);
          setInvalid('');
          commitOrReset(array.length === 0 ? undefined : array, value);
          return;
        }
        if (control === 'keyvalue') {
          var env = parseEnvText(draft);
          if (!env.ok) { setInvalid(env.reason); return; }
          setInvalid('');
          commitOrReset(Object.keys(env.value).length === 0 ? undefined : env.value, value);
        }
      }

      var input;
      if (control === 'checkbox') {
        input = h('label', { className: 'das-check' },
          h('input', {
            id: id,
            type: 'checkbox',
            checked: value === true,
            disabled: disabled,
            onChange: function (event) { props.onCommit(event.target.checked); },
          }),
          h('span', null, value === true ? '已启用' : '已关闭')
        );
      } else if (control === 'select') {
        var current = value === undefined || value === null ? '' : String(value);
        var selectOptions = meta.key === 'effort' && props.siblings && props.siblings.model
          ? effortsForModel(String(props.siblings.model))
          : (meta.options || []);
        var normalizedOptions = selectOptions.map(function (opt) {
          if (opt && typeof opt === 'object') {
            return { value: String(opt.value), label: String(opt.label !== undefined ? opt.label : opt.value) };
          }
          return { value: String(opt), label: String(opt) };
        });
        var hasCurrent = false;
        for (var oi = 0; oi < normalizedOptions.length; oi += 1) {
          if (normalizedOptions[oi].value === current) hasCurrent = true;
        }
        input = h('select', {
          id: id,
          className: 'das-select',
          value: current,
          disabled: disabled,
          onChange: function (event) {
            var next = event.target.value;
            if (next === '') props.onReset();
            else props.onCommit(next);
          },
        },
          meta.allowEmpty ? h('option', { value: '', key: '__empty' }, '未设置') : null,
          current !== '' && !hasCurrent ? h('option', { value: current, key: '__current' }, current) : null,
          normalizedOptions.map(function (opt) { return h('option', { key: opt.value, value: opt.value }, opt.label); })
        );
      } else if (control === 'textarea' || control === 'list' || control === 'keyvalue') {
        input = h('textarea', {
          id: id,
          className: 'das-textarea' + (invalid ? ' invalid' : ''),
          value: draft,
          placeholder: meta.placeholder || '',
          spellCheck: false,
          disabled: disabled,
          onFocus: function () { setEditing(true); },
          onChange: function (event) { setDraft(event.target.value); },
          onBlur: function () { setEditing(false); commitNow(); },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitNow(); }
          },
        });
      } else if (control === 'number') {
        input = h('input', {
          id: id,
          className: 'das-input' + (invalid ? ' invalid' : ''),
          type: 'number',
          inputMode: 'numeric',
          step: 1,
          value: draft,
          placeholder: meta.placeholder || '',
          disabled: disabled,
          onFocus: function () { setEditing(true); },
          onChange: function (event) { setDraft(event.target.value); },
          onBlur: function () { setEditing(false); commitNow(); },
          onKeyDown: function (event) {
            if (event.key === 'Enter') { event.preventDefault(); commitNow(); event.target.blur(); }
          },
        });
      } else {
        input = h('input', {
          id: id,
          className: 'das-input',
          type: 'text',
          value: draft,
          placeholder: meta.placeholder || '',
          disabled: disabled,
          onFocus: function () { setEditing(true); },
          onChange: function (event) { setDraft(event.target.value); },
          onBlur: function () { setEditing(false); commitNow(); },
          onKeyDown: function (event) {
            if (event.key === 'Enter') { event.preventDefault(); commitNow(); event.target.blur(); }
          },
        });
      }

      return h('div', { className: 'das-row' },
        h('div', { className: 'das-rowMain' },
          h('div', { className: 'das-rowHead' },
            h('label', { className: 'das-label', htmlFor: id }, meta.label),
            props.overridden ? h('span', { className: 'das-badge' }, LABELS.overridden) : null,
            props.overridden
              ? h('button', { type: 'button', className: 'das-reset', onClick: props.onReset, disabled: disabled }, LABELS.reset)
              : null
          ),
          meta.hint ? h('div', { className: 'das-hint' }, meta.hint) : null,
          props.pending ? h('div', { className: 'das-hint' }, LABELS.saving) : null
        ),
        h('div', { className: 'das-field' },
          input,
          invalid ? h('div', { className: 'das-invalid', role: 'alert' }, invalid) : null
        )
      );
    }

    function GroupSection(props) {
      var group = props.group;
      var state = props.state;
      var disabledBase = !state.writable;
      return h('div', { className: 'das-group', role: 'group', 'aria-label': group.title },
        h('h3', { className: 'das-groupTitle' }, group.title),
        group.hint ? h('div', { className: 'das-groupHint' }, group.hint) : null,
        props.fields.map(function (meta) {
          var value = state.values && state.values[meta.key] !== undefined
            ? state.values[meta.key]
            : projectFieldDefaults(meta.key);
          return h(FieldRow, {
            key: meta.key,
            meta: meta,
            value: value,
            siblings: state.values,
            overridden: isFieldOverridden(state.user, meta.key),
            disabled: disabledBase || state.pending > 0,
            pending: state.pending > 0,
            onCommit: function (next) { props.editField(meta.key, next); },
            onReset: function () { props.resetField(meta.key); },
          });
        })
      );
    }

    function AntigravitySettingsSection(props) {
      var useSettings = props.useAntigravitySettings;
      var state = typeof useSettings === 'function' ? useSettings(function (s) { return s; }) : null;
      var head = h('div', { className: 'das-head' },
        h('h2', { className: 'das-title' }, LABELS.title),
        h('div', { className: 'das-sub' }, LABELS.intro)
      );

      if (!state || state.status === 'loading') {
        return h('div', { className: 'das-page' }, head, h('div', { className: 'das-empty' }, LABELS.loading));
      }
      if (state.status === 'unavailable') {
        return h('div', { className: 'das-page' }, head, h('div', { className: 'das-banner warn' }, LABELS.unavailable));
      }

      var children = [head];
      if (!state.writable) children.push(h('div', { className: 'das-banner warn', key: '__readonly' }, LABELS.readOnly));
      if (state.error) children.push(h('div', { className: 'das-banner error', key: '__error', role: 'alert' }, state.error));
      for (var gi = 0; gi < GROUPS.length; gi += 1) {
        var group = GROUPS[gi];
        var groupFields = FIELDS.filter(function (meta) { return meta.group === group.id; });
        children.push(h(GroupSection, {
          key: group.id,
          group: group,
          fields: groupFields,
          state: state,
          editField: props.editField,
          resetField: props.resetField,
        }));
      }
      return h('div', { className: 'das-page' }, children);
    }

    function registerSettingsSection(ctx) {
      var owned = [];
      function mount(child) {
        var scope = child && child.slots && child.configForms ? child : (ctx && ctx.slots && ctx.configForms ? ctx : null);
        if (!scope) return;
        var offServed = scope.configForms.whileServed([SETTINGS_NS], function () {
          var form = scope.configForms.get(SETTINGS_NS);
          var controller = createSettingsController(form);
          var offSlot = scope.slots.inject('settings.section', function () {
            return scope.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: SECTION_ORDER,
                label: function () { return 'Antigravity'; },
                inject: function () { return controller.inject(); },
              },
              AntigravitySettingsSection
            );
          });
          return function () {
            try { offSlot(); } catch (error) { /* ignore */ }
            controller.dispose();
          };
        });
        owned.push(offServed);
      }
      // configForms is optional: never add it to `inject` (a required service),
      // or a deployment without the settings plugin would lose the Gemini panels too.
      if (typeof ctx.inject === 'function') {
        var offInject = ctx.inject(['configForms'], function (child) { mount(child); });
        owned.push(offInject);
      } else if (ctx.configForms) {
        mount(ctx);
      }
      return function () {
        for (var i = 0; i < owned.length; i += 1) {
          try { owned[i](); } catch (error) { /* ignore */ }
        }
      };
    }

    var inject = ['slots'];

    function apply(ctx) {
      ensureStyles();
      var disposers = [];
      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        disposers.push(
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, GeminiResearchPanel);
          })
        );
        disposers.push(
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID_CHAT }, GeminiChatPanel);
          })
        );
        disposers.push(
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: function () { return 'Gemini 调研'; } },
              GeminiIcon
            );
          })
        );
        disposers.push(
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID_CHAT, order: 31, label: function () { return 'Gemini 对话'; } },
              ChatIcon
            );
          })
        );
      }
      disposers.push(registerSettingsSection(ctx));
      return function () {
        for (var i = 0; i < disposers.length; i += 1) {
          try { disposers[i](); } catch (error) { /* ignore */ }
        }
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__settingsSection = AntigravitySettingsSection;
    exports.__internals = {
      FIELDS: FIELDS,
      FIELD_GROUPS: GROUPS,
      findField: findField,
      projectFieldDefaults: projectFieldDefaults,
      parseNumberField: parseNumberField,
      parseListText: parseListText,
      parseEnvText: parseEnvText,
      serializeList: serializeList,
      serializeEnv: serializeEnv,
      isFieldOverridden: isFieldOverridden,
      valuesEqual: valuesEqual,
      normalizeEmptyValue: normalizeEmptyValue,
    };
    exports.__panel = GeminiResearchPanel;
    exports.__icon = GeminiIcon;
    exports.__chatPanel = GeminiChatPanel;
    exports.__chatIcon = ChatIcon;
    return module.exports;
  },
});
