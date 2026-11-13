# agy ACP 接入方案设计（dsh-subagent-agy）

> 目标读者：`lib/acp-client.js` 的 implementer、`lib/index.js` 的改造者、以及验收人。
> 边界：本文只是设计，不改 `lib/` 代码。实现按本文接口落 `lib/`。
> 依据：本机 `agy 1.5.4` 实测（Lead 已跑通 initialize / session/new / session/prompt，得到文本 `OK`），以及仓库现有 `lib/run.js` / `lib/wire.js` / `lib/classify.js` / `lib/index.js` 真实源码。
> 参考架构事实：`AGENTS.md`、`docs/headless-scripting-plan.md`。

---

## 0. 结论速览

- **transport 双轨制**：新增 `Config.transport: 'stream-json' | 'acp'`，**默认 `'stream-json'`，完全保持现有行为**；`'acp'` 为 opt-in。
- **新增单文件 `lib/acp-client.js`**（放 `lib/` 顶层，`package.json` 的 `files: ["lib/*.js"]` 已覆盖，无需改白名单）。它只负责「`agy acp` 子进程 + JSON-RPC 连接 + session + prompt + 事件」，不负责 DSH provider 注册。
- **provider 侧只加一个分支**：`lib/index.js#AntigravityProvider.start()` 按 `this.config.transport` 选择 `startAcpRun(...)` 或现有 `startAntigravityRun(...)`；两条路径返回**同一种 run handle 形状**，上层无感。
- **错误分类复用 `lib/classify.js`**：ACP 侧把 JSON-RPC error 文本 / stderr / 非成功 `stopReason` 拼成文本再喂 `classifyFailure(text, outcome)`，仍输出 `quota_exhausted | rate_limited | usage_error | unknown`；超时与协议错误归入 `unknown` 但带独立 `stage`。
- **默认会话隔离**：一次 run = 一个 `agy acp` 子进程 + 一个 `session/new`，结束即 `dispose()` 杀掉子进程；不默认做跨 run 会话复用（现有 `NO_START_CAPABILITIES` / 无 follow-up 的语义不变）。
- **必须实测确认的点集中在附录 B**（帧格式、设模型方式、usage 位置、ACP 是否接受 CLI flag），这些不影响本文接口形状，只影响实现内部细节。

---

## 1. ACP 协议流程与消息样例

### 1.1 传输与帧格式（实现的第一假设）

- 传输：`agy acp` 子进程的 **stdin + stdout**，双向。与 stream-json 的关键区别：stream-json 里 `stdin: 'ignore'`，ACP **必须 `stdin: 'pipe'`**。
- 协议：**JSON-RPC 2.0**。请求含 `id`+`method`+`params`，响应含 `id`+`result`|`error`，通知只有 `method`+`params`（无 `id`）。
- 分帧：按社区 ACP 实现惯例与本次实测，**最可能是「一行一条 JSON（NDJSON）」**。`AcpConnection` 的分帧器必须先按 `\n` 切行 `JSON.parse`；**同时做兼容探测**：若某行以 `Content-Length:` 开头，则切换到 LSP 头模式（读完头再按字节数读 body）。两种模式在分帧器内部统一，向上只吐「已解析对象」。见附录 B-1 待实测项。
- stderr：继续 `pipe` 并沿用 `stripAnsi` 写日志，不参与协议。

### 1.2 启动

```jsonc
// argv（注意：`agy acp` 是常驻服务器，不是一次性 print）
["C:\\Users\\<user>\\.gemini\\bin\\agy.exe", "acp"]
// 若实测确认 acp 子命令也接受全局 flag，可追加（实现时以附录 B-4 为准）：
// ["--dangerously-skip-permissions"]  或  ["--mode","auto"]
```

### 1.3 initialize（客户端 → 服务器，握手）

请求：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}
```

响应（字段以实测为准，`authMethods` 可能为空数组或列条目）：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"Antigravity ACP Server","version":"1.5.5"},"authMethods":[],"sessionCapabilities":{"load":true,"resume":true,"close":true,"list":true,"additionalDirectories":true}}}
```

要点：
- `protocolVersion` 用 `1`。若服务器返回的 `protocolVersion` 与请求不一致，按「取服务器返回值」并记一条 warn，不直接失败。
- **若 `authMethods` 非空且服务器要求鉴权**：可能需在 `session/new` 前调用 `authenticate`（方法名/参数以实测为准，典型形状 `{"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"<id>"}}`）。无登录态时 `session/new` 会返回鉴权错误 → 映射 `usage_error`（见 §5），**不自动回退 stream-json**（stream-json 同样需要登录，回退无意义）。

### 1.4 session/new（客户端 → 服务器）

请求：

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"C:\\work\\repo","mcpServers":[]}}
```

响应：

```json
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_01HZX...","models":{"availableModels":[{"modelId":"gemini-4-argon-high","name":"Gemini 4 Argon (High)"}],"currentModelId":"gemini-4-argon-high"}}}
```

要点：
- `cwd` 必填，取 `assertUsableCwd` 已校验的 request.cwd。
- `mcpServers` 默认 `[]`（本插件不注入 MCP）。
- 若 `Config.model` 需要生效：优先尝试在 `session/new` 参数里加 `model`/`modelId`（以实测为准）；若 agent 不支持该参数，则用 `session/set_model`（§1.9）在拿到 `sessionId` 后再设。
- `additionalDirectories` 若要用（对应 stream-json 的 `--add-dir`），以 `sessionCapabilities.additionalDirectories` 为真时作为 `session/new` 参数传入（字段名以实测为准）。

### 1.5 session/prompt（客户端 → 服务器）

请求：

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"sess_01HZX...","prompt":[{"type":"text","text":"Say OK"}]}}
```

