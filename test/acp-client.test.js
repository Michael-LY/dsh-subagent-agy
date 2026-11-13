import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { registerHooks } from 'node:module';

// `lib/acp-client.js` imports a few Host packages unavailable in a plain
// checkout. Resolve them to tiny data-URL stubs so the pure protocol layers can
// be imported without a DSH runtime. The subagent stub mirrors the real
// `settleRunResult` / `subprocessRunHandle` contract closely enough that the
// high-level `startAcpRunWithRetry` wrapper can be exercised: `subprocessRunHandle`
// exposes only `{ id, result, dispose }` (the shape the review flagged), and
// `settleRunResult` turns a thrown attempt into an `error` result.
const SUBAGENT_STUB = `data:text/javascript,${encodeURIComponent(`
export const settleRunResult = async (parts) => {
	try {
		return await parts.attempt();
	} catch (error) {
		const output = typeof parts.collectOutput === 'function' ? parts.collectOutput() : [];
		const cancelled = typeof parts.cancelled === 'function' && parts.cancelled();
		return { output: Array.isArray(output) ? output : [], stopReason: cancelled ? 'aborted' : 'error' };
	}
};
export const subprocessRunHandle = (parts) => {
	let disposal;
	return {
		id: parts.id,
		result: parts.result,
		dispose() {
			if (disposal !== undefined) return disposal;
			try { parts.signal?.removeEventListener?.('abort', parts.onAbort); } catch {}
			try { parts.requestCancel?.(); } catch {}
			disposal = Promise.resolve().then(() => parts.teardown?.()).catch(() => {});
			return disposal;
		},
	};
};
`)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '@deepseek-ai/dsh-brand') {
			return { url: 'data:text/javascript,export const brandString = (value) => value;', shortCircuit: true };
		}
		if (specifier === '@deepseek-ai/dsh-subagent') {
			return { url: SUBAGENT_STUB, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const {
	ACP_PROTOCOL_VERSION,
	AcpClient,
	AcpFrameParser,
	agentMessageText,
	acpArgv,
	buildPermissionResult,
	classifyAcpFailure,
	classifyMessage,
	mapAcpStopReason,
	selectPermissionOption,
	startAcpRun,
	startAcpRunWithRetry,
} = await import('../lib/acp-client.js');

/** 把若干对象拼成 NDJSON 文本（带结尾换行）。 */
function ndjson(...messages) {
	return messages.map((message) => `${JSON.stringify(message)}\n`).join('');
}

/**
 * 造一个假子进程：内存 PassThrough 模拟 stdout/stderr，Writable 模拟 stdin。
 * `onRequest(message, reply)` 每收到一条客户端写入就调用；`reply` 往 stdout
 * 追加一行 JSON。全程不创建真实进程。
 */
function makeFakeChild(onRequest) {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let buffer = '';
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			buffer += chunk.toString('utf8');
			let index;
			while ((index = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim().length === 0) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				onRequest(message, (reply) => stdout.write(`${JSON.stringify(reply)}\n`));
			}
			callback();
		},
	});
	let resolveDone;
	let terminated = false;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});
	return {
		stdout,
		stderr,
		stdin,
		done,
		get terminated() {
			return terminated;
		},
		terminate() {
			terminated = true;
			resolveDone({ exitCode: 0, signal: null });
		},
		async waitForExit() {},
	};
}

/** 单个假子进程的 spawn。 */
function fakeSpawn(onRequest) {
	return () => makeFakeChild(onRequest);
}

/** 每次 spawn 依次使用不同 handler（模拟多次 startAcpRun）。 */
function fakeSpawnSequence(handlers) {
	let index = 0;
	return () => makeFakeChild(handlers[Math.min(index++, handlers.length - 1)]);
}

test('AcpFrameParser: 7 字节分片重组，多帧与半帧都能处理', () => {
	const payload = ndjson(
		{ jsonrpc: '2.0', id: 1, result: { ok: true } },
		{ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } },
	);
	const parser = new AcpFrameParser('test');
	const frames = [];
	for (let i = 0; i < payload.length; i += 7) frames.push(...parser.push(payload.slice(i, i + 7)));
	frames.push(...parser.end());

	assert.equal(frames.length, 2);
	assert.deepEqual(frames[0], { jsonrpc: '2.0', id: 1, result: { ok: true } });
	assert.equal(agentMessageText(frames[1].params.update), 'hi');
	assert.equal(parser.malformed, undefined);
});

test('AcpFrameParser: 一个 chunk 多帧 + 半帧续传', () => {
	const first = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
	const second = JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} });
	const parser = new AcpFrameParser('test');

	const frames = parser.push(`${first}\n${second.slice(0, 5)}`);
	assert.equal(frames.length, 1);
	assert.deepEqual(frames[0], { jsonrpc: '2.0', id: 1, result: {} });

	const more = parser.push(`${second.slice(5)}\n`);
	assert.equal(more.length, 1);
	assert.deepEqual(more[0], { jsonrpc: '2.0', id: 2, result: {} });
});

test('AcpFrameParser: 多字节 UTF-8 跨 chunk 边界正确重组', () => {
	const payload = `${JSON.stringify({
		jsonrpc: '2.0',
		method: 'session/update',
		params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '中文答案' } } },
	})}\n`;
	const bytes = Buffer.from(payload, 'utf8');
	const parser = new AcpFrameParser('test');
	const frames = [];
	for (let i = 0; i < bytes.length; i += 5) frames.push(...parser.push(bytes.subarray(i, i + 5)));
	frames.push(...parser.end());

	assert.equal(frames.length, 1);
	assert.equal(agentMessageText(frames[0].params.update), '中文答案');
});

test('AcpFrameParser: 无结尾换行的尾帧由 end() 补出', () => {
	const parser = new AcpFrameParser('test');
	assert.equal(parser.push(JSON.stringify({ jsonrpc: '2.0', id: 9, result: { ok: true } })).length, 0);
	const frames = parser.end();
	assert.equal(frames.length, 1);
	assert.deepEqual(frames[0], { jsonrpc: '2.0', id: 9, result: { ok: true } });
});

test('AcpFrameParser: 非 JSON 行记 malformed 但不中断后续帧', () => {
	const parser = new AcpFrameParser('test');
	const frames = parser.push(`not json\n${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
	assert.equal(frames.length, 1);
	assert.match(parser.malformed, /non-JSON line/);
});

