# agy ACP 传输通道（dsh-subagent-agy）

> 本文是 ACP（Agent Client Protocol）传输通道的**最终交付文档**：为什么接、怎么开、内部怎么走、怎么验证、有哪些坑。
> 方案与接口契约见 [agy-acp-transport-design.md](./agy-acp-transport-design.md)；代码审核记录（含 Round 2 复核）见 [agy-acp-transport-review.md](./agy-acp-transport-review.md)。
> 事实基线：本机 `agy 1.5.4`，`agy acp` 握手返回 `agentInfo.name = "Antigravity ACP Server"`、`agentInfo.version = "1.5.5"`。

---

## 0. 结论速览

- `agy 1.5.4` 起自带 `agy acp` 子命令：常驻 **stdio JSON-RPC 2.0** 服务器，**一行一条 JSON（NDJSON）**。实测 `initialize` → `session/new` → `session/prompt` 全部通过，终态返回 `stopReason: "end_turn"` 与答案文本。
- 本插件新增 **`transport` 双轨**：`'stream-json'`（默认，行为零变化）/ `'acp'`（opt-in）。ACP 逻辑全部落在新文件 `lib/acp-client.js`，`lib/index.js` 只加一个分支，两条路径返回**同形 run handle**，上层无感。
- 默认模型改为 `gemini-3.8-flash`（`lib/run.js` 的 `DEFAULT_MODEL`），思考强度默认 `medium`（`DEFAULT_EFFORT`）：stream-json 默认带 `--model gemini-3.8-flash --effort medium`；ACP 会拼成 `gemini-3.8-flash-medium` 再 `session/new` / `session/set_model`；**显式 `model` / `effort` 始终优先**。
- 验证：`node --check` 全通过；`node --test` **87 通过 / 0 失败**（原有 68 + ACP 19）。
- 部署：新增 `lib/acp-client.js` 后必须在 profile 执行 `pnpm install` 并重启 GUI（硬链接只覆盖已有文件，不覆盖新增文件）。
- 审核结论：**通过（可合并）**（review §8.7），残余风险见 §6.1。

---

## 1. 背景与结论

### 1.1 为什么加 ACP

原有通道（`transport: 'stream-json'`）是**一次性进程 + 单向事件流**：

- `agy --print <prompt> --output-format stream-json`，`stdin` 为 `'ignore'`，prompt 只能拼进 argv；
- 没有显式会话概念（靠 `--new-project` / `--project` 区分）；
- 工具确认只能靠 CLI flag 一刀切（`--dangerously-skip-permissions` / `--mode auto`），**没有反向请求**；
- 超时只能依赖原生 `--print-timeout`，结构化输出只能依赖 `--json-schema`。

`agy acp` 是另一种形态：**长驻服务器 + 双向 JSON-RPC**，有 `initialize` 握手、`session/new` 会话、`session/update` 流式通知，以及**必须应答的反向请求** `session/request_permission`。它把「权限交互」从 CLI flag 提升成协议内的一次问答。

### 1.2 实测确认的协议事实

| 项目 | 实测结论 |
|---|---|
| 启动方式 | `agy acp`，长驻进程，`stdin` 必须 `'pipe'`（与 stream-json 的 `'ignore'` 相反） |
| 分帧 | NDJSON：一行一条 JSON；`\r` 会被剥掉；UTF-8 多字节跨 chunk 由 `StringDecoder` 重组 |
| `initialize` | 请求 `protocolVersion: 1` + `clientCapabilities`；返回 `agentInfo`（`Antigravity ACP Server` / `1.5.5`）、`authMethods`、`sessionCapabilities` |
| `session/new` | 入参 `{cwd, mcpServers, model?, additionalDirectories?}`；返回 `sessionId` 与 `models.currentModelId` |
| `session/prompt` | 入参 `{sessionId, prompt:[{type:'text',text}]}`；该请求**本轮结束才返回**，期间持续推 `session/update` |
| `session/update` | 只有 `sessionUpdate === 'agent_message_chunk'` 且 `content.type === 'text'` 计入答案；**是增量 delta**（多 chunk 拼接无重复，已实测） |
| 终态 | `result.stopReason`（`end_turn` 等）+ `usage`（位于 `result` 顶层，代码同时兼容 `result._meta.usage`） |
| 反向请求 | `session/request_permission` 必须同步应答，否则该轮挂死（本次冒烟的 Say OK / 读文件 / echo 场景**未触发**，见 §6.1） |

### 1.3 本插件的接入方式

