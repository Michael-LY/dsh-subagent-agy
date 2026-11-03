/**
 * Node-side lifecycle and JSONL protocol client for the persistent Gemini
 * browser worker.
 *
 * One worker owns one persistent Playwright context and exposes independent
 * chat/research pages to the host bridge. The client treats the process as a
 * replaceable singleton: it starts lazily, rejects in-flight requests on a
 * crash, and lets the next request start a fresh worker.
 *
 * @module dsh-subagent-agy/worker-client
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

/** Default time allowed for the worker to launch its browser context. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
/** Default timeout for one worker request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;
/** Default idle period before the worker is shut down. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_STDERR_CHARS = 16_000;

/** Structured worker-side or client-side failure. */
export class WorkerError extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = 'WorkerError';
		this.code = code;
		this.details = details;
	}
}

/** Kill a child process and its descendants (Chrome is a grandchild on Windows). */
export function killProcessTree(child) {
	if (child === undefined || child === null) return;
	try {
		if (process.platform === 'win32' && child.pid !== undefined) {
			spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
			return;
		}
		child.kill('SIGKILL');
	} catch {}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Manages one persistent Python worker process.
 */
export class GeminiWorkerClient {
	#command;
	#args;
	#cwd;
	#env;
	#startupTimeoutMs;
	#idleTimeoutMs;
	#logger;
	#child;
	#lineReader;
	#ready = false;
	#starting;
	#readyResolve;
	#readyReject;
	#readyTimer;
	#pending = new Map();
	#idleTimer;
	#disposed = false;
	#stderr = '';
	#lastHeartbeatAt = 0;
	#lastError;

	/**
	 * @param {{command: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, startupTimeoutMs?: number, idleTimeoutMs?: number, logger?: {info?: Function, warn?: Function}}} options
	 */
	constructor(options) {
		if (options === undefined || typeof options.command !== 'string' || options.command.length === 0) {
			throw new Error('GeminiWorkerClient requires a command');
		}
		this.#command = options.command;
		this.#args = options.args ?? [];
		this.#cwd = options.cwd;
		this.#env = options.env;
		this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.#logger = options.logger;
	}

	/** Current process health for status reporting. */
	get health() {
		return {
			running: this.#child !== undefined && this.#child.exitCode === null,
			ready: this.#ready,
			pid: this.#child === undefined ? undefined : this.#child.pid,
			lastHeartbeatAt: this.#lastHeartbeatAt === 0 ? undefined : this.#lastHeartbeatAt,
			lastError: this.#lastError === undefined ? undefined : (this.#lastError instanceof Error ? this.#lastError.message : String(this.#lastError)),
			stderrTail: this.#stderr.length === 0 ? undefined : this.#stderr,
		};
	}

	/** Start the worker lazily; a second caller during startup shares the same promise. */
	async start() {
		if (this.#disposed) throw new WorkerError('worker_disposed', 'worker has been disposed');
		if (this.#child !== undefined && this.#ready) return;
		if (this.#starting !== undefined) return await this.#starting;
		this.#starting = this.#spawnAndWait().finally(() => {
			this.#starting = undefined;
		});
		return await this.#starting;
	}

	/**
	 * Send one command and await its terminal result.
	 * @param {string} command worker command name
	 * @param {object} payload command payload
	 * @param {{timeoutMs?: number, signal?: AbortSignal, onProgress?: (event: object) => void}} [options]
	 * @returns {Promise<any>}
	 */
	async request(command, payload = {}, options = {}) {
		await this.start();
		const child = this.#child;
		if (child === undefined || child.stdin === undefined || child.stdin.destroyed) {
			throw new WorkerError('worker_unavailable', 'worker stdin is unavailable');
		}
		const id = randomUUID();
		const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const pending = {
			resolve: undefined,
			reject: undefined,
			timer: undefined,
			onProgress: options.onProgress,
			signal: options.signal,
			abort: undefined,
		};
		const promise = new Promise((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
		});
		pending.timer = setTimeout(() => {
			if (!this.#pending.has(id)) return;
			this.#pending.delete(id);
			this.#removeAbortListener(pending);
			try {
				child.stdin.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
			} catch {}
			pending.reject(new WorkerError('worker_timeout', `worker request timed out after ${timeoutMs}ms`));
			this.#scheduleIdle();
		}, timeoutMs);
		pending.timer.unref?.();
		if (options.signal !== undefined) {
			pending.abort = () => {
				if (!this.#pending.has(id)) return;
				this.#pending.delete(id);
				clearTimeout(pending.timer);
				try {
					child.stdin.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
				} catch {}
				pending.reject(new WorkerError('cancelled', 'worker request was cancelled'));
				this.#scheduleIdle();
			};
			if (options.signal.aborted) {
				pending.abort();
				return await promise;
			}
			options.signal.addEventListener('abort', pending.abort, { once: true });
		}
		this.#pending.set(id, pending);
		try {
			child.stdin.write(`${JSON.stringify({ type: 'request', id, command, payload })}\n`);
		} catch (error) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			this.#removeAbortListener(pending);
			throw new WorkerError('worker_write_failed', error instanceof Error ? error.message : String(error));
		}
		this.#clearIdle();
		return await promise;
	}

	/** Graceful shutdown; the next request starts a new process. */
	async shutdown() {
		this.#clearIdle();
		const child = this.#child;
		if (child === undefined) return;
		this.#failPending(new WorkerError('worker_shutdown', 'worker is shutting down'));
		try {
			child.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
		} catch {}
		await Promise.race([
			new Promise((resolve) => child.once('exit', resolve)),
			sleep(3000),
		]);
		if (this.#child === child) {
			killProcessTree(child);
			this.#child = undefined;
			this.#ready = false;
		}
	}

	/** Permanent disposal for plugin unload. */
	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.shutdown();
	}

	#spawnAndWait() {
		const child = spawn(this.#command, this.#args, {
			cwd: this.#cwd,
			env: this.#env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.#child = child;
		this.#ready = false;
		this.#stderr = '';
		this.#lastHeartbeatAt = 0;
		this.#lastError = undefined;
		this.#lineReader = createInterface({ input: child.stdout });
		this.#lineReader.on('line', (line) => this.#handleLine(line));
		child.stderr?.on('data', (chunk) => {
			const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
			this.#stderr = `${this.#stderr}${text}`.slice(-MAX_STDERR_CHARS);
		});
		child.once('error', (error) => {
			this.#lastError = error;
			this.#failPending(new WorkerError('worker_spawn_failed', error.message));
			this.#rejectReady(new WorkerError('worker_spawn_failed', error.message));
		});
		child.once('exit', (code, signal) => {
			const wasReady = this.#ready;
			this.#ready = false;
			if (this.#child === child) this.#child = undefined;
			this.#lineReader?.close();
			this.#lineReader = undefined;
			if (!this.#disposed) {
				const error = new WorkerError('worker_crashed', `worker exited (code ${String(code)}, signal ${String(signal)})`);
				this.#lastError = error;
				this.#failPending(error);
				if (!wasReady) this.#rejectReady(error);
			}
		});
		const readyPromise = new Promise((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		this.#readyTimer = setTimeout(() => {
			this.#rejectReady(new WorkerError('worker_start_timeout', `worker did not become ready within ${this.#startupTimeoutMs}ms`));
			killProcessTree(child);
		}, this.#startupTimeoutMs);
		this.#readyTimer.unref?.();
		return readyPromise;
	}

	#handleLine(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.#logger?.warn?.(`gemini worker emitted non-JSON stdout: ${line.slice(0, 200)}`);
			return;
		}
		if (message === null || typeof message !== 'object') return;
		if (message.type === 'ready') {
			this.#ready = true;
			this.#lastHeartbeatAt = Date.now();
			clearTimeout(this.#readyTimer);
			this.#readyResolve?.();
			this.#readyResolve = undefined;
			this.#readyReject = undefined;
			this.#scheduleIdle();
			return;
		}
		if (message.type === 'heartbeat') {
			this.#lastHeartbeatAt = Date.now();
			return;
		}
		if (message.type === 'progress') {
			const pending = this.#pending.get(message.id);
			if (pending !== undefined) pending.onProgress?.(message);
			return;
		}
		if (message.type === 'result') {
			const pending = this.#pending.get(message.id);
			if (pending === undefined) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			this.#removeAbortListener(pending);
			if (message.ok === true) pending.resolve(message.data);
			else {
				const error = message.error ?? {};
				pending.reject(new WorkerError(typeof error.code === 'string' ? error.code : 'worker_error', typeof error.message === 'string' ? error.message : 'worker request failed', error.details));
			}
			this.#scheduleIdle();
		}
	}

	#rejectReady(error) {
		clearTimeout(this.#readyTimer);
		this.#readyReject?.(error);
		this.#readyReject = undefined;
		this.#readyResolve = undefined;
	}

	#failPending(error) {
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			this.#removeAbortListener(pending);
			pending.reject(error);
		}
	}

	#removeAbortListener(pending) {
		if (pending.signal !== undefined && pending.abort !== undefined) {
			pending.signal.removeEventListener('abort', pending.abort);
		}
	}

	#scheduleIdle() {
		this.#clearIdle();
		if (this.#idleTimeoutMs <= 0) return;
		this.#idleTimer = setTimeout(() => {
			this.shutdown().catch((error) => this.#logger?.warn?.(`gemini worker idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`));
		}, this.#idleTimeoutMs);
		this.#idleTimer.unref?.();
	}

	#clearIdle() {
		if (this.#idleTimer !== undefined) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
	}
}
