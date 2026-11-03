/**
 * One-shot Antigravity child lifecycle: spawn the real `agy` CLI through the
 * shared subprocess seam, publish only after the process is controllable,
 * flatten post-publication failures, and dispose to whole-range quiescence.
 *
 * @module dsh-subagent-agy/run
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { brandString } from '@deepseek-ai/dsh-brand';
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent';
import { AntigravityStream } from './wire.js';
import { classifyFailure } from './classify.js';

/** Default grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000;

/** ANSI/VT100 escape sequences (CSI, OSC, single-char escapes). */
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Strip terminal escape sequences so child stderr does not pollute logs.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
	return text.replace(ANSI_ESCAPE, '');
}

/** Native non-interactive permission modes this provider can enforce. */
export const ANTIGRAVITY_PERMISSION_MODES = Object.freeze(['auto', 'dangerously-skip-permissions']);

/**
 * Print mode soft-denies every tool confirmation unless permissions are skipped,
 * so a child that cannot skip permissions can never read the workspace.
 * `dangerously-skip-permissions` is therefore the only working default;
 * `auto` remains selectable for prompts that need no tools at all.
 */
export const DEFAULT_ANTIGRAVITY_PERMISSION_MODE = 'dangerously-skip-permissions';

/** Fixed facts for one failed run. */
export class AntigravityRunFailure extends Error {
	/** @param {{stage: string, category: string, outcome?: unknown}} facts */
	constructor(facts, cause) {
		super(`subagent-antigravity: Product subagent failure (${['product: Antigravity', `stage: ${facts.stage}`, `category: ${facts.category}`].join('; ')})`, cause === undefined ? undefined : { cause });
		this.facts = facts;
		this.name = 'AntigravityRunFailure';
	}
}