要点：
- `prompt` 是 content block 数组；**本插件只发 `{"type":"text","text":...}`**（与 `textTask()` 语义一致：只接受 text 块，空串/纯空白拒绝）。
- 该请求**长时间不返回**，期间服务器持续推 `session/update` 通知；响应总是在「本轮结束」时才回，因此实现里 `session/prompt` 的 Promise 是与流式通知并行等待的。

### 1.6 session/update（服务器 → 客户端，通知）

文本增量（最终答案）：

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01HZX...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"}}}}
```

其他已观测/常见 `sessionUpdate` 取值（实现应「未知类型忽略、不报错」）：

- `user_message_chunk`：回显用户输入块，忽略。
- `agent_thought_chunk`：思考内容，计入诊断/可选日志，**不计入答案文本**。
- `available_commands_update`：可用命令列表，忽略。
- `session_info_update`：会话元信息（标题等），可记录。
- `tool_call` / `tool_call_update`：工具调用事件，忽略或记日志。
- `plan`：计划更新，忽略。

答案文本装配规则：**只累加 `update.sessionUpdate === 'agent_message_chunk'` 且 `content.type === 'text'` 的 `content.text`**，按到达顺序拼接。见附录 B-5（确认是「增量 delta」还是「全量快照」——若是快照则改为覆盖而非追加）。

### 1.7 session/request_permission（服务器 → 客户端，反向请求）

这是 ACP 与 stream-json 最大的行为差异：**agent 会主动向客户端发 JSON-RPC 请求，客户端必须回一个响应**，否则该轮会挂住。

```json
{"jsonrpc":"2.0","id":"perm-7","method":"session/request_permission","params":{"sessionId":"sess_01HZX...","toolCall":{"toolCallId":"tc-1","title":"write_file","kind":"edit"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"deny","name":"Deny","kind":"reject_once"}]}}
```

客户端响应（选择某个 option）。`outcome` 是 ACP v1 的 `RequestPermissionOutcome` **对象**，不是字符串：

```json
{"jsonrpc":"2.0","id":"perm-7","result":{"outcome":{"outcome":"selected","optionId":"allow"}}}
```

或直接取消：

```json
{"jsonrpc":"2.0","id":"perm-7","result":{"outcome":{"outcome":"cancelled"}}}
```

要点：
- **`outcome` 必须是嵌套对象**。扁平写法 `{"outcome":"selected","optionId":"allow"}` 会被 `agy` 判为
  `cannot unmarshal string into Go struct field RequestPermissionResult.outcome of type acp.AllowedOutcome`，
  该次工具调用被当成拒绝（日志 `Tool confirmation ... approved=false`）并取消整轮。
  依据：ACP v1 规范 *Tool Calls → Requesting permission*。
- **headless 下必须自动应答**。默认策略（`permissionPolicy: 'auto-approve'`）选 `options` 里第一个「allow 类」选项（`kind` 前缀 `allow`，否则退回 `options[0].optionId`）。这与现有默认 `permissionMode='dangerously-skip-permissions'` 的语义一致。
- 若 `permissionMode === 'auto'`，建议 `permissionPolicy: 'first-allow'` 或 `'reject'`：只放行一次 / 其余回 `{"outcome":{"outcome":"cancelled"}}`（`auto` 本就意味着不保证能读工作区）。
- 该响应是**同步必需的**：收到就立刻回，不能等 prompt 结束。
- 旧的扁平形状仍可通过 `permissionResponseShape: 'flat'` 显式 opt-in，仅用于兼容按旧版设计文档实现的 agent。

### 1.8 终止与 usage

`session/prompt` 的响应（本轮终态）：

```json
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":123,"outputTokens":5,"cachedReadTokens":0,"cachedWriteTokens":0,"thoughtTokens":0,"totalTokens":128}}}
```

要点：
- `stopReason` 取值至少包含 `end_turn`（正常结束）；可能还有 `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`（以实测为准）。映射见 §3.3。
- `usage` 按实测位于响应顶层；**若某版本把它包在 `result._meta.usage`，实现要两者都探测**（附录 B-3）。usage 只进日志/诊断，不改变 output 形状。

### 1.9 取消 / 关闭 / 载入（按 sessionCapabilities 能力使用）

- 取消本轮（通知，无响应）：

```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"sess_01HZX..."}}
```

- 关闭会话（若 `sessionCapabilities.close`）：
  `{"jsonrpc":"2.0","id":9,"method":"session/close","params":{"sessionId":"sess_01HZX..."}}`
- 载入/恢复会话（若 `load`/`resume`，本设计默认不用）：
  `{"jsonrpc":"2.0","id":10,"method":"session/load","params":{"sessionId":"...","cwd":"...","mcpServers":[]}}`
- 设模型（若 session/new 不支持参数）：
  `{"jsonrpc":"2.0","id":11,"method":"session/set_model","params":{"sessionId":"...","modelId":"gemini-4-argon-high"}}`

---

## 2. 与现有 stream-json 路径的差异对照表

对照对象：`lib/run.js`（进程生命周期 + argv）、`lib/wire.js`（NDJSON 解析 + 答案选择）、`lib/classify.js`（失败分类）。

| 维度 | stream-json（现有，默认） | ACP（本次新增） | 影响点 |
|---|---|---|---|
| 子命令 / argv | `agy --print <prompt> --output-format stream-json [...]` | `agy acp`（常驻服务器） | `lib/acp-client.js` 自建 argv |
| stdin | `'ignore'` | **`'pipe'`（双向发包）** | spawn stdio 配置 |
| 协议 | 单向 NDJSON「envelope 事件」 | JSON-RPC 2.0（请求/响应/通知三态） | 需 `AcpConnection` 请求 id 关联 |
| 握手 | 无 | `initialize`（protocolVersion/capabilities） | 新增握手阶段 + 超时 |
| 会话 | 无显式会话概念；每 run 独立进程 + `--new-project/--project` | `session/new` 返回 `sessionId`，可 `load/resume/close` | 新增 session 生命周期 |
| 提示注入 | 拼进 CLI argv `--print <prompt>` | `session/prompt` 的 content blocks | `textTask()` 仍复用，产出 text 块数组 |
| 流式增量 | `step_update.step_update{step_type:'agent_response',text_delta}` | `session/update` → `agent_message_chunk` | 解析器不同 |
| 答案选择 | 终态 `result.response` 优先，`text_delta` 兜底 | `agent_message_chunk` 文本累加（无「终态 response」） | 语义差异，见附录 B-5 |
| 终态形态 | `{"event":"result","result":{"status":"SUCCESS"|...,"response":...}}` | `{"result":{"stopReason":"end_turn","usage":{...}}}` | stopReason 映射表见 §3.3 |
| 权限 / 工具确认 | CLI flag `--dangerously-skip-permissions` / `--mode auto`，**无反向请求** | **`session/request_permission` 反向请求，必须应答** | 新增权限处理器（headless 关键） |
| 失败文本来源 | `wire.errorText`（result/error 帧）+ stderr | JSON-RPC `error.message`/`error.data` + stderr + 非成功 stopReason | 汇总后喂同一个 `classifyFailure` |
| 退出码语义 | exit 0 = 正常（终态帧与退出竞争） | 服务器常驻，**不应主动 exit 0**；非零 exit 才是异常 | teardown 必须 kill，不能等自然退出 |
| 超时 | 原生 `--print-timeout`（Go duration） | **无原生超时**，靠宿主 timer + abort | 新增 `acpRequestTimeoutMs`/`acpPromptTimeoutMs` |
| 结构化输出 | `--json-schema` 约束最终 result | **无对应机制**（content blocks 自由文本） | `jsonSchema` 在 acp 下忽略，需文档说明 |
| 附加目录 | `--add-dir` 重复参数 | `session/new` 参数 / `sessionCapabilities.additionalDirectories` | 以实测为准 |
| 模型 / effort | `--model` / `--effort` | session/new models + `set_model`；**无 effort 概念** | `effort` 在 acp 下忽略/映射，需文档说明 |
| 进程生命周期 | 一次性，exit 0 即结束 | 长驻，必须显式 `dispose()` 终止 | 见 §5.3 |

**结论：无法复用 `AntigravityStream`（wire.js 绑死 envelope 形状），也不要改 `wire.js`。ACP 的帧/协议/答案装配全部在 `lib/acp-client.js` 内新建。**

---

## 3. transport 抽象设计

### 3.1 模块职责边界

`lib/acp-client.js`（新增，唯一新文件）负责：

1. spawn `agy acp`、`stdin/stdout/stderr` 管理、按行分帧、JSON-RPC 请求/响应/通知配对（`id` 关联）、反向请求 `session/request_permission` 应答。
2. 握手 `initialize`、`session/new`、`session/prompt`，装配答案文本与 stopReason/usage。
3. 把 ACP 失败映射成 `classify.js` 的四种 kind；提供超时、abort、进程清理。
4. 对外暴露两层：低层 `AcpClient`（可单测、可被未来持久连接复用）与高层 `startAcpRun` / `startAcpRunWithRetry`（返回与 `run.js` 同形状的 run handle）。

**不负责**：DSH provider 注册、Config 解析、Gemini 面板、并行工具。这些仍在 `lib/index.js` / `lib/parallel.js`。

### 3.2 `lib/acp-client.js` 对外接口（implementer 可直接照做）

> 全部使用 ESM、Tab 缩进、JSDoc 类型（与仓库风格一致）；只用 `node:` 内置模块 + 复用 `lib/classify.js`。**不 import `@deepseek-ai/*` 的可选包用于纯逻辑部分**；`subprocessRunHandle`/`settleRunResult`/`brandString` 的 import 方式照抄 `lib/run.js`。

```js
/**
 * @typedef {'quota_exhausted'|'rate_limited'|'usage_error'|'unknown'} FailureKind
 * @typedef {{kind: FailureKind, retryAfterMs?: number}} Classification   // 与 classify.js 返回值同形
 */

