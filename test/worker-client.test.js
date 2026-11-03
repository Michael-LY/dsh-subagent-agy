import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GeminiWorkerClient, WorkerError } from '../lib/worker-client.js';

const FAKE_WORKER = `
import { createInterface } from 'node:readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let ignoreShutdown = false;
send({ type: 'ready', pid: process.pid });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'shutdown') {
    if (ignoreShutdown) return;
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
  if (command === 'stubborn') {
    ignoreShutdown = true;
    send({ type: 'result', id, ok: true, data: { stubborn: true } });
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

test('GeminiWorkerClient: pending 请求期间 idle 定时器不会误杀 worker', async () => {
	const { client, dir } = makeClient({ idleTimeoutMs: 40 });
	try {
		const slow = client.request('slow', {}, { timeoutMs: 2000 });
		await new Promise((resolve) => setTimeout(resolve, 150));
		// Without the pending guard this would have been shut down by now.
		assert.equal(client.health.running, true);
		assert.deepEqual(await slow, { slow: true });
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('GeminiWorkerClient: 并发请求互不干扰', async () => {
	const { client, dir } = makeClient({ idleTimeoutMs: 40 });
	try {
		const slow = client.request('slow', {}, { timeoutMs: 2000 });
		const echo = client.request('echo', { concurrent: true });
		assert.deepEqual(await echo, { echo: { concurrent: true } });
		assert.deepEqual(await slow, { slow: true });
		assert.equal(client.health.running, true);
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('GeminiWorkerClient: 旧进程延迟退出不影响后续 worker', async () => {
	const { client, dir } = makeClient({ shutdownGraceMs: 30 });
	try {
		assert.deepEqual(await client.request('stubborn'), { stubborn: true });
		// The stubborn worker ignores the shutdown command; shutdown kills it
		// after the grace period and immediately returns. Its late exit event
		// must not close the next worker's line reader.
		await client.shutdown();
		assert.deepEqual(await client.request('echo', { afterStale: true }), { echo: { afterStale: true } });
		assert.equal(client.health.ready, true);
	} finally {
		await client.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
