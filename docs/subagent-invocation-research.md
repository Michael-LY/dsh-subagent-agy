# 官方 DSH 子代理插件（Codex / Claude Code）调用方式调研与 agy 对比

> 本文只做源码调研与对比，不修改任何运行时/测试文件。所有结论均来自本机已安装源码，引用格式为 `文件:行号`。
>
> **路径前缀约定**（下文省略公共前缀，均可直接定位）：
> - `codex/` = `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-subagent-codex\`
> - `claude-code/` = `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-subagent-claude-code\`
> - 其余相对路径（`lib/…`、`docs/…`、`AGENTS.md`、`cordis.patch.yml`、`locale/…`）均相对本仓库根目录 `dsh-subagent-agy`。
>
> 参考插件优先读 TS 源码（`src/*.ts`，最易读）；`lib/index.js` 为其编译产物，语义一致。

---

## 1. 两个参考插件的架构与功能

### 1.1 共同骨架（Codex 与 Claude Code 同构）

两者是同一套「产品子代理 provider」范式，只在「底座」上不同：Codex 用 `app-server --stdio` JSON-RPC，Claude Code 用官方 Agent SDK。共同点：

- **插件入口与注入**：`export const name`、`export const inject = ['subagents', 'subprocess']`
  （`codex/src/index.ts:30-31`、`claude-code/src/index.ts:30-31`）。
- **Config（schemastery）**：字段 `providerName` / `model` / `env` / `permissionMode` / `disposeGraceMs`
  （`codex/src/index.ts:36-59`、`claude-code/src/index.ts:38-66`）。
  - `providerName` 非空，默认 `codex` / `claude-code`（`codex/src/index.ts:33,53`、`claude-code/src/index.ts:33,60`）。
  - `model` 为 `z.string().min(1)`，**无默认**——省略即继承产品自身设置（`codex/src/index.ts:54`、`claude-code/src/index.ts:61`）。
  - `env` 为 `z.dict(z.string()).default({})`，叠加在「已擦除凭据的父环境」之上（`codex/src/index.ts:42-45,55`、`claude-code/src/index.ts:44-47,62`）。
  - `disposeGraceMs` 为 `z.number().default(DEFAULT_DISPOSE_GRACE_MS)`，`DEFAULT_DISPOSE_GRACE_MS = 3000`（`codex/src/run.ts:36`、`codex/src/index.ts:58`；`claude-code/src/run.ts:41`、`claude-code/src/index.ts:65`）。
- **capabilities / inheritsParentContext**：`readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES`、`readonly inheritsParentContext = false`
  （`codex/src/index.ts:64-65`、`claude-code/src/index.ts:74-75`）。
  即不支持「带起能力（agentPreset/agentOptions/output schema/深度强制）」，也不继承父会话上下文。
- **Provider 类 + `start()`**：`start(request)` 先 `assertUsableCwd(...)` 选子工作区，失败时（未 abort 情况下）转成**结构化 startup failure**，再组装 `XxxRunSpec` 调用 `startXxxRun`（`codex/src/index.ts:73-99`、`claude-code/src/index.ts:83-115`）。
- **RunSpec**：`{ cwd, model?, permissionMode, env, disposeGraceMs, spawn(spec), onError?(error, stopReason) }`（`codex/src/run.ts:139-155`、`claude-code/src/run.ts:149-165`）。
- **startXxxRun 生命周期**：`spawn → initialize/handshake → thread/或 query → runTurn → settle`。
  - Codex：`spec.spawn()` → `wire.initialize()`（JSON-RPC `initialize`/`initialized`）→ `wire.startThread(cwd)`（`thread/start` + `ephemeral:true`）→ `wire.runTurn(texts)`（`turn/start` + 等 `turn/completed`）→ `settleRunResult(...)`（`codex/src/run.ts:225-438`；细节见 `codex/src/wire.ts:268-302,311-375`）。
  - Claude Code：`officialQuery({prompt, options})` → 自定义 `spawnClaudeCodeProcess` 把真实 CLI 挂到 subprocess seam → 迭代 SDK 消息流 → 仅接受 `subtype:'success'` 的 result → `settleRunResult(...)`（`claude-code/src/run.ts:385-586`；spawn 投影见 `claude-code/src/process.ts:46-61,67-159`）。
- **wire / 协议层**：Codex 有独立 `src/wire.ts`（最小 app-server JSON-RPC 适配，只管产品方法与终态选择，帧解析复用 `@deepseek-ai/dsh-sdk-protocol` 的 `JsonRpcLineTransport`，`codex/src/wire.ts:13,230-249`）。Claude Code 无独立 wire 文件，协议完全复用官方 SDK，`process.ts` 只做「共享 managed process → SDK SpawnedProcess」的投影（`claude-code/src/process.ts:63-94`）。
- **startup failure 分类（固定安全事实）**：对外只暴露固定 `stage`/`category` 与（可选）观测到的进程 outcome，原始错误挂 `cause` 链，不进 model 可见文本。
  - `codexStartupFailure(cause)` → `{ stage:'initialize', category:'unknown' }`（`codex/src/run.ts:124-129`）。
  - `claudeCodeStartupFailure(cause)` → `{ stage:'query-start', category:'unknown' }`（`claude-code/src/run.ts:131-136`）。
  - 诊断文本构造 `failureDiagnostic(facts)` 拼 `product / stage / category / HTTP status / exit code / signal`（`codex/src/run.ts:87-104`、`claude-code/src/run.ts:81-96`）。
- **settleRunResult / subprocessRunHandle**：结果统一经 `settleRunResult({ attempt, collectOutput, collectDiagnostic, cancelled, onError, signal, onAbort })` 归一成 `{ output, stopReason }`，run handle 用 `subprocessRunHandle({ id, result, signal, onAbort, requestCancel, teardown })` 组装（`codex/src/run.ts:380-438`、`claude-code/src/run.ts:522-586`）。
- **teardown 到静默（dispose to quiescence）**：关 wire/SDK → `child.stdin.end()` → `child.terminate()` → `await child.waitForExit()` → `await child.done`；失败包成 `stage:'teardown'`（`codex/src/run.ts:190-217`、`claude-code/src/run.ts:270-306`）。
- **disposeGraceMs 校验**：`assertPositiveFinite(...)` + `<= MAX_TIMER_DELAY_MS`（`codex/src/index.ts:115-124`、`claude-code/src/index.ts:131-140`）。
- **cordis.patch.yml 绑定**：`insert` 两行——provider 包 + `@deepseek-ai/dsh-tool-subagent`（`provider` / `toolName` / `maxDepth: provider-managed`）（`codex/cordis.patch.yml:1-9`、`claude-code/cordis.patch.yml:1-9`）。
- **locale**：`locale/en.json` + `locale/zh.json`，`meta.title` / `meta.description`（`codex/locale/en.json:1-6`；`claude-code/locale/en.json:1-6`）。
- **发布时机（publish only after handshake）**：Codex 在 `initialize` + `thread/start` 都成功后，才在第 431 行 `subprocessRunHandle(...)` 发布（`codex/src/run.ts:315-354,431-438`）；Claude Code 在 SDK 的 custom-spawn 回调已产出可控 CLI 句柄后，才在第 571 行发布（`claude-code/src/run.ts:440-457,571-586`）。

### 1.2 Codex 细节

- 可执行体：包内 pinned 的 `@openai/codex` JS wrapper，argv 固定为 `[process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']`，不依赖 host `PATH`（`codex/src/run.ts:44-53,135-137`）。
- `permissionMode` 枚举：`never` / `approve-for-me` / `dangerously-bypass-approvals-and-sandbox`，**默认 `never`**（`codex/src/run.ts:56-69`），映射到 `thread/start` 的 `approvalPolicy` / `approvalsReviewer` / `sandbox`（`codex/src/wire.ts:32-43`）。
- 非交互应答：命令/文件审批取 `cancel|decline`，权限授予返回空，用户输入返回空，MCP elicitation 拒绝（`codex/src/wire.ts:574-633`）。
- 答案选择：`final_answer` > `partial_answer` > `phase:null`，`commentary` 永不入选（`codex/src/wire.ts:395-400,649-684`）。
- 失败类别：`limit / access-policy / service / transport / product-error / invalid-result / unknown`，并保留数字 `httpStatus`（`codex/src/wire.ts:19-30,114-148`）。

### 1.3 Claude Code 细节

- 可执行体：官方 Agent SDK 自带的 CLI，通过 `spawnClaudeCodeProcess` 接管，把真实 CLI 进程放在共享 subprocess owner 之下（`claude-code/src/run.ts:370-375`、`claude-code/src/process.ts:46-61`）。
- `permissionMode` 枚举：`dontAsk / acceptEdits / auto / plan / bypassPermissions`，**默认 `dontAsk`**（`claude-code/src/run.ts:44-56`）。
- 环境擦除：SDK 组合出的 env 再叠加「`scrubbedParentEnv()` 里有、SDK 里被删掉的名字置 `undefined`」的墓碑（`claude-code/src/process.ts:30-38`）。
- 严格成功：仅 `subtype:'success'` 且 `is_error:false` 且 `result` 非空才算完成；其余映射到 `limit / product-error / invalid-result`（`claude-code/src/run.ts:206-226`）。
- `AskUserQuestion` 始终禁；`plan` 模式再禁 `ExitPlanMode`；`canUseTool` 一律 deny，`onElicitation` decline，`onUserDialog` cancel（`claude-code/src/run.ts:331-369`）。

---

## 2. 三方功能对比矩阵（Codex / Claude Code / agy）

| 维度 | Codex | Claude Code | agy（本项目） | 证据 |
|---|---|---|---|---|
| 底座 | `app-server --stdio` JSON-RPC | 官方 Agent SDK | 本机 `agy` CLI：`stream-json` 或 `acp` | `codex/src/run.ts:135-137`；`claude-code/src/run.ts:370-375`；`lib/run.js:66-91,128-269`；`lib/acp-client.js:964-1084` |
| provider 注册 | `ctx.subagents.registerProvider` | 同 | 同（且额外注册 `antigravity-team`） | `codex/src/index.ts:125-129`；`claude-code/src/index.ts:141-145`；`lib/index.js:242-246` |
| Config 关键字段 | providerName/model/env/permissionMode/disposeGraceMs | 同 | 更宽（+executable/effort/transport/acp*/gemini*/team*/parallel*） | `codex/src/index.ts:36-59`；`claude-code/src/index.ts:38-66`；`lib/index.js:48-84` |
| `model` 默认 | 无（继承产品设置） | 无（继承产品设置） | `gemini-3.8-flash`（强制注入） | `codex/src/index.ts:54`；`claude-code/src/index.ts:61`；`lib/index.js:51`、`lib/run.js:19,82-83` |
| `permissionMode` 枚举/默认 | `never/approve-for-me/dangerously-bypass-approvals-and-sandbox`，默认 `never` | `dontAsk/acceptEdits/auto/plan/bypassPermissions`，默认 `dontAsk` | `auto/dangerously-skip-permissions`，默认 `dangerously-skip-permissions` | `codex/src/run.ts:56-69`；`claude-code/src/run.ts:44-56`；`lib/run.js:37-45` |
| capabilities | `NO_START_CAPABILITIES` | 同 | 同 | `codex/src/index.ts:64`；`claude-code/src/index.ts:74`；`lib/index.js:99` |
| `inheritsParentContext` | `false` | `false` | `false` | `codex/src/index.ts:65`；`claude-code/src/index.ts:75`；`lib/index.js:100` |
| 发布时机（publish gate） | initialize + thread/start 成功后发布 | SDK 产出可控 CLI 句柄后发布 | ACP：initialize + session/new 成功后发布；stream-json：spawn 即可控制 | `codex/src/run.ts:315-354,431`；`claude-code/src/run.ts:440-457,571`；`lib/acp-client.js:996-1027,1072`；`lib/run.js:131-142,261-268` |
| startup failure | `codexStartupFailure` 固定安全事实 + cause | `claudeCodeStartupFailure` + `logger.warn` | **无**（原始错误直抛，含绝对路径） | `codex/src/run.ts:124-129`；`claude-code/src/index.ts:93-99`；`lib/index.js:111-118` |
| 失败诊断字段 | product/stage/category/HTTP status/exit code/signal | product/stage/category/exit code/signal | 仅 product/stage/category | `codex/src/run.ts:87-104`；`claude-code/src/run.ts:81-96`；`lib/run.js:48-55` |
| teardown 归类 | `stage:'teardown'` | `stage:'teardown'` | **无归类**（原始错误直抛） | `codex/src/run.ts:190-217`；`claude-code/src/run.ts:270-306`；`lib/run.js:205-213,267` |
| `disposeGraceMs` 校验 | assertPositiveFinite + MAX_TIMER_DELAY_MS | 同 | 同 | `codex/src/index.ts:115-124`；`claude-code/src/index.ts:131-140`；`lib/index.js:240-241` |
| 重试/fallback | 无 | 无 | 有（`fallbackModel`/`retryOnRateLimit`，默认关闭） | `lib/run.js:279-332`；`lib/acp-client.js:1093-1152` |
| 续聊/上下文 | 一次性、无续聊 | 一次性、无续聊 | 一次性、无续聊 | `codex/src/index.ts:2-6`；`claude-code/src/run.ts:1-6`；`lib/index.js:2-7` |
| cordis.patch.yml | 1 provider + tool | 1 provider + tool | 2 provider（+team）+ 2 tools，均 `maxDepth: provider-managed` | `codex/cordis.patch.yml:1-9`；`claude-code/cordis.patch.yml:1-9`；`cordis.patch.yml:1-15` |
| locale | en/zh `meta` | en/zh `meta` | en/zh `meta` | `codex/locale/en.json:1-6`；`claude-code/locale/en.json:1-6`；`locale/en.json:1-6` |