/**
 * ACP 失败对象。message 面向日志；其余字段供分类/诊断。
 */
export class AcpError extends Error {
	/**
	 * @param {{
	 *   message: string,
	 *   code?: number,                 // JSON-RPC error.code（若有）
	 *   data?: unknown,                // JSON-RPC error.data
	 *   method?: string,               // 出错的 RPC 方法名
	 *   stage: 'spawn'|'initialize'|'session'|'prompt'|'protocol'|'process'|'timeout',
	 *   kind?: FailureKind,
	 *   retryAfterMs?: number,
	 * }} info
	 * @param {unknown} [cause]
	 */
	constructor(info, cause) { /* ... */ }
}

/**
 * 低层 ACP 连接。事件：
 *   'session_update'  (params)                    // 每条 session/update 的 params
 *   'agent_text'      ({ sessionId, text })       // agent_message_chunk 文本增量（便捷事件）
 *   'permission_request' (params)                 // 仅 permissionPolicy==='manual' 时抛给外部
 *   'stderr'          ({ text })                  // 已 stripAnsi 的 stderr
 *   'error'           (AcpError)                  // 非终止性协议错误
 */
export class AcpClient extends EventEmitter {
	/**
	 * @param {{
	 *   spawn: (spec: {argv: string[], cwd: string, stdio: {stdin:'pipe',stdout:'pipe',stderr:'pipe'}, graceMs: number, env: Record<string,string>}) => any,
	 *   executable: string,
	 *   cwd: string,
	 *   env?: Record<string,string>,
	 *   protocolVersion?: number,                                      // 默认 1
	 *   clientCapabilities?: { fs?: boolean, terminal?: boolean },     // 默认 { fs: true, terminal: true }
	 *   requestTimeoutMs?: number,                                     // 默认 30000（initialize/session/new 等）
	 *   promptTimeoutMs?: number,                                      // 默认 0 = 不限（靠 abort）
	 *   disposeGraceMs?: number,                                       // 默认 3000
	 *   permissionPolicy?: 'auto-approve'|'first-allow'|'reject'|'manual', // 默认 'auto-approve'
	 *   extraArgs?: string[],                                          // 追加到 `agy acp` 之后
	 *   writeStderr?: (bytes: Buffer) => void,
	 *   logger?: { warn(msg: string): void, info?(msg: string): void },
	 * }} options
	 */
	constructor(options) { /* ... */ }

