# AGENTS.md

DSH 插件 `dsh-subagent-agy`（v0.6.2）：把一次性任务委派给本机 Antigravity CLI（`agy`），并支持 Gemini 网页 Deep Research、普通对话、并发/团队子智能体。部署实例在 `%USERPROFILE%\.dsh\profiles\desktop`；npm 包名同为 `dsh-subagent-agy`。

## 仓库形态

- 纯 ESM JavaScript：无构建、无 lint、无本地 `node_modules`；使用 `node:test` 单测（`test/*.test.js`，当前 68 个用例，覆盖 `wire.js` / `classify.js` / `gemini-web.js` / `gemini-models.js` / `worker-client.js` / `parallel.js`），另有 `test/test_selectors.py` 覆盖完成判定与模型匹配纯函数。
- **已是 git 仓库**：origin `https://github.com/Michael-LY/dsh-subagent-agy.git`；主干 `master`，历史功能分支 `feature/gemini-web-research` / `feature/agy-parallel-subagents` 已合并；新功能分支 `feature/gemini-web-chat` 承载 Gemini 对话面板与常驻 worker。
- `lib/*.js` 就是发布源码（Tab 缩进、JSDoc 类型）。`lib/types/index.d.ts` **不是** tsc 生成的，改 `Config` / 导出后要手写同步。
- `package.json` 的 `files` 里 lib 部分只收 `lib/*.js`（顶层，不含子目录）加 `lib/types/**/*.d.ts`（另有 `icon.svg` / `README.md` / `locale/*.json` / `scripts/gemini_research/*.py` / `cordis.patch.yml`）：新模块放 `lib/` 顶层无需改白名单，放子目录则必须补，否则装进 profile 后缺失。
- `docs/headless-scripting-plan.md`：headless 能力嫁接（超时/结构化输出/附加目录/配额降级）的调研与取舍记录，改相关功能前先读。
- 包版本 `0.6.2`；`peerDependencies` 兼容 DSH `>=0.2.2-rc.3 <0.3.0-0`（已在 `0.2.2-rc.3` 上核对）/ cordis `~4.1.0`，升级时一起动。
- npm 发布：`package.json` 已去掉 `private`，`publishConfig.access=public`；当前账号 `mokngai`，发布前先 `npm pack --dry-run`，发布命令 `npm publish --access public`。不要把 `.tgz` 提交进仓库。

## 模块分工

- `lib/wire.js`：纯 NDJSON 帧解析（`AntigravityStream`）。按行切帧、校验 envelope、选答案（终态 `result.response` 优先，`text_delta` 兜底）、把终态 status 映射成 `completed` / `aborted` / `error`，并收集 result/error 帧的错误文本供分类。不碰进程。
- `lib/classify.js`：纯函数失败分类。`classifyFailure()` 输出 `quota_exhausted` / `rate_limited` / `usage_error` / `unknown`，`parseRetryAfterMs()` 从文本解析 retry-after / `Resets in XhYmZs`。零依赖、可独立单测。
- `lib/client.js`：DSH 客户端面板。lazy-CJS 格式（`window.__ModuleLoader__.load`），不需要打包器，只依赖 React。注册两个独立 `sidebar.panellist` 入口：「Gemini 调研」（`gemini-research`，order 30）与「Gemini 对话」（`gemini-chat`，order 31），以及对应的两个 `main` keyed slot。
- `lib/gemini-models.js`：静态模型/思考目录（含 4 Argon）、`normalizeModelCatalog()`、`validateModel()` / `validateThinking()`、按 id 精确匹配模型菜单项。面板目录优先实时读取，失败回退这里。
- `lib/gemini-web.js`：主机侧 `/api/dsh-gemini-research/*` 桥接。`createJobQueue` 派生出 research / chat 两条独立串行队列，共享一个 `GeminiWorkerClient`（同一浏览器 profile 只允许一个实例）；负责超时终止、任务摘要、登录态汇总、模型/思考参数校验与 `/models` 目录缓存，并注册模型可见工具 `gemini_web_research`。
  - 路由：`GET /models?mode=chat|research`、`GET /status`、`GET /chat/status`、`POST /login/init`、`POST /run`、`POST /chat/send`、`POST /chat/new`、`GET /chat/latest`、`GET /chat/job?id=`、`GET /job?id=`、`GET /latest`。
  - `/status` 关键字段：`loginSaved`（`login-ok.json` 存在）、`loginReady`、`loginCheckedAt`、`loginError`、`loginRunning`、`worker`（`{running, ready, pid, lastHeartbeatAt, lastError, stderrTail}`）、`research: {running, job}`、`chat: {running, job, conversationUrl}`。
