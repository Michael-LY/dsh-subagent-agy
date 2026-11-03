import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// `lib/run.js` imports two Host packages that are unavailable in a plain
// checkout. Resolve them to tiny data-URL stubs so the pure argv builder can be
// imported without a DSH runtime.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '@deepseek-ai/dsh-brand') {
			return {
				url: 'data:text/javascript,export const brandString = (value) => value;',
				shortCircuit: true,
			};
		}
		if (specifier === '@deepseek-ai/dsh-subagent') {
			return {
				url: 'data:text/javascript,export const settleRunResult = () => ({}); export const subprocessRunHandle = () => ({});',
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

const { antigravityArgv } = await import('../lib/run.js');

const BASE = {
	executable: 'agy.exe',
	permissionMode: 'dangerously-skip-permissions',
	extraArgs: [],
	prompt: 'hello',
};

function argv(overrides = {}) {
	return antigravityArgv({ ...BASE, ...overrides });
}

test('antigravityArgv: 默认不添加 --new-project / --project', () => {
	const args = argv();
	assert.equal(args.includes('--new-project'), false);
	assert.equal(args.includes('--project'), false);
});

test('antigravityArgv: newProject=true 才添加 --new-project', () => {
	assert.equal(argv({ newProject: false }).includes('--new-project'), false);
	assert.equal(argv({ newProject: true }).includes('--new-project'), true);
});

test('antigravityArgv: projectName 非空时添加 --project <name>', () => {
	const args = argv({ projectName: 'my-project' });
	const index = args.indexOf('--project');
	assert.notEqual(index, -1);
	assert.equal(args[index + 1], 'my-project');
	assert.equal(args.includes('--new-project'), false);
});

test('antigravityArgv: projectName 优先于 newProject，且会去空白', () => {
	const args = argv({ newProject: true, projectName: '  my-project  ' });
	assert.equal(args.includes('--new-project'), false);
	const index = args.indexOf('--project');
	assert.notEqual(index, -1);
	assert.equal(args[index + 1], 'my-project');
});

test('antigravityArgv: projectName 为空串时回落到 newProject 开关', () => {
	const args = argv({ newProject: true, projectName: '' });
	assert.equal(args.includes('--project'), false);
	assert.equal(args.includes('--new-project'), true);
});