	/** 'agy acp' 子进程是否仍在运行。 */
	get alive(): boolean;
	/** initialize 返回的 agentInfo（握手后可用）。 */
	get agentInfo(): { name: string, version?: string } | undefined;
	/** initialize 返回的 sessionCapabilities。 */
	get sessionCapabilities(): Record<string, unknown> | undefined;

	/**
	 * spawn `agy acp` 并完成 initialize 握手。
	 * @returns {Promise<{ protocolVersion: number, agentInfo: {name:string,version?:string}, authMethods: unknown[], sessionCapabilities: Record<string,unknown> }>}
	 */
	start(): Promise<{ protocolVersion: number, agentInfo: { name: string, version?: string }, authMethods: unknown[], sessionCapabilities: Record<string, unknown> }>;

	/**
	 * 需要鉴权时调用（authMethods 非空且 session/new 报鉴权错误）。
	 * @param {string} methodId
	 * @returns {Promise<void>}
	 */
	authenticate(methodId: string): Promise<void>;

	/**
	 * 新建会话。
	 * @param {{ cwd?: string, mcpServers?: unknown[], model?: string, additionalDirectories?: string[] }} [options]
	 * @returns {Promise<{ sessionId: string, models?: { availableModels?: unknown[], currentModelId?: string } }>}
	 */
	newSession(options?: { cwd?: string, mcpServers?: unknown[], model?: string, additionalDirectories?: string[] }): Promise<{ sessionId: string, models?: { availableModels?: unknown[], currentModelId?: string } }>;

	/**
	 * 设置会话模型（session/new 不支持 model 参数时的回退）。
	 * @returns {Promise<void>}
	 */
	setModel(sessionId: string, modelId: string): Promise<void>;

	/**
	 * 发送一轮 prompt，等待终态 stopReason。
	 * @param {string} sessionId
	 * @param {Array<{type:'text', text:string}>} blocks   // 只接受 text 块
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<{
	 *   stopReason: 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled'|string,
	 *   usage?: { inputTokens:number, outputTokens:number, cachedReadTokens?:number, cachedWriteTokens?:number, thoughtTokens?:number, totalTokens?:number },
	 *   text: string,
	 *   content: Array<{type:string, text?:string}>,
	 *   sessionId: string,
	 * }>}
	 */
	prompt(sessionId: string, blocks: Array<{ type: 'text', text: string }>, options?: { signal?: AbortSignal }): Promise<{
		stopReason: string,
		usage?: { inputTokens: number, outputTokens: number, cachedReadTokens?: number, cachedWriteTokens?: number, thoughtTokens?: number, totalTokens?: number },
		text: string,
		content: Array<{ type: string, text?: string }>,
		sessionId: string,
	}>;

	/** 发送 session/cancel 通知（无响应）。幂等。 */
	cancel(sessionId: string): void;

	/** 关闭会话（若 sessionCapabilities.close）。 */
	closeSession(sessionId: string): Promise<void>;

	/** 终止子进程：先 cancel 活跃会话 → end stdin → 按 disposeGraceMs 分档 terminate → waitForExit。幂等。 */
	dispose(): Promise<void>;
}
```

### 3.3 运行句柄适配（provider 直接消费）

`startAcpRun` / `startAcpRunWithRetry` 返回**与 `lib/run.js#startAntigravityRun` 完全同形**的 run handle，这样 `lib/index.js` 只需换调用的函数，不用改上层逻辑。