一句话：**协议全在 `lib/acp-client.js`，选择权在 `lib/index.js`，句柄形状与 `lib/run.js` 完全一致。**

- 新增 `lib/acp-client.js`：`AcpClient`（事件 `session_update` / `agent_text` / `permission_request` / `stderr` / `error`）+ `startAcpRun` / `startAcpRunWithRetry`（与 `lib/run.js` 同形句柄）。
- `lib/index.js`：`Config` 新增 7 个 ACP 字段；`AntigravityProvider.start()` 按 `this.config.transport` 分支，**默认 `stream-json` 的 spec 构造逐字段不变**。
- `lib/run.js` **不承载任何 ACP 逻辑**（只被 `acp-client.js` 复用 `DEFAULT_MODEL` / `startAntigravityRun` / `stripAnsi` / `textTask`）。
- 错误分类复用 `lib/classify.js`：ACP 侧把 JSON-RPC `error.message` / `error.data` / stderr / 非成功 `stopReason` 拼成文本喂 `classifyFailure()`，仍输出 `quota_exhausted` / `rate_limited` / `usage_error` / `unknown`。

---

## 2. 使用方式

### 2.1 开启 ACP（默认不开）

默认 `transport: 'stream-json'`，不配置就是老行为。要启用 ACP，在 profile 的 `cordis.patch.yml` 里给 provider 加一行：

```yaml
- insert:
    - id: subagent-antigravity
      name: 'dsh-subagent-agy'
      config:
        transport: acp
```

改完执行 §5.4 的部署步骤（`pnpm install` + 重启 GUI）。`antigravity-team` 复用同一个 `AntigravityProvider` 类，因此**同一个 `transport` 对它同样生效**，不需要额外配置。

### 2.2 配置字段

| 字段 | 类型 / 校验 | 默认值 | 说明 |
|---|---|---|---|
| `transport` | `stream-json \| acp` | `stream-json` | 传输通道。默认保持旧行为，ACP 为 opt-in。 |
| `acpProtocolVersion` | `number` (`min(1)`) | `1` | `initialize.protocolVersion`。服务器回报不同版本时取服务器值并记 warn，不直接失败。 |
| `acpRequestTimeoutMs` | `number` (`min(1000)`) | `30000` | 短请求超时：`initialize` / `session/new` / `session/set_model`（`session/close` 取 `min(该值, 5000)`）。 |
| `acpPromptTimeoutMs` | `number` (`min(0)`) | `0` | 单轮 `session/prompt` 超时；`0` = 不限，靠上层 abort。 |
| `acpPermissionPolicy` | `auto-approve \| first-allow \| reject \| manual` | `auto-approve` | `session/request_permission` 的应答策略（`permissionMode` 为 `dangerously-skip-permissions` 时被强制成 `auto-approve`，见 §2.5）。 |
| `acpFallbackToStreamJson` | `boolean` | `true` | prompt 开始前握手/建会话失败时，是否自动回退 stream-json（见 §2.6）。 |
| `acpExtraArgs` | `string[]` | `[]` | 追加到 `agy acp` 之后的 argv，例如 `["--foo"]` → `agy acp --foo`。 |

> 注意：`extraArgs`（老字段）只用于**回退到 stream-json 时**的 argv，不参与 ACP 的 argv；ACP 的追加参数请用 `acpExtraArgs`。

### 2.3 模型

- 默认模型是 **`gemini-3.8-flash`**，默认思考强度 **`medium`**（`lib/run.js` 的 `DEFAULT_MODEL` / `DEFAULT_EFFORT`，也是 `Config.model` / `Config.effort` 的默认值）。**显式配置的 `model` / `effort` 永远优先**。
- `stream-json`：argv 里**始终**带 `--model <model>`（未配置时用默认 flash）。
- `acp`：`session/new` 参数里带 `model`；若响应里 `models.currentModelId` 与期望值不一致（或服务器压根没回 `currentModelId`），再补发一次 `session/set_model`。服务器没有模型回读，只能靠日志确认：
  - 走了 `set_model` 时会记 `subagent-antigravity/acp: session/new ignored model "…" (currentModelId=…); applied via session/set_model (server returns no readback)`；
  - `set_model` 失败时记 `failed to apply model "…" via session/set_model: …`。
- `fallbackModel` 在 ACP 下语义不变：第二轮用 `fallbackModel` 重新 `session/new`（显式值覆盖默认 flash）。
- `effort` 在 ACP 下没有原生概念，会**拼接到模型名后缀**（`base-effort`，如 `gemini-3.8-flash-medium`）后再 `session/new` / `session/set_model`。

