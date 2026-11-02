import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_MAX_PARALLEL_TASKS,
	normalizeParallelTasks,
	renderParallelStart,
	setupParallelTool,
} from '../lib/parallel.js';

test('normalizeParallelTasks: 去空白、保留 cwd、description 可选', () => {
	const tasks = normalizeParallelTasks([
		{ description: ' first ', prompt: ' do first ', cwd: ' C:/work ' },
		{ prompt: 'do second' },
	], 8);

	assert.deepEqual(tasks, [
		{ description: 'first', prompt: 'do first', cwd: 'C:/work' },
		{ description: 'do second', prompt: 'do second' },
	]);
});

test('normalizeParallelTasks: 空数组、超上限、非数组都拒绝', () => {
	assert.throws(() => normalizeParallelTasks([], 8), /at least one task/);
	assert.throws(() => normalizeParallelTasks([{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], 2), /at most 2 tasks/);
	assert.throws(() => normalizeParallelTasks('not-an-array', 8), /must be an array/);
});

test('normalizeParallelTasks: 空 prompt、空 cwd、非对象任务拒绝', () => {
	assert.throws(() => normalizeParallelTasks([{ prompt: '   ' }], 8), /prompt must not be empty/);
	assert.throws(() => normalizeParallelTasks([{ prompt: 'a', cwd: '' }], 8), /cwd must not be empty/);
	assert.throws(() => normalizeParallelTasks([null], 8), /must be an object/);
});

test('normalizeParallelTasks: description 缺失时用 prompt 前 40 字符', () => {
	const prompt = 'x'.repeat(60);
	const [task] = normalizeParallelTasks([{ prompt }], 8);
	assert.equal(task.description, prompt.slice(0, 40));
	assert.equal(DEFAULT_MAX_PARALLEL_TASKS, 8);
});

test('renderParallelStart: 只报告启动/失败数量与失败原因', () => {
	assert.equal(renderParallelStart({ started: [{ description: 'a', subagentId: 's1' }, { description: 'b', subagentId: 's2' }], failed: [] }), '已启动 2 个 agy 子智能体');
	const text = renderParallelStart({
		started: [{ description: 'a', subagentId: 's1' }],
		failed: [{ description: 'b', error: 'boom' }],
	});
	assert.match(text, /已启动 1 个 agy 子智能体/);
	assert.match(text, /1 个启动失败：b: boom/);
});

test('setupParallelTool: 注册原始工具定义并并发调用 startActivation', async () => {
	let definition;
	const calls = [];
	const tctx = {
		effect(fn) {
			return fn();
		},
		tools: {
			register(value) {
				definition = value;
				return () => {};
			},
		},
		subagents: {
			async startActivation(spec) {
				calls.push(spec);
				return { childId: `child-${spec.label}` };
			},
		},
	};
	const ctx = {
		inject(services, callback) {
			assert.deepEqual(services, ['tools', 'subagents']);
			return callback(tctx);
		},
	};

	setupParallelTool(ctx, { provider: 'antigravity', toolName: 'subagent_agy_parallel', maxTasks: 3 });
	assert.equal(definition.name, 'subagent_agy_parallel');
	assert.equal(definition.parameters.type, 'object');
	assert.equal(definition.parameters.properties.tasks.type, 'array');
	assert.deepEqual(definition.parameters.required, ['tasks']);
	assert.equal(definition.isConcurrencySafe(), true);

	const agent = {};
	const signal = new AbortController().signal;
	const result = await definition.execute({
		tasks: [
			{ description: 'one', prompt: 'do one', cwd: 'C:/one' },
			{ description: 'two', prompt: 'do two' },
		],
	}, { agent, signal });

	assert.deepEqual(result, {
		started: [
			{ description: 'one', subagentId: 'child-one' },
			{ description: 'two', subagentId: 'child-two' },
		],
		failed: [],
	});
	assert.equal(calls.length, 2);
	assert.equal(calls[0].provider, 'antigravity');
	assert.equal(calls[0].label, 'one');
	assert.equal(calls[0].delivery, 'parent');
	assert.equal(calls[0].signal, signal);
	assert.equal(calls[0].request.parent, agent);
	assert.deepEqual(calls[0].request.prompt, [{ type: 'text', text: 'do one' }]);
	assert.equal(calls[0].request.cwd, 'C:/one');
	assert.equal('cwd' in calls[1].request, false);
	assert.deepEqual(definition.output.render(null, result), [{ type: 'text', text: '已启动 2 个 agy 子智能体' }]);
});

test('setupParallelTool: 部分失败保留成功项，全部失败抛出原因', async () => {
	let definition;
	const tctx = {
		effect(fn) {
			return fn();
		},
		tools: {
			register(value) {
				definition = value;
				return () => {};
			},
		},
		subagents: {
			async startActivation(spec) {
				if (spec.label === 'bad') throw new Error('boom');
				return { childId: 'child-ok' };
			},
		},
	};
	setupParallelTool({ inject: (_services, callback) => callback(tctx) }, { provider: 'antigravity', maxTasks: 2 });

	const partial = await definition.execute({
		tasks: [{ description: 'ok', prompt: 'ok' }, { description: 'bad', prompt: 'bad' }],
	}, { agent: {}, signal: new AbortController().signal });
	assert.deepEqual(partial.started, [{ description: 'ok', subagentId: 'child-ok' }]);
	assert.deepEqual(partial.failed, [{ description: 'bad', error: 'boom' }]);

	await assert.rejects(
		definition.execute({ tasks: [{ description: 'bad', prompt: 'bad' }] }, { agent: {}, signal: new AbortController().signal }),
		/all parallel agy subagents failed: bad: boom/,
	);
});
