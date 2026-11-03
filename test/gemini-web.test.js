import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRunArgs, createJobQueue, scriptErrorMessage, setupGeminiWeb, summarizeJob, validateChatMessage, validateTopic } from '../lib/gemini-web.js';

test('validateTopic: 去空白、拒绝空值与非字符串', () => {
	assert.equal(validateTopic('  hello  '), 'hello');
	assert.throws(() => validateTopic('   '), /不能为空/);
	assert.throws(() => validateTopic(42), /必须是字符串/);
	assert.throws(() => validateTopic('x'.repeat(8001)), /不能超过/);
});

test('validateChatMessage: 去空白、拒绝空值与超长消息', () => {
	assert.equal(validateChatMessage('  你好  '), '你好');
	assert.throws(() => validateChatMessage('   '), /不能为空/);
	assert.throws(() => validateChatMessage(null), /必须是字符串/);
	assert.throws(() => validateChatMessage('x'.repeat(8001)), /不能超过/);
});

test('buildRunArgs: 拼出脚本参数与可选的 --headless', () => {
	const args = buildRunArgs({
		scriptDir: 'C:/scripts',
		profileDir: 'C:/profile',
		topic: 'test topic',
		outFile: 'C:/out.json',
		headless: true,
		timeoutSec: 120,
	});
	assert.equal(args[0], join('C:/scripts', 'run_research.py'));
	assert.deepEqual(args.slice(1, 3), ['--topic', 'test topic']);
	assert.ok(args.includes('--headless'));
	assert.ok(args.includes('120'));
});

test('summarizeJob: 不含大字段 result', () => {
	const job = {
		id: 'j1',
		status: 'done',
		topic: 't',
		createdAt: '2026-01-01T00:00:00.000Z',
		startedAt: '2026-01-01T00:00:01.000Z',
		endedAt: '2026-01-01T00:00:02.000Z',
		result: 'very long report',
		error: undefined,
	};
	const summary = summarizeJob(job);
	assert.equal(summary.id, 'j1');
	assert.equal(summary.status, 'done');
	assert.equal(Object.hasOwn(summary, 'result'), false);
});

test('summarizeJob: 带出模型/思考档与应用结果', () => {
	const summary = summarizeJob({
		id: 'j2',
		kind: 'chat',
		status: 'done',
		message: 'hi',
		reply: 'long reply',
		model: 'flash',
		thinking: 'high',
		modelApplied: true,
		thinkingApplied: false,
		currentModel: 'Flash',
	});
	assert.equal(summary.model, 'flash');
	assert.equal(summary.thinking, 'high');
	assert.equal(summary.modelApplied, true);
	assert.equal(summary.thinkingApplied, false);
	assert.equal(summary.currentModel, 'Flash');
	assert.equal(Object.hasOwn(summary, 'reply'), false);
});

