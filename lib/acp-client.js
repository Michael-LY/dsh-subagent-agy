/**
 * ACP (Agent Client Protocol) transport for the Antigravity CLI.
 *
 * `agy acp` is a long-lived stdio JSON-RPC 2.0 server (one NDJSON frame per
 * line). This module owns the whole ACP channel: spawn, line framing, request /
 * id correlation, the `initialize` → `session/new` → `session/prompt`
 * handshake, streaming `session/update` collection, reverse
 * `session/request_permission` answers, timeouts and process cleanup.
 *
 * Two layers are exported:
 *
 *  - `AcpClient` — low-level, event-emitting connection (nameable, unit-testable
 *    with an injected fake `spawn`, reusable by a future persistent pool).
 *  - `startAcpRun` / `startAcpRunWithRetry` — high-level, returning a run handle
 *    with the exact same shape as `lib/run.js#startAntigravityRun`, so the
 *    provider only has to pick which function to call.
 *
 * Failure classification reuses `./classify.js`, so ACP failures share the
 * `quota_exhausted` / `rate_limited` / `usage_error` / `unknown` axis with the
 * legacy stream-json path.
 *
 * @module dsh-subagent-agy/acp-client
 */
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { brandString } from '@deepseek-ai/dsh-brand';
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent';
import { classifyFailure } from './classify.js';
import { DEFAULT_MODEL, startAntigravityRun, stripAnsi, textTask } from './run.js';

/** ACP protocol version this client implements. */
export const ACP_PROTOCOL_VERSION = 1;

const PREFIX = 'subagent-antigravity/acp';

/** Maximum buffered NDJSON bytes before a frame is treated as malformed. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_DISPOSE_GRACE_MS = 3000;

/** Sentinel returned by the frame parser for lines it fully handled. */
const SKIP = Symbol('skip');

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function thrown(value) {
	return value instanceof Error ? value : new Error(String(value));
}

function rpcError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

/**
 * ACP failure object. `message` is for logs; the rest feeds classification and
 * diagnostics. Mirrors the shape described in the design doc.
 */
export class AcpError extends Error {
	/**
	 * @param {{
	 *   message: string,
	 *   code?: number,
	 *   data?: unknown,
	 *   method?: string,
	 *   stage: 'spawn'|'initialize'|'session'|'prompt'|'protocol'|'process'|'timeout'|'turn',
	 *   kind?: 'quota_exhausted'|'rate_limited'|'usage_error'|'unknown',
	 *   retryAfterMs?: number,
	 * }} info
	 * @param {unknown} [cause]
	 */
	constructor(info, cause) {
		super(info.message, cause === undefined ? undefined : { cause });
		this.name = 'AcpError';
		this.stage = info.stage;
		this.code = info.code;
		this.data = info.data;
		this.method = info.method;
		this.kind = info.kind;
		this.retryAfterMs = info.retryAfterMs;
	}
}

/**
 * Split a raw byte/string stream into parsed NDJSON frames.
 *
 * Handles frames split across chunks, several frames in one chunk, a trailing
 * frame without a final newline, and multi-byte UTF-8 sequences straddling a
 * chunk boundary (via `StringDecoder`). The primary and only frame format is
 * NDJSON (one JSON object per line).
 */
export class AcpFrameParser {
	#prefix;
	#decoder = new StringDecoder('utf8');
	#buffer = '';
	#malformed;

	/** @param {string} [prefix] diagnostic prefix. */
	constructor(prefix = PREFIX) {
		this.#prefix = prefix;
	}

	/** First structural protocol error observed, if any. */
	get malformed() {
		return this.#malformed;
	}

	/**
	 * Feed one raw chunk and return every complete parsed frame it produced.
	 * @param {Buffer | string} chunk
	 * @returns {unknown[]}
	 */
	push(chunk) {
		const out = [];
		const piece = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
		this.#buffer += piece;
		if (this.#buffer.length > MAX_FRAME_BYTES) {
			this.#buffer = '';
			this.#malformed ??= `${this.#prefix}: ACP frame exceeded ${MAX_FRAME_BYTES} bytes`;
			return out;
		}
		let index;
		while ((index = this.#buffer.indexOf('\n')) !== -1) {
			const line = this.#buffer.slice(0, index);
			this.#buffer = this.#buffer.slice(index + 1);
			const parsed = this.#consume(line);
			if (parsed !== SKIP) out.push(parsed);
		}
		return out;
	}

	/** Flush a trailing frame that arrived without a final newline. */
	end() {
		const out = [];
		this.#buffer += this.#decoder.end();
		const line = this.#buffer;
		this.#buffer = '';
		if (line.length > 0) {
			const parsed = this.#consume(line);
			if (parsed !== SKIP) out.push(parsed);
		}
		return out;
	}

	#consume(raw) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line.trim().length === 0) return SKIP;
		try {
			return JSON.parse(line);
		} catch {
			this.#malformed ??= `${this.#prefix}: ACP emitted a non-JSON line`;
			return SKIP;
		}
	}
}

/**
 * Classify one parsed frame by JSON-RPC shape.
 * @param {unknown} message
 * @returns {'response' | 'request' | 'notification' | 'invalid'}
 */
export function classifyMessage(message) {
	if (!isRecord(message)) return 'invalid';
	if (typeof message.method === 'string') {
		return message.id === undefined || message.id === null ? 'notification' : 'request';
	}
	const hasId = message.id !== undefined && message.id !== null;
	if (hasId && ('result' in message || 'error' in message)) return 'response';
	return 'invalid';
}