test('classifyMessage: 区分 response / request / notification / invalid', () => {
	assert.equal(classifyMessage({ jsonrpc: '2.0', id: 1, result: {} }), 'response');
	assert.equal(classifyMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }), 'response');
	assert.equal(classifyMessage({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: {} }), 'request');
	assert.equal(classifyMessage({ jsonrpc: '2.0', method: 'session/update', params: {} }), 'notification');
	assert.equal(classifyMessage({ jsonrpc: '2.0' }), 'invalid');
	assert.equal(classifyMessage('nope'), 'invalid');
	assert.equal(classifyMessage(null), 'invalid');
});

test('agentMessageText: 只取 agent_message_chunk 的 text 内容', () => {
	assert.equal(agentMessageText({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'abc' } }), 'abc');
	assert.equal(agentMessageText({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }), undefined);
	assert.equal(agentMessageText({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } }), undefined);
	assert.equal(agentMessageText({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } }), undefined);
	assert.equal(agentMessageText(undefined), undefined);
});

test('mapAcpStopReason: ACP 终态映射到共享 stopReason（max_* 视为 error）', () => {
	assert.equal(mapAcpStopReason('end_turn'), 'completed');
	assert.equal(mapAcpStopReason('max_tokens'), 'error');
	assert.equal(mapAcpStopReason('max_turn_requests'), 'error');
	assert.equal(mapAcpStopReason('cancelled'), 'aborted');
	assert.equal(mapAcpStopReason('refusal'), 'error');
	assert.equal(mapAcpStopReason('weird'), 'error');
	assert.equal(mapAcpStopReason(undefined), 'error');
});

