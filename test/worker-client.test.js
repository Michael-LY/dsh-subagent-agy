import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GeminiWorkerClient, WorkerError } from '../lib/worker-client.js';

const FAKE_WORKER = `
import { createInterface } from 'node:readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'ready', pid: process.pid });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'shutdown') {
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (message.type !== 'request') return;
  const { id, command, payload } = message;
  if (command === 'echo') {
    send({ type: 'progress', id, phase: 'working' });
    setTimeout(() => send({ type: 'result', id, ok: true, data: { echo: payload } }), 10);
    return;
  }
  if (command === 'fail') {
    send({ type: 'result', id, ok: false, error: { code: 'test_failure', message: 'expected failure' } });
    return;
  }
  if (command === 'crash') {
    process.exit(7);
    return;
  }
  if (command === 'slow') {
    setTimeout(() => send({ type: 'result', id, ok: true, data: { slow: true } }), 500);
    return;
  }
  send({ type: 'result', id, ok: false, error: { code: 'unknown', message: 'unknown command' } });
});
`;

function makeClient(overrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'worker-client-test-'));
	const script = join(dir, 'fake-worker.mjs');
	writeFileSync(script, FAKE_WORKER, 'utf8');
	const client = new GeminiWorkerClient({
		command: process.execPath,
		args: [script],
		startupTimeoutMs: 5000,
		idleTimeoutMs: 0,
		...overrides,
	});
	return { client, dir };
}

test('GeminiWorkerClient: 懒启动、请求关联与 progress', async () => {
	const { client, dir } = makeClient();
	try {
		assert.equal(client.health.running, false);
		const progress = [];
		const result = await client.request('echo', { value: 42 }, { onProgress: (event) => progress.push(event) });
		assert.deepEqual(result, { echo: { value: 42 } });
		assert.equal(progress.length, 1);
		assert.equal(progress[0].phase, 'working');
		assert.equal(client.health.running, true);
		assert.equal(client.health.ready, true);
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('GeminiWorkerClient: worker 错误结果映射为 WorkerError', async () => {
	const { client, dir } = makeClient();
	try {
		await assert.rejects(
			client.request('fail'),
			(error) => error instanceof WorkerError && error.code === 'test_failure' && /expected failure/.test(error.message),
		);
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('GeminiWorkerClient: 崩溃拒绝 pending，下一次请求自动重启', async () => {
	const { client, dir } = makeClient();
	try {
		const crashed = client.request('crash');
		await assert.rejects(crashed, (error) => error instanceof WorkerError);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(client.health.running, false);
		const restarted = await client.request('echo', { afterCrash: true });
		assert.deepEqual(restarted, { echo: { afterCrash: true } });
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('GeminiWorkerClient: 请求超时返回 worker_timeout 并可继续使用', async () => {
	const { client, dir } = makeClient();
	try {
		await assert.rejects(client.request('slow', {}, { timeoutMs: 50 }), (error) => error instanceof WorkerError && error.code === 'worker_timeout');
		const result = await client.request('echo', { afterTimeout: true });
		assert.deepEqual(result, { echo: { afterTimeout: true } });
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('GeminiWorkerClient: idle 超时自动 shutdown', async () => {
	const { client, dir } = makeClient({ idleTimeoutMs: 40 });
	try {
		await client.request('echo', { idle: true });
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(client.health.running, false);
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