/**
 * Extract assistant text from the `update` object of a `session/update`
 * notification. Only `agent_message_chunk` counts toward the answer; the ACP
 * spec streams these as incremental deltas, so callers concatenate them.
 * @param {unknown} update
 * @returns {string | undefined}
 */
export function agentMessageText(update) {
	if (!isRecord(update)) return undefined;
	if (update.sessionUpdate !== 'agent_message_chunk') return undefined;
	const content = update.content;
	if (!isRecord(content) || content.type !== 'text') return undefined;
	const text = content.text;
	return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/**
 * Map an ACP terminal `stopReason` to the shared subagent stop reason.
 *
 * `max_tokens` / `max_turn_requests` are truncations, not clean completions, so
 * they share the `error` bucket (with a diagnostic tag) per the design doc.
 * @param {string | undefined} stopReason
 * @returns {'completed' | 'aborted' | 'error'}
 */
export function mapAcpStopReason(stopReason) {
	switch (stopReason) {
		case 'end_turn':
			return 'completed';
		case 'cancelled':
			return 'aborted';
		case 'max_tokens':
		case 'max_turn_requests':
		case 'refusal':
		default:
			return 'error';
	}
}

/**
 * Render the human-readable text of an ACP/JSON-RPC error for classification.
 * @param {unknown} error
 * @returns {string}
 */
export function acpErrorText(error) {
	if (error === undefined || error === null) return '';
	if (typeof error === 'string') return error;
	if (error instanceof Error) return error.message;
	if (isRecord(error)) {
		const parts = [];
		if (typeof error.message === 'string') parts.push(error.message);
		if (error.data !== undefined) {
			try {
				parts.push(typeof error.data === 'string' ? error.data : JSON.stringify(error.data).slice(0, 4000));
			} catch {
				parts.push(String(error.data));
			}
		}
		return parts.join(' ');
	}
	return String(error);
}

/**
 * Map an ACP failure to the shared classifier, annotating stage/category.
 * @param {AcpError | unknown} error
 * @param {{exitCode?: number | null, signal?: string | null} | undefined} [outcome]
 * @param {string} [stderrText]
 * @returns {{kind: 'quota_exhausted'|'rate_limited'|'usage_error'|'unknown', retryAfterMs?: number, stage: string, category: string}}
 */
export function classifyAcpFailure(error, outcome, stderrText) {
	const parts = [];
	if (error instanceof AcpError) {
		if (error.data !== undefined) {
			try {
				parts.push(typeof error.data === 'string' ? error.data : JSON.stringify(error.data).slice(0, 4000));
			} catch {
				parts.push(String(error.data));
			}
		}
		parts.push(error.message);
	} else if (error !== undefined) {
		const rendered = acpErrorText(error);
		if (rendered.length > 0) parts.push(rendered);
	}
	if (typeof stderrText === 'string' && stderrText.length > 0) parts.push(stderrText);
	const base = classifyFailure(parts.join('\n'), outcome);
	const stage = error instanceof AcpError ? error.stage : 'unknown';
	const category = stage === 'process'
		? 'process'
		: stage === 'timeout'
			? 'timeout'
			: base.kind === 'unknown' ? 'protocol' : 'product-error';
	return { ...base, stage, category };
}

/**
 * Pick the option id for a permission request under a non-manual policy.
 * @param {unknown} options raw `params.options`
 * @param {'auto-approve' | 'first-allow' | 'reject'} policy
 * @returns {string | undefined}
 */
export function selectPermissionOption(options, policy) {
	if (!Array.isArray(options)) return undefined;
	const candidates = options.filter((option) => isRecord(option) && typeof option.optionId === 'string');
	if (candidates.length === 0) return undefined;
	if (policy === 'reject') return undefined;
	const kindOf = (option) => (typeof option.kind === 'string' ? option.kind : '');
	const firstAllow = candidates.find((option) => /^allow/i.test(kindOf(option)));
	if (policy === 'first-allow') return firstAllow?.optionId;
	// auto-approve: first allow-kind option, else the first option (mirrors
	// `--dangerously-skip-permissions`).
	return firstAllow?.optionId ?? candidates[0].optionId;
}

/**
 * Build the JSON-RPC result for a `session/request_permission` request.
 * @param {unknown} params request params.
 * @param {'auto-approve' | 'first-allow' | 'reject' | string | ((params: unknown) => string)} [policy]
 * @param {'flat' | 'nested'} [shape] response envelope shape (default `flat` per design §1.7).
 * @returns {object}
 */
export function buildPermissionResult(params, policy = 'auto-approve', shape = 'flat') {
	const options = isRecord(params) && Array.isArray(params.options) ? params.options : [];
	let optionId;
	if (typeof policy === 'function') {
		try {
			const decision = policy(params);
			optionId = typeof decision === 'string' && decision !== 'auto-approve' && decision !== 'first-allow' && decision !== 'reject'
				? decision
				: selectPermissionOption(options, decision === 'reject' ? 'reject' : decision === 'first-allow' ? 'first-allow' : 'auto-approve');
		} catch {
			optionId = undefined;
		}
	} else if (policy === 'auto-approve' || policy === 'first-allow' || policy === 'reject') {
		optionId = selectPermissionOption(options, policy);
	} else {
		// explicit optionId
		optionId = typeof policy === 'string' && policy.length > 0 ? policy : undefined;
	}
	if (shape === 'nested') {
		return optionId === undefined
			? { outcome: { outcome: 'cancelled' } }
			: { outcome: { outcome: 'selected', optionId } };
	}
	return optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId };
}