- `lib/worker-client.js`：常驻 Gemini worker 客户端。懒启动、`ready` 握手、请求 id 关联、progress 转发、超时 cancel、崩溃拒绝 pending 并允许下一次请求自动重启、空闲 `geminiWorkerIdleMs` 后自动 shutdown、`dispose()` 杀进程树。
- `lib/parallel.js`：DSH 侧批量并发工具 `subagent_agy_parallel`。参数 `tasks:[{description,prompt,cwd?}]`，用 `ctx.subagents.startActivation` 一次并发启动多个 agy 子智能体，立即返回 `{started,failed}`，结果由 DSH 异步回传；默认上限 8 个任务。
- `scripts/gemini_research/`：
  - `worker.py`：常驻 Python worker。一个 Playwright persistent context + `ChatPage` / `ResearchPage` 两个 page；stdin/stdout JSONL 协议（`chat.send` / `chat.new` / `research.run` / `models.list` / `status` / `shutdown` / `cancel`；响应 `ready` / `heartbeat` / `progress` / `result`），日志只写 stderr。
  - `chat_page.py`：普通对话页。多轮上下文常驻同一 page；`new_chat()` 回 `/app`；`models.list` 读取模型目录；发送前按 `model` / `thinking` 选择后回读校验。
  - `research_page.py`：Deep Research 页。每次任务先回 `/app` 开新调研，走 Tools → Deep Research → 选择模型/思考 → 提交主题 → 计划审批 → 轮询报告。
  - `selectors.py`：所有候选选择器、可见性工具、登录判断（`is_logged_in`）、`record_login_state`、输入提交、回复/报告提取、调试截图；模型菜单 helper（`list_model_catalog` / `select_model` / `select_thinking` / `apply_generation_options`）。
  - `init_login.py`：headed 登录脚本。轮询 Google 会话 cookie（`SID`）或 DOM 登录态，成功后写 `login-ok.json` 并 exit 0；窗口关闭过早明确报错。
  - `run_research.py`：旧单次 Deep Research 脚本，仅在 `geminiWorkerMode: oneshot` 时作为 research 回退。
  - `browser.py`：`default_browser_channel()` 读取 Windows `UrlAssociations\http\UserChoice`，返回 `msedge` / `chrome` / `None`；`browser_label()` 生成展示名。
- `lib/run.js`：单次 agy 子进程生命周期 + 可选重试。`antigravityArgv` 拼 argv（含 `--print-timeout` / `--json-schema` / `--add-dir` / `--project`）、`textTask` 校验只收 text 块、`startAntigravityRun` 负责 spawn / 收流 / 终止清理 / 组装 run handle、`startAntigravityRunWithRetry` 在显式配置 `fallbackModel` / `retryOnRateLimit` 时做一次重试、`stripAnsi` 清理 stderr 转义码。
- `lib/index.js`：cordis 插件入口。定义 `Config`（schemastery，字段：providerName / executable / model / effort / env / permissionMode / extraArgs / printTimeout / jsonSchema / addDirs / newProject / projectName / fallbackModel / retryOnRateLimit / disposeGraceMs / geminiProfileDir / geminiPython / geminiHeadless / geminiTimeoutMs / geminiChatTimeoutMs / geminiWorkerIdleMs / geminiWorkerMode / geminiDefaultModel / geminiDefaultThinking / teamProviderName / teamEnabled / parallelToolName / parallelMaxTasks）、实现 `AntigravityProvider`（`NO_START_CAPABILITIES`、`inheritsParentContext = false`）、`apply()` 注册 `antigravity` 与 `antigravity-team` 两个 provider，调用 `setupParallelTool` 和 `setupGeminiWeb`。`antigravity-team` 在 prompt 前注入 `NATIVE_TEAM_DIRECTIVE`，让 agy 用原生 `invoke_subagent` 并发拆分子任务。
- 数据流（agy）：`apply` → `provider.start` →（配置 fallback/retry 时走 `startAntigravityRunWithRetry`）→ `startAntigravityRun` → spawn `agy` → `wire.js` 解析 stdout → `settleRunResult` 产出 `{ output, stopReason }`；失败由 `classifyFailure` 分类并写进诊断标签 `[kind]`。
- 数据流（Gemini）：面板 → `lib/gemini-web.js` 的 research/chat 队列 → `GeminiWorkerClient` → `worker.py` 的 chat/research page → Playwright persistent context。

