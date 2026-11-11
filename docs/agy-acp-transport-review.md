# ACP transport 实现代码审核（task-3）

- 审核对象：ACP transport 实现（task-2）
- 分支 / 工作树：`agy-acp-transport`
- 基线提交：`70493e2 Merge pull request #3 from Michael-LY/feature/dsh-0.2.2-compat`
- 审核人：`acp-reviewer`
- 依据：`docs/agy-acp-transport-design.md`（接口契约）+ 实际源码 + 实际运行输出
- 写入边界：本文件为本次审核唯一产物，未改动任何被审代码

## 0. 结论速览

**结论（Round 3 复核后）：通过（可合并）。** 首轮 2 个 major、以及后续并入的「`lib/run.js` 既有重试缺陷」均已修复并复核通过；仅剩「权限响应形状待真实冒烟」1 项实证风险与 1 条补测建议（详见 §8 / §9）。

> 说明：§0-§7 为首轮审核记录（保留可追溯）；§8 为 Round 2 复核，§9 为 Round 3 复核（run.js 重试修复 + nit），**以 §9 为准**。

- 默认 `transport=stream-json` 路径零行为变化，原有 68 用例不回归（全量 84 用例全绿）。
- ACP 基础链路（NDJSON 分帧 / JSON-RPC id 关联 / 权限反向请求自动应答 / stopReason 映射 / dispose 清理 / classify 复用）实现正确，纯逻辑可单测。
- **但有 2 个 major 缺陷必须先修/先确认**，且都集中在「非默认开关」路径或「声明了却未实现的能力」上：
  1. **`startAcpRunWithRetry` 对内部 run handle 调用了不存在的 `.teardown()` / `.requestCancel()`**：导致重试永远不生效、且内层 `agy acp` 长驻进程不会被 `dispose()` 回收（只要配置了 `fallbackModel` / `retryOnRateLimit`，即使首轮成功也会漏进程）。
  2. **initialize 声明 `terminal: true` 却没有实现任何 `terminal/*` 服务端请求处理**：若 agent 走客户端终端，会收到 `-32601` 导致工具执行失败。
- 默认路径（stream-json 或未配置 fallback/retry 的 acp）可合并；**在启用 acp 的 `fallbackModel`/`retryOnRateLimit` 之前必须修复缺陷 1**。

## 1. 审核范围与文件状态

| 文件 | 状态 | 说明 |
|---|---|---|
| `lib/acp-client.js` | 新增（约 40KB / 1113 行） | 审核重点 |
| `lib/index.js` | 改（+53 行，纯增量） | 新增 `transport` 分支与 Config 字段 |
| `lib/types/index.d.ts` | 改（+20 行，纯增量） | 手工同步类型 |
| `test/acp-client.test.js` | 新增（16 个用例） | 假 spawn，不依赖真实进程 |
| `lib/run.js` | **未改动**（`git diff --name-only HEAD -- lib/run.js` 为空） | 与设计一致，见 §3 |

**关于 `lib/run.js` 是否该改**：任务书把 run.js 列为"被审文件"，但 `git diff` 显示它未改动。对照设计 §3.4：provider 侧只需在 `lib/index.js#start()` 加一个 `transport==='acp'` 分支即可；`acp-client.js` 通过 `import { startAntigravityRun, stripAnsi, textTask } from './run.js'` 及 `@deepseek-ai/dsh-subagent` 的 `settleRunResult/subprocessRunHandle` 复用现有基础设施，**run.js 本身无需改动**。

**ACP 路径是否真正接进 `provider.start`：是。** `lib/index.js:138-174` 在 `start()` 内构造 `acpSpec` 并 `return startAcpRun(...) / startAcpRunWithRetry(...)`；`startAcpRun` 返回与 `startAntigravityRun` 同形的 `SubagentRun`（`{id, result, dispose}`）。接入完整，非空接。

## 2. 实际运行验证（原文输出）

环境：Node `v26.13.0`。

### 2.1 语法检查

```
$ node --check lib/acp-client.js ; echo exit=$?
acp-client exit=0
$ node --check lib/index.js ; echo exit=$?
index exit=0
$ node --check lib/run.js ; echo exit=$?
run exit=0
```

> `.d.ts` 非 JS，不能 `node --check`；类型同步以人工 diff 核对（见 §6）。

### 2.2 全量单测（默认隔离模式）

```
$ node --test
...
✔ GeminiWorkerClient: 旧进程延迟退出不影响后续 worker (296.462ms)
ℹ tests 84
ℹ suites 0
ℹ pass 84
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5572.3772
```

84 = 原有 68 + 新增 16，**无回归、新增全通过**。

### 2.3 ACP 单测单独运行

