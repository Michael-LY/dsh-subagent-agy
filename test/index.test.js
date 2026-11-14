import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// `lib/index.js` imports several Host packages and sibling feature modules that
// are unavailable in a plain checkout. Stub them so the provider's startup
// failure wrapping can be exercised without a DSH runtime.
const SUBAGENT_STUB = `data:text/javascript,${encodeURIComponent(`
export const NO_START_CAPABILITIES = {};
export const assertPositiveFinite = () => {};
export const assertUsableCwd = (prefix, label, cwd) => {
	if (cwd === undefined || cwd === null || cwd === '') {
		throw new Error(prefix + ': ' + label + ' must be a non-empty directory');
	}
	return cwd;
};
export const settleRunResult = () => ({});
export const subprocessRunHandle = () => ({});
`)}`;

const TIMEOUT_STUB = `data:text/javascript,export const MAX_TIMER_DELAY_MS = 2147483647;`;

const SCHEMASTERY_STUB = `data:text/javascript,${encodeURIComponent(`
const chain = () => new Proxy({}, {
	get(_t, key) {
		if (key === 'volatile') return () => ({});
		return chain;
	},
});
const fn = new Proxy(() => ({}), {
	get(_t, key) {
		if (key === 'object') return (obj) => new Proxy(obj, {
			get(_o, k) { if (k === 'volatile') return () => ({}); return chain; },
		});
		return chain;
	},
});
export default fn;
`)}`;

const GEMINI_WEB_STUB = `data:text/javascript,export const setupGeminiWeb = () => {};`;
const PARALLEL_STUB = `data:text/javascript,export const setupParallelTool = () => {};`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '@deepseek-ai/dsh-brand') {
			return { url: 'data:text/javascript,export const brandString = (value) => value;', shortCircuit: true };
		}
		if (specifier === '@deepseek-ai/dsh-subagent') {
			return { url: SUBAGENT_STUB, shortCircuit: true };
		}
		if (specifier === '@deepseek-ai/dsh-timeout') {
			return { url: TIMEOUT_STUB, shortCircuit: true };
		}
		if (specifier === '@deepseek-ai/schemastery') {
			return { url: SCHEMASTERY_STUB, shortCircuit: true };
		}
		if (specifier.endsWith('/gemini-web.js')) {
			return { url: GEMINI_WEB_STUB, shortCircuit: true };
		}
		if (specifier.endsWith('/parallel.js')) {
			return { url: PARALLEL_STUB, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const { apply } = await import('../lib/index.js');

/**
 * 造一个最小 ctx：捕获注册的 provider，记录 warn 调用，并提供 subprocess。
 */
function makeCtx(config) {
	const providers = [];
	const warns = [];
	const ctx = {
		logger: { warn: (msg) => { warns.push(msg); } },
		subagents: {
			registerProvider: (provider) => { providers.push(provider); },
		},
		subprocess: { spawn: () => { throw new Error('spawn not used in startup tests'); } },
	};
	apply(ctx, config);
	return { ctx, providers, warns };
}

function request(overrides = {}) {
	return {
		cwd: 'C:\\ws',
		prompt: [{ type: 'text', text: 'hi' }],
		signal: new AbortController().signal,
		...overrides,
	};
}

test('AntigravityProvider.start: cwd 校验失败包装为 initialize/unknown，原始错误挂 cause，并记录 warn', () => {
	const { providers, warns } = makeCtx({ executable: 'C:\\agy.exe', teamEnabled: false });
	const provider = providers[0];
	assert.ok(provider, 'provider 应已注册');

	let thrownError;
	try {
		provider.start(request({ cwd: '' }));
	} catch (error) {
		thrownError = error;
	}
	assert.ok(thrownError, 'cwd 校验失败应抛错');
	assert.equal(thrownError.name, 'AntigravityRunFailure');
	assert.equal(thrownError.facts.stage, 'initialize');
	assert.equal(thrownError.facts.category, 'unknown');
	assert.ok(thrownError.cause instanceof Error, '原始错误应挂 cause');
	assert.equal(warns.length, 1, '应记录一条 warn');
	assert.match(warns[0], /child start failed/);
});

test('AntigravityProvider.start: executable 不存在时同样包装为 initialize/unknown', () => {
	const { providers, warns } = makeCtx({ executable: 'C:\\does\\not\\exist\\agy.exe', teamEnabled: false });
	const provider = providers[0];

	let thrownError;
	try {
		provider.start(request());
	} catch (error) {
		thrownError = error;
	}
	assert.equal(thrownError.name, 'AntigravityRunFailure');
	assert.equal(thrownError.facts.stage, 'initialize');
	assert.equal(thrownError.facts.category, 'unknown');
	assert.ok(thrownError.cause instanceof Error);
	assert.match(warns[0], /child start failed/);
});

test('AntigravityProvider.start: signal.aborted 时保留 "aborted before CLI startup" 语义', () => {
	const { providers, warns } = makeCtx({ executable: 'C:\\agy.exe', teamEnabled: false });
	const provider = providers[0];
	const controller = new AbortController();
	controller.abort();

	let thrownError;
	try {
		provider.start(request({ cwd: '', signal: controller.signal }));
	} catch (error) {
		thrownError = error;
	}
	assert.equal(thrownError.name, 'Error');
	assert.match(thrownError.message, /aborted before CLI startup/);
	assert.equal(warns.length, 0, 'abort 路径不应记录 startup failure warn');
});