---

## 3. agy 现状与参考实现的差异清单（含证据）

> 只列「行为/契约层面」的实质差异；`agy` 额外拥有的 Gemini 面板、parallel/team 工具属产品扩展，不与参考插件比较。
>
> **基线说明**：本节与第 4 节基于本分支「优化前」的源码基线（即 `git show HEAD:lib/index.js` / `HEAD:lib/run.js`）分析；本轮的 implementer 正在按 P0-1 / P0-2 落地改动，若工作区已含更新，以实际代码为准，但差异清单描述的正是这些改动要解决的问题。

- **D1 启动期失败未结构化（缺 startup failure 包裹 + 缺日志）**：`start()` 里 `assertUsableCwd` 失败就直接 `throw error`，`existsSync(cfg.executable)` 失败直接 `throw new Error("... not found at \"<绝对路径>\"")`，既未归一到固定安全事实，也没有 `ctx.logger.warn`（`lib/index.js:111-118`）。参考实现把这类失败包成 `stage:'initialize'|'query-start'` 的固定事实并保留 `cause`（`codex/src/run.ts:124-129`），Claude 还额外 `logger.warn`（`claude-code/src/index.ts:93-99`）。后果：本机绝对路径与未归一化异常会直接冒到 start 边界。
- **D2 失败诊断缺 `exitCode` / `signal`**：`AntigravityRunFailure` 的 message 只拼 `product/stage/category`（`lib/run.js:48-55`）；进程 outcome 虽在 `processSettled` 记录（`lib/run.js:182-192`），却从未进入诊断文本。参考实现均追加 `exit code` / `signal`（`codex/src/run.ts:96-102`、`claude-code/src/run.ts:87-94`）。后果：无法区分「业务失败」与「进程被杀/非零退出」。
- **D3 teardown 失败未归类为 `stage:'teardown'`**：`disposeProcess`（`lib/run.js:205-213`）无 try/catch，且 `teardown: disposeProcess`（`lib/run.js:267`）直接暴露原始拒绝。参考实现把 teardown 异常包成 `stage:'teardown'`（`codex/src/run.ts:190-217`、`claude-code/src/run.ts:270-306`）。后果：清理期失败与业务失败混在一起，且类型不稳。
- **D4 ACP 发布时机——已符合 publish-after-handshake（确认，不是缺陷）**：`startAcpRun` 在 `client.start()`（=spawn + `initialize`）与 `client.newSession()` 都成功后，才 `return subprocessRunHandle(...)`；两者任一失败会在 catch（`lib/acp-client.js:1015-1027`）里回退或抛出，绝不先发布（`lib/acp-client.js:996-1003,1072`）。stream-json 路径无握手，spawn 成功即视为可控制并发布（`lib/run.js:131-142,261-268`）。→ 与参考的「publish only after handshake」不变量一致，**无需改动，但建议补回归测试锁定**。
- **D5 Config 默认值/校验差异**：
  - `model`：参考缺省即继承产品设置（`codex/src/index.ts:54`、`claude-code/src/index.ts:61`）；agy 固定默认并始终注入 `--model`（`lib/index.js:51`、`lib/run.js:19,82-83`），**无法继承 CLI 自身默认模型**。属有意为（见 `docs/agy-acp-transport.md:13`）。
  - `env` 默认 `{}`、`permissionMode` 用 union+default、`disposeGraceMs` 默认 3000 且 `assertPositiveFinite + MAX_TIMER_DELAY_MS`：**均已对齐**（`lib/index.js:53-54,70,240-241`）。
  - `Config.volatile()` + `readConfig()`（`lib/index.js:84,87-93,202`）是 agy 独有（支持 settings UI 热读），参考实现为普通 `z.object`（`codex/src/index.ts:52-59`），**不属于缺陷**。
