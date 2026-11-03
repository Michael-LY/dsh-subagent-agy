/**
 * Gemini 网页 Deep Research 的主机侧桥接。
 *
 * 浏览器面板只通过 `/api/dsh-gemini-research/*` 与这里通信：真正的 Chrome
 * 由 Python Playwright 脚本启动，任务严格串行（同一个用户目录只能有一个
 * Chrome 实例）。本模块不接触浏览器会话，只负责排队、超时、日志和结果读取。
 *
 * @module dsh-subagent-agy/gemini-web
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** HTTP 桥接前缀。 */
export const API_PREFIX = '/api/dsh-gemini-research';
const PREFIX = 'dsh-gemini-research';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOPIC_CHARS = 8000;

/** 校验并归一化调研主题。 */
export function validateTopic(value) {
	if (typeof value !== 'string') throw new Error('topic 必须是字符串');
	const topic = value.trim();
	if (topic.length === 0) throw new Error('topic 不能为空');
	if (topic.length > MAX_TOPIC_CHARS) throw new Error(`topic 不能超过 ${MAX_TOPIC_CHARS} 个字符`);
	return topic;
}

/** 组装传给 Python 解释器的脚本参数（不含解释器本身）。 */
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

/** 只暴露给浏览器的任务摘要（不含完整报告，避免每次轮询传大文本）。 */
export function summarizeJob(job) {
	if (!job) return null;
	return {
		id: job.id,
		status: job.status,
		topic: job.topic,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		error: job.error,
	};
}

/** 杀掉 Python 及其子进程（Windows 上 Chrome 是孙进程，必须按进程树杀）。 */
function killTree(child) {
	try {
		if (process.platform === 'win32' && child.pid) {
			spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			return;
		}
		child.kill('SIGKILL');
	} catch {}
}