function thrown(value) {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Build the CLI argv for one run.
 * @param {{executable: string, model?: string, effort?: string, permissionMode: string, printTimeout?: string, jsonSchema?: string, addDirs?: readonly string[], extraArgs: readonly string[], prompt: string, promptPrefix?: string}} spec
 * @returns {string[]}
 */
export function antigravityArgv(spec) {
	const prompt = spec.promptPrefix === undefined || spec.promptPrefix.length === 0
		? spec.prompt
		: `${spec.promptPrefix}\n\n${spec.prompt}`;
	return [
		spec.executable,
		'--print',
		prompt,
		'--output-format',
		'stream-json',
		'--new-project',
		...(spec.model === undefined ? [] : ['--model', spec.model]),
		...(spec.effort === undefined ? [] : ['--effort', spec.effort]),
		...(spec.permissionMode === 'dangerously-skip-permissions' ? ['--dangerously-skip-permissions'] : ['--mode', 'auto']),
		...(spec.printTimeout === undefined ? [] : ['--print-timeout', spec.printTimeout]),
		...(spec.jsonSchema === undefined ? [] : ['--json-schema', spec.jsonSchema]),
		...(spec.addDirs === undefined ? [] : spec.addDirs.flatMap((dir) => ['--add-dir', dir])),
		...spec.extraArgs,
	];
}

/**
 * Validate and join the one-shot task before crossing the process boundary.
 * @param {readonly {type: string, text?: string}[]} prompt
 * @returns {string}
 */
export function textTask(prompt) {
	if (prompt.length === 0) throw new Error('subagent-antigravity: the one-shot task must contain only text blocks');
	const texts = [];
	for (const block of prompt) {
		if (block.type !== 'text') throw new Error('subagent-antigravity: the one-shot task must contain only text blocks');
		texts.push(typeof block.text === 'string' ? block.text : '');
	}
	const joined = texts.join('');
	if (joined.trim().length === 0) throw new Error('subagent-antigravity: the one-shot task must not be empty');
	return joined;
}

/**
 * Wait for the CLI to reach its terminal envelope.
 * @param {AntigravityStream} stream
 * @param {{promise: Promise<void>, resolve: () => void}} terminal
 * @returns {Promise<void>}
 */
async function awaitTerminal(stream, terminal) {
	await terminal.promise;
	stream.end();
	if (stream.malformed !== undefined && !stream.terminalObserved) throw new AntigravityRunFailure({ stage: 'turn', category: 'protocol' }, new Error(stream.malformed));
}

/**
 * Start the real `agy` child and publish its one-shot run.
 * @param {{prompt: readonly {type: string}[], signal: AbortSignal, cwd?: string}} request
 * @param {object} spec
 * @returns {Promise<object>}
 */
export async function startAntigravityRun(request, spec) {
	const prompt = textTask(request.prompt);
	if (request.signal.aborted) throw new Error('subagent-antigravity: request was aborted before CLI startup');
	let child;
	try {
		child = spec.spawn({
			argv: antigravityArgv({ ...spec, prompt }),
			cwd: spec.cwd,
			stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
			graceMs: spec.disposeGraceMs,
			env: spec.env,
		});
	} catch (error) {
		throw new AntigravityRunFailure({ stage: 'spawn', category: 'unknown' }, thrown(error));
	}

	const stream = new AntigravityStream('subagent-antigravity');
	let stderrText = '';
	const collectErrorText = () => [stream.errorText, stderrText].filter((value) => typeof value === 'string' && value.length > 0).join('\n');
	let lastFailure = { kind: 'ok' };
	const recordFailure = (failure) => {
		lastFailure = failure;
		if (spec.report !== undefined) spec.report.classification = failure;
	};
	const terminal = Promise.withResolvers();
	const onStdout = (chunk) => {
		stream.push(chunk);
		if (stream.terminalObserved) terminal.resolve();
	};
	const onStderr = (chunk) => {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		try {
			stderrText += bytes.toString('utf8');
			if (stderrText.length > 16000) stderrText = stderrText.slice(-16000);
		} catch {}
		try {
			spec.writeStderr(bytes);
		} catch {}
	};
	child.stdout?.on('data', onStdout);
	child.stderr?.on('data', onStderr);

	const detachPipes = () => {
		child.stdout?.off('data', onStdout);
		child.stderr?.off('data', onStderr);
	};

	let processFailureFacts;
	/**
	 * A normally exited child is not a failure: `agy` prints its terminal
	 * envelope and exits, and the exit notification can win a race against the
	 * final `stdout` chunk. Only a non-zero exit rejects; a clean exit resolves
	 * so the caller can flush the remaining frames and read the envelope.
	 */
	const processSettled = child.done.then(
		(outcome) => {
			if (outcome?.exitCode === 0) return outcome;
			processFailureFacts = { stage: 'process', category: 'process', outcome };
			throw new AntigravityRunFailure(processFailureFacts);
		},
		(error) => {
			processFailureFacts = { stage: 'process', category: 'unknown' };
			throw new AntigravityRunFailure(processFailureFacts, thrown(error));
		},
	);
	processSettled.catch(() => {});

	const runAbort = new AbortController();
	const requestCancel = () => {
		if (runAbort.signal.aborted) return;
		runAbort.abort(new Error('subagent-antigravity: run cancelled locally'));
	};
	const onAbort = () => {
		requestCancel();
	};
	request.signal.addEventListener('abort', onAbort, { once: true });

	const disposeProcess = async () => {
		detachPipes();
		try {
			child.stdin?.end();
		} catch {}
		child.terminate();
		await child.waitForExit();
		await child.done.catch(() => {});
	};

	try {
		request.signal.throwIfAborted();
	} catch {
		detachPipes();
		request.signal.removeEventListener('abort', onAbort);
		await disposeProcess().catch(() => {});
		throw new Error('subagent-antigravity: request was aborted before run publication');
	}

	let diagnostic;
	const result = settleRunResult({
		attempt: async () => {
			try {
				await Promise.race([awaitTerminal(stream, terminal), processSettled]);
			} catch (error) {
				const facts = error instanceof AntigravityRunFailure ? error.facts : {
					stage: 'turn',
					category: stream.malformed === undefined ? 'unknown' : 'protocol',
					...(processFailureFacts === undefined ? {} : { outcome: processFailureFacts.outcome }),
				};
				const failure = error instanceof AntigravityRunFailure ? error : new AntigravityRunFailure(facts, thrown(error));
				diagnostic = failure.message;
				recordFailure(classifyFailure(collectErrorText(), processFailureFacts?.outcome));
				throw failure;
			}
			stream.end();
			const settled = stream.result();
			if (settled.stopReason === 'error') {
				const failureClass = classifyFailure(collectErrorText(), processFailureFacts?.outcome);
				recordFailure(failureClass);
				diagnostic ??= new AntigravityRunFailure({ stage: 'turn', category: 'product-error' }).message;
				diagnostic += ` [${failureClass.kind}]`;
				if (stream.conversationId !== undefined) diagnostic += ` (conversation: ${stream.conversationId})`;
			} else {
				recordFailure({ kind: 'ok' });
			}
			return settled;
		},
		collectOutput: () => stream.result().output,
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
		teardown: disposeProcess,
	});
}

/**
 * Run the CLI once, optionally retrying a rate-limited / quota-exhausted
 * attempt with a configured fallback model or a single rate-limit backoff.
 * Retries only when explicitly configured; defaults to a single attempt.
 * @param {{prompt: readonly {type: string}[], signal: AbortSignal, cwd?: string}} request
 * @param {object} spec
 * @returns {Promise<object>}
 */
export async function startAntigravityRunWithRetry(request, spec) {
	const wantFallback = typeof spec.fallbackModel === 'string' && spec.fallbackModel.length > 0;
	const wantRateRetry = spec.retryOnRateLimit === true;
	if (!wantFallback && !wantRateRetry) return startAntigravityRun(request, spec);
	const firstReport = {};
	const first = await startAntigravityRun(request, { ...spec, report: firstReport });
	let active = first;
	const result = (async () => {
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
			await current.teardown().catch(() => {});
			currentReport = {};
			if (canFallback) {
				current = await startAntigravityRun(request, { ...spec, model: spec.fallbackModel, report: currentReport });
			} else {
				await delay(Math.min(info.retryAfterMs ?? 2000, 15000), undefined, { signal: request.signal });
				current = await startAntigravityRun(request, { ...spec, report: currentReport });
			}
			active = current;
			attempt += 1;
		}
	})();
	result.catch(() => {});
	return subprocessRunHandle({
		id: brandString(randomUUID()),
		result,
		signal: request.signal,
		onAbort: () => {},
		requestCancel: () => {
			try {
				active.requestCancel?.();
			} catch {}
		},
		teardown: async () => {
			try {
				await active.teardown();
			} catch {}
		},
	});
}