## 本地跑不起来的部分

- `lib/wire.js` / `lib/classify.js` / `lib/gemini-web.js` / `lib/worker-client.js` 只用 node 内置模块，可直接用 node 跑；`lib/client.js` 是浏览器 lazy-CJS 模块，只能做 `node --check`。
- `lib/index.js` / `lib/run.js` 依赖 `@deepseek-ai/*`，仓库内解析不到；只能借 profile 的 hoisted `node_modules`（该 profile 是 `nodeLinker: hoisted` + `autoInstallPeers: false`）。
- `lib/run.js` import 了 `@deepseek-ai/dsh-brand`，已随 DSH 0.2.2-rc.1 对齐补进 `dependencies`（此前靠别的包提升）。

## 有意为之，别「顺手改回」

- 默认 `permissionMode` 是 `dangerously-skip-permissions`（`lib/run.js`），别按直觉改成更安全的 `auto`：print 模式下工具确认被软拒，`auto` 的子级读不了工作区，只适合不需要工具的 prompt。
- `agy` 正常退出（exit 0）必须 resolve，不能当失败：终态 `result` 帧与退出通知会竞争同一轮 stdout。
- 答案取值：终态 `result.response` 优先，`agent_response` 的 `text_delta` 只是兜底；没有终态帧 → `stopReason: 'error'`。
- `SCRUBBED_ENV`（`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `GEMINI_CLI` / `ANTIGRAVITY_SESSION_ID`）被置为**空字符串**而非删除，用来阻止子进程挂到父 CLI 会话上。
- `NO_START_CAPABILITIES` + `inheritsParentContext = false` 是 Antigravity 只有 CLI、没有 app-server/SDK 的直接后果；因此 `cordis.patch.yml` 里必须配 `maxDepth: provider-managed`。
- CLI 的 `--mode` 还支持 `accept-edits`，但 `Config.permissionMode` 有意只暴露 `auto` / `dangerously-skip-permissions`。
- **重试默认关闭**：`fallbackModel` / `retryOnRateLimit` 只在显式配置时生效。一次性委派自动重试会翻倍配额，`usage_error`（CLI exit 2）一律不重试。别把默认改成自动重试。
- `--print-timeout`（1.1.28+）到期会返回**部分输出、在 stderr 打 warning 并以 exit 0 成功退出**，不是失败；`printTimeout` 只是兜底截断，不能据此判断任务真正完成。
- **agy 原生 `/agents` / `/teamwork` 不能直接 headless 复用**：`/agents` 是 TUI 面板，`/teamwork` 是付费版交互式两阶段（访谈 + 审批）。并发能力走底层 `invoke_subagent`：单次调用一个子智能体，同一轮多次调用并发。`antigravity-team` provider 只注入指令，不伪造 `/teamwork` 流程。
- **Gemini 浏览器单实例**：同一个 `geminiProfileDir` 同时只能有一个浏览器实例。`lib/gemini-web.js` 用 chat / research 两条独立队列共享单个常驻 worker（一个 persistent context、两个 page）：每条队列各自串行，两个 page 之间可以并发；不要给 chat/research 各起一个浏览器（双 profile）。worker 懒启动，崩溃后下一次请求自动重启，空闲 `geminiWorkerIdleMs` 后自动 shutdown；初始化登录前必须先 `worker.shutdown()` 释放 profile。登录必须 headed（可见窗口），worker 默认 headless，均使用系统默认浏览器（Chrome/Edge）。
- **登录态假阳性**：`login-ok.json` 只作为 `loginSaved`；`loginReady` 必须是 `login-state.json` 的 `signedIn === true`，并且 worker 在线或 `checkedAt` 在 5 分钟内（`LOGIN_FRESH_MS`）。不要再退回「只看文件存在」。
- **Deep Research 完成判定**：只认 Export 控件出现，或 Stop 消失后连续 12 秒；不要用「文本 N 秒不变」判定（研究中途停顿会误判）。
- **普通对话完成判定**：`wait_for_reply` 要求出现新回复气泡、文本稳定 ≥2.5 秒，且 Stop 已消失或回复动作按钮已出现；发出后 90 秒没有开始生成则报 `no_response_started`。
- **普通对话允许未登录**：Gemini 网页支持未登录对话，但无历史；`ChatPage.ensure_page` 会记录 `signedIn: false`。Deep Research 必须登录，`ResearchPage.run` 检测不到登录直接抛 `LoginRequired`。
- **专用浏览器 profile**：Playwright 不能复用正在运行的日常 Edge/Chrome User Data（单实例锁），必须使用独立 profile（默认 `~/.dsh/gemini-web-research/browser-profile`，目录名不再是 `chrome-profile`）。
- **模型/思考强度选择**：面板目录由 `models.list` 实时读取，失败回退 `lib/gemini-models.js`；模型用 `_model_id_from_label` 精确匹配（`flash-lite` / `flash` / `pro` / `argon`）并回读模型 id 校验，`bard-mode-option-*` hash 只作提示；思考等级按「思考等级」二级菜单结构断言正好 3 项、索引 0/1/2 = low/medium/high。未请求时保持网页默认；**显式请求非默认但控件/选项不存在时抛 `ModelUnavailable` / `ThinkingUnavailable` 明确报错，不静默降级**；只有目录读取失败才回退静态目录。oneshot 模式的 research 不接受模型/思考参数。
- **Deep Research 的模型选择**：composer 阶段可设置，但 DR 是否真正采用所选模型尚未 E2E 验证，面板文案必须保留「可能不生效」。
- **Gemini 网页自动化是 best-effort**：Google ToS 禁止自动化访问，可能触发风控/封号；选择器随网页改版会失效，脚本失败时在 profile 目录留 `debug-*.png`。不要把这条路径接进高频批量任务。

## 三处联动，改触发词要一起改

1. `cordis.patch.yml`：`provider: antigravity` 必须等于插件注册的 `providerName`；`toolName: subagent_agy` 才是模型看到的工具名。第二个 `tool-subagent-antigravity-team` 绑定 `provider: antigravity-team` / `toolName: subagent_agy_team`。
2. `locale/zh.json` + `locale/en.json`：description 里的 `agy` / `antigravity` 关键词，中英同步。
3. `%USERPROFILE%\.dsh\AGENTS.md`：真正让模型在用户说「agy」时选中该工具的指令（仓库外，但缺了工具不会被选中）。
- 运行期配置覆盖写在 profile 的 `cordis.patch.yml`（`- id: subagent-antigravity`）；当前部署**没有**覆盖，全部走代码默认值（含默认 `agy.exe` 路径）。

## 验证

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js; node --check lib/worker-client.js; node --check lib/parallel.js   # 语法
python -m py_compile scripts/gemini_research/browser.py scripts/gemini_research/init_login.py scripts/gemini_research/run_research.py scripts/gemini_research/worker.py scripts/gemini_research/chat_page.py scripts/gemini_research/research_page.py scripts/gemini_research/selectors.py   # Python 语法
node --test   # 单测（68 用例；DSH 沙箱内若 spawn EPERM，用 node --test --test-isolation=none）
python -m unittest test/test_selectors.py   # Python 完成判定纯函数测试

# 协议解析冒烟（7 字节强制分片，模拟真实 chunk 边界）：期望 completed + 文本
node -e "import('./lib/wire.js').then(({AntigravityStream})=>{const s=new AntigravityStream('t');const t=[JSON.stringify({event:'init',conversation_id:'c1'}),JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'par'}}),JSON.stringify({event:'result',result:{status:'SUCCESS',response:'partial answer'}})].join('\n')+'\n';for(let i=0;i<t.length;i+=7)s.push(t.slice(i,i+7));s.end();console.log(s.result(),s.conversationId)})"

# 失败分类冒烟：期望 rate_limited / quota_exhausted / usage_error
node -e "import('./lib/classify.js').then(({classifyFailure})=>console.log(classifyFailure('429 too many requests',{exitCode:1}),classifyFailure('quota limit exceeded',{exitCode:1}),classifyFailure('x',{exitCode:2})))"

# CLI 本身可用（未登录时会静默降级）：末帧应为 {"status":"SUCCESS",...}
& "$env:USERPROFILE\.gemini\bin\agy.exe" --print "Say OK" --output-format stream-json --project dsh-subagent-agy
```

## 让改动真的生效

- profile 里的 `node_modules/dsh-subagent-agy/*` 是**硬链接**到本仓库（`fsutil hardlink list <file>` 可验证）：原地改内容会同步过去，但**新增文件不会**；而整体替换文件的保存方式（原子写）会断开硬链接，profile 继续用旧副本。
- 因此改完执行：`cd $env:USERPROFILE\.dsh\profiles\desktop; pnpm install`。pnpm 要写全局 store，在 DSH 沙箱里可能被拦——那就换真实终端跑；装完重启 GUI，`subagent_agy` / `subagent_agy_team` / `subagent_agy_parallel` 和两个 Gemini 面板才会带新代码。