test('classifyAcpFailure: 复用 classifyFailure，并补 stage/category', () => {
	assert.equal(classifyAcpFailure('429 too many requests', { exitCode: 1 }).kind, 'rate_limited');
	assert.equal(classifyAcpFailure({ message: 'quota limit exceeded' }, { exitCode: 1 }).kind, 'quota_exhausted');
	assert.equal(classifyAcpFailure({ message: 'whatever', data: 'insufficient credits' }, { exitCode: 1 }).kind, 'quota_exhausted');
	assert.equal(classifyAcpFailure('anything', { exitCode: 2 }).kind, 'usage_error');
	const unknown = classifyAcpFailure(undefined, undefined);
	assert.equal(unknown.kind, 'unknown');
	assert.equal(unknown.stage, 'unknown');
	assert.equal(unknown.category, 'protocol');
	assert.equal(classifyAcpFailure(new (Object.getPrototypeOf(new Error()).constructor)('x'), undefined).stage, 'unknown');
});

test('permission: 策略选择 + ACP v1 嵌套结果形状', () => {
	const options = [
		{ optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
		{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' },
	];
	assert.equal(selectPermissionOption(options, 'auto-approve'), 'allow-1');
	assert.equal(selectPermissionOption(options, 'first-allow'), 'allow-1');
	assert.equal(selectPermissionOption(options, 'reject'), undefined);
	// ACP v1 要求 outcome 是 RequestPermissionOutcome 对象; 扁平字符串会被 agy 判为
	// `cannot unmarshal string into Go struct field ... of type acp.AllowedOutcome`。
	assert.deepEqual(buildPermissionResult({ options }, 'auto-approve'), { outcome: { outcome: 'selected', optionId: 'allow-1' } });
	assert.deepEqual(buildPermissionResult({ options }, 'reject'), { outcome: { outcome: 'cancelled' } });
	assert.deepEqual(buildPermissionResult({ options }, 'allow-1'), { outcome: { outcome: 'selected', optionId: 'allow-1' } });
	assert.deepEqual(buildPermissionResult({ options: [] }, 'auto-approve'), { outcome: { outcome: 'cancelled' } });
	// 扁平形状仍可显式 opt-in（兼容按旧设计文档实现的 agent）。
	assert.deepEqual(buildPermissionResult({ options }, 'auto-approve', 'flat'), { outcome: 'selected', optionId: 'allow-1' });
	assert.deepEqual(buildPermissionResult({ options }, 'reject', 'flat'), { outcome: 'cancelled' });
});

test('acpArgv: agy acp 加 extraArgs', () => {
	assert.deepEqual(acpArgv({ executable: 'agy.exe' }), ['agy.exe', 'acp']);
	assert.deepEqual(acpArgv({ executable: 'agy.exe', extraArgs: ['--foo'] }), ['agy.exe', 'acp', '--foo']);
});

test('AcpClient: start() 内置握手 + 权限自动允许 + 文本增量收集', async () => {
	const requests = [];
	const permissionResponses = [];
	const spawn = fakeSpawn((message, reply) => {
		if (message.id === 900 && 'result' in message) {
			permissionResponses.push(message.result);
			return;
		}
		requests.push(message);
		if (message.method === 'initialize') {
			reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.5' }, authMethods: [], sessionCapabilities: { load: true } } });
		} else if (message.method === 'session/new') {
			reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-1', models: { availableModels: [] } } });
		} else if (message.method === 'session/prompt') {
			reply({
				jsonrpc: '2.0',
				id: 900,
				method: 'session/request_permission',
				params: {
					sessionId: 'sess-1',
					toolCall: {},
					options: [
						{ optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
						{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' },
					],
				},
			});
			setImmediate(() => {
				reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'O' } } } });
				reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'K' } } } });
				reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } });
				reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
			});
		}
	});

	const client = new AcpClient({ spawn, cwd: 'C:/ws', executable: 'agy.exe', requestTimeoutMs: 5000 });
	const init = await client.start();
	assert.equal(init.agentInfo.name, 'Antigravity ACP Server');
	assert.equal(client.agentInfo.version, '1.5.5');
	const initRequest = requests.find((item) => item.method === 'initialize');
	assert.equal(initRequest.params.protocolVersion, ACP_PROTOCOL_VERSION);
	assert.deepEqual(initRequest.params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: false });

	const session = await client.newSession();
	assert.equal(session.sessionId, 'sess-1');
	const newSessionRequest = requests.find((item) => item.method === 'session/new');
	assert.deepEqual(newSessionRequest.params, { cwd: 'C:/ws', mcpServers: [] });

	const agentTexts = [];
	client.on('agent_text', (event) => agentTexts.push(event.text));
	const outcome = await client.prompt('sess-1', [{ type: 'text', text: 'hi' }]);
	assert.equal(outcome.text, 'OK');
	assert.equal(outcome.stopReason, 'end_turn');
	assert.deepEqual(outcome.usage, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
	assert.deepEqual(agentTexts, ['O', 'K']);
	assert.deepEqual(permissionResponses, [{ outcome: { outcome: 'selected', optionId: 'allow-1' } }]);

	await client.dispose();
});

