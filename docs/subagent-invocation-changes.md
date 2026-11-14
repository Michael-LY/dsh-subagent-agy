# 子智能体调用链路优化变更说明

> 分支：`feature/subagent-invocation-optimization`
> 目标：参照官方插件 `@deepseek-ai/dsh-subagent-codex` / `@deepseek-ai/dsh-subagent-claude-code` 的 provider 架构，对齐本项目 `dsh-subagent-agy` 的启动失败包装、诊断信息、teardown 分类与 ACP 传输层。

---

## 1. 启动前失败统一包装为结构化 startup failure（(a)）

**文件**：`lib/index.js`（`AntigravityProvider.start()`，约 L109–L125）

**改了什么**：
- `cwd` 校验失败（`assertUsableCwd` 抛错）与 `executable` 不存在（`existsSync` 为 false）这两类「启动前失败」，不再原样抛出内部错误，而是统一包装为 `AntigravityRunFailure({ stage: 'initialize', category: 'unknown' }, cause)`。
- 原始错误挂到 `Error.cause`，错误消息只含固定安全事实（`product: Antigravity; stage: initialize; category: unknown`），不泄露 cwd 路径 / 可执行文件路径等敏感信息。
- 用 `this.ctx.logger.warn(...)` 记录（只记录安全信息：`child start failed: <message>`）。
- 保留既有 `signal.aborted` 语义：abort 时仍抛 `"...request was aborted before CLI startup"`，且不记录 startup failure warn。

**为什么**：对齐 codex 的 `codexStartupFailure` / claude-code 的 `claudeCodeStartupFailure`，让「未发布 run 就失败」的启动错误以固定安全事实暴露给上层，原始细节只留在 cause 链供内部诊断。

**对既有行为的影响**：cwd/executable 失败从「抛裸 Error」变为「抛 `AntigravityRunFailure`（stage=initialize/category=unknown）」。上层若只读 `error.message` 仍可见 `subagent-antigravity: Product subagent failure (...)` 前缀，但不再包含原始路径文本。

**测试覆盖**：`test/index.test.js` 新增 3 例（cwd 失败包装 + cause、executable 失败包装、abort 语义保留）。

---

## 2. 诊断信息补 exit code / signal（(b) 前半）

**文件**：`lib/run.js`（新增 `failureDiagnostic()`，约 L47–L65；`AntigravityRunFailure` 构造函数约 L67–L75）

**改了什么**：
- 抽出纯函数 `failureDiagnostic(facts)`，渲染 `product / stage / category` 三个固定字段，并在 `facts.outcome` 已知时追加 `exit code` 与 `signal`。
- `AntigravityRunFailure` 构造函数改用 `failureDiagnostic` 生成消息，从而所有 `stage: 'process'` / `stage: 'teardown'` 等携带 outcome 的失败都能在消息里带上退出码 / 信号。

**为什么**：对齐 codex 的 `failureDiagnostic`（`exit code` / `signal` 字段），让进程级失败可诊断，而不只停留在 `stage/category`。

**对既有行为的影响**：`AntigravityRunFailure` 的消息文本在携带 `outcome` 时会多出 `exit code: N` / `signal: X` 片段；不携带 outcome 时文本与之前完全一致（纯新增信息，不改变分类/重试逻辑）。

**测试覆盖**：`test/run.test.js` 新增 6 例（`failureDiagnostic` 无 outcome、含 exit code/signal、null/undefined 忽略；`AntigravityRunFailure` 固定事实+cause、teardown 携带 outcome、无 cause）。

---

## 3. teardown/dispose 失败归为可诊断失败（(b) 后半）

**文件**：`lib/run.js`（`disposeProcess`，约 L225–L246）

**改了什么**：
- `disposeProcess` 里先 `child.done.then(...)` 记录 `outcome`（静默，供 teardown 失败时挂载）。
- `child.stdin?.end()` 失败静默（对齐 codex `disposeCodexChild`：并发关闭 stdin 不改变范围归属）。
- `child.terminate()` 后 `await child.waitForExit()` 若抛错，则抛 `AntigravityRunFailure({ stage: 'teardown', category: 'unknown', outcome }, cause)`，而不是静默吞掉。
- `await child.done.catch(() => {})` 保持静默（正常退出不视为失败）。

**为什么**：对齐 codex `disposeCodexChild` 的取舍——只有「退出观测失败」才是 teardown 失败；正常 post-result dispose（终止一个已静默的子进程）必须 resolve，不能变成失败。

**对既有行为的影响**：
- 作为 run handle 的 `teardown`（`subprocessRunHandle({ ..., teardown: disposeProcess })`）现在会传播 teardown 失败（此前 `waitForExit` 抛错会被静默吞掉）。
- abort-before-publication 分支里 `disposeProcess().catch(() => {})` 仍静默（该场景要抛 abort 错误，teardown 失败是次要 cleanup，不覆盖 abort 语义）。