### 2.4 超时

- 短请求（握手/建会话/设模型）：`acpRequestTimeoutMs`，默认 30s，到期抛 `AcpError{ stage: 'timeout' }`。
- 单轮 prompt：`acpPromptTimeoutMs`，默认 `0`（不设超时）。设为 `>0` 时到期会**先发 `session/cancel` 通知再拒绝**，该轮按 `stopReason: 'error'` 处理，且**不自动重试**（与 `--print-timeout` 的「截断不等于成功」保持一致）。
- `printTimeout`（`--print-timeout`）在 ACP 下**不生效**，会记 warn 并提示改用 `acpPromptTimeoutMs`。

### 2.5 权限策略

`session/request_permission` 是 ACP 与 stream-json 最大的行为差异：**agent 会主动发请求，客户端必须回一个结果**，否则该轮挂住。

**策略如何决定**（`lib/index.js`）：

| `permissionMode` | 实际传给 ACP 的策略 |
|---|---|
| `dangerously-skip-permissions`（默认） | 强制 `auto-approve`，等价于原来的「跳过权限」 |
| `auto` | 取 `acpPermissionPolicy`（`Config` 默认 `auto-approve`；建议显式设成 `first-allow` 或 `reject`，与「`auto` 不保证能读工作区」的语义一致） |

**各策略的应答行为**：

| 策略 | 应答 |
|---|---|
| `auto-approve` | 选 `options` 里第一个 `kind` 以 `allow` 开头的选项；没有 allow 类则退回 `options[0]`。 |
| `first-allow` | 只选 `kind` 以 `allow` 开头的选项；找不到 allow 类就回 `cancelled`（放行类请求放行，其余取消）。 |
| `reject` | 一律回 `{ "outcome": "cancelled" }`。 |
| `manual` | 不自动应答，抛 `permission_request` 事件交给外部；超过 `acpRequestTimeoutMs` 自动回 `cancelled`，**保证不挂死**。 |

- `options` 为空时一律回 `{ "outcome": "cancelled" }`，绝不静默卡住。
- 默认响应形状是**扁平** `{ "outcome": "selected", "optionId": "…" }`（design §1.7）。代码内部保留 `permissionResponseShape: 'nested'` 开关，但**未暴露到 `Config`**，见 §6.1 风险 1。

### 2.6 回退到 stream-json

`acpFallbackToStreamJson`（默认 `true`）只在 **prompt 开始之前**生效，且只回退一次：

| 场景 | 是否回退 | 原因 |
|---|---|---|
| `agy acp` 启动失败 / 子命令不存在 | ❌ 不回退 | `failure.stage === 'spawn'`，直接抛 `AcpError`。 |
| `initialize` / `session/new` / `session/set_model` 报错或超时 | ✅ 回退 | prompt 尚未发出，回退不会重复消耗配额。 |
| 错误文本命中鉴权类关键字（`auth` / `login` / `sign in` / `credential` / `unauthor`） | ❌ 不回退 | stream-json 同样需要登录，回退没有意义。 |
| prompt 已经开始（无论成功或失败） | ❌ 不回退 | 避免重复执行与重复扣配额，错误直接上抛。 |

回退时日志形如：`ACP unavailable (initialize: …); falling back to stream-json`（括号内是失败阶段与错误文本），并用 stream-json 的 spec（含 `printTimeout` / `jsonSchema` / `addDirs` / `extraArgs` 等）重新发起。

---

## 3. 架构

### 3.1 文件职责

| 文件 | 角色 | 本次变化 |
|---|---|---|
| `lib/acp-client.js` | ACP 通道全部实现：spawn `agy acp`、NDJSON 分帧、JSON-RPC id 关联、`initialize`/`session/new`/`session/prompt`、`session/update` 收集、权限反向请求应答、超时、进程清理、失败分类 | **新增** |
| `lib/index.js` | cordis 插件入口：`Config` 字段、`AntigravityProvider.start()` 的 `transport` 分支、ACP 下被忽略字段的 warn | 改（纯增量） |
| `lib/run.js` | stream-json 一次性进程生命周期 + 可选重试；导出 `DEFAULT_MODEL` | 改（默认模型 + 重试缺陷修复） |
| `lib/wire.js` | stream-json 的 NDJSON envelope 解析 | 未改 |
| `lib/classify.js` | 纯函数失败分类（ACP 复用） | 未改 |
| `lib/types/index.d.ts` | 手写 TS 类型 | 改（同步 7 个 ACP 字段 + 2 个类型） |
| `test/acp-client.test.js` | ACP 单测（假 spawn，不真起进程） | **新增** |