/**
 * Build the default `agy acp` argv.
 * @param {{executable: string, permissionMode?: string, extraArgs?: readonly string[]}} spec
 * @returns {string[]}
 */
export function acpArgv(spec) {
	const args = [spec.executable, 'acp'];
	for (const extra of spec.extraArgs ?? []) args.push(extra);
	return args;
}

/** Read a file for an `fs/read_text_file` server request (optional line/limit). */
async function readTextFileResult(params, cwd) {
	if (!isRecord(params) || typeof params.path !== 'string' || params.path.length === 0) {
		throw rpcError(-32602, 'fs/read_text_file: missing path');
	}
	const path = typeof cwd === 'string' && cwd.length > 0 ? resolvePath(cwd, params.path) : params.path;
	const content = await readFile(path, 'utf8');
	const line = params.line;
	if (typeof line === 'number' && line > 1) {
		const lines = content.split('\n');
		const limit = typeof params.limit === 'number' && params.limit >= 0 ? params.limit : undefined;
		return { content: (limit === undefined ? lines.slice(line - 1) : lines.slice(line - 1, line - 1 + limit)).join('\n') };
	}
	if (typeof params.limit === 'number' && params.limit >= 0) {
		return { content: content.split('\n').slice(0, params.limit).join('\n') };
	}
	return { content };
}

/** Write a file for an `fs/write_text_file` server request. */
async function writeTextFileResult(params, cwd) {
	if (!isRecord(params) || typeof params.path !== 'string' || params.path.length === 0) {
		throw rpcError(-32602, 'fs/write_text_file: missing path');
	}
	const path = typeof cwd === 'string' && cwd.length > 0 ? resolvePath(cwd, params.path) : params.path;
	await writeFile(path, typeof params.content === 'string' ? params.content : '', 'utf8');
	return null;
}

/**
 * One ACP connection over a spawned `agy acp` child.
 *
 * Events:
 *   'session_update'    (params)                — every session/update params
 *   'agent_text'        ({ sessionId, text })   — agent_message_chunk delta
 *   'permission_request'(params)                — only when policy === 'manual'
 *   'stderr'            ({ text })              — stripAnsi'd stderr
 *   'error'             (AcpError)              — non-terminal protocol error
 */
export class AcpClient extends EventEmitter {
	#spawn;
	#executable;
	#cwd;
	#env;
	#protocolVersion;
	#capabilities;
	#requestTimeoutMs;
	#promptTimeoutMs;
	#disposeGraceMs;
	#permissionPolicy;
	#permissionShape;
	#extraArgs;
	#writeStderr;
	#logger;

	#child;
	#parser;
	#stderrText = '';
	#nextId = 0;
	#pending = new Map();
	#manualPermissions = new Map();
	#sessions = new Set();
	#cancelledSessions = new Set();
	#activePrompts = new Map();
	#turn;
	#disposed = false;
	#exited = false;
	#exitOutcome;
	#protocolError;
	#started;
	#agentInfo;
	#sessionCapabilities;
	#negotiatedVersion;