```
$ node --test test/acp-client.test.js
✔ AcpFrameParser: 7 字节分片重组，多帧与半帧都能处理 (2.4069ms)
✔ AcpFrameParser: 一个 chunk 多帧 + 半帧续传 (0.3182ms)
✔ AcpFrameParser: 多字节 UTF-8 跨 chunk 边界正确重组 (0.5516ms)
✔ AcpFrameParser: 无结尾换行的尾帧由 end() 补出 (0.2433ms)
✔ AcpFrameParser: 非 JSON 行记 malformed 但不中断后续帧 (0.4401ms)
✔ classifyMessage: 区分 response / request / notification / invalid (0.2239ms)
✔ agentMessageText: 只取 agent_message_chunk 的 text 内容 (0.2148ms)
✔ mapAcpStopReason: ACP 终态映射到共享 stopReason（max_* 视为 error） (0.1615ms)
✔ classifyAcpFailure: 复用 classifyFailure，并补 stage/category (1.0452ms)
✔ permission: 策略选择 + 扁平结果形状（design §1.7） (0.8068ms)
✔ acpArgv: agy acp 加 extraArgs (0.3113ms)
✔ AcpClient: start() 内置握手 + 权限自动允许 + 文本增量收集 (11.6502ms)
✔ AcpClient: permissionPolicy=reject 时回 cancelled (1.8721ms)
✔ AcpClient: 请求超时以 AcpError(stage=timeout) 拒绝 (33.5124ms)
✔ AcpClient: JSON-RPC error 响应以 AcpError 拒绝，保留 code/stage (0.8903ms)
✔ startAcpRun: 握手失败且禁用回退时抛 AcpError (1.3944ms)
ℹ tests 16
ℹ pass 16
ℹ fail 0
```

> 说明：本机默认隔离模式即可运行（`fakeSpawn` 用内存流，不 spawn 真实进程），未触发 spawn EPERM，无需 `--test-isolation=none`。

### 2.4 关键证据：真实 `SubagentRun` 句柄只有 `{id, result, dispose}`

用已安装的 `@deepseek-ai/dsh-subagent@0.2.2-rc.1` 实际构造一个 run handle：

```
$ node --input-type=module -e "import('@deepseek-ai/dsh-subagent').then(m=>{const h=m.subprocessRunHandle({id:'x',result:Promise.resolve(...),signal:ac.signal,onAbort:()=>{},requestCancel:()=>{},teardown:async()=>{}});console.log('keys=',Object.keys(h));console.log('has teardown=',typeof h.teardown,'has requestCancel=',typeof h.requestCancel,'has dispose=',typeof h.dispose);})"
keys= [ 'id', 'result', 'dispose' ]
has teardown= undefined has requestCancel= undefined has dispose= function
```

类型定义亦印证：`SubagentRun` 仅 `id / result / dispose()`（`@deepseek-ai/dsh-subagent/lib/types/types.d.ts:271-287`）。**这是缺陷 1 的直接证据。**

## 3. 七个审核要点逐项结论

### 要点 1：正确性（帧解析 / id 关联 / sessionId / 文本拼接 / stopReason）— 通过（minor 见 §4）

- **NDJSON 分帧（`AcpFrameParser`，`acp-client.js:99-162`）**：按 `\n` 切帧，`#buffer` 处理半帧续传；一个 chunk 多帧循环处理；`end()` 冲刷无结尾换行的尾帧；`StringDecoder('utf8')` 处理跨 chunk 多字节 UTF-8；剥 `\r`；空行 `SKIP`；非 JSON 只记 `malformed` 不中断。单测 5 例覆盖（7 字节分片、多帧+半帧、UTF-8、尾帧、malformed），**结论正确**。
- **JSON-RPC id 关联（`#request`/`#resolveResponse`，`728-815`）**：自增 `#nextId`，`#pending` Map 配对；`classifyMessage` 以「是否带 `method`」区分 server 请求 vs 响应，避免 id 撞号误判；未知 id 响应直接忽略。**正确**。
- **sessionId 生命周期（`newSession`/`#sessions`/`closeSession`，`564-658`）**：`session/new` 校验 `sessionId` 非空；`#sessions` 跟踪；`closeSession` 按 capability、失败忽略。**正确**。
- **文本拼接（`#handleNotification` + `prompt`，`858-876` / `596-629`）**：只累加 `agent_message_chunk` + `content.type==='text'`，按到达顺序 `join('')`；`agent_thought_chunk` 不计入；`content` 仅在 `trim()` 非空时产出一个 text 块，与 `wire.result()`/设计 §3.3 一致。**正确**。
- **stopReason（`mapAcpStopReason`，`203-215`）**：`end_turn→completed`、`cancelled→aborted`、`max_tokens/max_turn_requests/refusal/未知→error`，与设计映射表完全一致。**正确**。