### 3.2 数据流

```
apply()  (lib/index.js)
  └─ 注册 provider：antigravity / antigravity-team（同一类，共用 transport 配置）
        │
provider.start(request)                      ← transport 分支点（lib/index.js）
  ├─ transport === 'stream-json'（默认）
  │    └─ startAntigravityRun[WithRetry]()   (lib/run.js)
  │         └─ spawn agy --print … --output-format stream-json
  │              └─ AntigravityStream (lib/wire.js) → settleRunResult → { output, stopReason }
  │
  └─ transport === 'acp'
       └─ startAcpRun[WithRetry]()           (lib/acp-client.js)
            ├─ AcpClient.start()  → spawn agy acp → initialize
            ├─ newSession()       → session/new { cwd, mcpServers, model, additionalDirectories? }
            ├─ setModel()         → session/set_model（仅当 currentModelId 与期望不一致）
            └─ prompt()           → session/prompt + session/update 流
                 ├─ session/request_permission ← 必须应答（auto-approve / first-allow / reject / manual）
                 └─ 终态 stopReason → mapAcpStopReason → completed / aborted / error
                      └─ 失败 → classifyAcpFailure → classifyFailure（lib/classify.js）
```

两条路径最终都产出 `settleRunResult` 的 `{ output, stopReason }`，并通过 `subprocessRunHandle` 返回**只含 `{ id, result, dispose }`** 的句柄（这是 `@deepseek-ai/dsh-subagent` 的 `SubagentRun` 契约）。

### 3.3 一次 ACP run 的时序（真实报文形状）

```text
客户端                                          agy acp
  │  ── initialize {protocolVersion:1,            │
  │       clientCapabilities:{fs:{…},terminal:false}} ──▶
  │  ◀── result {agentInfo:{name:"Antigravity ACP Server",version:"1.5.5"},
  │              authMethods:[], sessionCapabilities:{…}}
  │  ── session/new {cwd, mcpServers:[], model:"gemini-3.8-flash-medium"} ──▶
  │  ◀── result {sessionId:"sess_…", models:{currentModelId:"…"}}
  │  ── session/set_model {sessionId, modelId}    （仅当上一步模型不一致）──▶
  │  ── session/prompt {sessionId, prompt:[{type:"text",text:"…"}]} ──▶
  │  ◀── notification session/update {update:{sessionUpdate:"agent_message_chunk",
  │              content:{type:"text",text:"OK"}}}   （多次，增量 delta，按序拼接）
  │  ◀── request  session/request_permission {toolCall, options:[…]}   （可能没有）
  │  ── result  {outcome:"selected", optionId:"allow-1"} ──▶          （必须立刻回）
  │  ◀── result session/prompt {stopReason:"end_turn",
  │              usage:{inputTokens,outputTokens,totalTokens,…}}
  │  ── dispose：session/cancel → session/close(尽力) → stdin.end → terminate → waitForExit
```

### 3.4 关键实现点

- **分帧**（`AcpFrameParser`）：按 `\n` 切行、剥 `\r`、空行跳过、非 JSON 行只记 `malformed` 不中断后续帧、`end()` 补出无结尾换行的尾帧；`MAX_FRAME_BYTES = 32MB` 超限清空缓冲（纯防御）。
- **id 关联**：`#pending` Map + 自增 id；`classifyMessage()` 按「是否带 `method`」区分服务端请求 / 响应 / 通知，避免 id 撞号；未知 id 的响应直接忽略。
- **答案装配**：只累加 `agent_message_chunk` 且 `content.type === 'text'` 的 `content.text`，按到达顺序 `join('')`；`agent_thought_chunk`（思考）不计入答案；最终 `output` 仅在 `text.trim()` 非空时产出一个 text 块（与 `wire.result()` 一致）。
- **stopReason 映射**：`end_turn → completed`、`cancelled → aborted`、`max_tokens` / `max_turn_requests` / `refusal` / 未知 / 缺失 → `error`（截断不当作成功）。
- **客户端侧服务端请求**：实现 `session/request_permission`、`fs/read_text_file`、`fs/write_text_file`（相对路径按 run 的 cwd 解析）；其余方法回 `-32601`。`clientCapabilities.terminal` 显式声明为 `false`，因此**不实现** `terminal/*`。
- **进程清理**（`dispose()`，幂等）：对活跃会话发 `session/cancel` → 尽力 `session/close`（不阻塞）→ `stdin.end()` → `terminate()` → `waitForExit()` → `done`。ACP 下**不能把「子进程 exit 0」当成功**，子进程退出即连接断裂，未完成的请求一律以 `AcpError{ stage: 'process' }` 拒绝。
- **并发**：一次 run = 一个 `agy acp` 进程 + 一个会话，结束即 `dispose()`；不做跨 run 会话复用（`sessionCapabilities` 里的 `load/resume/close/list` 暂不使用）。同一 `sessionId` 上并发 `prompt()` 会被直接拒绝（`AcpError{ stage: 'prompt' }`）。
- **重试**：`startAcpRunWithRetry` 仅在显式配置 `fallbackModel` / `retryOnRateLimit` 时生效，最多一次：`quota_exhausted` / `rate_limited` → 换 `fallbackModel` 重跑；`rate_limited` → 退避 `min(retryAfterMs ?? 2000, 15000)` 后重跑。包装层的 `result` **永不 reject**（异常一律收敛成 `{ output: [], stopReason: 'aborted' | 'error' }`），句柄的 `requestCancel` / `teardown` 统一走内层 `dispose()`。