	/**
	 * @param {{
	 *   spawn: (spec: object) => any,
	 *   executable: string,
	 *   cwd: string,
	 *   env?: Record<string, string>,
	 *   protocolVersion?: number,
	 *   clientCapabilities?: {fs?: boolean, terminal?: boolean},
	 *   requestTimeoutMs?: number,
	 *   promptTimeoutMs?: number,
	 *   disposeGraceMs?: number,
	 *   permissionPolicy?: 'auto-approve'|'first-allow'|'reject'|'manual',
	 *   permissionResponseShape?: 'flat'|'nested',
	 *   extraArgs?: string[],
	 *   writeStderr?: (bytes: Buffer) => void,
	 *   logger?: {warn?: (msg: string) => void, info?: (msg: string) => void},
	 * }} options
	 */
	constructor(options) {
		super();
		this.#spawn = options.spawn;
		this.#executable = options.executable;
		this.#cwd = options.cwd;
		this.#env = options.env;
		this.#protocolVersion = options.protocolVersion ?? ACP_PROTOCOL_VERSION;
		const caps = options.clientCapabilities ?? { fs: true, terminal: false };
		this.#capabilities = {
			fs: { readTextFile: caps.fs !== false, writeTextFile: caps.fs !== false },
			terminal: caps.terminal === true,
		};
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#promptTimeoutMs = options.promptTimeoutMs ?? 0;
		this.#disposeGraceMs = options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
		this.#permissionPolicy = options.permissionPolicy ?? 'auto-approve';
		this.#permissionShape = options.permissionResponseShape ?? 'flat';
		this.#extraArgs = options.extraArgs ?? [];
		this.#writeStderr = options.writeStderr;
		this.#logger = options.logger;
	}

	/** Whether the child is still running. */
	get alive() {
		return this.#child !== undefined && !this.#exited && !this.#disposed;
	}

	/** `initialize` agentInfo, once handshaken. */
	get agentInfo() {
		return this.#agentInfo;
	}

	/** `initialize` sessionCapabilities, once handshaken. */
	get sessionCapabilities() {
		return this.#sessionCapabilities;
	}

	/** Accumulated stderr from the child. */
	get stderrText() {
		return this.#stderrText;
	}

	/** Child exit outcome, once observed. */
	get exitOutcome() {
		return this.#exitOutcome;
	}

	/** First structural protocol error observed, if any. */
	get protocolError() {
		return this.#protocolError ?? this.#parser?.malformed;
	}

	/**
	 * Spawn `agy acp` and finish the initialize handshake.
	 * @returns {Promise<{protocolVersion: number, agentInfo: {name: string, version?: string}, authMethods: unknown[], sessionCapabilities: Record<string, unknown>}>}
	 */
	start() {
		if (this.#started !== undefined) return this.#started;
		this.#started = this.#startRuntime();
		return this.#started;
	}

	async #startRuntime() {
		const argv = acpArgv({ executable: this.#executable, extraArgs: this.#extraArgs });
		let child;
		try {
			child = this.#spawn({
				argv,
				cwd: this.#cwd,
				stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
				graceMs: this.#disposeGraceMs,
				env: this.#env,
			});
		} catch (error) {
			throw new AcpError({ message: `${PREFIX}: failed to spawn "${this.#executable} acp": ${thrown(error).message}`, stage: 'spawn' }, error);
		}
		this.#child = child;
		const parser = new AcpFrameParser(PREFIX);
		this.#parser = parser;
		// Swallow pipe errors so a late write after teardown cannot escape as an
		// uncaught 'error' event.
		child.stdin?.on?.('error', () => {});
		child.stdout?.on?.('error', () => {});
		child.stderr?.on?.('error', () => {});
		child.stdout?.on('data', (chunk) => {
			for (const message of parser.push(chunk)) this.#route(message);
		});
		child.stderr?.on('data', (chunk) => {
			const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
			let text = '';
			try {
				const raw = bytes.toString('utf8');
				this.#stderrText += raw;
				if (this.#stderrText.length > 16000) this.#stderrText = this.#stderrText.slice(-16000);
				text = stripAnsi(raw);
			} catch {}
			try {
				this.#writeStderr?.(bytes);
			} catch {}
			if (text.length > 0) this.#emitSafe('stderr', { text });
		});
		child.done?.then(
			(outcome) => this.#onExit(outcome, undefined),
			(error) => this.#onExit(undefined, error),
		);
		return this.#initialize();
	}

	async #initialize() {
		const result = await this.#request('initialize', {
			protocolVersion: this.#protocolVersion,
			clientCapabilities: this.#capabilities,
		}, { stage: 'initialize', timeoutMs: this.#requestTimeoutMs });
		const info = isRecord(result) ? result : {};
		if (typeof info.protocolVersion === 'number' && info.protocolVersion !== this.#protocolVersion) {
			this.#logger?.warn?.(`${PREFIX}: server negotiated protocolVersion ${info.protocolVersion} (requested ${this.#protocolVersion})`);
		}
		this.#negotiatedVersion = typeof info.protocolVersion === 'number' ? info.protocolVersion : this.#protocolVersion;
		this.#agentInfo = isRecord(info.agentInfo) && typeof info.agentInfo.name === 'string' ? info.agentInfo : undefined;
		this.#sessionCapabilities = isRecord(info.sessionCapabilities) ? info.sessionCapabilities : undefined;
		return {
			protocolVersion: this.#negotiatedVersion,
			agentInfo: this.#agentInfo ?? { name: 'Antigravity ACP Server' },
			authMethods: Array.isArray(info.authMethods) ? info.authMethods : [],
			sessionCapabilities: this.#sessionCapabilities ?? {},
		};
	}

	/**
	 * Authenticate when the server requires it.
	 * @param {string} methodId
	 * @returns {Promise<void>}
	 */
	async authenticate(methodId) {
		await this.#request('authenticate', { methodId }, { stage: 'initialize', timeoutMs: this.#requestTimeoutMs });
	}

	/**
	 * Create a new session.
	 * @param {{cwd?: string, mcpServers?: unknown[], model?: string, additionalDirectories?: string[]}} [options]
	 * @returns {Promise<{sessionId: string, models?: {availableModels?: unknown[], currentModelId?: string}}>}
	 */
	async newSession(options = {}) {
		const params = {
			cwd: options.cwd ?? this.#cwd,
			mcpServers: options.mcpServers ?? [],
		};
		if (options.model !== undefined) params.model = options.model;
		if (Array.isArray(options.additionalDirectories) && options.additionalDirectories.length > 0) params.additionalDirectories = options.additionalDirectories;
		const result = await this.#request('session/new', params, { stage: 'session', timeoutMs: this.#requestTimeoutMs });
		if (!isRecord(result) || typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
			throw new AcpError({ message: `${PREFIX}: session/new returned no sessionId`, stage: 'session' });
		}
		this.#sessions.add(result.sessionId);
		return result;
	}

	/**
	 * Set the session model (fallback when `session/new` ignores `model`).
	 * @param {string} sessionId
	 * @param {string} modelId
	 * @returns {Promise<void>}
	 */
	async setModel(sessionId, modelId) {
		await this.#request('session/set_model', { sessionId, modelId }, { stage: 'session', timeoutMs: this.#requestTimeoutMs });
	}

	/**
	 * Send one prompt turn and wait for its terminal stopReason.
	 * @param {string} sessionId
	 * @param {Array<{type: 'text', text: string}>} blocks only text blocks are accepted
	 * @param {{signal?: AbortSignal}} [options]
	 * @returns {Promise<{stopReason: string, usage?: object, text: string, content: Array<{type: string, text?: string}>, sessionId: string}>}
	 */
	async prompt(sessionId, blocks, options = {}) {
		if (typeof sessionId !== 'string' || sessionId.length === 0) throw new AcpError({ message: `${PREFIX}: prompt requires a sessionId`, stage: 'prompt' });
		if (this.#activePrompts.has(sessionId)) throw new AcpError({ message: `${PREFIX}: a prompt is already in progress for session ${sessionId}`, stage: 'prompt' });
		const normalized = normalizeBlocks(blocks);
		const turn = { sessionId, texts: [], content: [] };
		this.#activePrompts.set(sessionId, turn);
		this.#turn = turn;
		const abortCancel = () => {
			try {
				this.cancel(sessionId);
			} catch {}
		};
		try {
			const result = await this.#request('session/prompt', { sessionId, prompt: normalized }, {
				stage: 'prompt',
				timeoutMs: this.#promptTimeoutMs > 0 ? this.#promptTimeoutMs : undefined,
				signal: options.signal,
				onAbortCancel: abortCancel,
			});
			const raw = isRecord(result) ? result : {};
			const text = turn.texts.join('');
			const usage = isRecord(raw.usage) ? raw.usage : isRecord(raw._meta) && isRecord(raw._meta.usage) ? raw._meta.usage : undefined;
			return {
				stopReason: typeof raw.stopReason === 'string' ? raw.stopReason : undefined,
				...(usage === undefined ? {} : { usage }),
				text,
				content: text.trim().length > 0 ? [{ type: 'text', text }] : [],
				sessionId,
			};
		} finally {
			this.#activePrompts.delete(sessionId);
			if (this.#turn === turn) this.#turn = undefined;
		}
	}

	/**
	 * Send a `session/cancel` notification. Idempotent per session.
	 * @param {string} sessionId
	 */
	cancel(sessionId) {
		if (typeof sessionId !== 'string' || this.#cancelledSessions.has(sessionId)) return;
		this.#cancelledSessions.add(sessionId);
		try {
			this.#send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
		} catch {}
	}

	/**
	 * Close a session when the server advertises the capability.
	 * @param {string} sessionId
	 * @returns {Promise<void>}
	 */
	async closeSession(sessionId) {
		if (this.#sessionCapabilities?.close === false) {
			this.#sessions.delete(sessionId);
			return;
		}
		if (!this.#sessions.has(sessionId)) return;
		try {
			await this.#request('session/close', { sessionId }, { stage: 'session', timeoutMs: Math.min(this.#requestTimeoutMs, 5000) });
		} catch {}
		this.#sessions.delete(sessionId);
	}

	/**
	 * Answer a manual `session/request_permission` (only meaningful when policy
	 * is `'manual'`).
	 * @param {number|string} id
	 * @param {string} [optionId] omit to cancel
	 */
	respondPermission(id, optionId) {
		const entry = this.#manualPermissions.get(id);
		if (entry === undefined) return;
		this.#manualPermissions.delete(id);
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		const result = optionId === undefined
			? buildPermissionResult({ options: [] }, 'reject', this.#permissionShape)
			: buildPermissionResult({ options: [] }, optionId, this.#permissionShape);
		try {
			this.#send({ jsonrpc: '2.0', id, result });
		} catch {}
	}

	/**
	 * Terminate the child: cancel active session → end stdin → terminate tiers →
	 * waitForExit. Idempotent.
	 * @returns {Promise<void>}
	 */
	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		const child = this.#child;
		if (child === undefined) return;
		for (const sessionId of [...this.#activePrompts.keys()]) {
			try {
				this.cancel(sessionId);
			} catch {}
		}
		for (const sessionId of [...this.#sessions]) {
			// Best-effort: do not block dispose on a session/close round-trip.
			// Any still-pending request is rejected when the child exits below.
			void this.closeSession(sessionId).catch(() => {});
		}
		try {
			child.stdin?.end();
		} catch {}
		try {
			child.terminate?.();
		} catch {}
		try {
			await child.waitForExit?.();
		} catch {}
		try {
			await child.done?.catch?.(() => {});
		} catch {}
	}

	#emitSafe(event, payload) {
		if (event === 'error' && this.listenerCount('error') === 0) return;
		try {
			this.emit(event, payload);
		} catch {}
	}

	#send(message) {
		const stdin = this.#child?.stdin;
		if (stdin === undefined || stdin === null || typeof stdin.write !== 'function') {
			throw new Error(`${PREFIX}: ACP child stdin is not writable`);
		}
		if (stdin.writableEnded === true || stdin.destroyed === true) {
			throw new Error(`${PREFIX}: ACP child stdin is closed`);
		}
		stdin.write(`${JSON.stringify(message)}\n`);
	}

	#request(method, params, options = {}) {
		return new Promise((resolve, reject) => {
			if (this.#child === undefined) {
				reject(new AcpError({ message: `${PREFIX}: ACP client is not started`, stage: options.stage ?? 'protocol' }));
				return;
			}
			const id = ++this.#nextId;
			const stage = options.stage ?? 'protocol';
			const record = { method, stage, resolve: () => {}, reject: () => {} };
			const finish = () => {
				if (record.timer !== undefined) clearTimeout(record.timer);
				if (record.onAbort !== undefined && options.signal !== undefined) options.signal.removeEventListener('abort', record.onAbort);
			};
			record.resolve = (value) => {
				finish();
				resolve(value);
			};
			record.reject = (error) => {
				finish();
				reject(error);
			};
			this.#pending.set(id, record);
			if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
				record.timer = setTimeout(() => {
					if (!this.#pending.has(id)) return;
					this.#pending.delete(id);
					try {
						options.onAbortCancel?.();
					} catch {}
					record.reject(new AcpError({ message: `${PREFIX}: ACP request "${method}" timed out after ${options.timeoutMs}ms`, stage: 'timeout', method }));
				}, options.timeoutMs);
				record.timer.unref?.();
			}
			if (options.signal !== undefined) {
				if (options.signal.aborted) {
					this.#pending.delete(id);
					record.reject(new AcpError({ message: `${PREFIX}: ACP request "${method}" was aborted`, stage, method }));
					return;
				}
				record.onAbort = () => {
					this.#pending.delete(id);
					try {
						options.onAbortCancel?.();
					} catch {}
					record.reject(new AcpError({ message: `${PREFIX}: ACP request "${method}" was aborted`, stage, method }));
				};
				options.signal.addEventListener('abort', record.onAbort, { once: true });
			}
			try {
				this.#send({ jsonrpc: '2.0', id, method, params });
			} catch (error) {
				this.#pending.delete(id);
				record.reject(new AcpError({ message: `${PREFIX}: failed to send "${method}": ${thrown(error).message}`, stage, method }, error));
			}
		});
	}

	#route(message) {
		switch (classifyMessage(message)) {
			case 'response':
				this.#resolveResponse(message);
				return;
			case 'request':
				void this.#handleServerRequest(message);
				return;
			case 'notification':
				this.#handleNotification(message);
				return;
			default:
				this.#protocolError ??= `${PREFIX}: ACP emitted a non-JSON-RPC message`;
				this.#emitSafe('error', new AcpError({ message: this.#protocolError, stage: 'protocol' }));
		}
	}

	#resolveResponse(message) {
		const record = this.#pending.get(message.id);
		if (record === undefined) return;
		this.#pending.delete(message.id);
		if ('error' in message) {
			const error = isRecord(message.error) ? message.error : {};
			record.reject(new AcpError({
				message: typeof error.message === 'string' ? error.message : `${PREFIX}: ${record.method} failed`,
				code: typeof error.code === 'number' ? error.code : undefined,
				data: error.data,
				method: record.method,
				stage: record.stage,
			}));
		} else {
			record.resolve(message.result);
		}
	}

	async #handleServerRequest(message) {
		if (message.method === 'session/request_permission' && this.#permissionPolicy === 'manual') {
			this.#handleManualPermission(message);
			return;
		}
		try {
			const result = await this.#dispatchServerRequest(message.method, message.params);
			this.#send({ jsonrpc: '2.0', id: message.id, result });
		} catch (error) {
			const code = typeof error?.code === 'number' ? error.code : -32603;
			try {
				this.#send({ jsonrpc: '2.0', id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
			} catch {}
		}
	}

	async #dispatchServerRequest(method, params) {
		switch (method) {
			case 'session/request_permission':
				return buildPermissionResult(params, this.#permissionPolicy, this.#permissionShape);
			case 'fs/read_text_file':
				return readTextFileResult(params, this.#cwd);
			case 'fs/write_text_file':
				return writeTextFileResult(params, this.#cwd);
			default:
				throw rpcError(-32601, `${PREFIX}: unsupported ACP client method "${method}"`);
		}
	}

	#handleManualPermission(message) {
		const id = message.id;
		const respond = (optionId) => this.respondPermission(id, optionId);
		const timer = setTimeout(() => {
			// Never leave the agent hanging: fall back to cancel.
			this.respondPermission(id, undefined);
		}, this.#requestTimeoutMs);
		timer.unref?.();
		this.#manualPermissions.set(id, { timer });
		this.#emitSafe('permission_request', { id, params: message.params, respond });
	}

	#handleNotification(message) {
		if (message.method === 'session/update' && isRecord(message.params)) {
			const params = message.params;
			this.#emitSafe('session_update', params);
			const update = params.update;
			if (isRecord(update)) {
				const text = agentMessageText(update);
				if (text !== undefined) {
					const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
					this.#emitSafe('agent_text', { sessionId, text });
					const turn = this.#turn;
					if (turn !== undefined && (sessionId === undefined || sessionId === turn.sessionId)) {
						turn.texts.push(text);
						turn.content.push({ type: 'text', text });
					}
				}
			}
		}
	}

	#onExit(outcome, error) {
		this.#exited = true;
		if (error === undefined) this.#exitOutcome = outcome;
		const parser = this.#parser;
		if (parser !== undefined) {
			try {
				for (const message of parser.end()) this.#route(message);
			} catch {}
		}
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const record of pending) {
			record.reject(new AcpError({ message: `${PREFIX}: ACP server exited before responding to "${record.method}"`, stage: 'process', method: record.method }));
		}
		const abnormal = error !== undefined || (isRecord(outcome) && typeof outcome.exitCode === 'number' && outcome.exitCode !== 0);
		if (abnormal) {
			this.#emitSafe('error', new AcpError({
				message: `${PREFIX}: ACP server exited${isRecord(outcome) && typeof outcome.exitCode === 'number' ? ` with code ${outcome.exitCode}` : ''}`,
				stage: 'process',
			}, error));
		}
	}
}