test('AcpClient: permissionPolicy=reject 时回 cancelled', async () => {
	const permissionResponses = [];
	const spawn = fakeSpawn((message, reply) => {
		if (message.id === 42 && 'result' in message) {
			permissionResponses.push(message.result);
			return;
		}
		if (message.method === 'initialize') {
			reply({ jsonrpc: '2.0', id: message.id, result: { agentInfo: { name: 'x' }, authMethods: [], sessionCapabilities: {} } });
		} else if (message.method === 'session/new') {
			reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's', models: { availableModels: [] } } });
		} else if (message.method === 'session/prompt') {
			reply({
				jsonrpc: '2.0',
				id: 42,
				method: 'session/request_permission',
				params: { sessionId: 's', toolCall: {}, options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }] },
			});
			setImmediate(() => reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'cancelled' } }));
		}
	});
	const client = new AcpClient({ spawn, cwd: 'C:/ws', executable: 'agy.exe', permissionPolicy: 'reject', requestTimeoutMs: 5000 });
	await client.start();
	await client.newSession();
	const outcome = await client.prompt('s', [{ type: 'text', text: 'go' }]);
	assert.equal(outcome.stopReason, 'cancelled');
	assert.deepEqual(permissionResponses, [{ outcome: { outcome: 'cancelled' } }]);
	await client.dispose();
});

test('AcpClient: 请求超时以 AcpError(stage=timeout) 拒绝', async () => {
	const spawn = fakeSpawn(() => {
		/* 永不回复 */
	});
	const client = new AcpClient({ spawn, cwd: 'C:/ws', executable: 'agy.exe', requestTimeoutMs: 20 });
	await assert.rejects(client.start(), (error) => error.name === 'AcpError' && error.stage === 'timeout');
	await client.dispose();
});

test('AcpClient: JSON-RPC error 响应以 AcpError 拒绝，保留 code/stage', async () => {
	const spawn = fakeSpawn((message, reply) => {
		if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'invalid request' } });
	});
	const client = new AcpClient({ spawn, cwd: 'C:/ws', executable: 'agy.exe', requestTimeoutMs: 5000 });
	await assert.rejects(client.start(), (error) => error.name === 'AcpError' && error.code === -32600 && error.stage === 'initialize');
	await client.dispose();
});

test('startAcpRun: 握手失败且禁用回退时抛 AcpError', async () => {
	const spawn = fakeSpawn((message, reply) => {
		if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
	});
	const controller = new AbortController();
	await assert.rejects(
		startAcpRun(
			{ prompt: [{ type: 'text', text: 'hi' }], signal: controller.signal, cwd: 'C:/ws' },
			{
				cwd: 'C:/ws',
				executable: 'agy.exe',
				env: {},
				permissionMode: 'dangerously-skip-permissions',
				acpFallbackToStreamJson: false,
				disposeGraceMs: 1000,
				spawn,
				writeStderr: () => {},
				onError: () => {},
			},
		),
		(error) => error.name === 'AcpError' && error.stage === 'initialize',
	);
});