---

## 4. 与 stream-json 的差异对照与适用场景

| 维度 | `stream-json`（默认） | `acp` |
|---|---|---|
| 子命令 / 生命周期 | `agy --print … --output-format stream-json`，一次性，exit 0 即结束 | `agy acp`，**长驻服务器**，必须显式 `dispose()` 终止 |
| stdin | `'ignore'` | **`'pipe'`（双向发包）** |
| 协议 | 单向 NDJSON「envelope 事件」 | JSON-RPC 2.0（请求 / 响应 / 通知三态 + 反向请求） |
| 握手 | 无 | `initialize`（协议版本 + 客户端能力） |
| 会话 | 无显式会话（靠 `--new-project` / `--project`） | `session/new` 返回 `sessionId` |
| 提示注入 | 拼进 argv `--print <prompt>` | `session/prompt` 的 content blocks（只发 text 块） |
| 流式增量 | `step_update.step_update{step_type:'agent_response',text_delta}` | `session/update` → `agent_message_chunk` |
| 答案选择 | 终态 `result.response` 优先，`text_delta` 兜底 | 只有 `agent_message_chunk` 增量累加（没有「终态 response」） |
| 终态 | `{event:'result', result:{status:'SUCCESS'|…, response}}` | `{result:{stopReason:'end_turn'|…, usage}}` |
| 工具确认 | CLI flag，一刀切，无反向请求 | `session/request_permission` **反向请求，必须应答** |
| 超时 | 原生 `--print-timeout` | 无原生超时，靠 `acpRequestTimeoutMs` / `acpPromptTimeoutMs` + abort |
| 结构化输出 | `--json-schema` 约束最终 result | **无对应机制**（`jsonSchema` 忽略 + warn） |
| 附加目录 | 重复 `--add-dir` | `session/new.additionalDirectories`（字段名 best-effort） |
| 模型 / effort | `--model` / `--effort` | `session/new.model` + `session/set_model`；**无 effort 概念** |
| 退出码语义 | exit 0 = 正常（终态帧与退出竞争） | 服务器不应主动退出；非零退出才是异常 |

**适用场景**

- 继续用 **`stream-json`**：日常一次性委派、需要 `--json-schema` 结构化输出、需要 `--print-timeout` 截断保护、追求最小变更面。
- 选 **`acp`**：需要协议内的会话语义（未来做会话复用 / 多轮）、需要权限反向请求的细粒度控制、或希望摆脱 argv 长度限制的长 prompt（prompt 走 stdin，不占命令行）。
- 无论选哪个，`permissionMode` 的结论不变：**需要读写工作区的委派保持默认 `dangerously-skip-permissions`**（ACP 侧对应 `auto-approve`）。

---

## 5. 验证方法

### 5.1 语法与单测

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js; node --check lib/worker-client.js; node --check lib/parallel.js; node --check lib/acp-client.js

node --test
# 当前结果：87 通过 / 0 失败（原有 68 + ACP 19）
# DSH 受限 shell 内若报 spawn EPERM，改用：
node --test --test-isolation=none