test('createJobQueue: 串行执行，第二个任务等第一个结束', async () => {
	let active = 0;
	let maxActive = 0;
	const order = [];
	const queue = createJobQueue({
		runner: async (job) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			order.push(`start:${job.topic}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
			order.push(`end:${job.topic}`);
			active -= 1;
			return `report:${job.topic}`;
		},
	});
	const first = queue.enqueue('a');
	const second = queue.enqueue('b');
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(maxActive, 1);
	assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
	assert.equal(queue.get(first.id).status, 'done');
	assert.equal(queue.get(second.id).status, 'done');
	assert.equal(queue.get(first.id).result, 'report:a');
	assert.equal(queue.latest().id, second.id);
});

test('createJobQueue: runner 失败进入 error 状态，后续任务继续执行', async () => {
	const queue = createJobQueue({
		runner: async (job) => {
			if (job.topic === 'bad') throw new Error('boom');
			return 'ok';
		},
	});
	const bad = queue.enqueue('bad');
	const good = queue.enqueue('good');
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(queue.get(bad.id).status, 'error');
	assert.match(queue.get(bad.id).error, /boom/);
	assert.equal(queue.get(good.id).status, 'done');
});

test('scriptErrorMessage: 登录/超时/空报告翻译', () => {
	assert.match(scriptErrorMessage(2, 'login_required'), /登录/);
	assert.match(scriptErrorMessage(1, 'timeout waiting for report'), /超时/);
	assert.match(scriptErrorMessage(1, 'empty report'), /没有返回/);
	assert.equal(scriptErrorMessage(9, 'custom'), 'custom');
});

test('createJobQueue: chat 与 research 两个队列互不阻塞', async () => {
	const research = createJobQueue({
		runner: async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return 'research-result';
		},
	});
	const chat = createJobQueue({ runner: async () => 'chat-result' });
	const researchJob = research.enqueue({ kind: 'research', topic: 't' });
	const chatJob = chat.enqueue({ kind: 'chat', message: 'm' });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(chat.get(chatJob.id).status, 'done');
	assert.equal(research.get(researchJob.id).status, 'running');
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(research.get(researchJob.id).status, 'done');
});

test('setupGeminiWeb: chat 队列、/chat/send 与 /job 返回回复', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gemini-web-chat-test-'));
	const routes = [];
	const sctx = {
		effect(fn) { return fn(); },
		webServer: { register(entry) { routes.push(entry); return () => {}; } },
		tools: { register() { return () => {}; } },
	};
	const ctx = { inject(_services, callback) { callback(sctx); } };
	const fakeWorker = {
		health: { running: true, ready: true },
		async request(command, payload, options) {
			if (command === 'chat.send') {
				options?.onProgress?.({ phase: 'waiting' });
				return {
					reply: `reply:${payload.message}`,
					conversationUrl: 'https://gemini.google.com/app/abc',
					signedIn: true,
					modelApplied: payload.model === 'pro',
					thinkingApplied: payload.thinking === 'high',
					currentModel: 'Pro',
				};
			}
			if (command === 'chat.new') return {};
			return {};
		},
		async shutdown() {},
		async dispose() {},
	};
	setupGeminiWeb(ctx, {
		profileDir: join(dir, 'profile'),
		python: 'python',
		headless: true,
		timeoutMs: 60000,
		chatTimeoutMs: 1000,
		scriptDir: join(dir, 'scripts'),
		workerClient: fakeWorker,
	});
	const makeRes = () => ({
		statusCode: 0,
		headers: {},
		body: undefined,
		setHeader(key, value) { this.headers[key] = value; },
		end(value) { this.body = value; },
	});
	const makeReq = (method, url, body) => {
		const listeners = {};
		return {
			method,
			url,
			on(event, handler) {
				listeners[event] = handler;
				if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)));
				if (event === 'end') handler();
			},
			destroy() {},
		};
	};
	try {
		const sendRoute = routes.find((entry) => entry.path.endsWith('/chat/send'));
		const sendRes = makeRes();
		await sendRoute.handler(makeReq('POST', '/api/dsh-gemini-research/chat/send', { message: 'hi', model: 'pro', thinking: 'high' }), sendRes);
		const sent = JSON.parse(sendRes.body);
		assert.equal(sent.ok, true);
		assert.ok(sent.jobId);

		await new Promise((resolve) => setTimeout(resolve, 30));
		const jobRoute = routes.find((entry) => entry.path.endsWith('/chat/job'));
		const jobRes = makeRes();
		await jobRoute.handler(makeReq('GET', `/api/dsh-gemini-research/job?id=${sent.jobId}`), jobRes);
		const job = JSON.parse(jobRes.body).job;
		assert.equal(job.kind, 'chat');
		assert.equal(job.reply, 'reply:hi');
		assert.equal(job.conversationUrl, 'https://gemini.google.com/app/abc');
		assert.equal(job.model, 'pro');
		assert.equal(job.thinking, 'high');
		assert.equal(job.modelApplied, true);
		assert.equal(job.thinkingApplied, true);

		const statusRoute = routes.find((entry) => entry.path.endsWith('/status'));
		const statusRes = makeRes();
		await statusRoute.handler(makeReq('GET', '/api/dsh-gemini-research/status'), statusRes);
		const status = JSON.parse(statusRes.body);
		assert.equal(status.loginReady, true);
		assert.equal(status.chat.running, false);
		assert.equal(status.chat.conversationUrl, 'https://gemini.google.com/app/abc');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('setupGeminiWeb: /models 返回实时目录与配置默认值', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gemini-web-models-test-'));
	const routes = [];
	const sctx = {
		effect(fn) { return fn(); },
		webServer: { register(entry) { routes.push(entry); return () => {}; } },
		tools: { register() { return () => {}; } },
	};
	const ctx = { inject(_services, callback) { callback(sctx); } };
	const fakeWorker = {
		health: { running: true, ready: true },
		async request(command) {
			if (command === 'models.list') {
				return {
					source: 'live',
					models: [{ id: 'argon', label: '4 Argon 复杂任务', tokens: ['4 argon'], thinkingLevels: ['low', 'medium', 'high'] }],
					thinking: [{ id: 'high', label: '高（超级详尽）' }],
					deepThink: { supported: false, label: 'Deep Think' },
				};
			}
			return {};
		},
		async shutdown() {},
		async dispose() {},
	};
	setupGeminiWeb(ctx, {
		profileDir: join(dir, 'profile'),
		python: 'python',
		headless: true,
		timeoutMs: 60000,
		scriptDir: join(dir, 'scripts'),
		defaultModel: 'argon',
		defaultThinking: 'high',
		workerClient: fakeWorker,
	});
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(key, value) { this.headers[key] = value; },
		end(value) { this.body = value; },
	};
	try {
		const modelsRoute = routes.find((entry) => entry.path.endsWith('/models'));
		await modelsRoute.handler({ method: 'GET', url: '/api/dsh-gemini-research/models?mode=chat' }, res);
		const body = JSON.parse(res.body);
		assert.equal(body.ok, true);
		assert.equal(body.source, 'live');
		assert.equal(body.models[0].id, 'argon');
		assert.deepEqual(body.defaults, { model: 'argon', thinking: 'high' });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('setupGeminiWeb: worker 未就绪时 loginReady 不采信旧的 login-state.json', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gemini-web-login-test-'));
	const profileDir = join(dir, 'profile');
	mkdirSync(profileDir, { recursive: true });
	writeFileSync(join(profileDir, 'login-state.json'), JSON.stringify({ signedIn: true, checkedAt: '2026-11-03T00:58:48+08:00' }));
	writeFileSync(join(profileDir, 'login-ok.json'), '{}');
	const routes = [];
	const sctx = {
		effect(fn) { return fn(); },
		webServer: { register(entry) { routes.push(entry); return () => {}; } },
		tools: { register() { return () => {}; } },
	};
	const ctx = { inject(_services, callback) { callback(sctx); } };
	const fakeWorker = {
		health: { running: false, ready: false },
		async request() { return {}; },
		async shutdown() {},
		async dispose() {},
	};
	setupGeminiWeb(ctx, {
		profileDir,
		python: 'python',
		headless: true,
		timeoutMs: 60000,
		scriptDir: join(dir, 'scripts'),
		workerClient: fakeWorker,
	});
	const makeRes = () => ({
		statusCode: 0,
		headers: {},
		setHeader(key, value) { this.headers[key] = value; },
		end(value) { this.body = value; },
	});
	const statusRoute = routes.find((entry) => entry.path.endsWith('/status'));
	try {
		const offlineRes = makeRes();
		await statusRoute.handler({ method: 'GET', url: '/api/dsh-gemini-research/status' }, offlineRes);
		const offline = JSON.parse(offlineRes.body);
		assert.equal(offline.loginSaved, true);
		assert.equal(offline.loginReady, false);

		fakeWorker.health = { running: true, ready: true };
		const onlineRes = makeRes();
		await statusRoute.handler({ method: 'GET', url: '/api/dsh-gemini-research/status' }, onlineRes);
		assert.equal(JSON.parse(onlineRes.body).loginReady, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('setupGeminiWeb: /job 找不到任务返回 404', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gemini-web-test-'));
	const routes = [];
	const sctx = {
		effect(fn) { fn(); },
		webServer: { register(entry) { routes.push(entry); return () => {}; } },
		tools: { register() { return () => {}; } },
		on() { return () => {}; },
	};
	const ctx = { inject(_services, callback) { callback(sctx); } };
	setupGeminiWeb(ctx, {
		profileDir: join(dir, 'profile'),
		python: 'python',
		headless: true,
		timeoutMs: 60000,
		scriptDir: join(dir, 'scripts'),
	});
	const route = routes.find((entry) => entry.path.endsWith('/job'));
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(key, value) { this.headers[key] = value; },
		end() {},
	};
	await route.handler({ method: 'GET', url: '/api/dsh-gemini-research/job?id=missing' }, res);
	assert.equal(res.statusCode, 404);
	rmSync(dir, { recursive: true, force: true });
});