- **D6 可执行体来源与泄漏**：参考用包内 pinned payload，不查 host `PATH`（`codex/src/run.ts:44-53`、`claude-code/src/run.ts:370-375`）；agy 调本机 CLI，必须 `existsSync`（`lib/index.js:118`），但当前错误文本带绝对路径——应并入 D1 的安全事实包裹。
- **D7 绑定多一层 provider**：agy 额外注册 `antigravity-team`（`cordis.patch.yml:10-15`、`lib/index.js:243-246`），参考每插件仅 1 个 provider；三方 `maxDepth` 都是 `provider-managed`（`cordis.patch.yml:9,15`；`codex/cordis.patch.yml:9`；`claude-code/cordis.patch.yml:9`）。
- **D8 重试能力**：参考无重试/fallback；agy 有可选重试（`lib/run.js:279-332`、`lib/acp-client.js:1093-1152`），默认关闭（`lib/run.js:280-282`），与参考的「单次执行」在默认路径上等价。

---

## 4. 针对「agy 作为 subagent 的调用方式」的优化建议（按优先级）

> 目标：在不改变既有设计意图（见第 5 节）前提下，把 agy 的「错误可诊断性 / 失败归类」对齐官方 Codex / Claude Code 插件的成熟做法。

### P0-1 `lib/index.js` 的 `start()` 用结构化 startup failure 包裹