# 只跑 ACP：19 通过 / 0 失败
node --test test/acp-client.test.js
```

ACP 单测用 `registerHooks` 把 `@deepseek-ai/dsh-brand` / `@deepseek-ai/dsh-subagent` 替换成 `data:` URL 桩，`fakeSpawn` 用内存 `PassThrough` / `Writable` 模拟子进程，**全程不 spawn 真实进程**，因此在纯 checkout 与 CI 里都能跑。

### 5.2 ACP 协议冒烟（不依赖插件，纯协议）

把下面整段粘进 PowerShell 直接跑：脚本写到 `$env:TEMP`，跑完删除，不污染仓库。

```powershell
$smoke = Join-Path $env:TEMP 'acp-smoke.mjs'
@'
import { spawn } from 'node:child_process';

const exe = `${process.env.USERPROFILE}\\.gemini\\bin\\agy.exe`;
const child = spawn(exe, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const request = (id, method, params) => new Promise((resolve, reject) => {
	pending.set(id, { resolve, reject });
	send({ jsonrpc: '2.0', id, method, params });
});

child.stdout.on('data', (chunk) => {
	buf += chunk.toString('utf8');
	let index;
	while ((index = buf.indexOf('\n')) !== -1) {
		const line = buf.slice(0, index);
		buf = buf.slice(index + 1);
		if (line.trim().length === 0) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		if (message.id !== undefined && pending.has(message.id)) {
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
			else waiter.resolve(message.result);
		} else if (message.method === 'session/update') {
			const update = message.params?.update;
			if (update?.sessionUpdate === 'agent_message_chunk') process.stdout.write(update.content?.text ?? '');
		} else if (message.method === 'session/request_permission') {
			const optionId = message.params?.options?.[0]?.optionId;
			send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'selected', optionId } });
		}
	}
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const info = await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
console.log('\n[initialize]', JSON.stringify(info));
const session = await request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
console.log('[session/new]', JSON.stringify(session));
const result = await request(3, 'session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Say OK' }] });
console.log('\n[prompt result]', JSON.stringify(result));

child.stdin.end();
child.kill();
'@ | Set-Content -Path $smoke -Encoding utf8NoBOM
node $smoke
Remove-Item $smoke
```

**期望输出**：`[initialize]` 里含 `"name":"Antigravity ACP Server"` 与 `"version":"1.5.5"`；`[session/new]` 含 `"sessionId"`；先打印 `OK`（来自 `session/update` 的增量），再打印 `[prompt result]` 且含 `"stopReason":"end_turn"`。

### 5.3 集成冒烟（插件内）

```powershell
# 1) stream-json 路径回归（默认通道，应与改动前一致，只是默认多带 --model）
& "$env:USERPROFILE\.gemini\bin\agy.exe" --print "Say OK" --output-format stream-json --project dsh-subagent-agy --model gemini-3.8-flash --effort medium

# 2) ACP 路径：profile 里临时设 transport: acp → 部署 → 重启 GUI → 发一次任意 agy 委派
#    正常时能看到答案；走了 set_model 会看到：
#      subagent-antigravity/acp: session/new ignored model "…"; applied via session/set_model …
#    握手失败回退时会看到：
#      ACP unavailable (initialize: …); falling back to stream-json
```

### 5.4 profile 重新部署

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
# 然后重启 DSH GUI
```

> 必须做这一步：profile 里的 `node_modules/dsh-subagent-agy/*` 是**硬链接**，原地改内容会同步，但**新增文件不会**——本次新增了 `lib/acp-client.js`，不 `pnpm install` 的话 profile 里没有这个文件，插件会在 import 阶段失败。另外编辑器「整体替换文件」（原子写）会断开硬链接，也要靠重新 install 恢复。DSH 沙箱可能拦住 pnpm 写全局 store，请在真实独立终端执行。

---

## 6. 风险、回退与已知限制

### 6.1 残余风险（来自 review §8.6，均不阻塞合并）

1. **权限响应形状（flat vs nested）未实证**：真实 `agy acp` 在 Say OK / 写文件 / echo 等场景都没有触发 `session/request_permission`，因此无法判定服务器要扁平 `{outcome:'selected',optionId}` 还是嵌套 `{outcome:{outcome,optionId}}`。当前默认**扁平**（与 design §1.7 一致），代码内部保留 `permissionResponseShape: 'nested'` 开关（未暴露到 `Config`）。后续拿到能稳定触发权限请求的 prompt/配置后需要再冒烟一次。
2. **重试退避期间的取消**：`startAcpRunWithRetry` 的 `requestCancel` 走内层 `active.dispose()`，不会 abort `request.signal`，所以正处于退避 `delay` 时只能等 dispose 收尾，`handle.result` 可能稍后 settle。不影响正确性，属边角。
3. **分帧只实现 NDJSON**：没有实现 design §1.1 提到的 Content-Length / LSP 头兼容探测。当前 `agy` 实测就是 NDJSON，无功能影响，仅作记录；若未来版本改成 LSP 风格，需要补分帧器主路径。