```js
/**
 * @typedef {{
 *   cwd: string,
 *   executable: string,
 *   env: Record<string,string>,
 *   permissionMode: 'auto'|'dangerously-skip-permissions',
 *   model?: string,
 *   effort?: string,                         // ACP 无原生 effort：可忽略/仅日志
 *   acpProtocolVersion?: number,             // 默认 1
 *   acpRequestTimeoutMs?: number,            // 默认 30000
 *   acpPromptTimeoutMs?: number,             // 默认 0
 *   acpPermissionPolicy?: 'auto-approve'|'first-allow'|'reject'|'manual',
 *   acpFallbackToStreamJson?: boolean,       // 默认 true
 *   disposeGraceMs: number,
 *   spawn: Function, writeStderr: Function, onError: Function,
 *   report?: { classification?: Classification },   // 供重试包装读取失败分类
 * }} AcpRunSpec
 */

/**
 * 启动一次 ACP run。返回与 startAntigravityRun 同形的句柄。
 * @param {{ prompt: readonly {type:string, text?:string}[], signal: AbortSignal, cwd?: string }} request
 * @param {AcpRunSpec} spec
 * @returns {Promise<{
 *   id: string,
 *   result: Promise<{ output: Array<{type:'text', text:string}>, stopReason: 'completed'|'aborted'|'error' }>,
 *   requestCancel(): void,
 *   teardown(): Promise<void>,
 * }>}
 */
export async function startAcpRun(request, spec) { /* ... */ }

/**
 * 与 startAntigravityRunWithRetry 同语义：仅在显式配置
 * fallbackModel / retryOnRateLimit 时做一次重试（quota/rate → fallbackModel；rate → 退避重试）。
 * @param {object} request
 * @param {AcpRunSpec & { fallbackModel?: string, retryOnRateLimit?: boolean }} spec
 * @returns {Promise<object>}
 */
export async function startAcpRunWithRetry(request, spec) { /* ... */ }
```

**stopReason 映射表（ACP → 共享 stopReason）：**

| ACP `stopReason` | 共享 `stopReason` | 说明 |
|---|---|---|
| `end_turn` | `completed` | 正常结束 |
| `max_tokens` / `max_turn_requests` | `error` | 被截断，按失败处理（诊断加 `[unknown]`，可带 usage） |
| `refusal` | `error` | 模型拒答 |
| `cancelled` | `aborted` | 本地取消/超时 abort |
| 其他/未知 | `error` | 记 warn，保留原值进诊断 |

**答案装配**：`output = text.trim().length > 0 ? [{ type:'text', text }] : []`（与 `wire.result()` 一致）。

### 3.4 `lib/index.js` 的 transport 选择（伪代码，实现照抄）

在 `AntigravityProvider.start(request)` 内，保留现有 cwd 校验 / executable 存在性 / env 清理，然后在构造 spec 后分支：

```js
// 顶部 import 增加：
import { startAcpRun, startAcpRunWithRetry } from './acp-client.js';

// start() 末尾，替换原来的 return：
if (this.config.transport === 'acp') {
	const acpSpec = {
		cwd,
		executable: this.config.executable,
		env: { ...env, ...this.config.env },
		permissionMode: this.config.permissionMode,
		...(this.config.model === undefined ? {} : { model: this.config.model }),
		...(this.config.effort === undefined ? {} : { effort: this.config.effort }),
		acpProtocolVersion: this.config.acpProtocolVersion,
		acpRequestTimeoutMs: this.config.acpRequestTimeoutMs,
		acpPromptTimeoutMs: this.config.acpPromptTimeoutMs,
		acpPermissionPolicy:
			this.config.permissionMode === 'dangerously-skip-permissions'
				? 'auto-approve'
				: (this.config.acpPermissionPolicy ?? 'first-allow'),
		acpFallbackToStreamJson: this.config.acpFallbackToStreamJson,
		...(this.config.fallbackModel === undefined ? {} : { fallbackModel: this.config.fallbackModel }),
		retryOnRateLimit: this.config.retryOnRateLimit,
		disposeGraceMs: this.config.disposeGraceMs,
		spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
		writeStderr: (bytes) => { /* 同现有，stripAnsi 后写 stderr */ },
		onError: (error, stopReason) => this.ctx.logger.warn(`${PREFIX} "${this.name}": ACP run failed (${stopReason}): ${error.message}`),
	};
	return this.config.fallbackModel === undefined && this.config.retryOnRateLimit !== true
		? startAcpRun(request, acpSpec)
		: startAcpRunWithRetry(request, acpSpec);
}
// 否则：现有 stream-json 分支不变
return this.config.fallbackModel === undefined && this.config.retryOnRateLimit !== true
	? startAntigravityRun(request, spec)
	: startAntigravityRunWithRetry(request, spec);
```

要点：
- **默认 `transport='stream-json'`** → 走原分支，零行为变化。
- 回退逻辑（`acpFallbackToStreamJson`）放在 `startAcpRun` 内部实现：仅在**「prompt 尚未开始」的 spawn/initialize/session 阶段**失败时，记 warn 并内部改走 `startAntigravityRun`（需把 stream-json 需要的 `printTimeout/jsonSchema/addDirs/extraArgs` 等一并放进 acpSpec 透传）。**prompt 一旦开始不得回退**（避免重复消耗配额、重复副作用）。
- `antigravity-team` provider 复用同一个 `AntigravityProvider` 类，因此同样自动支持 `transport` 切换，无需额外代码。

---

## 4. Config 新增字段与类型同步

在 `lib/index.js#Config`（schemastery）中**追加**以下字段（不要改既有字段默认值）：