- **做法**：在 `lib/run.js` 导出一个 `antigravityStartupFailure(cause)`，返回 `AntigravityRunFailure({ stage:'initialize', category:'unknown' }, cause)`（与 `codexStartupFailure` 同构，`codex/src/run.ts:124-129`）。把 `lib/index.js:111-118` 的 cwd 校验失败与 `existsSync` 失败统一 `try/catch` 包住：message 只保留固定安全事实，原始错误挂 `cause`；并在 `catch` 里 `this.ctx.logger.warn(...)` 记录（对齐 `claude-code/src/index.ts:93-99`）。
- **理由**：避免把本机绝对路径、未归一化异常直接抛到 start 边界；让上层拿到稳定的 `stage/category`。
- **风险**：低——只改失败路径的错误形态，不影响成功路径；需保证 `request.signal.aborted` 时仍短路为「aborted」语义（现状 `lib/index.js:115` 已处理，保留）。
- **是否需新增测试**：**是**。新增单测：executable 缺失 / cwd 非法 → 断言 `stage==='initialize'`、`category==='unknown'`、`message` 不含绝对路径、`cause` 保留原始错误。

### P0-2 `lib/run.js` 失败诊断补 `exitCode`/`signal`，teardown 失败归为 `stage:'teardown'`

- **做法**：
  1. 在 `AntigravityRunFailure` 的 message 构造里，当 `facts.outcome` 存在时追加 `exit code` / `signal`（对齐 `codex/src/run.ts:96-102`、`claude-code/src/run.ts:87-94`）。`facts` 里已能取到 `outcome`（`lib/run.js:185,233`）。
  2. 把 `disposeProcess`（`lib/run.js:205-213`）包 `try/catch`，失败抛 `AntigravityRunFailure({ stage:'teardown', category:'unknown', outcome }, cause)`；`teardown: disposeProcess`（`lib/run.js:267`）随之稳定。