### 6.2 已知限制（ACP 下的能力不对等）

下表前五项在 ACP 下会记 warn，不会静默假装生效：

| 配置 | ACP 下的实际行为 |
|---|---|
| `effort` | **映射**：拼成模型名后缀（`base-effort`），如 `gemini-3.8-flash-medium`（ACP 无独立 effort 参数）。 |
| `printTimeout` | **忽略**，warn 并提示改用 `acpPromptTimeoutMs`。 |
| `jsonSchema` | **忽略**，warn（ACP 只有自由文本 content blocks，没有结构化输出约束）。 |
| `addDirs` | 映射到 `session/new.additionalDirectories`（字段名 best-effort），warn 说明映射关系。 |
| `newProject` / `projectName` | **忽略**，各自 warn（ACP 用 `cwd` 定位工作区，没有 project 概念）。 |
| `extraArgs` | 仅用于回退 stream-json 时；ACP 追加参数请用 `acpExtraArgs`。 |

其它限制：

- **权限交互**：headless 下必须自动应答。默认 `dangerously-skip-permissions` → `auto-approve`；若改成 `permissionMode: 'auto'`，请同时显式设 `acpPermissionPolicy`，否则默认仍是 `auto-approve`（不是 `first-allow`）。
- **ACP 版本漂移**：CLI 是 `1.5.4`、agentInfo 报 `1.5.5`，协议仍在演进（`usage` 位置、`stopReason` 取值集合、`set_model` 是否存在都可能变）。实现是「宽松解析、未知忽略」：关键字段缺失只降级不崩（`usage` 同时探测 `result.usage` 与 `result._meta.usage`；`stopReason` 未知值按 `error` 处理并保留原值进诊断）。
- **Windows 管道**：`agy acp` 依赖 `stdin` 可写管道；宿主进程异常退出时不会自动回收，只能靠 `dispose()`（框架 `finishDisposal` 会 `await run.result` 后再 `run.dispose()`）。ACP 子进程**不会自然退出**，这是与 stream-json 最本质的运维差异。
- **多会话并发**：`AcpClient` 内部只有单个「当前 turn」槽位，多会话并发时非当前 turn 的文本会被丢弃。默认「一 run 一进程一会话」用不到，属未来持久连接池的限制。
- **不做会话复用**：`sessionCapabilities` 里有 `load` / `resume` / `close` / `list`，但本插件仍是一次性委派语义（`NO_START_CAPABILITIES`、无 follow-up），复用会引入生命周期复杂度，本期不做。

### 6.3 回退决策表

| 现象 | 处理 |
|---|---|
| `agy acp` 不存在 / 起不来 | 抛 `AcpError{stage:'spawn'}`，**不自动回退**；把 `transport` 改回 `stream-json` 即可。 |
| 握手/建会话失败或超时 | 默认自动回退 stream-json 一次（`acpFallbackToStreamJson: true`）；要严格 fail-fast 就设为 `false`。 |
| 未登录 | 抛鉴权类错误，**不回退**（stream-json 同样要登录）。 |
| prompt 中途失败 | 不回退，按 `stopReason: 'error'` 上抛，诊断带 `[kind]`。 |
| 想彻底关掉 ACP | 删掉 `transport: acp`（或显式写 `transport: stream-json`），重新部署并重启 GUI。 |

---

## 7. 变更清单与审核结论