### 要点 2：协议合规（initialize / session/new / session/prompt / 权限响应）— 部分通过（见 major 2、风险 5）

- `initialize` 参数（`531-534`）：`protocolVersion` + `clientCapabilities:{fs:{readTextFile,writeTextFile},terminal}`，结构符合设计 §1.3。
- `session/new`（`564-577`）：`{cwd, mcpServers:[]}`，`sessionId` 校验。符合 §1.4。
- `session/prompt`（`596-629`）：`{sessionId, prompt:[{type:'text',text}]}`，只发 text 块。符合 §1.5。
- `session/update` 未知类型忽略、不报错（`858-876` 只处理 agent_message_chunk）。符合 §1.6。
- **权限反向请求（`#handleServerRequest`/`#dispatchServerRequest`，`817-844`）**：收到即同步应答；未知方法回 `-32601`；`manual` 策略有超时兜底（`#handleManualPermission`，`846-856`）——**不会挂死**，符合 §1.7 的"必须应答"。
- **问题 A（major，见 §4-2）**：`clientCapabilities.terminal` 声明 `true` 却未实现 `terminal/*` 服务端请求。
- **风险 B（minor）**：权限响应默认扁平 `{outcome:'selected',optionId}`（设计 §1.7 如此写），但真实 ACP 常见嵌套 `{outcome:{outcome,optionId}}`。代码已支持 `permissionResponseShape:'nested'` 开关，只是默认 flat，需以真实 `agy acp` 冒烟确认。

### 要点 3：不破坏默认行为 — 通过

- `git diff` 显示 `lib/index.js` 仅 +53 行纯增量；`lib/types/index.d.ts` 仅 +20 行纯增量；`lib/run.js` 未改动。
- `Config` 新增字段均有默认值（`transport:'stream-json'`），`apply()` 的 `resolved` 同步补默认值（`index.js:203-209`）。
- `start()` 中 `this.config.transport === 'acp'` 才走新分支；否则走原来的 `startAntigravityRun(WithRetry)`，`spec` 构造与改动前逐字段一致（diff 无删改）。
- 全量 84 用例全绿，含原有 wire/classify/gemini/worker 等，**证明默认路径零变化**。

### 要点 4：健壮性（超时 / 异常退出 / 僵尸清理 / pending 拒绝 / 重复 dispose）— 通过（minor 见 §4）

- 短请求超时：`#request` 定时器 → `AcpError(stage:'timeout')`（`750-757`），单测覆盖。
- prompt 超时：`acpPromptTimeoutMs>0` 生效（`609-614`），到时 reject 并由 attempt catch `dispose()`。
- 异常退出：`#onExit`（`878-899`）flushes 尾帧、拒绝全部 pending（`stage:'process'`）、非零退出/错误再发 `error`。
- 僵尸进程清理：`dispose()`（`684-711`）先 cancel 活跃会话→`stdin.end()`→`terminate()`→`waitForExit()`→`done`；`#disposed` 幂等。
- **设计关键点已核对**：`agy acp` 是长驻进程，框架侧 `finishDisposal`（`@deepseek-ai/dsh-subagent/lib/index.js:2010,2040`）先 `await run.result` 再 `run.dispose()`，而 `subprocessRunHandle.dispose()` 会调 `requestCancel()+teardown()`→`AcpClient.dispose()` 杀子进程。**因此默认 acp 路径（`startAcpRun`）无进程泄漏。**
- minor：prompt 超时未显式发 `session/cancel`（仅 dispose 杀进程）；重复 `dispose` 幂等 OK。

### 要点 5：错误映射（复用 classify.js）— 通过

- `classifyAcpFailure`（`248-272`）把 `AcpError.data/message` + stderr 拼接后交 `classifyFailure`，补 `stage` / `category`（process/timeout/protocol/product-error），与设计 §5.1 一致。
- 测试用 429/quota/exitCode 2 分别命中 `rate_limited/quota_exhausted/usage_error`，通过。

### 要点 6：测试质量 — 部分通过（覆盖边界好，但有关键盲区）