/**
 * Normalize prompt blocks to `{ type: 'text', text }`.
 * @param {readonly {type: string, text?: string}[]} blocks
 * @returns {{type: 'text', text: string}[]}
 */
function normalizeBlocks(blocks) {
	if (!Array.isArray(blocks) || blocks.length === 0) throw new AcpError({ message: `${PREFIX}: prompt must be a non-empty array of text blocks`, stage: 'prompt' });
	return blocks.map((block) => {
		if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
			throw new AcpError({ message: `${PREFIX}: prompt must contain only text blocks`, stage: 'prompt' });
		}
		return { type: 'text', text: block.text };
	});
}

/** Build the legacy stream-json spec from an ACP spec (for pre-prompt fallback). */
function buildStreamSpec(spec) {
	return {
		cwd: spec.cwd,
		executable: spec.executable,
		env: spec.env,
		permissionMode: spec.permissionMode,
		...(spec.model === undefined ? {} : { model: spec.model }),
		...(spec.effort === undefined ? {} : { effort: spec.effort }),
		...(spec.promptPrefix === undefined ? {} : { promptPrefix: spec.promptPrefix }),
		extraArgs: spec.extraArgs ?? [],
		newProject: spec.newProject,
		projectName: spec.projectName,
		...(spec.printTimeout === undefined ? {} : { printTimeout: spec.printTimeout }),
		...(spec.jsonSchema === undefined ? {} : { jsonSchema: spec.jsonSchema }),
		...(spec.addDirs === undefined ? {} : { addDirs: spec.addDirs }),
		...(spec.fallbackModel === undefined ? {} : { fallbackModel: spec.fallbackModel }),
		retryOnRateLimit: spec.retryOnRateLimit === true,
		disposeGraceMs: spec.disposeGraceMs,
		spawn: spec.spawn,
		writeStderr: spec.writeStderr,
		onError: spec.onError,
		...(spec.report === undefined ? {} : { report: spec.report }),
	};
}