test('startAcpRun: 成功返回 completed，addDirs 映射到 session/new.additionalDirectories 且 terminal=false', async () => {
	const requests = [];
	const spawn = fakeSpawn((message, reply) => {
		requests.push(message);
		if (message.method === 'initialize') {
			reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server' }, authMethods: [], sessionCapabilities: {} } });
		} else if (message.method === 'session/new') {
			reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sx', models: { availableModels: [], currentModelId: 'gemini-3.8-flash-medium' } } });
		} else if (message.method === 'session/set_model') {
			reply({ jsonrpc: '2.0', id: message.id, result: {} });
		} else if (message.method === 'session/prompt') {
			setImmediate(() => {
				reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sx', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HELLO' } } } });
				reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { totalTokens: 1 } } });
			});
		}
	});
	const controller = new AbortController();
	const handle = await startAcpRun(
		{ prompt: [{ type: 'text', text: 'hi' }], signal: controller.signal, cwd: 'C:/ws' },
		{
			cwd: 'C:/ws',
			executable: 'agy.exe',
			env: {},
			permissionMode: 'dangerously-skip-permissions',
			addDirs: ['C:/extra'],
			acpFallbackToStreamJson: false,
			disposeGraceMs: 1000,
			spawn,
			writeStderr: () => {},
			onError: () => {},
		},
	);
	const settled = await handle.result;
	assert.equal(settled.stopReason, 'completed');
	assert.equal(settled.output[0].text, 'HELLO');
	const initRequest = requests.find((item) => item.method === 'initialize');
	assert.equal(initRequest.params.clientCapabilities.terminal, false);
	const newSessionRequest = requests.find((item) => item.method === 'session/new');
	assert.deepEqual(newSessionRequest.params.additionalDirectories, ['C:/extra']);
	assert.equal(newSessionRequest.params.model, 'gemini-3.8-flash-medium', '未显式配置 model 时默认 flash');
	await handle.dispose();
});

test('startAcpRun: 只有 Gemini 基础名拼 effort 后缀，claude/gpt 保持原样', async () => {
	// claude 系没有 effort 档位（CLI 直接拒绝 --effort），拼上就是 CLI 从未发布过的 id。
	const cases = [
		['gemini-3.8-flash', 'high', 'gemini-3.8-flash-high'],
		['gemini-3.8-flash-medium', 'high', 'gemini-3.8-flash-medium'],
		['claude-sonnet-4-6', 'high', 'claude-sonnet-4-6'],
		['claude-opus-4-6-thinking', 'high', 'claude-opus-4-6-thinking'],
		['gpt-oss-120b-medium', 'high', 'gpt-oss-120b-medium'],
	];
	for (const [model, effort, expected] of cases) {
		const requests = [];
		const spawn = fakeSpawn((message, reply) => {
			requests.push(message);
			if (message.method === 'initialize') {
				reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server' }, authMethods: [], sessionCapabilities: {} } });
			} else if (message.method === 'session/new') {
				reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sm', models: { availableModels: [], currentModelId: message.params.model } } });
			} else if (message.method === 'session/prompt') {
				setImmediate(() => reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }));
			}
		});
		const controller = new AbortController();
		const handle = await startAcpRun(
			{ prompt: [{ type: 'text', text: 'hi' }], signal: controller.signal, cwd: 'C:/ws' },
			{
				cwd: 'C:/ws',
				executable: 'agy.exe',
				env: {},
				permissionMode: 'dangerously-skip-permissions',
				model,
				effort,
				acpFallbackToStreamJson: false,
				disposeGraceMs: 1000,
				spawn,
				writeStderr: () => {},
				onError: () => {},
			},
		);
		await handle.result;
		const newSession = requests.find((item) => item.method === 'session/new');
		assert.equal(newSession.params.model, expected, `${model} 应发送 ${expected}`);
		await handle.dispose();
	}
});