- **理由**：区分「业务失败」与「进程非零退出/被杀」；清理期失败不再与业务失败混淆，类型稳定。
- **风险**：低——仅扩展诊断字段与 teardown 错误包装；成功与正常清理路径不变。
- **是否需新增测试**：**是**。① 进程非零退出 → 断言诊断含 `exit code: N`；② 模拟 `waitForExit` 拒绝 → 断言 `stage==='teardown'`。

### P0-3 ACP 传输 publish-after-handshake 的回归测试（保持不变量）

- **现状**：已满足——`lib/acp-client.js:996-1027` 在 `initialize` + `session/new` 成功后才于 `1072` 返回 run handle；失败先 catch 回退/抛错。
- **做法**：补一条用例：注入 fake spawn，令 `initialize` 或 `session/new` 拒绝 → 断言「未返回 run handle」且「要么回退到 stream-json、要么抛出 `AcpError`」。
- **理由**：这是参考实现的核心不变量（publish only after handshake），agy ACP 已实现但缺显式守护，防止后续重构提前 publish。
- **风险**：无（只加测试）。
- **是否需新增测试**：**是**（本身即测试项）。

### P1-1 Config 与参考对齐（讨论项，默认不改）

- **做法（可选）**：是否让 `model` 允许缺省以继承 agy 自身设置（参考 `codex/src/index.ts:54`、`claude-code/src/index.ts:61`）；若允许，`antigravityArgv` 在 `model===undefined` 时不带 `--model`（当前 `lib/run.js:71-83` 始终带默认值）。
- **理由**：对齐「省略即继承产品设置」的语义，减少与 CLI 自身配置的强制耦合。
- **风险**：中——会改变默认模型（改用 agy 自身默认），可能偏离本项目「固定 `gemini-3.8-flash`」的定位（`docs/agy-acp-transport.md:13`）。**需产品决策，默认不改**。
- **是否需新增测试**：若采纳则需（断言缺省时不带 `--model`）。

