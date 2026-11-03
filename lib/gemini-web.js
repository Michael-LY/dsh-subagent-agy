/**
 * Gemini 网页调研与普通对话的主机侧桥接。
 *
 * 浏览器面板通过 `/api/dsh-gemini-research/*` 与这里通信。调研和对话各自
 * 有独立队列；它们共享一个懒启动的常驻 Python worker（一个 persistent
 * Playwright context、两个 page），因此浏览器 profile 始终只有一个实例，
 * chat 与 research 又可以真正并行。
 *
 * @module dsh-subagent-agy/gemini-web
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { GeminiWorkerClient, WorkerError, killProcessTree } from './worker-client.js';

/** HTTP 桥接前缀。 */
export const API_PREFIX = '/api/dsh-gemini-research';
const PREFIX = 'dsh-gemini-research';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOPIC_CHARS = 8000;
const MAX_CHAT_CHARS = 8000;
const DEFAULT_CHAT_TIMEOUT_MS = 180_000;
const DEFAULT_WORKER_IDLE_MS = 10 * 60_000;
const LOGIN_FRESH_MS = 5 * 60_000;
const MAX_LOG_TAIL = 12000;

/** 校验并归一化调研主题。 */
export function validateTopic(value) {
	if (typeof value !== 'string') throw new Error('topic 必须是字符串');
	const topic = value.trim();
	if (topic.length === 0) throw new Error('topic 不能为空');
	if (topic.length > MAX_TOPIC_CHARS) throw new Error(`topic 不能超过 ${MAX_TOPIC_CHARS} 个字符`);
	return topic;
}

/** 校验并归一化普通对话消息。 */
export function validateChatMessage(value) {
	if (typeof value !== 'string') throw new Error('message 必须是字符串');
	const message = value.trim();
	if (message.length === 0) throw new Error('message 不能为空');
	if (message.length > MAX_CHAT_CHARS) throw new Error(`message 不能超过 ${MAX_CHAT_CHARS} 个字符`);
	return message;
}

/** 组装旧版一次性 research 脚本参数（worker 不可用时的 fallback）。 */
export function buildRunArgs({ scriptDir, profileDir, topic, outFile, headless = true, timeoutSec = 900 }) {
	return [
		join(scriptDir, 'run_research.py'),
		'--topic',
		topic,
		'--out',
		outFile,
		'--profile',
		profileDir,
		'--timeout',
		String(timeoutSec),
		...(headless ? ['--headless'] : []),
	];
}

/** 只暴露给浏览器的任务摘要（不含完整报告/回复，避免轮询传大文本）。 */
export function summarizeJob(job) {
	if (!job) return null;
	const summary = {
		id: job.id,
		kind: job.kind ?? 'research',
		status: job.status,
		createdAt: job.createdAt,
	};
	if (job.topic !== undefined) summary.topic = job.topic;
	if (job.message !== undefined) summary.message = job.message;
	if (job.startedAt !== undefined) summary.startedAt = job.startedAt;
	if (job.endedAt !== undefined) summary.endedAt = job.endedAt;
	if (job.error !== undefined) summary.error = job.error;
	return summary;
}

/** 把 Python 脚本的错误码/错误文本翻成用户能处理的提示（旧 fallback）。 */
export function scriptErrorMessage(code, error) {
	if (error === 'login_required' || code === 2) {
		return '尚未完成 Gemini 登录，请先在面板点「初始化登录」并登录 Google 账号';
	}
	if (error === 'timeout waiting for report') return '等待 Gemini 生成报告超时；可在 profile 目录查看 debug 截图';
	if (error === 'empty report') return 'Gemini 没有返回可提取的报告内容';
	return typeof error === 'string' && error.length > 0 ? error : `调研脚本退出码 ${code}`;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('请求体过大'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim();
			if (raw.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error('请求体不是合法 JSON'));
			}
		});
		req.on('error', reject);
	});
}

function writeJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

function route(path, methods, handler) {
	return {
		kind: 'exact',
		path,
		handler: async (req, res) => {
			const method = String(req.method ?? 'GET').toUpperCase();
			if (!methods.includes(method)) {
				writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `只接受 ${methods.join('/')}` });
				return;
			}
			try {
				const body = method === 'POST' ? await readJsonBody(req) : {};
				writeJson(res, 200, await handler(body, req));
			} catch (error) {
				const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 400;
				writeJson(res, statusCode, {
					ok: false,
					code: typeof error?.code === 'string' ? error.code : statusCode === 404 ? 'not-found' : 'bad-request',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

function httpError(statusCode, code, message) {
	const error = new Error(message);
	error.statusCode = statusCode;
	error.code = code;
	return error;
}

/** 简单单任务队列：同一时间只启动一个 runner。 */
export function createJobQueue({ runner, now = () => Date.now(), idFactory = randomUUID }) {
	const jobs = new Map();
	const pending = [];
	let active = null;
	let lastId = null;
	let pumping = false;

	function runNext() {
		if (pumping || active !== null) return;
		const next = pending.shift();
		if (next === undefined) return;
		pumping = true;
		active = next;
		next.status = 'running';
		next.startedAt = new Date(now()).toISOString();
		Promise.resolve()
			.then(() => runner(next))
			.then((result) => {
				next.status = 'done';
				next.result = typeof result === 'string' ? result : result && typeof result.report === 'string' ? result.report : String(result ?? '');
			})
			.catch((error) => {
				next.status = 'error';
				next.error = error instanceof Error ? error.message : String(error);
				next.errorCode = error instanceof WorkerError ? error.code : undefined;
			})
			.finally(() => {
				next.endedAt = new Date(now()).toISOString();
				const waiters = next.waiters;
				next.waiters = [];
				for (const resolve of waiters) resolve(next);
				active = null;
				pumping = false;
				runNext();
			});
	}

	function enqueue(input) {
		const base = {
			id: idFactory(),
			status: 'queued',
			createdAt: new Date(now()).toISOString(),
			startedAt: null,
			endedAt: null,
			result: undefined,
			error: undefined,
			logTail: '',
			waiters: [],
		};
		const job = typeof input === 'string'
			? { ...base, kind: 'research', topic: input }
			: { ...base, ...input };
		if (job.kind === undefined) job.kind = job.topic !== undefined ? 'research' : 'chat';
		jobs.set(job.id, job);
		pending.push(job);
		lastId = job.id;
		runNext();
		return job;
	}

	return {
		enqueue,
		get(id) {
			return jobs.get(id) ?? null;
		},
		latest() {
			return lastId === null ? null : jobs.get(lastId) ?? null;
		},
		isRunning() {
			return active !== null;
		},
		pendingCount() {
			return pending.length;
		},
		waitFor(id) {
			const job = jobs.get(id);
			if (job === undefined) return Promise.reject(new Error('找不到该任务'));
			if (job.status === 'done' || job.status === 'error') return Promise.resolve(job);
			return new Promise((resolve) => {
				job.waiters.push(resolve);
			});
		},
	};
}

function readState(path, fallback) {
	try {
		const value = JSON.parse(readFileSync(path, 'utf8'));
		return value !== null && typeof value === 'object' ? { ...fallback, ...value } : fallback;
	} catch {
		return fallback;
	}
}

function writeState(path, value) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value), 'utf8');
	} catch {}
}

function appendLog(job, chunk) {
	const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
	job.logTail = `${job.logTail ?? ''}${text}`.slice(-MAX_LOG_TAIL);
}

function appendProgress(job, event) {
	if (event === null || typeof event !== 'object') return;
	const detail = typeof event.detail === 'string' ? event.detail : typeof event.phase === 'string' ? event.phase : '';
	if (detail.length === 0) return;
	job.progress = detail;
	appendLog(job, `[${detail}]\n`);
}