test('startAcpRunWithRetry: 首轮 quota 失败后按 fallbackModel 重试成功（使用 dispose 而非不存在的 teardown）', async () => {
	let spawnCount = 0;
	const secondRequests = [];
	const baseSpawn = fakeSpawnSequence([
		// 第一轮：prompt 返回配额错误
		(message, reply) => {
			if (message.method === 'initialize') {
				reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'x' }, authMethods: [], sessionCapabilities: {} } });
			} else if (message.method === 'session/new') {
				reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1', models: { availableModels: [], currentModelId: 'm0' } } });
			} else if (message.method === 'session/set_model') {
				reply({ jsonrpc: '2.0', id: message.id, result: {} });
			} else if (message.method === 'session/prompt') {
				reply({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'quota limit exceeded' } });
			}
		},
		// 第二轮（fallbackModel）：正常返回
		(message, reply) => {
			secondRequests.push(message);
			if (message.method === 'initialize') {
				reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'x' }, authMethods: [], sessionCapabilities: {} } });
			} else if (message.method === 'session/new') {
				reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's2', models: { availableModels: [], currentModelId: 'fallback-model' } } });
			} else if (message.method === 'session/set_model') {
				reply({ jsonrpc: '2.0', id: message.id, result: {} });
			} else if (message.method === 'session/prompt') {
				setImmediate(() => {
					reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
					reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { totalTokens: 1 } } });
				});
			}
		},
	]);
	const spawn = () => {
		spawnCount += 1;
		return baseSpawn();
	};
	const controller = new AbortController();
	const handle = await startAcpRunWithRetry(
		{ prompt: [{ type: 'text', text: 'hi' }], signal: controller.signal, cwd: 'C:/ws' },
		{
			cwd: 'C:/ws',
			executable: 'agy.exe',
			env: {},
			permissionMode: 'dangerously-skip-permissions',
			fallbackModel: 'fallback-model',
			retryOnRateLimit: false,
			acpFallbackToStreamJson: false,
			disposeGraceMs: 1000,
			spawn,
			writeStderr: () => {},
			onError: () => {},
		},
	);
	const settled = await handle.result;
	assert.equal(settled.stopReason, 'completed');
	assert.equal(settled.output[0].text, 'OK');
	assert.equal(spawnCount, 2, '应发生第二次 spawn（fallbackModel 重试）');
	const secondNewSession = secondRequests.find((item) => item.method === 'session/new');
	assert.equal(secondNewSession.params.model, 'fallback-model', '重试时显式 fallbackModel 覆盖默认 flash');
	await handle.dispose();
});

test('startAcpRunWithRetry: 首轮成功时不重试，dispose 回收内层 agy acp', async () => {
	const children = [];
	const baseSpawn = fakeSpawn((message, reply) => {
		if (message.method === 'initialize') {
			reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'x' }, authMethods: [], sessionCapabilities: {} } });
		} else if (message.method === 'session/new') {
			reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1', models: { availableModels: [], currentModelId: 'gemini-3.8-flash-medium' } } });
		} else if (message.method === 'session/set_model') {
			reply({ jsonrpc: '2.0', id: message.id, result: {} });
		} else if (message.method === 'session/prompt') {
			setImmediate(() => {
				reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
				reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { totalTokens: 1 } } });
			});
		}
	});
	const spawn = () => {
		const child = baseSpawn();
		children.push(child);
		return child;
	};
	const controller = new AbortController();
	const handle = await startAcpRunWithRetry(
		{ prompt: [{ type: 'text', text: 'hi' }], signal: controller.signal, cwd: 'C:/ws' },
		{
			cwd: 'C:/ws',
			executable: 'agy.exe',
			env: {},
			permissionMode: 'dangerously-skip-permissions',
			fallbackModel: 'fallback-model',
			retryOnRateLimit: false,
			acpFallbackToStreamJson: false,
			disposeGraceMs: 1000,
			spawn,
			writeStderr: () => {},
			onError: () => {},
		},
	);
	const settled = await handle.result;
	assert.equal(settled.stopReason, 'completed');
	assert.equal(settled.output[0].text, 'OK');
	assert.equal(children.length, 1, '首轮成功不应再次 spawn');
	assert.equal(children[0].terminated, false);
	await handle.dispose();
	assert.equal(children[0].terminated, true, '外层 dispose 必须回收内层 agy acp 进程');
});