**测试覆盖**：`failureDiagnostic` / `AntigravityRunFailure` 的 teardown facts 用例（`test/run.test.js`）；`disposeProcess` 为内部闭包，通过 `AntigravityRunFailure` 的 teardown 消息构造路径间接覆盖。

---

## 4. 传输层：默认 transport=acp 已实现 publish-after-handshake（(c)）

**文件**：`lib/acp-client.js`（`startAcpRun`，约 L964–L1084）

**结论**：本项目**已做到**「握手成功（`initialize` + `session/new`）后才 publish run」——无需再改，仅做说明。

**现状**：
- `Config.transport` 默认值已是 `'acp'`（`lib/index.js` L63 `z.union(['stream-json', 'acp']).default('acp')`），与 AGENTS.md「transport 默认 acp」一致（注意：`lib/types/index.d.ts` L54 注释仍写着「default 'stream-json'」，是既有文档漂移，见 §7）。
- `startAcpRun` 先 `await client.start()`（`initialize` 握手）→ `await client.newSession()`（`session/new`）都成功、拿到 `sessionId` 后，才创建 `runAbort` / `settleRunResult` 并返回 run handle。`session/prompt` 是在 `settleRunResult.attempt` 内（即 publish 之后、消费 `result` 时）才发出。
- 握手阶段（spawn/initialize/session）失败会进入 `catch`，按 `acpFallbackToStreamJson` 决定是否回退 stream-json；prompt 一旦开始不回退。
- stream-json 路径（`startAntigravityRun`）无 `initialize`/`session/new` 握手，未伪造握手——与设计一致。

**加固（本次未改，说明理由）**：ACP 路径的 `teardown`（`startAcpRun` 里 `teardown: async () => { try { await client.dispose(); } catch {} }`）保持静默。原因是 `AcpClient.dispose()` 内部已是全 try/catch 的幂等实现、从不抛错，`catch {}` 是纯防御；若强行让 ACP teardown 抛 `teardown` 失败，反而破坏 ACP 连接「幂等关闭」的语义。teardown 分类要求已在 stream-json 路径（`lib/run.js`）落实。

**测试覆盖**：`test/acp-client.test.js` 既有用例已覆盖握手顺序（`startAcpRun: 成功返回 completed，addDirs 映射到 session/new...` 断言 `initialize` → `session/new` → `session/set_model` → `session/prompt` 的先后），以及「握手失败且禁用回退时抛 AcpError」。

---

## 5. Config / 校验对齐（(d)）

**文件**：`lib/index.js`（`apply()`，约 L246–L247）

**结论**：**已满足，无需新增**。

- `assertPositiveFinite(PREFIX, 'disposeGraceMs', resolved.disposeGraceMs)` + `MAX_TIMER_DELAY_MS` 上限校验已存在（对齐 codex/claude-code 的 `apply()`）。
- `acpRequestTimeoutMs`（`z.number().min(1000)`）、`acpPromptTimeoutMs`（`z.number().min(0)`）已由 schemastery 做下界约束。
- 本次未改动 Config 字段默认值，未新增导出，故 `lib/types/index.d.ts` 无需同步。

---

## 6. 测试汇总

| 文件 | 新增用例 | 覆盖点 |
|---|---|---|
| `test/run.test.js` | +6 | `failureDiagnostic`（exit code / signal / null 忽略）、`AntigravityRunFailure`（固定事实+cause、teardown outcome、无 cause） |
| `test/index.test.js` | +3（新文件） | startup failure 包装（cwd、executable）、abort 语义保留 |

全量 `node --test`：**109 通过 / 0 失败**（改前 100，新增 9）。

---

## 7. 遗留风险 / 未做项

1. **`lib/types/index.d.ts` 注释漂移**：L54 `transport` 的注释仍写「default 'stream-json'」，而代码默认已是 `'acp'`。这是既有漂移，与本次优化无直接关系，未顺手改（避免扩大范围）。
2. **ACP teardown 静默**：`startAcpRun` 的 `teardown` 保持静默（`AcpClient.dispose()` 幂等不抛错），未改为可诊断失败——见 §4 理由。
3. **`startAcpRunWithRetry` 的 dispose 静默**：外层重试包装的 `teardown`/`requestCancel` 对 `active.dispose()` 用 `.catch(() => {})`，属既有设计（重试场景下内层失败已在 result 里以 `stopReason:'error'` 收敛），未改动。
4. **未做真实 CLI 冒烟**：`agy acp` 的真实握手仍需在本机有登录态时手动验证（AGENTS.md 附录 B 的实测清单）；本次只跑了纯协议冒烟与单测。