- **优点**：分帧边界（半帧/多帧/7 字节/UTF-8/尾帧/malformed）、`classifyMessage`、`agentMessageText`、`mapAcpStopReason`、`classifyAcpFailure`、权限策略与形状、`acpArgv`、`AcpClient` 握手+权限自动允许+文本增量、reject 策略、超时、JSON-RPC error、`startAcpRun` 禁回退抛错——共 16 例。
- **不依赖真实进程**：`fakeSpawn` 用 `PassThrough`/`Writable` 内存流，CI 安全（要点 6 明确要求）。✔
- **盲区（重要）**：
  - 无 `startAcpRunWithRetry` 的任何测试 → **正是缺陷 1 未被发现的原因**。
  - `startAcpRun` 成功路径未被真正执行：测试把 `settleRunResult` 桩成 `() => ({})`，`attempt` 回调从不运行（所以 prompt 成功链路、report.classification、diagnostic、dispose 编排都没被测）。
  - 无 `fs/read_text_file`、`fs/write_text_file`、`manual` 权限、abort 取消、`dispose` 幂等、并发 prompt 拒绝的用例。
- 建议补：至少 1 个「首轮 rate_limited/quota → 回退/重试」的 `startAcpRunWithRetry` 用例（会直接暴露缺陷 1），再补 fs handler 与 abort。

### 要点 7：代码风格 / 依赖 / 白名单 — 通过

- Tab 缩进、JSDoc、纯 ESM；`import` 仅 `node:` 内置（`events/string_decoder/fs/promises/crypto/timers/promises`）+ 已有 `@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-subagent`、`./classify.js`、`./run.js`，**无新增第三方依赖**。
- `package.json` 的 `files` 含 `lib/*.js`（`package.json:52`），**新文件 `lib/acp-client.js` 自动被收录**，无需改白名单。✔

## 4. 缺陷清单（按严重级别）

### 缺陷 1（MAJOR —— 必须修）：`startAcpRunWithRetry` 误用内部 run handle 的 `.teardown()` / `.requestCancel()`

- 位置：`lib/acp-client.js:1066-1112`，关键行：
  - `1084`：`await current.teardown().catch(() => {});`
  - `1099-1106`：`requestCancel: () => { try { active.requestCancel?.(); } catch {} }`
  - `1107-1111`：`teardown: async () => { try { await active.teardown(); } catch {} }`
- 问题：`startAcpRun(...)` 返回的是 `subprocessRunHandle(...)`，即 `SubagentRun`，**只有 `{id, result, dispose}`**（运行时实测见 §2.4；类型见 types.d.ts:271-287），**没有 `teardown`、没有 `requestCancel`**。
- 影响：
  1. **重试永不生效**：首轮失败进入重试分支时 `current.teardown()` 对 `undefined` 发起调用，抛同步 `TypeError`，`.catch` 挂不上 → 重试 IIFE reject → `handle.result` reject（违反"result 永不 reject"的 seam 契约）。即 `fallbackModel`/`retryOnRateLimit` 在 ACP 下形同虚设。
  2. **进程泄漏**：外层 `handle.dispose()` 调用 `teardown: async()=>{ await active.teardown() }`，`active.teardown` 为 `undefined` 抛 TypeError 被 `catch{}` 吞掉 → 内层 `AcpClient` 从未 dispose → **长驻 `agy acp` 进程不被回收**。只要配置了 `fallbackModel`/`retryOnRateLimit`（即使首轮成功）就会触发。
  3. **无法取消**：`active.requestCancel?.()` 对 `SubagentRun` 是 no-op，外层取消不会中止内层 run。
- 修复要求：
  - `1084` 改为 `await current.dispose().catch(() => {});`
  - `1107-1111` 改为 `await active.dispose();`（dispose 幂等）
  - `requestCancel` 改为能真正中止内层：把内层 run 的取消入口暴露出来（例如让 `startAcpRun` 在其返回句柄上附带一个内部取消函数，或在 wrapper 里持有其 `AbortController`），至少不要对不存在的 `.requestCancel` 空调用。
  - 补 `startAcpRunWithRetry` 的失败→回退/重试用例。
- 备注（给 lead，非本次写入范围）：**同样的写法在 `lib/run.js#startAntigravityRunWithRetry`（`run.js:288,308,313`）也存在**（同样对 `SubagentRun` 调 `.teardown()/.requestCancel`）。stream-json 子进程会自然退出，故无泄漏；但该重试路径同样会因 `current.teardown()` 抛错而**失效**。run.js 未在本任务改动，建议另行评估修复。

### 缺陷 2（MAJOR —— 强烈建议修/先确认）：声明 `terminal: true` 但未实现任何 `terminal/*` 请求