> 说明：`disposeGraceMs` / `env` / `permissionMode` 的校验与默认已对齐（`lib/index.js:53-54,70,240-241`），**无需改动**；`Config.volatile()` 为 agy 特有的热读机制（`lib/index.js:84,87-93,202`），保留。

---

## 5. 保持不变的既有设计意图（原样保留，勿「顺手改回」）

以下来自 `AGENTS.md`「有意为之」一节，本次调研不改变，也不应被优化建议推翻：

1. 默认 `permissionMode` 仍为 `dangerously-skip-permissions`（`AGENTS.md:47`、`lib/run.js:40-45`）。print 模式下工具确认被软拒，`auto` 的子级读不了工作区。
2. `agy` 正常退出（exit 0）必须 resolve，不当失败（`AGENTS.md:48`、`lib/run.js:182-186`）。
3. 答案取值：终态 `result.response` 优先，`text_delta` 兜底；无终态帧 → `stopReason:'error'`（`AGENTS.md:49`、`lib/wire.js:122-128`）。
4. `SCRUBBED_ENV` 置为**空字符串**而非删除（`AGENTS.md:50`、`lib/index.js:96,119-120`）。
5. `NO_START_CAPABILITIES` + `inheritsParentContext=false`，`cordis.patch.yml` 配 `maxDepth: provider-managed`（`AGENTS.md:51`、`lib/index.js:99-100`、`cordis.patch.yml:9,15`）。
6. `Config.permissionMode` 有意只暴露 `auto` / `dangerously-skip-permissions`（`AGENTS.md:52`、`lib/run.js:37`）。
7. **重试默认关闭**：`fallbackModel` / `retryOnRateLimit` 只在显式配置时生效；`usage_error`（CLI exit 2）一律不重试（`AGENTS.md:53`、`lib/run.js:279-282`、`lib/classify.js:30`）。
8. `--print-timeout` 到期返回部分输出 + stderr warning + exit 0，不算失败（`AGENTS.md:54`）。
9. `transport` 默认 `acp`（`lib/index.js:63,218`），`stream-json` 为回退/可选。
10. `agy` 原生 `/agents` / `/teamwork` 不能 headless 复用，并发走底层 `invoke_subagent`（`AGENTS.md:55`、`lib/index.js:39-46`）。

---

## 6. 证据索引（便于核对）

- Codex：`codex/src/index.ts:30-31,36-59,64-65,73-99,124-129,115-124,125-129`；`codex/src/run.ts:36,44-53,56-69,87-104,124-129,135-137,139-155,190-217,225-438`；`codex/src/wire.ts:13,32-43,114-148,268-302,311-375,395-400,574-633,649-684`；`codex/cordis.patch.yml:1-9`；`codex/locale/en.json:1-6`。
- Claude Code：`claude-code/src/index.ts:30-31,38-66,74-75,83-115,93-99,131-140,141-145`；`claude-code/src/run.ts:41,44-56,81-96,131-136,149-165,206-226,270-306,331-369,370-375,385-586`；`claude-code/src/process.ts:30-38,46-61,63-94`；`claude-code/cordis.patch.yml:1-9`；`claude-code/locale/en.json:1-6`。
- agy：`lib/index.js:2-7,48-84,87-93,96,99-100,109-192,111-118,119-120,200-272,240-241,242-246`；`lib/run.js:16-22,37-45,48-55,66-91,98-108,128-269,182-192,205-213,225-268,279-332`；`lib/wire.js:122-128`；`lib/classify.js:29-40`；`lib/acp-client.js:996-1027,1041-1084,1093-1152`；`lib/parallel.js:176-225`；`cordis.patch.yml:1-15`；`locale/en.json:1-6`；`AGENTS.md:45-64`；`docs/agy-acp-transport.md:13,31,39-40`。