```js
/** 传输通道选择：默认保持 stream-json，ACP 为 opt-in。 */
transport: z.union(['stream-json', 'acp']).default('stream-json'),
/** ACP 协议版本（initialize.protocolVersion）。 */
acpProtocolVersion: z.number().min(1).default(1),
/** ACP 握手/建会话等短请求超时（ms）。 */
acpRequestTimeoutMs: z.number().min(1000).default(30000),
/** ACP 单轮 prompt 超时（ms）；0 = 不限，靠 abort。 */
acpPromptTimeoutMs: z.number().min(0).default(0),
/** ACP 权限请求应答策略。 */
acpPermissionPolicy: z.union(['auto-approve', 'first-allow', 'reject', 'manual']).default('auto-approve'),
/** ACP 在「prompt 前」握手失败时是否自动回退 stream-json。 */
acpFallbackToStreamJson: z.boolean().default(true),
/** ACP 追加到 `agy acp` 之后的额外 argv（可选）。 */
acpExtraArgs: z.array(z.string()).default([]),
```

> 说明：`transport` 与既有 `permissionMode/model/effort/printTimeout/jsonSchema/addDirs/fallbackModel/retryOnRateLimit/disposeGraceMs` 共存。ACP 下：`printTimeout/jsonSchema/addDirs/effort` **不生效**（分别改由 `acpPromptTimeoutMs`、无、`additionalDirectories`、忽略代替），需在文档/日志里明说不静默假装生效。

`lib/types/index.d.ts` **必须手工同步**（该文件不是 tsc 生成，见 AGENTS.md）。追加：

```ts
/** Transport channel: legacy stream-json (default) or ACP JSON-RPC. */
export type AntigravityTransport = 'stream-json' | 'acp';
/** ACP permission request handling policy. */
export type AcpPermissionPolicy = 'auto-approve' | 'first-allow' | 'reject' | 'manual';

export interface Config {
	// ...既有字段...
	/** Transport channel; default 'stream-json' preserves existing behavior. */
	transport?: AntigravityTransport;
	/** ACP protocolVersion for initialize (default 1). */
	acpProtocolVersion?: number;
	/** Timeout (ms) for ACP handshake/session requests (default 30000). */
	acpRequestTimeoutMs?: number;
	/** Timeout (ms) for a single ACP prompt; 0 = unlimited (default 0). */
	acpPromptTimeoutMs?: number;
	/** How to answer session/request_permission (default 'auto-approve'). */
	acpPermissionPolicy?: AcpPermissionPolicy;
	/** Auto-fallback to stream-json when ACP handshake fails before prompt (default true). */
	acpFallbackToStreamJson?: boolean;
	/** Extra argv appended after `agy acp` (default []). */
	acpExtraArgs?: string[];
}
```

`apply()` 的 `resolved` 对象里补默认值（与现有风格一致）：

```js
transport: config.transport ?? 'stream-json',
acpProtocolVersion: config.acpProtocolVersion ?? 1,
acpRequestTimeoutMs: config.acpRequestTimeoutMs ?? 30000,
acpPromptTimeoutMs: config.acpPromptTimeoutMs ?? 0,
acpPermissionPolicy: config.acpPermissionPolicy ?? 'auto-approve',
acpFallbackToStreamJson: config.acpFallbackToStreamJson ?? true,
acpExtraArgs: config.acpExtraArgs ?? [],
```

`package.json`：新文件 `lib/acp-client.js` 在 `lib/*.js` 白名单内，**无需改 `files`**。若希望单测用包名导入可加 `exports` 的 `"./acp-client": "./lib/acp-client.js"`（当前测试用相对路径导入，可不加）。

---

## 5. 错误分类映射、超时、进程清理、并发/会话复用

### 5.1 错误分类映射（复用 `lib/classify.js`）

实现一个内部函数（不导出也可，导出更好测）：

```js
/**
 * 把 ACP 失败映射成 classify.js 的四种 kind。
 * @param {AcpError | unknown} error
 * @param {{exitCode?: number|null, signal?: string|null}} [outcome]
 * @param {string} [stderrText]
 * @returns {{kind: FailureKind, retryAfterMs?: number, stage: string, category: string}}
 */
function classifyAcpFailure(error, outcome, stderrText) {
	const parts = [];
	if (error instanceof AcpError) {
		if (error.data !== undefined) parts.push(typeof error.data === 'string' ? error.data : JSON.stringify(error.data).slice(0, 4000));
		parts.push(error.message);
	} else if (error instanceof Error) parts.push(error.message);
	else if (error !== undefined) parts.push(String(error));
	if (typeof stderrText === 'string') parts.push(stderrText);
	const text = parts.join('\n');
	const base = classifyFailure(text, outcome);            // ← 直接复用
	const stage = error instanceof AcpError ? error.stage : 'unknown';
	const category = stage === 'process' ? 'process'
		: stage === 'timeout' ? 'timeout'
		: base.kind === 'unknown' ? 'protocol' : 'product-error';
	return { ...base, stage, category };
}
```

映射表（症状 → kind → 行为）：

| 症状 / 阶段 | 检测依据 | classify kind | stage | 行为 |
|---|---|---|---|---|
| spawn 失败（exe 缺失/权限） | spawn throw | `unknown` | `spawn` | 直接抛，不重试 |
| initialize/session 报错 | JSON-RPC `error.code`/`message` | 文本→`classifyFailure`，兜底 `unknown` | `initialize`/`session` | `acpFallbackToStreamJson=true` 时可回退 |
| 鉴权失败（auth_required） | error.data 含 auth / 登录态 | `usage_error` | `initialize` | 不重试、不回退（stream-json 也要登录） |
| prompt 期间 JSON-RPC error | `error.message` | `classifyFailure(text)` | `prompt` | `stopReason=error`，写诊断 `[kind]` |
| `stopReason` = `refusal`/`max_*` | 终端 stopReason | `unknown`（若文本空） | `turn` | `stopReason=error` |
| prompt 超时 | `acpPromptTimeoutMs` 到点 | `unknown` | `timeout` | abort + 杀进程，`stopReason=error`，不自动重试 |
| 进程非零退出 | `exitCode !== 0` | `classifyFailure(text, outcome)` | `process` | `stopReason=error` |
| 文本含 429/rate/quota | `classifyFailure` | `rate_limited`/`quota_exhausted` | `turn` | 仅当显式 `retryOnRateLimit`/`fallbackModel` 才重试（沿用现有语义） |