- 位置：`lib/acp-client.js:965`（`clientCapabilities: { fs: true, terminal: true }`；`AcpClient` 构造默认 `terminal:true` 见 `434-437`）与 `#dispatchServerRequest`（`833-844`，仅实现 `session/request_permission` / `fs/read_text_file` / `fs/write_text_file`，其余 `-32601`）。
- 问题：对客户端能力 `terminal` 声明 `true`，等价于承诺支持 `terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill`、`terminal/release` 等；实际一概回 `-32601`。
- 影响：若 `agy acp` 的 agent 依赖客户端终端执行命令，则工具调用失败、任务半途中止（比"不声明"更糟——不声明时 agent 会用自身进程执行）。
- 修复要求：二选一 ——（a）默认 `clientCapabilities.terminal=false`（最省事、最安全，除非实证 agy 需要）；或（b）实现 `terminal/*` 服务端处理器。请以真实 `agy acp` 冒烟确认后再定。

### 缺陷 3（MINOR）：`addDirs` 在 acp 下被静默丢弃（未接线、未 warn）

- 位置：`lib/index.js:152` 把 `addDirs` 放进 `acpSpec`；但 `lib/acp-client.js:979` 只 `client.newSession({ cwd: spec.cwd })`，未把 `addDirs` 映射到 `session/new` 的 `additionalDirectories`（`newSession` 本身支持该参数，见 `570`）；`index.js:169-171` 只 warn 了 `effort/printTimeout/jsonSchema`，**漏了 `addDirs`**。
- 影响：用户配 `addDirs` + `transport=acp` 时，附加目录不生效且无任何提示（设计 §4/§6.1 明确要求"记 warn 并说明被忽略，不静默丢弃"）。
- 修复：在 `startAcpRun` 里把 `spec.addDirs` 传入 `newSession({ cwd, additionalDirectories })`（视 `sessionCapabilities.additionalDirectories`），或在 index.js 对 `addDirs` 补一条 ignore warn。

### 缺陷 4（MINOR）：`newProject` / `projectName` 在 acp 下静默忽略

- 位置：`acpSpec` 透传了 `newProject/projectName`（`index.js:148-149`），但 `startAcpRun` 未使用、也未 warn。ACP 语义里无 project 概念（用 cwd）。
- 建议：至少 warn 说明被忽略，避免用户误以为 `--new-project/--project` 生效。

### 风险 5（MINOR，需实测）：权限响应形状 / agent_message_chunk 增量语义

- 权限响应默认扁平 `{outcome:'selected',optionId}`（`buildPermissionResult`，`300-324`）；真实 ACP 多用嵌套 `{outcome:{outcome,optionId}}`。已留 `permissionResponseShape` 开关，但默认 flat，需真实冒烟确认。
- `agentMessageText` 按"增量 delta"累加（`prompt` 中 `turn.texts.join('')`）；若 agy 实际发"全量快照"，会重复拼接。设计附录 B-5 未实测确认。建议真实冒烟时打印 update 序列核实。

### 其它 minor / nit

- `readTextFileResult` / `writeTextFileResult`（`337-362`）对相对 `params.path` 解析在宿主进程 cwd 上，而非 run 的 `#cwd`；若 agent 传相对路径会读错文件。建议以 `#cwd` 解析。（无沙箱限制在 `dangerously-skip-permissions` 语义下可接受。）
- `prompt` 超时未显式 `session/cancel`（仅 dispose 杀进程）。
- 多会话并发时 `#turn` 是单值（`398`、`602`），非当前 turn 的 `session/update` 文本会被丢弃/错归属；默认「一 run 一会话」用不到，属未来持久池限制。
- `startAcpRunWithRetry` 的 `result` 未再套 `settleRunResult`，除缺陷 1 外的异常（如退避 `delay` 在 caller abort 时抛）也会让 `handle.result` reject；建议保证该 wrapper 结果永不 reject。
- 尾随 `agent_message_chunk` 若与 `session/prompt` 结果帧跨 chunk 分离，可能因 `#turn` 已清空而丢最后一段（同步同 chunk 场景无碍）。低概率。
- `MAX_FRAME_BYTES` 超限直接清空 buffer（仅防御）；未实现设计 §1.1 提到的 Content-Length/LSP 兼容探测——当前 agy 为 NDJSON，无功能影响，仅作记录。

## 5. 重点核查项结论（任务点 4 汇总）

| 核查项 | 结论 |
|---|---|
| NDJSON 半帧/多帧/分片/UTF-8 | ✅ 正确（`AcpFrameParser`，5 例单测覆盖） |
| JSON-RPC id 关联 | ✅ 正确（`#pending` + `classifyMessage` 按 method 分流） |
| stopReason 映射（end_turn→completed 等） | ✅ 与设计一致 |
| 权限反向请求必须应答 | ✅ 已应答，未知方法回 error，manual 有超时兜底，不挂死；但 `terminal` 能力声明见缺陷 2 |
| 超时与子进程/进程树清理 | ✅ 默认路径正确（框架 `finishDisposal` 后 `run.dispose()`→`AcpClient.dispose()`）；⚠️ retry 路径漏清理（缺陷 1） |
| 默认 transport=stream-json 旧行为零变化 | ✅ diff 纯增量 + 84 用例全绿 |
| 错误分类复用 classify.js | ✅ `classifyAcpFailure`→`classifyFailure` |

