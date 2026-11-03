# dsh-subagent-agy

DSH（DeepSeek Harness）插件：把一次性任务委派给本机 **Antigravity CLI（`agy`）**，并在侧边栏提供 **Gemini 网页 Deep Research** 与 **Gemini 网页对话**两个独立面板。

- npm 包名：`dsh-subagent-agy`
- 当前版本：`0.4.0`
- 仓库：<https://github.com/Michael-LY/dsh-subagent-agy>

---

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 安装与部署](#2-安装与部署)
- [3. 使用说明](#3-使用说明)
- [4. 配置字段](#4-配置字段)
- [5. 架构说明](#5-架构说明)
- [6. 目录结构与模块分工](#6-目录结构与模块分工)
- [7. 验证与测试](#7-验证与测试)
- [8. 已知限制与注意事项](#8-已知限制与注意事项)

---

## 1. 项目简介

### 1.1 定位

Antigravity（`agy`）是 Google 提供的 Agent CLI，没有对外开放 app-server 或客户端 SDK，只提供命令行交互与无头脚本模式。本插件在 DSH 中提供三类能力：

1. **一次性子智能体委派**：注册 `antigravity` provider，向模型暴露 `subagent_agy`。每次任务在宿主会话的工作区里 spawn 一个独立的 `agy --print --output-format stream-json` 子进程，执行完即退出。
2. **并发/团队子智能体**：
   - `subagent_agy_team`：绑定 `antigravity-team` provider，在 prompt 前注入团队指令，让 agy 主模型用原生 `invoke_subagent` 在同一轮并发拆分子任务。
   - `subagent_agy_parallel`：DSH 侧批量工具，一次调用并发启动多个独立 agy 子进程，立即返回 id，结果异步回传。
3. **Gemini 网页端**：
   - 「Gemini 调研」面板：用 Google AI Pro 网页端 Deep Research 做多步调研。
   - 「Gemini 对话」面板：直接和 Gemini 网页端多轮对话。
   - 两个面板各有一条独立任务队列，共享同一个常驻浏览器 worker，互不排队、可以同时工作。

### 1.2 触发词

模型侧通过 `subagent_agy` 工具使用本插件。触发词为 `agy` 与 `antigravity`（不区分大小写），由三处联动保证：

1. `locale/zh.json` / `locale/en.json` 的 description；
2. `cordis.patch.yml` 的 `provider` / `toolName`；
3. `%USERPROFILE%\.dsh\AGENTS.md` 中的模型指令。

---

## 2. 安装与部署

### 2.1 从 npm 安装

```powershell
npm install dsh-subagent-agy
# 或交给 DSH 装进指定 profile：
dsh plugin --profile desktop add dsh-subagent-agy
```

安装后重启 DSH GUI，模型可见工具 `subagent_agy`、`subagent_agy_team`、`subagent_agy_parallel`，侧边栏出现「Gemini 调研」「Gemini 对话」两个入口。

### 2.2 本地开发与 Profile 配置

本插件也作为本地依赖接入本机 DSH 桌面端 Profile（`%USERPROFILE%\.dsh\profiles\desktop`）。在 Profile 的 `package.json` 中：

```json
{
  "dependencies": {
    "dsh-subagent-agy": "file:C:/Users/moyi_/Documents/Claude-Mok/dsh-subagent-agy"
  }
}
```

并把 `"dsh-subagent-agy"` 加入 `dsh.profile.bundles`。

### 2.3 硬链接机制与同步注意

- Profile 安装后，`node_modules/dsh-subagent-agy/*` 以**硬链接（Hardlink）**方式指向本仓库对应文件。
- 原地修改现有文件会通过硬链接实时生效；**新增文件不会自动同步**；编辑器整体替换文件（原子写）可能切断硬链接。
- 新增文件或需要重建硬链接时：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

> DSH 内置沙箱可能限制 pnpm 写全局 store，建议在真实独立终端执行。完成后重启 DSH GUI。

### 2.4 环境要求

- Node.js `>=22.19.0`，DSH `>=0.2.1-rc.2 <0.3.0-0`。
- `agy` CLI 已安装并完成本机登录（默认路径 `%USERPROFILE%\.gemini\bin\agy.exe`）。
- Gemini 网页功能需要本机 `python` 与 `playwright`（`pip install playwright`）；使用系统默认浏览器 Chrome/Edge，不需要 `playwright install`。

---

## 3. 使用说明

### 3.1 子智能体

- `subagent_agy`：单次任务委派。任务 prompt 必须自包含，子进程不继承父会话上下文。
- `subagent_agy_team`：适合「一个大任务，让 agy 自己拆」；由 agy 用原生 `invoke_subagent` 并发执行。
- `subagent_agy_parallel`：适合「已经知道要拆成哪几个独立任务」；参数 `tasks: [{description, prompt, cwd?}]`，默认最多 8 个。

### 3.2 「Gemini 调研」面板

- 顶部显示运行状态、登录进程、登录态、Profile 状态。
- 输入调研主题 →「开始 Deep Research」，单次通常 5–10 分钟。
- 完成后展示报告，可复制；失败时展示错误与运行日志。
- 同一时间只跑一个调研任务；与「Gemini 对话」分属不同队列，可并行。

### 3.3 「Gemini 对话」面板

- 消息列表 + 输入框：Enter 发送，Shift+Enter 换行。
- 多轮上下文保留在同一个浏览器 page 内；「新对话」清空上下文。
- 未登录也可进行普通对话（但无历史记录）；Deep Research 必须登录。
- 与 Deep Research 共享同一个浏览器 profile，但各占一个标签页、各自一条队列。

### 3.4 登录

1. 在任一 Gemini 面板点「初始化登录」。
2. 弹出系统默认浏览器（Chrome/Edge），登录 Google AI Pro 账号。
3. 登录成功后 `init_login.py` 写入 `login-ok.json` 并退出；面板状态变为「登录态已验证」。
4. `login-ok.json` 只表示历史登录文件存在；真正的登录验证以 `login-state.json` 的 `signedIn` / `checkedAt` 为准。

---

## 4. 配置字段

### 4.1 配置示例

```yaml
- insert:
    - id: subagent-antigravity
      name: 'dsh-subagent-agy'
      config:
        providerName: antigravity
        executable: 'C:/Users/moyi_/.gemini/bin/agy.exe'
        model: gemini-4-argon-high
        effort: high
        permissionMode: dangerously-skip-permissions
        newProject: false
        projectName: ''
        printTimeout: 180s
        # jsonSchema: '{"type": "object"}'   # 可选，内联 JSON 或文件路径；不要传空字符串
        addDirs: []
        fallbackModel: gemini-3.8-flash-high
        retryOnRateLimit: false
        disposeGraceMs: 3000
        geminiProfileDir: 'C:/Users/moyi_/.dsh/gemini-web-research/browser-profile'
        geminiPython: python
        geminiHeadless: true
        geminiTimeoutMs: 900000
        geminiChatTimeoutMs: 180000
        geminiWorkerIdleMs: 600000
        geminiWorkerMode: persistent
        geminiDefaultModel: ''
        geminiDefaultThinking: ''
        teamProviderName: antigravity-team
        teamEnabled: true
        parallelToolName: subagent_agy_parallel
        parallelMaxTasks: 8
        extraArgs: []
        env: {}
```

### 4.2 字段说明

| 字段 | 类型 / 校验 | 默认值 | 说明 |
|---|---|---|---|
| `providerName` | `string` (`min(1)`) | `antigravity` | 注册到 `ctx.subagents` 的 provider 名，须与工具绑定名一致。 |
| `executable` | `string` (`min(1)`) | `%USERPROFILE%/.gemini/bin/agy.exe` | `agy` 可执行文件绝对路径。 |
| `model` | `string` (`min(1)`) | 无（继承 CLI） | 模型名，如 `gemini-4-argon-high`、`gemini-3.8-flash-high`、`claude-opus-5-5-high`。 |
| `effort` | `low \| medium \| high \| xhigh \| max` | 无 | 推理档位，映射 `--effort`。 |
| `env` | `Record<string, string>` | `{}` | 注入子进程的环境变量，覆盖在内置清理后的环境之上。 |
| `permissionMode` | `dangerously-skip-permissions \| auto` | `dangerously-skip-permissions` | 权限模式。print 模式下工具确认会被软拒，默认跳过权限；`auto` 仅适合纯问答。 |
| `extraArgs` | `string[]` | `[]` | 直接追加到 `agy` 命令行。 |
| `newProject` | `boolean` | `false` | 是否附加 `--new-project`。默认关闭，避免 Desktop Projects 列表堆积同名项目。 |
| `projectName` | `string` | `''` | 非空时映射 `--project <name>`，固定复用同一项目；优先于 `newProject`。 |
| `printTimeout` | `string` (`min(1)`) | 无（无限等待） | `--print-timeout`，Go duration 格式（如 `180s`、`10m`）。到期会返回部分结果并以 exit 0 退出，不能据此判断任务完成。 |
| `jsonSchema` | `string` (`min(1)`) | 无 | `--json-schema`，内联 JSON 或文件路径。 |
| `addDirs` | `string[]` | 无 | 附加只读工作区目录，每个映射一个 `--add-dir`。 |
| `fallbackModel` | `string` (`min(1)`) | 无（不重试） | 配额耗尽/限流时的降级备用模型，最多重试一次。 |
| `retryOnRateLimit` | `boolean` | `false` | 429 限流时按提示时长退避重试一次（上限 15s）。 |
| `disposeGraceMs` | `number` | `3000` | 终止清理子进程的宽限时长（毫秒）。 |
| `geminiProfileDir` | `string` (`min(1)`) | `~/.dsh/gemini-web-research/browser-profile` | Gemini 持久化浏览器 profile 目录。目录名是 `browser-profile`，因为浏览器可能是 Edge 或 Chrome。 |
| `geminiPython` | `string` (`min(1)`) | `python` | Playwright 脚本使用的 Python 可执行文件。 |
| `geminiHeadless` | `boolean` | `true` | Deep Research 是否无头运行；初始化登录始终有头。 |
| `geminiTimeoutMs` | `number` | `900000` | 单次 Deep Research 硬超时（毫秒）。 |
| `geminiChatTimeoutMs` | `number` (`min(1000)`) | `180000` | 单条普通对话消息硬超时（毫秒）。 |
| `geminiWorkerIdleMs` | `number` (`min(0)`) | `600000` | 常驻 worker 空闲回收时长（毫秒）；`0` 表示不自动回收。 |
| `geminiWorkerMode` | `persistent \| oneshot` | `persistent` | `persistent` 走常驻 worker；`oneshot` 时 Deep Research 回退旧 `run_research.py` 单次脚本（普通对话仍走 worker，且不支持模型/思考档选择）。 |
| `geminiDefaultModel` | `string` | `''` | 面板未保存本地选择时使用的默认模型 id（`flash-lite` / `flash` / `pro` / `argon`）；空值跟随网页默认。 |
| `geminiDefaultThinking` | `string` | `''` | 面板未保存本地选择时使用的默认思考档（`low` / `medium` / `high`）；空值跟随网页默认。 |
| `teamProviderName` | `string` (`min(1)`) | `antigravity-team` | 团队 provider 名，必须与 `providerName` 不同。 |
| `teamEnabled` | `boolean` | `true` | 是否注册 `antigravity-team` provider。 |
| `parallelToolName` | `string` (`min(1)`) | `subagent_agy_parallel` | 批量并发工具名。 |
| `parallelMaxTasks` | `number` (1–8) | `8` | 批量工具一次最多启动的任务数。 |

---

## 5. 架构说明

### 5.1 agy 委派链路

```
apply()
  → provider.start(request)
  → startAntigravityRunWithRetry()（仅在配置 fallbackModel / retryOnRateLimit 时）
  → startAntigravityRun()
  → spawn agy --print --output-format stream-json
  → lib/wire.js 解析 stdout（NDJSON）
  → settleRunResult() → { output, stopReason }
  → 失败由 lib/classify.js 分类（quota_exhausted / rate_limited / usage_error / unknown）
```

- `lib/run.js` 负责 argv 组装、spawn、收流、终止清理与退出结算。
- `lib/wire.js` 负责按行切帧、校验 envelope、选答案（终态 `result.response` 优先，`text_delta` 兜底）与状态映射。
- `lib/classify.js` 是纯函数错误分类器，零依赖。
- `lib/parallel.js` 通过 `ctx.subagents.startActivation` 并发启动多个 agy 子智能体，立即返回 `{started, failed}`。

### 5.2 Gemini 双队列 + 常驻 worker

```
lib/client.js（两个侧边栏面板）
  ├── 「Gemini 调研」→ /models、/run、/job、/status
  └── 「Gemini 对话」→ /models、/chat/send、/chat/job、/chat/status、/chat/new
                │
lib/gemini-web.js（HTTP 桥接）
  ├── researchQueue（串行）──┐
  └── chatQueue（串行）──────┤
                             ▼
                GeminiWorkerClient（lib/worker-client.js）
                  ├── 懒启动 python worker.py
                  ├── JSONL 协议：request/result/heartbeat/progress
                  ├── 崩溃拒绝 pending，下次请求自动重启
                  ├── 空闲 geminiWorkerIdleMs 后 shutdown
                  └── dispose() 杀进程树
                             │
                worker.py（常驻 Python）
                  ├── 一个 Chromium persistent context（persistent 模式）
                  ├── ChatPage（chat.send / chat.new / models.list / status）
                  └── ResearchPage（research.run / models.list / status）
```

- 两条队列各自串行，但共享同一个 worker，所以 chat 与 research 使用两个独立 page 并行工作。
- `geminiWorkerMode: oneshot` 时，research 队列回退到旧 `run_research.py`（每次启动一个 Python 进程），chat 仍走 worker；该模式下 research 不接受模型/思考参数。
- 协议：stdin/stdout JSONL；命令 `chat.send`、`chat.new`、`research.run`、`models.list`、`status`、`shutdown`、`cancel`；响应 `ready`、`heartbeat`、`progress`、`result`（`ok/error/data`）。日志只写 stderr。
- `chat.send` / `research.run` 可选 payload：`model`（id）、`modelLabel`（UI 文本，辅助匹配）、`thinking`（`low` / `medium` / `high`）；结果返回 `modelApplied` / `thinkingApplied` / `currentModel`。

### 5.3 浏览器 profile 与登录检测

**浏览器选择**：`scripts/gemini_research/browser.py` 的 `default_browser_channel()` 读取 Windows 注册表 `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice`：

- `ProgId` 含 `msedge` → `msedge`（Microsoft Edge）
- 含 `chrome` → `chrome`（Google Chrome）
- 无法识别 → `None`（Playwright 内置 Chromium）

当前本机默认浏览器为 **Microsoft Edge**，所以面板和脚本弹窗都是 Edge（Chromium 内核，外观与 Chrome 接近）。

**为什么用专用 profile**：Playwright 无法复用正在运行的 Edge/Chrome 的日常 User Data（浏览器单实例锁）。插件使用独立 profile `~/.dsh/gemini-web-research/browser-profile`，首次登录后长期保存登录态。

**登录检测（两层）**：

1. `init_login.py`（初始化登录）：
   - 每秒轮询，成功条件为 profile 中存在 Google 会话 cookie（`SID`）或页面 DOM 判断为已登录。
   - 登录成功后写入 `login-ok.json` 并 exit 0；窗口关闭过早会明确报错 `browser window closed before login was detected`。
2. `login-state.json`（运行时验证）：
   - worker 的每个页面在打开/任务前后调用 `selectors.is_logged_in()`，并通过 `record_login_state()` 写入 `{signedIn, checkedAt, error?}`。
   - 判定顺序：URL 跳到 `accounts.google.com` → 未登录；账号菜单存在 → 已登录；编辑器可见且没有「Sign in to save activity」→ 已登录。

**宿主状态字段**：

- `loginSaved`：`login-ok.json` 是否存在（历史登录文件）。
- `loginReady`：`loginState.signedIn === true` 且满足以下之一：worker 在线，或 `checkedAt` 距现在不超过 5 分钟（刚完成登录的宽限期）。
- 这样旧的 `login-ok.json` 不会单独造成「已就绪」假阳性；重启 GUI 后 5 分钟内显示「已验证」，之后显示「待验证」，发起任务会自动重新验证。

### 5.4 模型与思考强度

两个面板各有「模型」和「思考强度」下拉，选择随每次 `/run` / `/chat/send` 请求下发：

- **模型目录动态读取**：worker 的 `models.list` 打开 Gemini 模型菜单（`[data-test-id='bard-mode-menu-button']`），读取 `gem-data-id^='bard-mode-option-'` 选项；失败时回退到 `lib/gemini-models.js` 的静态目录（含 `3.5 Flash-Lite` / `3.8 Flash` / `3.1 Pro` / `4 Argon`）。
- **模型匹配**：按英文模型名 token（`flash-lite` / `3.8 flash` / `3.1 pro` / `4 argon`）匹配菜单文本，`data-test-id` hash 只作提示；点选后回读按钮 aria/text 校验。
- **思考强度**：在模型菜单底部「思考等级」二级菜单中按结构断言必须正好 3 项，索引 0/1/2 对应 `low` / `medium` / `high`（文本为低/中/高，中英文都做 sanity 校验）。
- **降级**：找不到控件时保持网页默认并在结果里标 `modelApplied:false` / `thinkingApplied:false`，不阻断；请求了非默认值但控件整体不存在时返回 `model_unavailable` / `thinking_unavailable`。
- **Deep Research**：提交前模型按钮仍存在，面板同样提供选择；但 DR 是否真正采用所选模型尚未 E2E 验证，面板注明「可能不生效」。
- **Deep Think**：当前页面没有独立控件，本期不做。

---

## 6. 目录结构与模块分工

```
dsh-subagent-agy/
├── AGENTS.md                  # 开发与维护规范
├── README.md                  # 项目说明（本文件）
├── cordis.patch.yml           # 插件插入补丁：provider 与 tool 绑定
├── package.json               # ESM 声明、peerDependencies、files 白名单
├── icon.svg                   # 插件图标
├── docs/
│   └── headless-scripting-plan.md  # headless 能力调研记录
├── lib/
│   ├── index.js               # Cordis 插件入口：Config、Provider、apply
│   ├── run.js                 # agy 进程生命周期与可选重试
│   ├── wire.js                # NDJSON 流解析
│   ├── classify.js            # 失败分类与 retry-after 解析
│   ├── client.js              # 两个侧边栏面板（Gemini 调研 / Gemini 对话）
│   ├── gemini-web.js          # /api/dsh-gemini-research/* 桥接、双队列、登录态
│   ├── gemini-models.js       # 静态模型目录、目录归一化、模型/思考校验与匹配
│   ├── worker-client.js       # 常驻 worker 客户端（懒启动/重启/空闲回收）
│   ├── parallel.js            # subagent_agy_parallel 批量并发工具
│   └── types/
│       └── index.d.ts         # 手写 TypeScript 类型
├── locale/
│   ├── zh.json                # 中文描述与触发词
│   └── en.json                # 英文描述与触发词
├── scripts/
│   └── gemini_research/
│       ├── browser.py         # 解析系统默认浏览器（Chrome/Edge）
│       ├── init_login.py      # 持久化 profile 登录（SID cookie + DOM）
│       ├── worker.py          # 常驻 worker：一个 context + chat/research 两个 page
│       ├── chat_page.py       # 普通对话页：输入、完成判定、回复提取
│       ├── research_page.py   # Deep Research 页：计划审批、轮询报告、正文提取
│       ├── selectors.py       # 共享选择器、登录检测、可见性、调试截图
│       └── run_research.py    # 旧单次 Deep Research 脚本（oneshot 回退）
└── test/
    ├── classify.test.js       # 失败分类与延时解析
    ├── gemini-models.test.js  # 模型目录归一化、校验与 token 匹配
    ├── gemini-web.test.js     # 双队列、路由、登录态、任务摘要
    ├── parallel.test.js       # 批量并发任务规范化与渲染
    ├── test_selectors.py      # Python 完成判定纯函数
    ├── worker-client.test.js  # worker 协议、崩溃重启、超时、空闲回收
    └── wire.test.js           # NDJSON 协议解析
```

### 6.1 模块职责

- `lib/wire.js`：纯 NDJSON 帧解析（`AntigravityStream`）。按行切帧、校验 envelope、选答案、映射终态状态、收集错误文本。
- `lib/classify.js`：纯函数失败分类。`classifyFailure()` → `quota_exhausted` / `rate_limited` / `usage_error` / `unknown`；`parseRetryAfterMs()` 解析 retry-after / `Resets in XhYmZs`。
- `lib/client.js`：DSH 客户端面板。lazy-CJS（`window.__ModuleLoader__.load`），只依赖 React；注册两个 `sidebar.panellist` 入口（order 30 / 31）和两个 `main` keyed slot。
- `lib/gemini-web.js`：主机侧 HTTP 桥接。`createJobQueue` 派生出 research / chat 两条串行队列；共享一个 `GeminiWorkerClient`；提供 `/models`、`/status`、`/chat/status`、`/login/init`、`/run`、`/chat/send`、`/chat/new`、`/chat/latest`、`/chat/job`、`/job`、`/latest`；注册模型可见工具 `gemini_web_research`。
- `lib/gemini-models.js`：静态模型/思考目录（含 4 Argon）、`normalizeModelCatalog()`、`validateModel()` / `validateThinking()`、按英文 token 匹配菜单项。
- `lib/worker-client.js`：常驻 worker 客户端。懒启动、`ready` 握手、请求 id 关联、progress 转发、超时 cancel、崩溃拒绝 pending、空闲 shutdown、dispose 杀进程树；`health` 暴露 `{running, ready, pid, lastHeartbeatAt, lastError, stderrTail}`。
- `lib/parallel.js`：DSH 侧批量并发工具。
- `scripts/gemini_research/worker.py`：常驻 Python worker，持有一个 persistent context 与 chat/research 两个 page，JSONL 协议。
- `scripts/gemini_research/chat_page.py` / `research_page.py`：页面级操作与完成判定。
- `scripts/gemini_research/selectors.py`：所有候选选择器、登录判断、输入提交、回复提取、调试截图。
- `scripts/gemini_research/init_login.py`：headed 登录脚本，写 `login-ok.json`。
- `scripts/gemini_research/run_research.py`：旧单次 Deep Research 脚本，`oneshot` 回退。
- `scripts/gemini_research/browser.py`：`default_browser_channel()` / `browser_label()`。

### 6.2 HTTP API

前缀：`/api/dsh-gemini-research`

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 综合状态：登录、worker、research / chat 队列与任务 |
| GET | `/models?mode=chat\|research` | 模型/思考目录（实时读取，失败回退静态目录）与配置默认值 |
| GET | `/chat/status` | 对话面板状态 |
| POST | `/login/init` | 停止 worker 并启动 `init_login.py`（有任务时 409） |
| POST | `/run` | 提交 Deep Research 任务，可选 `model` / `thinking`，返回 `{jobId}` |
| POST | `/chat/send` | 提交对话消息，可选 `model` / `thinking`，返回 `{jobId}` |
| POST | `/chat/new` | 清空当前对话上下文（有对话任务时 409） |
| GET | `/chat/latest` | 最近一条对话任务与 `conversationUrl` |
| GET | `/chat/job?id=` | 查询对话任务 |
| GET | `/job?id=` | 查询任务（research 或 chat） |
| GET | `/latest` | 最近一条调研任务 |

---

## 7. 验证与测试

### 7.1 单元测试

```powershell
npm test
# 或
node --test --test-isolation=none
```

当前共 **67 个用例**，覆盖 `wire.js` / `classify.js` / `gemini-web.js` / `gemini-models.js` / `worker-client.js` / `parallel.js`；另有 Python 完成判定用例：

```powershell
python -m unittest test/test_selectors.py
```

> DSH 受限 shell 内若报 `spawn EPERM`，改用 `node --test --test-isolation=none`。

### 7.2 语法检查

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js; node --check lib/worker-client.js; node --check lib/parallel.js
python -m py_compile scripts/gemini_research/browser.py scripts/gemini_research/init_login.py scripts/gemini_research/run_research.py scripts/gemini_research/worker.py scripts/gemini_research/chat_page.py scripts/gemini_research/research_page.py scripts/gemini_research/selectors.py
```

### 7.3 快速冒烟

```powershell
# NDJSON 7 字节分片重组：期望 completed + 文本
node -e "import('./lib/wire.js').then(({AntigravityStream})=>{const s=new AntigravityStream('t');const t=[JSON.stringify({event:'init',conversation_id:'c1'}),JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'par'}}),JSON.stringify({event:'result',result:{status:'SUCCESS',response:'partial answer'}})].join('\n')+'\n';for(let i=0;i<t.length;i+=7)s.push(t.slice(i,i+7));s.end();console.log(s.result(),s.conversationId)})"

# 失败分类：期望 rate_limited / quota_exhausted / usage_error
node -e "import('./lib/classify.js').then(({classifyFailure})=>console.log(classifyFailure('429 too many requests',{exitCode:1}),classifyFailure('quota limit exceeded',{exitCode:1}),classifyFailure('x',{exitCode:2})))"
```

### 7.4 手动 E2E 清单

1. 点「初始化登录」→ 系统默认浏览器打开 → 登录 → 面板显示「登录态已验证」。
2. 「Gemini 对话」发一条消息 → 收到回复 → 追问确认多轮上下文。
3. 「新对话」后上下文清空。
4. 发起 Deep Research 的同时在对话面板发消息 → 两边都正常，确认双队列互不阻塞。
5. 关闭 GUI 再重开 → worker 按需重启，会话 URL / 登录态可恢复或重新验证。

---

## 8. 已知限制与注意事项

1. **ToS 与风控**：Google 服务条款禁止自动化访问；网页端自动化可能触发风控甚至封号，建议使用专用账号、控制频率，不要拿主账号批量跑。
2. **选择器漂移**：Gemini 网页 UI 改版会导致选择器失效。所有选择器集中在 `scripts/gemini_research/selectors.py`，失败时会在 profile 目录留下 `debug-*.png`，整体属于 best-effort。
3. **浏览器单实例**：同一个 `geminiProfileDir` 同时只能有一个浏览器实例。chat / research 通过一个常驻 worker 的两个 page 并发；不要为两者各起一个浏览器。初始化登录前会先停 worker 释放 profile。
4. **专用 profile**：不能直接复用日常 Edge/Chrome 的 User Data（浏览器单实例锁）；首次使用需要在专用 profile 中登录一次。
5. **Deep Research 额度**：Google AI Pro 约每天 20 次，单次通常 5–10 分钟。
6. **未登录对话**：普通对话允许未登录使用，但没有历史记录；Deep Research 必须登录。
7. **一次性委派无法续聊**：`agy --print` 执行完即退出，不继承父会话上下文；任务 prompt 必须自包含。
8. **`--print-timeout` 语义**：到期会返回部分输出、stderr 打 warning 并以 exit 0 退出；`printTimeout` 只是兜底截断，不能据此判断任务完整完成。
9. **Windows 路径默认值**：默认 `executable` 是 Windows 的 `agy.exe`；迁移到 Linux/macOS 需在配置中显式指定可执行文件路径。
10. **模型/思考选择**：菜单项随账号/版本可能变化；实时目录读取失败会回退静态目录，选择结果以 `modelApplied` / `thinkingApplied` 为准。Deep Research 内选择是否真正影响报告仍待最小 E2E 验证。