/**
 * Start one ACP run. Returns a handle shaped like
 * `lib/run.js#startAntigravityRun`.
 * @param {{prompt: readonly {type: string, text?: string}[], signal: AbortSignal, cwd?: string}} request
 * @param {object} spec AcpRunSpec (see design §3.3).
 * @returns {Promise<object>}
 */
export async function startAcpRun(request, spec) {
	if (request.signal.aborted) throw new Error('subagent-antigravity: request was aborted before ACP startup');
	const taskText = textTask(request.prompt);
	const promptText = typeof spec.promptPrefix === 'string' && spec.promptPrefix.length > 0
		? `${spec.promptPrefix}\n\n${taskText}`
		: taskText;
	const blocks = [{ type: 'text', text: promptText }];
	const desiredModel = typeof spec.model === 'string' && spec.model.length > 0 ? spec.model : DEFAULT_MODEL;
	const logger = spec.logger;

	const client = new AcpClient({
		spawn: spec.spawn,
		executable: spec.executable,
		cwd: spec.cwd,
		env: spec.env,
		protocolVersion: spec.acpProtocolVersion,
		clientCapabilities: { fs: true, terminal: false },
		requestTimeoutMs: spec.acpRequestTimeoutMs,
		promptTimeoutMs: spec.acpPromptTimeoutMs,
		disposeGraceMs: spec.disposeGraceMs,
		permissionPolicy: spec.acpPermissionPolicy,
		permissionResponseShape: spec.acpPermissionResponseShape,
		extraArgs: spec.acpExtraArgs,
		writeStderr: spec.writeStderr,
		logger,
	});

	let sessionId;
	try {
		await client.start();
		const session = await client.newSession({
			cwd: spec.cwd,
			...(Array.isArray(spec.addDirs) && spec.addDirs.length > 0 ? { additionalDirectories: spec.addDirs } : {}),
			model: desiredModel,
		});
		sessionId = session.sessionId;
		const currentModel = session.models?.currentModelId;
		if (currentModel !== desiredModel) {
			try {
				await client.setModel(sessionId, desiredModel);
				const note = `${PREFIX}: session/new ignored model "${desiredModel}" (currentModelId=${currentModel ?? 'unknown'}); applied via session/set_model (server returns no readback)`;
				if (typeof logger?.info === 'function') logger.info(note);
				else logger?.warn?.(note);
			} catch (error) {
				logger?.warn?.(`${PREFIX}: failed to apply model "${desiredModel}" via session/set_model: ${thrown(error).message}`);
			}
		}
	} catch (error) {
		const failure = classifyAcpFailure(error, client.exitOutcome, client.stderrText);
		if (spec.report !== undefined) spec.report.classification = { kind: failure.kind, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
		const combined = `${acpErrorText(error)}\n${client.stderrText}`;
		const authFailure = /auth|login|sign[ -]?in|credential|unauthor/i.test(combined);
		await client.dispose().catch(() => {});
		const canFallback = spec.acpFallbackToStreamJson !== false && failure.stage !== 'spawn' && !authFailure;
		if (canFallback) {
			logger?.warn?.(`ACP unavailable (${failure.stage}: ${acpErrorText(error)}); falling back to stream-json`);
			return startAntigravityRun(request, buildStreamSpec(spec));
		}
		throw error instanceof AcpError ? error : new AcpError({ message: acpErrorText(error), stage: failure.stage === 'unknown' ? 'initialize' : failure.stage }, error);
	}

	const runAbort = new AbortController();
	let finalOutput = [];
	let diagnostic;
	const requestCancel = () => {
		if (!runAbort.signal.aborted) runAbort.abort(new Error('subagent-antigravity: ACP run cancelled locally'));
		try {
			client.cancel(sessionId);
		} catch {}
	};
	const onAbort = () => requestCancel();
	request.signal.addEventListener('abort', onAbort, { once: true });

	const result = settleRunResult({
		attempt: async () => {
			try {
				const promptResult = await client.prompt(sessionId, blocks, { signal: runAbort.signal });
				const stopReason = mapAcpStopReason(promptResult.stopReason);
				finalOutput = promptResult.content;
				if (stopReason === 'completed') {
					if (spec.report !== undefined) spec.report.classification = { kind: 'ok' };
				} else {
					const failure = classifyAcpFailure(new AcpError({ message: `${PREFIX}: ACP turn ended with stopReason ${JSON.stringify(promptResult.stopReason)}`, stage: 'turn' }), undefined, client.stderrText);
					if (spec.report !== undefined) spec.report.classification = { kind: failure.kind, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
					diagnostic = `${new AcpError({ message: 'subagent-antigravity: Product subagent failure (ACP; stage: turn)', stage: 'turn' }).message} [${failure.kind}]`;
					await client.dispose().catch(() => {});
				}
				return { output: finalOutput, stopReason };
			} catch (error) {
				const failure = classifyAcpFailure(error, client.exitOutcome, client.stderrText);
				if (spec.report !== undefined) spec.report.classification = { kind: failure.kind, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
				diagnostic = `${new AcpError({ message: 'subagent-antigravity: Product subagent failure (ACP)', stage: failure.stage }).message} [${failure.kind}]`;
				await client.dispose().catch(() => {});
				throw error instanceof AcpError ? error : new AcpError({ message: acpErrorText(error), stage: failure.stage === 'unknown' ? 'prompt' : failure.stage }, error);
			}
		},
		collectOutput: () => finalOutput,
		collectDiagnostic: () => diagnostic,
		cancelled: () => runAbort.signal.aborted,
		onError: spec.onError,
		signal: request.signal,
		onAbort,
	});

	return subprocessRunHandle({
		id: brandString(randomUUID()),
		result,
		signal: request.signal,
		onAbort,
		requestCancel,
		teardown: async () => {
			try {
				await client.dispose();
			} catch {}
		},
	});
}

/**
 * Same retry semantics as `lib/run.js#startAntigravityRunWithRetry`: only when
 * `fallbackModel` / `retryOnRateLimit` are explicitly configured.
 * @param {object} request
 * @param {object} spec AcpRunSpec & {fallbackModel?: string, retryOnRateLimit?: boolean}
 * @returns {Promise<object>}
 */
export async function startAcpRunWithRetry(request, spec) {
	const wantFallback = typeof spec.fallbackModel === 'string' && spec.fallbackModel.length > 0;
	const wantRateRetry = spec.retryOnRateLimit === true;
	if (!wantFallback && !wantRateRetry) return startAcpRun(request, spec);
	const firstReport = {};
	const first = await startAcpRun(request, { ...spec, report: firstReport });
	let active = first;
	const result = (async () => {
		try {
			let current = first;
			let currentReport = firstReport;
			let attempt = 0;
			for (;;) {
				const settled = await current.result;
				if (settled.stopReason !== 'error') return settled;
				const info = currentReport.classification ?? { kind: 'unknown' };
				const canFallback = attempt === 0 && wantFallback && (info.kind === 'quota_exhausted' || info.kind === 'rate_limited');
				const canRateRetry = attempt === 0 && wantRateRetry && info.kind === 'rate_limited';
				if (!canFallback && !canRateRetry) return settled;
				await current.dispose().catch(() => {});
				currentReport = {};
				if (canFallback) {
					current = await startAcpRun(request, { ...spec, model: spec.fallbackModel, report: currentReport });
				} else {
					await delay(Math.min(info.retryAfterMs ?? 2000, 15000), undefined, { signal: request.signal });
					current = await startAcpRun(request, { ...spec, report: currentReport });
				}
				active = current;
				attempt += 1;
			}
		} catch (error) {
			// The seam contract says a child-level failure must resolve with
			// stopReason 'error', never reject the run handle.
			if (spec.report !== undefined) {
				const failure = classifyAcpFailure(error, undefined);
				spec.report.classification = { kind: failure.kind, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
			}
			return { output: [], stopReason: request.signal.aborted ? 'aborted' : 'error' };
		}
	})();
	result.catch(() => {});
	return subprocessRunHandle({
		id: brandString(randomUUID()),
		result,
		signal: request.signal,
		onAbort: () => {},
		// The inner `SubagentRun` only exposes id/result/dispose(); dispose() is
		// the cancellation + teardown primitive. Route both hooks through it.
		requestCancel: () => {
			try {
				void active.dispose().catch(() => {});
			} catch {}
		},
		teardown: async () => {
			try {
				await active.dispose();
			} catch {}
		},
	});
}