## 6. 类型同步核对（`lib/types/index.d.ts`）

- 新增 `AntigravityTransport`、`AcpPermissionPolicy` 两个类型；`Config` 增加 `transport/acpProtocolVersion/acpRequestTimeoutMs/acpPromptTimeoutMs/acpPermissionPolicy/acpFallbackToStreamJson/acpExtraArgs` 七个可选字段；JSDoc 与 `lib/index.js#Config` 一致。**手工同步完整，无遗漏**（`lib/types/index.d.ts:18-22,54-67`）。

## 7. 总体结论与合并建议

- **可合并范围**：默认 `transport=stream-json` 完全安全；`transport=acp` 且**未**配置 `fallbackModel`/`retryOnRateLimit` 的基础路径实现质量良好，可合并。
- **合并前必须处理**：
  1. 修复缺陷 1（`startAcpRunWithRetry`：`.teardown()`→`.dispose()`、`requestCancel` 接线），并补重试用例——否则启用 ACP 的 fallback/retry 会漏进程且不重试。
  2. 处置缺陷 2（`terminal` 能力：默认改 `false` 或实现 `terminal/*`），并以真实 `agy acp` 冒烟确认权限形状/增量语义（风险 5）。
- 建议顺手修：缺陷 3/4（`addDirs`、`newProject/projectName` 的接线或 warn）。
- **最终判定（首轮）：有条件通过。** 默认路径可立即合并；ACP 的 fallback/retry 子能力在修复缺陷 1 前不建议对外宣称可用。

---

## 8. Round 2 复核（修复验证，2026-11-11）

implementer 已按首轮意见修复并重新 complete task-2（rev6）。本节为逐项复核结论（均已对照源码，不只看汇报）。

### 8.1 本轮改动范围

`git diff --stat`（相对基线 `70493e2`）：

```
 lib/index.js         | 62 +++++++++++++++++++++++++++++++++++++++++++++++++---
 lib/run.js           |  7 +++++-
 lib/types/index.d.ts | 22 ++++++++++++++++++-
 3 files changed, 86 insertions(+), 5 deletions(-)
（另：lib/acp-client.js、test/acp-client.test.js 为新增文件；docs/ 为文档）
```

### 8.2 逐项验证

| # | 项目 | 结论 | 证据 |
|---|---|---|---|
| 1 | **MAJOR-1** 重试句柄误用 | ✅ 已解决 | `lib/acp-client.js:1108` 改 `await current.dispose().catch(...)`；`1137-1146` `requestCancel`/`teardown` 均走 `active.dispose()`（注释也说明 SubagentRun 只有 `id/result/dispose`）；`1096-1128` wrapper result 外层 `try/catch`，异常返回 `{output:[], stopReason: aborted\|error}`，**永不 reject**。新增 2 用例（`test/acp-client.test.js:429-490`、`492-537`）：断言 quota→fallback 时 spawn 2 次、第二轮 `session/new.model=fallback-model`；首轮成功只 spawn 1 次且 `handle.dispose()` 后内层 child `terminated=true`。 |
| 2 | **MAJOR-2** `terminal` 能力 | ✅ 已解决 | `lib/acp-client.js:437` 构造默认 `{fs:true, terminal:false}`；`980` `startAcpRun` 显式 `{fs:true, terminal:false}`。用例 `test/acp-client.test.js:422` 断言 `initialize.clientCapabilities.terminal === false`。注：`440` 仍写 `terminal: caps.terminal !== false`，若未来调用方只传 `{fs:true}` 会回落为 `true`，属 nit（建议 `caps.terminal === true`）。 |
| 3 | **新需求：默认模型 flash** | ✅ 通过 | `lib/run.js:19` `DEFAULT_MODEL='gemini-3.8-flash-medium'`；`68` `const model = spec.model ?? DEFAULT_MODEL`；`78` 始终输出 `--model <model>`。`lib/index.js:51` `Config.model.default(DEFAULT_MODEL)`；`194` `resolved.model = config.model ?? DEFAULT_MODEL`。ACP 侧 `lib/acp-client.js:971` `desiredModel`、`997` `session/new` 带 `model`、`1001-1010` `currentModelId!==desiredModel` 时回退 `session/set_model`。 |
| 4 | **minor：addDirs** | ✅ 已接线 | `lib/acp-client.js:996` 把 `spec.addDirs` 映射为 `session/new.additionalDirectories`；`lib/index.js` ACP 分支补 `addDirs` best-effort warn。用例 `test/acp-client.test.js:424` 断言。 |
| 5 | **minor：newProject/projectName warn** | ✅ 已补 | `lib/index.js` ACP 分支新增 `newProject` / `projectName` ignored warn。 |
| 6 | **minor：fs 相对路径按 run cwd** | ✅ 已修 | `lib/acp-client.js:339/343`、`358/362` 接收 `cwd` 并 `resolvePath(cwd, params.path)`；`#dispatchServerRequest`（`851-854`）传 `this.#cwd`。 |
| 7 | **minor：prompt 超时发 session/cancel** | ✅ 已修 | `#request` 超时回调（`lib/acp-client.js:762-768`）先 `options.onAbortCancel?.()` 再 reject；prompt 的 `onAbortCancel` 即 `abortCancel`→`session/cancel`。 |
| 8 | **agent_message_chunk 增量语义** | ✅ 采信实测 | implementer 真实 `agy acp` 冒烟：多 chunk 输出 `"one two three four"` / `" five ..."` / `" twenty-one ..."` 拼接无重复，确认为**增量 delta**；与代码 `turn.texts.join('')` 一致。 |