诊断信息格式与 `run.js` 对齐：`AntigravityRunFailure` 等价物消息末尾追加 `[${kind}]`，`stopReason==='error'` 时写 `report.classification = { kind, retryAfterMs? }` 供 `startAcpRunWithRetry` 读取。

### 5.2 超时

- **短请求**（initialize / session/new / set_model）：`acpRequestTimeoutMs`（默认 30s）。超时 → `AcpError{stage:'timeout'}`，可触发回退（此时 prompt 未开始）。
- **prompt**：`acpPromptTimeoutMs`（默认 0 = 不限）。>0 时到期 → 发 `session/cancel` 通知 + abort + `dispose()` + 返回 `stopReason:'error'`（诊断 `[unknown]`），**不自动重试**（与 `--print-timeout` 的「截断不可当成功」哲学一致）。
- 同时尊重 `request.signal`（上层 abort）：立即 cancel + dispose，返回 `stopReason:'aborted'`。

### 5.3 进程清理（与 stream-json 的关键区别）

`agy acp` 是**常驻服务器**，不能等它自然退出。`dispose()` 顺序（幂等）：

1. 对活跃 session 发 `session/cancel`（尽力而为，失败忽略）。
2. 对每个 session 尝试 `session/close`（若能力支持，失败忽略）。
3. `child.stdin.end()` → 关闭写端。
4. `child.terminate()` → `await child.waitForExit()` → `await child.done.catch(()=>{})`（沿用 `run.js#disposeProcess` 的分档与 `disposeGraceMs`）。
5. 移除所有 stdout/stderr 监听、清空 `pending` 请求（对未决请求 reject 一个 `AcpError{stage:'process'}`）。

注意：**不要**把「子进程 exit 0」当成功（与 stream-json 相反）；ACP 下子进程退出即连接断裂，未完成的 prompt 一律按 `error` 处理。

### 5.4 并发 / 会话复用策略

- **默认：一 run 一进程一会话，结束即 dispose**（与现有「一次性委派、无 follow-up」语义完全一致）。并行多个子任务时，每个 `provider.start` 各自 spawn 自己的 `agy acp`，互不共享，天然安全。
- **不做跨 run 会话复用**（虽然 `sessionCapabilities` 有 `load/resume/close/list`）。原因：`NO_START_CAPABILITIES` + 无 follow-up，复用会引入生命周期/串行化复杂度。
- **未来可选**（不在本次范围，仅在文档留口）：`acpSessionPool { maxIdle, idleMs }`，用一个长驻 `AcpClient` 承载多个 session，按 `cwd+model` 复用；需先解决 DSH provider 的 follow-up 语义，故暂不实现。
- `AcpClient` 内部保证：同一 `sessionId` 上**不允许并发 prompt**（若上层误调，直接 reject `AcpError{stage:'prompt'}`）；不同 session 可并行（但默认一 run 一 session，用不到）。

---

## 6. 风险与回退

### 6.1 主要风险

1. **协议帧格式未最终确认**（NDJSON vs Content-Length）。→ 分帧器双模式探测（§1.1），附录 B-1 冒烟先验。
2. **版本漂移**：CLI 是 `agy 1.5.4`，agentInfo 报 `1.5.5`；ACP 仍在演进，字段（usage 位置、stopReason 取值、set_model 是否存在）可能变。→ 实现全部「宽松解析、未知忽略」，关键字段缺失只降级不崩。
3. **反向请求漏答导致挂死**：`session/request_permission` 若不应答，prompt 永不返回。→ headless 强制自动应答；`requestTimeoutMs`/`acpPromptTimeoutMs` 兜底；`dispose()` 清 pending。
4. **审批在 headless 下的语义**：`permissionMode='auto'` 时，工具确认被拒会让任务半途失败（与 stream-json 同样限制）。→ 文档明确：需要读写工作区的委派仍应保持默认 `dangerously-skip-permissions`（ACP 侧对应 `auto-approve`）。
5. **功能不对等**：ACP 无 `--json-schema`、无 `--effort`、无原生 `--print-timeout`、`--add-dir` 改由会话参数。→ 若用户显式配置了这些而选了 `transport:'acp'`，**记 warn 并说明该字段被忽略**，不静默丢弃也不假装生效。
6. **重复消耗**：错误重试沿用现有 opt-in 语义，且「prompt 已开始」不触发 stream-json 回退，避免一次任务跑两遍。

### 6.2 回退到 stream-json 的条件（`acpFallbackToStreamJson`，默认 true）

**允许回退**（自动，一次性，且仅当 prompt 尚未发出）：
- `agy acp` 启动后立即退出 / 报「unknown subcommand」/ initialize 返回 `-32601 method not found`；
- initialize 或 session/new 在 `acpRequestTimeoutMs` 内超时；
- 明确检测到该 `agy` 版本不支持 ACP 子命令。

