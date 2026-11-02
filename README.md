# dsh-subagent-antigravity

将一次性任务委派给本机 **Antigravity CLI（`agy`）**，并在 DSH 侧边栏提供 **Gemini 网页 Deep Research** 调研面板的 DSH（DeepSeek Harness）插件。

与 DSH 官方 `dsh-subagent-codex` / `dsh-subagent-claude-code` 同构：通过注册外部单次执行（one-shot）subagent provider，配合 `@deepseek-ai/dsh-tool-subagent` 向模型暴露工具 `subagent_agy`（触发关键词：`agy`、`antigravity`，不区分大小写）。

---

## 目录

- [1. 项目简介与定位](#1-项目简介与定位)
- [2. 安装与部署](#2-安装与部署)
- [3. 协议（print + stream-json）](#3-协议print--stream-json)
- [4. 配置全字段说明](#4-配置全字段说明)
- [5. 失败分类与重试机制](#5-失败分类与重试机制)
- [6. 目录结构与模块分工](#6-目录结构与模块分工)
- [7. 验证与测试方法](#7-验证与测试方法)
- [8. Gemini 网页调研（侧边栏面板）](#8-gemini-网页调研侧边栏面板)
- [9. 已知限制与注意事项](#9-已知限制与注意事项)

---

## 1. 项目简介与定位

### 1.1 背景与定位

Antigravity（`agy`）是 Google 提供的 Agent CLI 工具，没有对外开放类似 app-server 或客户端 SDK 的长连接 RPC 服务，只提供命令行交互与无头脚本模式。

本插件为 DSH 提供原生接入 Antigravity 的能力：

- **单次委派（One-shot External Provider）**：在宿主会话的工作区下 spawn 独立的 `agy` 子进程，执行单个独立任务后收集结果并退出。
- **上下文完全隔离**：每次任务强制附加 `--new-project`，不复用已有项目，不污染用户本地会话。
- **环境清理与解耦**：清理父级 CLI 注入的环境变量，阻断会话劫持。
- **多模型与推理档位透传**：支持通过 Antigravity 调度 Gemini 4 Argon、Gemini 3.8 Flash、Claude 5.5 系列及开源大模型。

### 1.2 触发词联动机制

工具本身无法主动监听关键词，模型选择调用 `subagent_agy` 依赖三处联动配置：

1. **插件国际化文案（本仓库）**：`locale/zh.json` 与 `locale/en.json` 的 `description` 中明确列出 `agy` 与 `antigravity`，作为插件注册时的元数据展示。
2. **Cordis 工具定义（本仓库）**：`cordis.patch.yml` 声明 provider 为 `antigravity`，映射暴露的工具名为 `subagent_agy`，并指定 `maxDepth: provider-managed`。
3. **系统提示词（宿主配置）**：`%USERPROFILE%\.dsh\AGENTS.md`（仓库外）明确提示模型当用户提及 "agy" 或 "antigravity" 时调用 `subagent_agy` 工具。

---

## 2. 安装与部署

本插件已作为本地依赖接入本机的 DSH 桌面端 Profile（`%USERPROFILE%\.dsh\profiles\desktop`）。

### 2.1 依赖关系与 Profile 配置

在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 中：

```json
{
  "dependencies": {
    "dsh-subagent-antigravity": "file:C:/Users/moyi_/Documents/Claude-Mok/dsh-subagent-antigravity"
  }
}
```

在 Profile 的配置清单中，已将 `"dsh-subagent-antigravity"` 加入 `dsh.profile.bundles`。

### 2.2 硬链接机制与同步注意

- 在 Profile 安装后，`node_modules/dsh-subagent-antigravity/*` 文件以**硬链接（Hardlink）**方式映射到本代码仓库对应文件。
- **同步规则**：
  - 原地修改现有文件（如修改 `lib/run.js`、`lib/wire.js` 的内容）会通过硬链接实时生效。
  - **新增文件不会自动同步**到 profile 的 `node_modules`。
  - 编辑器整体替换文件保存（原子写入）可能会切断硬链接。
- **重新同步**：
  若新增了文件或需要重建硬链接，请执行：
  ```powershell
  cd "$env:USERPROFILE\.dsh\profiles\desktop"
  pnpm install
  ```
  > **注意**：DSH 内置沙箱可能会限制 pnpm 写入全局 store，建议在真实的独立终端中执行 `pnpm install`。完成后重启 DSH GUI 即可载入最新代码。

---

## 3. 协议（print + stream-json）

### 3.1 命令行调用原型

插件内部拼装并执行的核心命令行格式如下：

```powershell
agy --print <prompt> --output-format stream-json --new-project `
    [--model <model>] [--effort <effort>] `
    (--dangerously-skip-permissions | --mode auto) `
    [--print-timeout <duration>] [--json-schema <schema>] `
    [--add-dir <dir> ...] [extraArgs ...]
```

### 3.2 NDJSON 流式帧解析（`lib/wire.js`）

子进程的 `stdout` 输出逐行 NDJSON，由 `AntigravityStream` 进行行切分与缓冲（单帧缓冲上限 `MAX_FRAME_BYTES = 32MB`）。插件处理以下四类 Envelope：

| event | 关键字段 | 作用与解析逻辑 |
|---|---|---|
| `init` | `conversation_id` | 记录 CLI 分配的会话 ID（仅记录首次出现的 ID），用于失败诊断标签。 |
| `step_update` | `step_update.step_type`<br>`step_update.text_delta` | 当 `step_type === 'agent_response'` 时累加 `text_delta`，作为权威答案缺失时的兜底文本。 |
| `result` | `result.status`<br>`result.response` | **权威终态帧**：`status` 支持 `SUCCESS`、`ERROR`、`FAILURE`、`CANCELED`、`CANCELLED`、`INTERRUPTED`。非 SUCCESS 时标记 `product-error` 并记录错误文本。 |
| `error` | `error` | 异常 Envelope，记录到 `malformed` 并累积到错误文本，供失败分类器分析。 |

### 3.3 答案决策与状态映射

- **答案提取逻辑**：优先取终态 `result.response`；若缺失或为空，则使用 `step_update` 累加的 `text_delta` 作为兜底；去除前后空白后包装为 `[{ type: 'text', text: answer }]`。
- **终态停机原因（`stopReason`）映射**：
  - `result.status === 'SUCCESS'` → `'completed'`
  - `result.status` 为 `CANCELED` / `CANCELLED` / `INTERRUPTED` → `'aborted'`
  - 出现未知状态、未观测到终态帧，或状态为 `ERROR` / `FAILURE` → `'error'`

---

## 4. 配置全字段说明

在 DSH 的 `cordis.patch.yml` 中支持对 `subagent-antigravity` 进行配置覆盖。所有字段经由 `@deepseek-ai/schemastery` 进行模式校验：

```yaml
- insert:
    - id: subagent-antigravity
      name: 'dsh-subagent-antigravity'
      config:
        providerName: antigravity
        executable: 'C:/Users/moyi_/.gemini/bin/agy.exe'
        model: gemini-4-argon-high
        effort: high
        permissionMode: dangerously-skip-permissions
        printTimeout: 180s
        # jsonSchema: '{"type": "object"}'   # 可选，内联 JSON 或文件路径；不要传空字符串（min(1) 校验）
        addDirs: []
        fallbackModel: gemini-3.8-flash-high
        retryOnRateLimit: false
        disposeGraceMs: 3000
        extraArgs: []
        env: {}
```

### 4.1 字段定义详解

| 字段名 | 类型 / 校验规则 | 默认值 | 说明与行为 |
|---|---|---|---|
| `providerName` | `string` (`min(1)`) | `'antigravity'` | 注册到 `ctx.subagents` 的服务标识名，须与工具绑定的 provider 名称一致。 |
| `executable` | `string` (`min(1)`) | `%USERPROFILE%/.gemini/bin/agy.exe` | 本机 `agy` 可执行文件绝对路径。插件启动任务前会用 `existsSync` 校验其存在性。 |
| `model` | `string` (`min(1)`) | *无（继承 CLI）* | 调用的模型名称（取值来自 `agy models`，如 `gemini-4-argon-high`、`gemini-3.8-flash-high`、`claude-opus-5-5-high` 等）。不填则沿用 CLI 内部默认设置。 |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | *无* | 推理/思考档位（映射 `--effort <val>`）。注意部分模型 ID 自带档位后缀，二者叠加时可能存在覆盖。 |
| `permissionMode` | `'dangerously-skip-permissions' \| 'auto'` | `'dangerously-skip-permissions'` | **核心权限开关**：<br>• `dangerously-skip-permissions`（推荐/默认）：映射为 `--dangerously-skip-permissions`。非交互 print 模式下工具确认会被软拒，必须跳过权限才能操作工作区文件；<br>• `auto`：映射为 `--mode auto`，保留权限拦截，仅适合不需要读写工作区文件的纯问答场景。 |
| `printTimeout` | `string` (`min(1)`) | *无（无限等待）* | 原生执行超时（Go duration 格式，如 `"180s"`、`"10m"`），映射为 `--print-timeout <val>`。**注意：CLI 到期超时后输出部分结果、在 stderr 打 warning，并以 exit 0 退出**，不是失败。 |
| `jsonSchema` | `string` (`min(1)`) | *无* | 结构化输出约束，映射为 `--json-schema <val>`。支持内联 JSON Schema 字符串或本地 schema 文件路径。 |
| `addDirs` | `string[]` | *无* | 附加只读工作区目录列表。每个路径映射为一个 `--add-dir <dir>` 参数。 |
| `fallbackModel` | `string` (`min(1)`) | *无（不重试）* | 降级重试备用模型。首轮出现配额耗尽（`quota_exhausted`）或限流（`rate_limited`）时，用该模型重试一次。 |
| `retryOnRateLimit` | `boolean` | `false` | 429 限流重试开关。首轮限流且未触发降级模型时，按提示时长退避（上限 15s）并用原模型重试一次。 |
| `disposeGraceMs` | `number` | `3000` | 终止清理子进程的宽限时长（毫秒）。必须为正有限数且 ≤ `MAX_TIMER_DELAY_MS`。 |
| `geminiProfileDir` | `string` (`min(1)`) | `~/.dsh/gemini-web-research/chrome-profile` | Gemini 网页调研的持久化浏览器 profile 目录（目录名沿用 `chrome-profile`）；登录态保存在这里。 |
| `geminiPython` | `string` (`min(1)`) | `python` | 运行 Playwright 脚本的 Python 可执行文件。 |
| `geminiHeadless` | `boolean` | `true` | 调研时是否无头运行；初始化登录始终有头（可见窗口）。 |
| `geminiTimeoutMs` | `number` | `900000` | 单次调研任务的硬超时（毫秒），默认 15 分钟。 |
| `extraArgs` | `string[]` | `[]` | 直接透传给 `agy` 进程的追加命令行参数数组。 |
| `env` | `Record<string, string>` | `{}` | 注入子进程的环境变量，覆盖在内置清理过的环境变量字典之上。 |

### 4.2 会话隔离与环境变量清理（`SCRUBBED_ENV`）

为防止子进程通过环境变量意外继承或挂载到宿主的父级 CLI 会话，插件会在启动子进程前，强制将以下环境变量设置为空字符串 `''`：

- `CLAUDECODE`
- `CLAUDE_CODE_ENTRYPOINT`
- `GEMINI_CLI`
- `ANTIGRAVITY_SESSION_ID`

用户自定义的 `env` 配置会在清理后再合并覆盖。

---

## 5. 失败分类与重试机制

一次性委派子进程自动重试可能消耗双倍配额，且账号级配额耗尽通常无法通过重试恢复，因此插件默认策略为：**精确识别分类，默认不自动重试**。

### 5.1 失败分类器（`lib/classify.js`）

`classifyFailure(text, outcome)` 结合子进程退出结果（`outcome`）与标准错误/终态错误文本（`text`）进行纯函数分类：

```
                ┌───────────────────────────┐
                │ outcome.exitCode === 2 ?  │── 是 ──> usage_error（CLI exit 2，绝不重试）
                └─────────────┬─────────────┘
                              │ 否
                ┌─────────────▼─────────────┐
                │ 匹配 429 / rate limit /   │── 是 ──> rate_limited (+ 可选 retryAfterMs)
                │ resource exhausted / ...  │
                └─────────────┬─────────────┘
                              │ 否
                ┌─────────────▼─────────────┐
                │ 匹配 quota / out of       │── 是 ──> quota_exhausted (+ 可选 retryAfterMs)
                │ credits / insufficient ...│
                └─────────────┬─────────────┘
                              │ 否
                              ▼
                           unknown
```

> 说明：`exit 2` 只在 stream-json 输入协议的 control_request/response 或 CLI 自处理 slash 命令时出现；插件走 `-p` 文本 prompt 基本碰不到，未知 `--model` 等用法问题多为 exit 1。

### 5.2 等待时长解析（`parseRetryAfterMs`）

从错误文本中自动解析恢复时间：

- 匹配 `retry-after: <seconds>` 模式：换算为毫秒，最大截断为 1 小时（3600 秒）。
- 匹配 `Resets in XhYmZs` / `resets in Xm` 模式：换算为对应毫秒数。

### 5.3 诊断标签与重试语义（`lib/run.js`）

执行失败时，诊断信息会追加格式化标签：

`subagent-antigravity: Product subagent failure (...) [quota_exhausted] (conversation: <id>)`

**重试决策流**（由 `startAntigravityRunWithRetry` 控制，最多重试 1 次）：

1. **Fallback 降级模型重试**：
   - 触发条件：显式配置了 `fallbackModel`，且首轮失败分类为 `quota_exhausted` 或 `rate_limited`。
   - 行为：释放当前子进程，改用 `spec.fallbackModel` 作为 `--model` 参数立即重跑一次。
2. **限流退避重试**：
   - 触发条件：未触发 Fallback 且配置了 `retryOnRateLimit: true`，首轮失败分类为 `rate_limited`。
   - 行为：等待退避时长（解析到 `retryAfterMs` 就用它，否则默认 2s，统一上限 15s），使用原参数重跑一次。
3. **用法错误与未知错误不重试**：
   - 命中 `usage_error` 或 `unknown` 时直接报告失败，避免无效重试。

---

## 6. 目录结构与模块分工

```
dsh-subagent-antigravity/
├── AGENTS.md                  # 开发与维护核心规范（触发词、硬链接、不可触碰的设计原则）
├── README.md                  # 项目详细说明文档（本文件）
├── cordis.patch.yml           # DSH Cordis 插件插入补丁配置（声明 provider 与 tool）
├── package.json               # ESM 模块声明、peerDependencies 与 files 白名单
├── icon.svg                   # DSH 插件图标
├── docs/
│   └── headless-scripting-plan.md  # CLI 原生能力调研与 headless 结合方案记录
├── lib/
│   ├── index.js               # Cordis 插件入口：定义 Config、实现 Provider、注册 apply
│   ├── run.js                 # 进程生命周期：argv 组装、spawn、流驱动、可选重试与退出结算
│   ├── wire.js                # 纯 NDJSON 流解析器：行缓冲、Envelope 状态提取、权威答案决策
│   ├── classify.js            # 纯函数错误分类：退出码判定、429/配额正则匹配、重试时间解析
│   ├── client.js              # DSH 客户端面板：sidebar.panellist 入口 + main 面板
│   ├── gemini-web.js          # 主机侧 /api/dsh-gemini-research/* 桥接与串行任务队列
│   └── types/
│       └── index.d.ts         # 手写 TypeScript 类型定义（Config / Export 声明）
├── locale/
│   ├── zh.json                # 中文描述与触发词声明（agy、antigravity）
│   └── en.json                # 英文描述与触发词声明（agy、antigravity）
├── scripts/
│   └── gemini_research/
│       ├── init_login.py      # 系统默认浏览器手动登录并保存持久化 profile
│       └── run_research.py    # Playwright 触发 Gemini 网页 Deep Research 并提取报告
└── test/
    ├── classify.test.js       # 错误分类与延时解析单元测试（覆盖配额、429、exit 2 等）
    └── wire.test.js           # 协议解析测试（7 字节分片重组、兜底答案、Envelope 校验等）
```

---

## 7. 验证与测试方法

### 7.1 单元测试套件

项目采用 Node.js 原生测试运行器（`node:test`），零外部测试依赖，共 36 个用例：

```powershell
# 运行全部单元测试（覆盖 classify / wire / gemini-web 桥接）
npm test
# 或直接执行：
node --test
```

> DSH 受限 shell 内若报 `spawn EPERM`（测试运行器开子进程管道被沙箱拦截，不是用例失败），改用单进程模式：`node --test --test-isolation=none`。

### 7.2 模块语法检查

确保纯 ESM 模式下无语法错误：

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js
```

### 7.3 协议与分类快速冒烟

- **NDJSON 7 字节流分片重组冒烟**（模拟极端 IO 分片场景）：

  ```powershell
  node -e "import('./lib/wire.js').then(({AntigravityStream})=>{const s=new AntigravityStream('t');const t=[JSON.stringify({event:'init',conversation_id:'c1'}),JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'par'}}),JSON.stringify({event:'result',result:{status:'SUCCESS',response:'partial answer'}})].join('\n')+'\n';for(let i=0;i<t.length;i+=7)s.push(t.slice(i,i+7));s.end();console.log(s.result(),s.conversationId)})"
  ```

  *期望输出*：`{ output: [ { type: 'text', text: 'partial answer' } ], stopReason: 'completed' } c1`

- **失败分类冒烟**：

  ```powershell
  node -e "import('./lib/classify.js').then(({classifyFailure})=>console.log(classifyFailure('429 too many requests',{exitCode:1}),classifyFailure('quota limit exceeded',{exitCode:1}),classifyFailure('x',{exitCode:2})))"
  ```

  *期望输出*：`{ kind: 'rate_limited' } { kind: 'quota_exhausted' } { kind: 'usage_error' }`

### 7.4 本机 CLI 可用性校验

验证本地 Antigravity CLI 安装与参数响应：

```powershell
& "$env:USERPROFILE\.gemini\bin\agy.exe" --print "Say OK" --output-format stream-json --new-project --dangerously-skip-permissions
```

*期望结果*：末尾输出状态为 `{"status":"SUCCESS","response":"OK\n"}` 的结果帧。

---

## 8. Gemini 网页调研（侧边栏面板）

插件在 DSH 左侧边栏注册「Gemini 调研」面板（`sidebar.panellist` + `main` keyed slot），用 Google AI Pro 网页端的 Deep Research 做调研。

### 8.1 组成

- `lib/client.js`：侧边栏入口与面板 UI（主题输入、任务状态、报告展示与复制）。
- `lib/gemini-web.js`：主机侧 `/api/dsh-gemini-research/*` 桥接；单任务串行队列（同一浏览器 profile 只能一个实例），超时终止。
- `scripts/gemini_research/init_login.py`：打开系统默认浏览器（Chrome/Edge），人工登录一次，保存持久化 profile。
- `scripts/gemini_research/run_research.py`：Playwright 打开 Gemini → Tools → Deep Research → 提交主题 → 等研究计划 → 点 Start research → 轮询报告 → 提取正文。

### 8.2 首次使用

1. 确认本机 `python` 与 `playwright` 可用：`pip install playwright`（使用系统默认浏览器 Chrome/Edge，不需要 `playwright install`）。
2. 侧边栏打开「Gemini 调研」→ 点「初始化登录」→ 在弹出的系统默认浏览器里登录 Google AI Pro 账号。
3. 回到面板填主题 →「开始 Deep Research」。

### 8.3 风险与边界

- Google 服务条款禁止自动化访问；网页端自动化可能触发风控甚至封号，建议使用专用账号并控制频率，不要拿主账号批量跑。
- AI Pro 的 Deep Research 约为每天 20 次；单次通常 5–10 分钟。
- 网页 UI 改版会导致选择器失效，脚本会保存调试截图（profile 目录 `debug-*.png`），整体属于 best-effort。
- 面板只展示本机生成的报告；不上传内容，也不替代 Google 官方界面。

---

## 9. 已知限制与注意事项

1. **单向外部委派（No Continuation）**：
   Antigravity CLI 在 `--print` 模式下是一次性执行，执行完毕即退出。宿主模型无法与其建立多轮交互会话，不能调用 `send_message`。
2. **上下文不继承**：
   子进程启动时 `inheritsParentContext = false`。传递给 `subagent_agy` 的任务 Prompt 必须完全自包含，包含所有必要的文件路径、背景事实或操作指示。
3. **固定能力集声明**：
   插件声明 `capabilities = NO_START_CAPABILITIES`，不支持由宿主动态传入 `agentOptions`（模型由本插件配置或 CLI 决定）、`outputSchema`、`depthLimit` 等扩展参数。因此 `cordis.patch.yml` 中必须显式配置 `maxDepth: provider-managed`。
4. **`--print-timeout` 退出码语义（Antigravity 1.1.28+）**：
   触发 `--print-timeout` 超时截断时，`agy` CLI 会返回当前部分生成内容、在 stderr 打 warning，并以 **exit code 0 正常退出**，不会判定为进程异常。因此 `printTimeout` 仅作耗时上限保护，不能单纯依靠进程退出码判断任务是否完整执行完毕。
   另：本机 `agy 1.4.12 --help` 写默认 `0s`（等到本轮结束），官方 headless 网页文档写默认 `5m`，两处口径冲突，以实测为准。
5. **本地登录状态前置要求**：
   子进程调用依赖本机预先完成 Antigravity 认证。若未登录，CLI 可能以匿名状态运行或静默降级模型能力，插件无法代为发起登录交互。
6. **Windows 路径默认值**：
   当前配置项 `DEFAULT_EXECUTABLE` 使用 `agy.exe` 路径（基于 Windows 环境）。迁移至 Linux 或 macOS 时需在配置中显式指定对应系统的可执行文件路径（如 `/usr/local/bin/agy`）。