### 8.3 新需求专项核查（默认模型 flash）

实际运行 `antigravityArgv`（Node v26，stub 掉 Host 包）：

```
DEFAULT_MODEL= gemini-3.8-flash-medium
no model   : agy.exe --print hi --output-format stream-json --model gemini-3.8-flash-medium --dangerously-skip-permissions
explicit   : agy.exe --print hi --output-format stream-json --model my-model --dangerously-skip-permissions
```

- **显式 model 仍优先**：显式传 `my-model` 时输出 `--model my-model`（`spec.model ?? DEFAULT_MODEL` 只在 undefined 时回落）。✅
- **fallbackModel 语义不变**：`startAcpRunWithRetry` 第二轮以 `{...spec, model: spec.fallbackModel}` 启动，用例断言第二轮 `session/new.model=fallback-model`；`buildStreamSpec` 也保留 `fallbackModel`。✅
- **默认 stream-json 仅新增默认 `--model`**：`lib/run.js` 的 diff 只有 `DEFAULT_MODEL` 常量、`const model` 与「始终输出 `--model`」，其余 argv 顺序/内容不变。✅
- **types 同步**：`lib/types/index.d.ts` 的 `model` 注释更新为默认 `gemini-3.8-flash-medium`，ACP 字段齐全。✅
- 行为影响提示：默认模型由「继承 CLI 设置」变为固定 `gemini-3.8-flash-medium`，这是 Lead 追加需求，需在发布说明里写清（用户可用显式 `model` 覆盖）。

### 8.4 复核运行验证（原文输出）

```
$ node --check lib/run.js        -> exit=0
$ node --check lib/index.js      -> exit=0
$ node --check lib/acp-client.js -> exit=0
$ node --check lib/wire.js       -> exit=0
$ node --check lib/classify.js   -> exit=0

$ node --test
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5667.4147

$ node --test test/acp-client.test.js
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

87 = 原有 68 + ACP 19（首轮 16 + 本轮 3：`startAcpRun` 成功路径、retry fallback、retry dispose 回收）。**无回归、新增全通过。**

### 8.5 关于 `lib/run.js#startAntigravityRunWithRetry` 的 `.teardown()/.requestCancel()`（Lead 专门追问）

**结论：确实存在，且是真实缺陷；但不属于本次 ACP 任务的必改范围。**

- 文件:行（当前 HEAD 工作树）：
  - `lib/run.js:293` `await current.teardown().catch(() => {});`
  - `lib/run.js:311-315` `requestCancel: () => { ... active.requestCancel?.(); ... }`
  - `lib/run.js:316-320` `teardown: async () => { ... await active.teardown(); ... }`
- 证据：`current` / `active` 是 `startAntigravityRun(...)` 的返回值，而它返回 `subprocessRunHandle(...)`，即 `SubagentRun`。运行时实测（§2.4）`keys=[id,result,dispose]`，`typeof teardown===undefined`、`typeof requestCancel===undefined`；类型定义见 `@deepseek-ai/dsh-subagent/lib/types/types.d.ts:271-287`（仅 `id/result/dispose`）。
- 后果：stream-json 的 `fallbackModel`/`retryOnRateLimit` 重试在 `293` 行对 `undefined` 发起调用抛同步 `TypeError`，`.catch` 挂不上 → 重试 IIFE reject、重试不生效；`318` 行 `active.teardown()` 抛错被 `catch{}` 吞掉，内层 run 未被显式 dispose（stream-json 子进程会自然退出，故不产生进程泄漏，但 teardown 语义不完整）。
- 是否本次必须修：**首轮判定为「否」**（它是基线 `70493e2` 既有缺陷、非本次回归；本次首轮 diff 对 run.js 只新增 `DEFAULT_MODEL` 与默认 `--model`）。**但 Lead 已裁决并入本分支，implementer 已修复，复核见 §8.8（通过）。**