**禁止回退**：
- prompt 已经开始（哪怕失败）——避免重复执行与重复扣配额，直接把错误上抛；
- 鉴权失败（stream-json 一样要登录）；
- 用户显式 `transport:'acp'` 且 `acpFallbackToStreamJson=false`（严格模式，fail fast）。

回退时日志：`warn('ACP unavailable (<stage>: <reason>); falling back to stream-json')`，诊断里标注 `transport→stream-json(fallback)`。

### 6.3 保守默认

- 全局默认仍是 `transport:'stream-json'`。ACP 需在 profile 的 `cordis.patch.yml` 里显式 `transport: acp` 才启用，**先在测试实例验证再推广**。

---

## 7. 验证计划

### 7.1 语法与单测

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js; node --check lib/worker-client.js; node --check lib/parallel.js; node --check lib/acp-client.js
node --test
# 若 DSH 沙箱内 spawn 报 EPERM：
node --test --test-isolation=none
```

新增单测建议（`test/acp-client.test.js`，用 `registerHooks` 或注入假 `spawn`，不真起进程）：

- `AcpClient.prompt()`：喂入 `session/update` 的 `agent_message_chunk` + 终态 `stopReason:end_turn`，断言 `text` 拼接正确、`usage` 透传。
- 反向请求：喂入 `session/request_permission`，断言客户端按策略回了 `{outcome:'selected', optionId}`。
- `classifyAcpFailure`：文本含 `429`/`quota`/`exitCode 2` 分别得 `rate_limited`/`quota_exhausted`/`usage_error`。
- `startAcpRun`：模拟握手失败 → 断言（`acpFallbackToStreamJson=true` 时）走回退分支、（false 时）直接抛。

### 7.2 ACP 真实冒烟（不改仓库，临时脚本）

用附录 A 的 `acp-smoke.mjs`：期望依次打印 `[initialize]` 含 `Antigravity ACP Server`、`[session/new]` 含 `sessionId`、`[prompt result]` 含 `stopReason:"end_turn"`，且 stdout 出现 `OK`。

### 7.3 集成冒烟（实现后）

```powershell
# stream-json 路径回归（默认不变）
& "$env:USERPROFILE\.gemini\bin\agy.exe" --print "Say OK" --output-format stream-json --project dsh-subagent-agy
# ACP 路径：profile 里临时设 transport: acp，用任意一次 agy 委派观察日志出现 "[initialize] Antigravity ACP Server" 与正常答案
```

### 7.4 profile 重新部署

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install            # 新增文件 lib/acp-client.js 需让硬链接生效
# 重启 GUI
```

注意（来自 AGENTS.md）：profile 里的 `node_modules/dsh-subagent-agy/*` 是**硬链接**；原地改内容会同步，但**新增文件不会**，且原子写会断链。因此新增 `lib/acp-client.js` 后**必须** `pnpm install`，否则 profile 里没有该文件。启用 ACP 时在 `cordis.patch.yml` 的 `- id: subagent-antigravity` 下加 `config: { transport: acp }`（或直接改默认后再部署）。

---

## 附录 A：原始 JSON-RPC 冒烟脚本（零依赖，先摸清协议）

把下面存成临时 `acp-smoke.mjs`（不放仓库），`node acp-smoke.mjs`：

```js
import { spawn } from 'node:child_process';

const exe = `${process.env.USERPROFILE}\\.gemini\\bin\\agy.exe`;
const child = spawn(exe, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();

function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
function req(id, method, params) {
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ jsonrpc: '2.0', id, method, params });
	});
}

child.stdout.on('data', (chunk) => {
	buf += chunk.toString('utf8');
	let i;
	while ((i = buf.indexOf('\n')) !== -1) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let msg; try { msg = JSON.parse(line); } catch { continue; }
		if (msg.id !== undefined && pending.has(msg.id)) {
			const p = pending.get(msg.id); pending.delete(msg.id);
			msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
		} else if (msg.method === 'session/update') {
			const u = msg.params?.update;
			if (u?.sessionUpdate === 'agent_message_chunk') process.stdout.write(u.content?.text ?? '');
		} else if (msg.method === 'session/request_permission') {
			const opt = msg.params?.options?.[0]?.optionId;
			send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'selected', optionId: opt } });
		}
	}
});
child.stderr.on('data', (b) => process.stderr.write(b));

const info = await req(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
console.log('\n[initialize]', JSON.stringify(info));
const session = await req(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
console.log('[session/new]', JSON.stringify(session));
const result = await req(3, 'session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Say OK' }] });
console.log('\n[prompt result]', JSON.stringify(result));

child.stdin.end();
child.kill();
process.exit(0);
```

---

## 附录 B：实现前待实测确认清单（不影响接口形状，只影响内部细节）

1. **帧格式**：是 NDJSON（一行一条）还是 Content-Length 头？→ 决定分帧器主路径。
2. **`session/new` 设模型**：是否支持 `model`/`modelId` 参数？还是必须 `session/set_model`？
3. **`usage` 位置**：在 `result` 顶层还是 `result._meta.usage`？
4. **`agy acp` 是否接受全局 flag**（`--dangerously-skip-permissions` / `--mode auto` / `--add-dir`）？
5. **`agent_message_chunk` 是增量 delta 还是全量快照**？（决定累加 or 覆盖）
6. **`sessionCapabilities.additionalDirectories`** 对应的 `session/new` 参数字段名。
7. **鉴权**：无登录态时 `session/new` 的错误 code/message 形状，用于映射 `usage_error`。
8. **`stopReason` 全集**（是否真会出现 `max_tokens`/`refusal` 等）。
