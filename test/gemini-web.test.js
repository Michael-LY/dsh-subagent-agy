import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildRunArgs, createJobQueue, summarizeJob, validateTopic } from '../lib/gemini-web.js';

test('validateTopic: 去空白、拒绝空值与非字符串', () => {
	assert.equal(validateTopic('  hello  '), 'hello');
	assert.throws(() => validateTopic('   '), /不能为空/);
	assert.throws(() => validateTopic(42), /必须是字符串/);
	assert.throws(() => validateTopic('x'.repeat(8001)), /不能超过/);
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