### 8.6 残余风险（不阻塞合并）

1. **权限响应形状仍未实证**：真实 `agy acp` 在 Say OK / 写文件 / echo 等场景均未触发 `session/request_permission`，`flat`（design §1.7）vs `nested` 无法判定。当前默认 flat，保留 `permissionResponseShape:'nested'` 开关；建议后续拿到可稳定触发权限请求的 prompt/配置再冒烟。
2. ~~**`terminal` 构造回落的 nit**：`lib/acp-client.js:440` 用 `caps.terminal !== false`，若调用方只传 `{fs:true}` 会变成 `true`。~~ **已在 Round 3 修复为 `caps.terminal === true`（见 §8.8）。**
3. **重试退避期间的取消**：wrapper 的 `requestCancel` 走 `active.dispose()`，不 abort `request.signal`，因此处于 `delay` 退避时只能等 `dispose` 的 teardown，`handle.result` 可能稍后 settle；不影响正确性，属边角。

### 8.7 Round 2 最终结论

- **首轮 2 个 MAJOR 均已解决**（有源码与新增用例双重证据）。
- 默认模型 flash 需求已落地，显式 model 优先、fallbackModel 语义不变、默认 stream-json 仅新增 `--model`、类型已同步。
- 87 用例全绿、`node --check` 全通过。
- **判定：通过（可合并）。** 首轮跟进项（`lib/run.js` 既有重试缺陷）已在 Round 3 一并修复并复核通过（§8.8）；残余仅「权限响应形状待真实冒烟」这一项实证风险，以及建议给 `run.js` 重试补一个单测。

---

## 9. Round 3 复核（run.js 重试修复 + terminal nit，2026-11-11）

Lead 裁决后将 §8.5 的 `lib/run.js` 既有重试缺陷并入本分支；implementer 同步处理了 §8.6-2 的 `terminal` nit。本轮只改 `lib/run.js` 与 `lib/acp-client.js`，已逐行复核。

### 9.1 `lib/run.js#startAntigravityRunWithRetry`（已修）

| 行 | 修复后 | 判定 |
|---|---|---|
| `294` | `await current.dispose().catch(() => {});` | ✅ 句柄为 `SubagentRun`，`dispose()` 是唯一取消+teardown 原语 |
| `283-309` | IIFE 外层包 `try { ... } catch { return { output: [], stopReason: request.signal.aborted ? 'aborted' : 'error' }; }` | ✅ `result` 永不 reject，符合 seam 契约 |
| `319` | `requestCancel: () => { try { void active.dispose().catch(() => {}); } catch {} }` | ✅ 走 `dispose()` |
| `324` | `teardown: async () => { try { await active.dispose(); } catch {} }` | ✅ 走 `dispose()`（幂等） |

- diff 核对：除上述重试 wrapper 外，`antigravityArgv` 仅新增默认 `--model`（§8.3），重试条件 `canFallback`/`canRateRetry` 与 argv 其它部分未变。**无额外行为变化。**
- 与 `lib/acp-client.js#startAcpRunWithRetry` 的修复方式一致（都用 `dispose()` + wrapper catch）。

### 9.2 `lib/acp-client.js:440`（nit 已修）

`terminal: caps.terminal !== false` → `terminal: caps.terminal === true`：只传 `{fs:true}` 时不再回落为 `true`。✅

### 9.3 复核运行验证（原文输出）

```
$ node --check lib/run.js        -> exit=0
$ node --check lib/acp-client.js -> exit=0
$ node --check lib/index.js      -> exit=0

$ node --test
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5467.8782
```

### 9.4 Round 3 结论

- `lib/run.js` 既有重试缺陷已修复，stream-json 的 `fallbackModel`/`retryOnRateLimit` 重试不再抛 `TypeError`，且 `result` 永不 reject；内层 run 经 `dispose()` 回收。
- `terminal` nit 已修。
- 87 用例全绿、`node --check` 全通过。
- **判定：通过（可合并）。** 残余仅：① 权限响应 `flat` vs `nested` 仍待真实 `agy acp` 冒烟实证（保留 `nested` 开关）；② `lib/run.js` 的重试修复目前无单测覆盖，建议补一个 `startAntigravityRunWithRetry` 的失败→回退用例（不阻塞）。