/** 把 Python 脚本的错误码/错误文本翻成用户能处理的提示。 */
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
	const body = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(body);
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

	function enqueue(topic) {
		const job = {
			id: idFactory(),
			status: 'queued',
			topic,
			createdAt: new Date(now()).toISOString(),
			startedAt: null,
			endedAt: null,
			result: undefined,
			error: undefined,
			logTail: '',
			waiters: [],
		};
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

/**
 * 注册 Gemini 网页调研的 HTTP 桥接。
 * @param {object} ctx cordis context（需要 webServer 可选注入）。
 * @param {{profileDir: string, python: string, headless: boolean, timeoutMs: number, scriptDir: string}} options
 */
export function setupGeminiWeb(ctx, options) {
	if (!ctx || typeof ctx.inject !== 'function') return;
	const runtimeDir = dirname(options.profileDir);
	const jobsDir = join(runtimeDir, 'jobs');
	mkdirSync(jobsDir, { recursive: true });

	const queue = createJobQueue({
		runner: async (job) => runOneJob(job, options, jobsDir),
	});
	let loginChild = null;
	let loginLog = '';

	function appendLog(target, chunk) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
		target.logTail = (target.logTail + text).slice(-12000);
	}

	async function runOneJob(job, opts, dir) {
		const outFile = join(dir, `${job.id}.json`);
		const args = buildRunArgs({
			scriptDir: opts.scriptDir,
			profileDir: opts.profileDir,
			topic: job.topic,
			outFile,
			headless: opts.headless,
			timeoutSec: Math.max(60, Math.round(opts.timeoutMs / 1000)),
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
				child = spawn(opts.python, args, {
					cwd: opts.scriptDir,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (error) {
				reject(new Error(`无法启动 Python：${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			job.child = child;
			const timer = setTimeout(() => {
				killTree(child);
				finish(() => reject(new Error(`调研任务超时（${Math.round(opts.timeoutMs / 1000)}s）`)));
			}, opts.timeoutMs);
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
	}

	ctx.inject(['webServer'], (sctx) => {
		sctx.effect(() => {
			const routes = [
				route(API_PREFIX + '/status', ['GET'], async () => ({
					ok: true,
					profileDir: options.profileDir,
					profileExists: existsSync(options.profileDir),
					loginReady: existsSync(join(options.profileDir, 'login-ok.json')),
					python: options.python,
					loginRunning: loginChild !== null,
					running: queue.isRunning(),
					busy: loginChild !== null || queue.isRunning(),
					job: summarizeJob(queue.latest()),
				})),
				route(API_PREFIX + '/login/init', ['POST'], async () => {
					if (loginChild !== null) return { ok: true, alreadyRunning: true };
					if (queue.isRunning()) throw new Error('调研任务进行中，请等结束后再初始化登录');
					loginLog = '';
					const args = [join(options.scriptDir, 'init_login.py'), '--profile', options.profileDir];
					const child = spawn(options.python, args, {
						cwd: options.scriptDir,
						windowsHide: true,
						stdio: ['ignore', 'pipe', 'pipe'],
					});
					loginChild = child;
					child.stdout?.on('data', (chunk) => { loginLog = (loginLog + chunk.toString('utf8')).slice(-8000); });
					child.stderr?.on('data', (chunk) => { loginLog = (loginLog + chunk.toString('utf8')).slice(-8000); });
					child.on('close', () => { loginChild = null; });
					child.on('error', () => { loginChild = null; });
					return { ok: true, started: true };
				}),
				route(API_PREFIX + '/run', ['POST'], async (body) => {
					if (loginChild !== null) throw new Error('正在初始化登录，请等登录窗口关闭后再开始调研');
					const topic = validateTopic(body.topic);
					const job = queue.enqueue(topic);
					return { ok: true, jobId: job.id };
				}),
				route(API_PREFIX + '/job', ['GET'], async (body, req) => {
					const url = new URL(req.url ?? '/', 'http://localhost');
					const id = url.searchParams.get('id') ?? '';
					const job = queue.get(id);
					if (job === null) {
						const error = new Error('找不到该任务');
						error.statusCode = 404;
						error.code = 'not-found';
						throw error;
					}
					return { ok: true, job: { ...summarizeJob(job), result: job.result, logTail: job.logTail } };
				}),
				route(API_PREFIX + '/latest', ['GET'], async () => ({ ok: true, job: summarizeJob(queue.latest()) })),
			];
			const disposers = routes.map((entry) => sctx.webServer.register(entry));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, `${PREFIX}: bridge`);
	});

	// 对话内的模型可见工具：与面板共用同一个单任务队列，直接等待报告返回。
	ctx.inject(['tools'], (tctx) => {
		tctx.effect(() => tctx.tools.register({
			name: 'gemini_web_research',
			description: 'Run a Gemini web Deep Research report through the locally logged-in Google AI Pro browser profile. Use this when the user explicitly asks for Gemini Deep Research or a deep multi-source research report. It takes about 5-10 minutes and returns the full report text. The user must first complete the one-time Gemini login in the sidebar "Gemini 调研" panel.',
			parameters: {
				topic: {
					type: 'string',
					description: 'The research topic, including goals, boundaries, and any formatting requirements.',
				},
			},
			output: {
				schema: { type: 'string' },
				render: (_args, value) => [{ type: 'text', text: String(value) }],
			},
			async execute(args) {
				if (!existsSync(join(options.profileDir, 'login-ok.json'))) {
					throw new Error('Gemini 网页调研尚未登录：请先在侧边栏「Gemini 调研」点「初始化登录」并完成 Google 登录');
				}
				if (loginChild !== null) throw new Error('正在初始化 Gemini 登录，请等登录窗口关闭后再试');
				const topic = validateTopic(args?.topic);
				const job = queue.enqueue(topic);
				const finished = await queue.waitFor(job.id);
				if (finished.status === 'error') throw new Error(finished.error || 'Gemini Deep Research 失败');
				return finished.result || '(Gemini 没有返回报告内容)';
			},
		}), `${PREFIX}: tool`);
	});
}