### 7.1 变更清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `lib/acp-client.js` | **新增** | ACP 全链路：`AcpError`、`AcpFrameParser`、`classifyMessage` / `agentMessageText` / `mapAcpStopReason` / `classifyAcpFailure` / `selectPermissionOption` / `buildPermissionResult` / `acpArgv`、`AcpClient`、`startAcpRun`、`startAcpRunWithRetry`。 |
| `test/acp-client.test.js` | **新增** | 19 个用例：分帧边界（7 字节分片 / 多帧半帧 / UTF-8 / 尾帧 / malformed）、`classifyMessage`、答案抽取、stopReason 映射、失败分类、权限策略与形状、argv、握手 + 自动放行 + 增量收集、reject 策略、请求超时、JSON-RPC error、禁用回退时抛错、成功路径、fallback 重试、retry 句柄 dispose 回收。 |
| `docs/agy-acp-transport-design.md` | **新增** | 方案设计（协议流程、transport 抽象、接口契约、错误映射、风险与验证计划）。 |
| `docs/agy-acp-transport-review.md` | **新增** | 代码审核记录（首轮缺陷清单 + Round 2 复核，§0 / §8 为准）。 |
| `docs/agy-acp-transport.md` | **新增** | 本文（最终交付文档）。 |
| `lib/index.js` | 修改 | `Config` 新增 `transport` / `acpProtocolVersion` / `acpRequestTimeoutMs` / `acpPromptTimeoutMs` / `acpPermissionPolicy` / `acpFallbackToStreamJson` / `acpExtraArgs`；`apply()` 的 `resolved` 补默认值；`start()` 增加 `transport === 'acp'` 分支与 ACP 忽略字段的 warn。默认 `stream-json` 的 spec 构造逐字段不变。 |
| `lib/run.js` | 修改 | 新增并导出 `DEFAULT_MODEL = 'gemini-3.8-flash'` 与 `DEFAULT_EFFORT = 'medium'`；`antigravityArgv()` 始终输出 `--model` 与 `--effort`（显式值优先）；顺带修复 `startAntigravityRunWithRetry` 的**预存缺陷**：不再调用 `SubagentRun` 上不存在的 `.teardown()` / `.requestCancel()`，改用 `dispose()`，并保证包装层 `result` 永不 reject。 |
| `lib/types/index.d.ts` | 修改 | 手工同步 `AntigravityTransport` / `AcpPermissionPolicy` 两个类型与 7 个 `Config` 字段（含 `model` 默认值注释）。 |
| `README.md` | 修改 | 新增「传输方式（transport）」说明并链接本文；同步默认模型、测试用例数与文件清单。 |
| `package.json` | **未改** | `files` 已含 `lib/*.js`，新文件 `lib/acp-client.js` 自动被收录，无需改白名单；未新增任何第三方依赖。 |

### 7.2 审核结论摘要

审核人 `acp-reviewer` 的最终判定：**通过（可合并）**（review §8.7）。要点：

- 首轮 2 个 MAJOR 已修复并有源码 + 新增用例双重证据：
  1. `startAcpRunWithRetry` 误用 `SubagentRun` 上不存在的 `.teardown()` / `.requestCancel()` → 已改为 `dispose()`，包装层 `result` 永不 reject，并补了「quota → fallbackModel 重试」与「首轮成功 dispose 回收内层进程」两个用例；
  2. `initialize` 声明 `terminal: true` 却未实现 `terminal/*` → 已改为 `terminal: false`（构造默认与 `startAcpRun` 显式声明两处），用例断言 `clientCapabilities.terminal === false`。
- 默认 `transport=stream-json` 路径零行为变化：`lib/index.js` 为纯增量 diff，全量用例（含原有 wire / classify / gemini / worker / parallel）无回归。
- 协议合规（NDJSON 分帧、JSON-RPC id 关联、`session/new` / `session/prompt` 形状、权限反向请求必答、stopReason 映射、dispose 清理、`classifyFailure` 复用）逐项通过。
- 代码风格合规：Tab 缩进、JSDoc、纯 ESM、只用 `node:` 内置模块 + 既有 Host 包，无新增第三方依赖。
- 复核运行结果：`node --check` 全通过；`node --test` **87 通过 / 0 失败**；ACP 单独 **19 通过 / 0 失败**。

**遗留 / 跟进项**

1. 权限响应 flat vs nested 未实证（§6.1 风险 1）——需要能稳定触发权限请求的场景再冒烟。
2. 重试退避期间的取消只走 `dispose()`，不 abort `request.signal`（§6.1 风险 2）。
3. 未实现 Content-Length / LSP 分帧兼容（§6.1 风险 3，当前无功能影响）。
4. `lib/run.js` 既有重试缺陷是基线 `70493e2` 就存在的问题（非本次引入），本分支已顺带修复；若后续改动该重试逻辑，请保留 `startAntigravityRunWithRetry` 的用例覆盖。

### 7.3 本次验证记录

```text
$ node --check lib/index.js; node --check lib/run.js; node --check lib/acp-client.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js; node --check lib/worker-client.js; node --check lib/parallel.js
→ 全部 exit=0

$ node --test
ℹ tests 87
ℹ pass 87
ℹ fail 0

$ node --test test/acp-client.test.js
ℹ tests 19
ℹ pass 19
ℹ fail 0
```