/** 把 worker 的登录失败同步到持久化状态，供面板显示。 */
function recordLoginFailure(loginPath, loginState, error) {
	if (!(error instanceof WorkerError) || error.code !== 'login_required') return loginState;
	const next = { signedIn: false, checkedAt: new Date().toISOString(), error: error.message };
	writeState(loginPath, next);
	return next;
}

/**
 * 注册 Gemini 网页调研与对话的 HTTP 桥接。
 * @param {object} ctx cordis context（需要 webServer 可选注入）。
 * @param {{profileDir: string, python: string, headless: boolean, timeoutMs: number, chatTimeoutMs?: number, workerIdleMs?: number, scriptDir: string, workerMode?: 'persistent'|'oneshot', workerClient?: object}} options
 */
export function setupGeminiWeb(ctx, options) {
	if (!ctx || typeof ctx.inject !== 'function') return;
	if (typeof options.scriptDir !== 'string' || options.scriptDir.length === 0) throw new Error('setupGeminiWeb requires scriptDir');
	const profileDir = options.profileDir;
	const python = options.python ?? 'python';
	const headless = options.headless !== false;
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 900_000;
	const chatTimeoutMs = Number.isFinite(options.chatTimeoutMs) && options.chatTimeoutMs > 0 ? options.chatTimeoutMs : DEFAULT_CHAT_TIMEOUT_MS;
	const workerIdleMs = Number.isFinite(options.workerIdleMs) && options.workerIdleMs >= 0 ? options.workerIdleMs : DEFAULT_WORKER_IDLE_MS;
	const workerMode = options.workerMode === 'oneshot' ? 'oneshot' : 'persistent';
	const runtimeDir = dirname(profileDir);
	const jobsDir = join(runtimeDir, 'jobs');
	const chatStatePath = join(runtimeDir, 'chat-state.json');
	const loginStatePath = join(profileDir, 'login-state.json');
	mkdirSync(jobsDir, { recursive: true });
	let chatState = readState(chatStatePath, { conversationUrl: null });
	let loginState = readState(loginStatePath, { signedIn: false, checkedAt: null });

	const worker = options.workerClient ?? new GeminiWorkerClient({
		command: python,
		args: [
			join(options.scriptDir, 'worker.py'),
			'--profile',
			profileDir,
			...(headless ? ['--headless'] : []),
		],
		cwd: options.scriptDir,
		idleTimeoutMs: workerIdleMs,
		logger: ctx.logger,
	});

	const markLoginReady = () => {
		loginState = { signedIn: true, checkedAt: new Date().toISOString() };
		writeState(loginStatePath, loginState);
	};

	// 「已验证」：worker 在线时以实时检查为准；worker 未启动时，只采信最近
	// 5 分钟内的实际检查结果（例如刚完成登录），避免旧的 signedIn 文件造成假阳性。
	const isLoginReady = () => {
		if (loginState.signedIn !== true) return false;
		if (worker.health.ready === true) return true;
		const checked = Date.parse(loginState.checkedAt ?? '');
		return Number.isFinite(checked) && Date.now() - checked <= LOGIN_FRESH_MS;
	};

	const recordLoginFailureFor = (error) => {
		loginState = recordLoginFailure(loginStatePath, loginState, error);
	};

	const runWorkerResearch = async (job) => {
		try {
			const data = await worker.request('research.run', {
				topic: job.topic,
				timeoutSec: Math.max(60, Math.round(timeoutMs / 1000)),
			}, {
				timeoutMs,
				onProgress: (event) => appendProgress(job, event),
			});
			if (data !== null && typeof data === 'object' && typeof data.report === 'string') {
				markLoginReady();
				return data.report;
			}
			throw new Error('Gemini worker 没有返回报告');
		} catch (error) {
			recordLoginFailureFor(error);
			throw error;
		}
	};

	const runWorkerChat = async (job) => {
		try {
			const data = await worker.request('chat.send', {
				message: job.message,
				timeoutSec: Math.max(10, Math.round(chatTimeoutMs / 1000)),
				...(chatState.conversationUrl === null || chatState.conversationUrl === undefined ? {} : { conversationUrl: chatState.conversationUrl }),
			}, {
				timeoutMs: chatTimeoutMs,
				onProgress: (event) => appendProgress(job, event),
			});
			const reply = data !== null && typeof data === 'object' && typeof data.reply === 'string' ? data.reply : '';
			if (data !== null && typeof data === 'object' && typeof data.conversationUrl === 'string' && data.conversationUrl.length > 0) {
				chatState = { ...chatState, conversationUrl: data.conversationUrl };
				writeState(chatStatePath, chatState);
			}
			if (!reply) throw new Error('Gemini 没有返回回复内容');
			if (data !== null && typeof data === 'object' && data.signedIn === true) {
				markLoginReady();
			} else {
				loginState = { signedIn: false, checkedAt: new Date().toISOString(), error: 'logged_out_chat' };
				writeState(loginStatePath, loginState);
			}
			job.reply = reply;
			job.conversationUrl = chatState.conversationUrl ?? undefined;
			return reply;
		} catch (error) {
			recordLoginFailureFor(error);
			throw error;
		}
	};

	const runOneShotResearch = async (job) => {
		const outFile = join(jobsDir, `${job.id}.json`);
		const args = buildRunArgs({
			scriptDir: options.scriptDir,
			profileDir,
			topic: job.topic,
			outFile,
			headless,
			timeoutSec: Math.max(60, Math.round(timeoutMs / 1000)),
		});
		return await new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn) => {
				if (settled) return;
				settled = true;
				fn();
			};
			let child;
			try {
				child = spawn(python, args, { cwd: options.scriptDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			} catch (error) {
				reject(new Error(`无法启动 Python：${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			job.child = child;
			const timer = setTimeout(() => {
				killProcessTree(child);
				finish(() => reject(new Error(`调研任务超时（${Math.round(timeoutMs / 1000)}s）`)));
			}, timeoutMs);
			child.stdout?.on('data', (chunk) => appendLog(job, chunk));
			child.stderr?.on('data', (chunk) => appendLog(job, chunk));
			child.on('error', (error) => {
				clearTimeout(timer);
				finish(() => reject(new Error(`Python 启动失败：${error.message}`)));
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				job.exitCode = code;
				let payload;
				try {
					payload = JSON.parse(readFileSync(outFile, 'utf8'));
				} catch {}
				if (payload !== undefined) {
					if (payload.ok === true && typeof payload.report === 'string') {
						markLoginReady();
						finish(() => resolve(payload.report));
						return;
					}
					finish(() => reject(new Error(scriptErrorMessage(code, payload.error || payload.message))));
					return;
				}
				if (code === 2) {
					finish(() => reject(new Error('尚未完成 Gemini 登录，请先在面板点「初始化登录」并登录 Google 账号')));
					return;
				}
				if (code !== 0) {
					finish(() => reject(new Error(`调研脚本退出码 ${code}${job.logTail ? `：${job.logTail.slice(-600)}` : ''}`)));
					return;
				}
				finish(() => reject(new Error('调研脚本没有返回报告')));
			});
		});
	};

	const researchQueue = createJobQueue({
		runner: async (job) => (workerMode === 'oneshot' ? runOneShotResearch(job) : runWorkerResearch(job)),
	});
	const chatQueue = createJobQueue({ runner: runWorkerChat });
	let loginChild = null;
	let loginLog = '';

	const statusPayload = () => ({
		ok: true,
		loginState: (loginState = readState(loginStatePath, loginState)),
		profileDir,
		profileExists: existsSync(profileDir),
		loginSaved: existsSync(join(profileDir, 'login-ok.json')),
		loginReady: isLoginReady(),
		loginCheckedAt: loginState.checkedAt ?? null,
		loginError: loginState.error,
		python,
		loginRunning: loginChild !== null,
		worker: worker.health,
		running: researchQueue.isRunning(),
		busy: loginChild !== null || researchQueue.isRunning() || chatQueue.isRunning(),
		job: summarizeJob(researchQueue.latest()),
		research: { running: researchQueue.isRunning(), job: summarizeJob(researchQueue.latest()) },
		chat: { running: chatQueue.isRunning(), job: summarizeJob(chatQueue.latest()), conversationUrl: chatState.conversationUrl ?? null },
	});

	const chatStatusPayload = () => ({
		ok: true,
		loginState: (loginState = readState(loginStatePath, loginState)),
		running: chatQueue.isRunning(),
		busy: loginChild !== null || chatQueue.isRunning(),
		loginSaved: existsSync(join(profileDir, 'login-ok.json')),
		loginReady: isLoginReady(),
		loginCheckedAt: loginState.checkedAt ?? null,
		worker: worker.health,
		job: summarizeJob(chatQueue.latest()),
		conversationUrl: chatState.conversationUrl ?? null,
	});

	const setLoginFromChild = (code) => {
		if (code === 0) {
			loginState = { signedIn: true, checkedAt: new Date().toISOString() };
		} else {
			loginState = { signedIn: false, checkedAt: new Date().toISOString(), error: 'login init failed' };
		}
		writeState(loginStatePath, loginState);
	};

	ctx.inject(['webServer'], (sctx) => {
		sctx.effect(() => {
			const routes = [
				route(API_PREFIX + '/status', ['GET'], async () => statusPayload()),
				route(API_PREFIX + '/chat/status', ['GET'], async () => chatStatusPayload()),
				route(API_PREFIX + '/login/init', ['POST'], async () => {
					if (loginChild !== null) return { ok: true, alreadyRunning: true };
					if (researchQueue.isRunning() || chatQueue.isRunning()) throw httpError(409, 'busy', '有调研或对话任务正在运行，请等结束后再初始化登录');
					await worker.shutdown().catch(() => {});
					loginLog = '';
					const args = [join(options.scriptDir, 'init_login.py'), '--profile', profileDir, '--timeout', '600'];
					let child;
					try {
						child = spawn(python, args, { cwd: options.scriptDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
					} catch (error) {
						throw httpError(500, 'spawn-failed', `无法启动登录脚本：${error instanceof Error ? error.message : String(error)}`);
					}
					loginChild = child;
					child.stdout?.on('data', (chunk) => { loginLog = (loginLog + chunk.toString('utf8')).slice(-8000); });
					child.stderr?.on('data', (chunk) => { loginLog = (loginLog + chunk.toString('utf8')).slice(-8000); });
					child.on('close', (code) => {
						loginChild = null;
						setLoginFromChild(code);
					});
					child.on('error', () => {
						loginChild = null;
						loginState = { signedIn: false, checkedAt: new Date().toISOString(), error: 'login init spawn failed' };
						writeState(loginStatePath, loginState);
					});
					return { ok: true, started: true };
				}),
				route(API_PREFIX + '/run', ['POST'], async (body) => {
					if (loginChild !== null) throw httpError(409, 'busy', '正在初始化登录，请等登录窗口关闭后再开始调研');
					const topic = validateTopic(body.topic);
					const job = researchQueue.enqueue({ kind: 'research', topic });
					return { ok: true, jobId: job.id };
				}),
				route(API_PREFIX + '/chat/send', ['POST'], async (body) => {
					if (loginChild !== null) throw httpError(409, 'busy', '正在初始化登录，请等登录窗口关闭后再对话');
					const message = validateChatMessage(body.message);
					const job = chatQueue.enqueue({ kind: 'chat', message });
					return { ok: true, jobId: job.id };
				}),
				route(API_PREFIX + '/chat/new', ['POST'], async () => {
					if (chatQueue.isRunning()) throw httpError(409, 'busy', '对话任务正在进行中');
					if (worker.health.running) await worker.request('chat.new', {}, { timeoutMs: 30_000 });
					chatState = { ...chatState, conversationUrl: null };
					writeState(chatStatePath, chatState);
					return { ok: true };
				}),
				route(API_PREFIX + '/chat/latest', ['GET'], async () => ({ ok: true, job: summarizeJob(chatQueue.latest()), conversationUrl: chatState.conversationUrl ?? null })),
				route(API_PREFIX + '/chat/job', ['GET'], async (body, req) => {
					const url = new URL(req.url ?? '/', 'http://localhost');
					const id = url.searchParams.get('id') ?? '';
					const job = chatQueue.get(id);
					if (job === null) throw httpError(404, 'not-found', '找不到该对话任务');
					const view = summarizeJob(job);
					if (job.reply !== undefined) view.reply = job.reply;
					if (job.conversationUrl !== undefined) view.conversationUrl = job.conversationUrl;
					if (job.logTail !== undefined) view.logTail = job.logTail;
					return { ok: true, job: view };
				}),
				route(API_PREFIX + '/job', ['GET'], async (body, req) => {
					const url = new URL(req.url ?? '/', 'http://localhost');
					const id = url.searchParams.get('id') ?? '';
					const job = researchQueue.get(id) ?? chatQueue.get(id);
					if (job === null) throw httpError(404, 'not-found', '找不到该任务');
					const view = summarizeJob(job);
					if (job.result !== undefined) view.result = job.result;
					if (job.reply !== undefined) view.reply = job.reply;
					if (job.conversationUrl !== undefined) view.conversationUrl = job.conversationUrl;
					if (job.logTail !== undefined) view.logTail = job.logTail;
					return { ok: true, job: view };
				}),
				route(API_PREFIX + '/latest', ['GET'], async () => ({ ok: true, job: summarizeJob(researchQueue.latest()) })),
			];
			const disposers = routes.map((entry) => sctx.webServer.register(entry));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, `${PREFIX}: bridge`);
	});

	// 对话内的模型可见工具：与面板共用 research 队列。
	ctx.inject(['tools'], (tctx) => {
		tctx.effect(() => tctx.tools.register({
			name: 'gemini_web_research',
			description: 'Run a Gemini web Deep Research report through the locally logged-in Google AI Pro browser profile. Use this when the user explicitly asks for Gemini Deep Research or a deep multi-source research report. It takes about 5-10 minutes and returns the full report text. The user must first complete the one-time Gemini login in the sidebar "Gemini 调研" panel.',
			parameters: {
				type: 'object',
				properties: {
					topic: { type: 'string', description: 'The research topic, including goals, boundaries, and any formatting requirements.' },
				},
				required: ['topic'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'string' },
				render: (_args, value) => [{ type: 'text', text: String(value) }],
			},
			async execute(args) {
				if (!existsSync(join(profileDir, 'login-ok.json'))) {
					throw new Error('Gemini 网页调研尚未登录：请先在侧边栏「Gemini 调研」点「初始化登录」并完成 Google 登录');
				}
				if (loginChild !== null) throw new Error('正在初始化 Gemini 登录，请等登录窗口关闭后再试');
				const topic = validateTopic(args?.topic);
				const job = researchQueue.enqueue({ kind: 'research', topic });
				const finished = await researchQueue.waitFor(job.id);
				if (finished.status === 'error') throw new Error(finished.error || 'Gemini Deep Research 失败');
				return finished.result || '(Gemini 没有返回报告内容)';
			},
		}), `${PREFIX}: tool`);
	});

	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => {
			worker.dispose().catch(() => {});
		}, `${PREFIX}: worker lifecycle`);
	}

	return { worker, researchQueue, chatQueue };
}
