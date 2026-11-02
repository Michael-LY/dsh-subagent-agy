import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFailure, parseRetryAfterMs } from '../lib/classify.js';

test('parseRetryAfterMs: retry-after 数字按秒换算', () => {
	assert.equal(parseRetryAfterMs('retry after 30'), 30_000);
	assert.equal(parseRetryAfterMs('Retry-After: 120'), 120_000);
	assert.equal(parseRetryAfterMs('retry_after=5'), 5_000);
});

test('parseRetryAfterMs: retry-after 上限截到 1 小时', () => {
	assert.equal(parseRetryAfterMs('retry after 999999'), 3_600_000);
});

test('parseRetryAfterMs: Resets in XhYmZs 组合时长', () => {
	assert.equal(parseRetryAfterMs('quota will reset in 1h2m3s'), ((1 * 3600) + (2 * 60) + 3) * 1000);
	assert.equal(parseRetryAfterMs('Resets in 45s'), 45_000);
	assert.equal(parseRetryAfterMs('resets in 2m'), 120_000);
	assert.equal(parseRetryAfterMs('resets in 3h'), 10_800_000);
});

test('parseRetryAfterMs: 无提示返回 undefined', () => {
	assert.equal(parseRetryAfterMs('something went wrong'), undefined);
	assert.equal(parseRetryAfterMs(''), undefined);
	assert.equal(parseRetryAfterMs('reset in soon'), undefined);
});

test('classifyFailure: quota 文案归为 quota_exhausted', () => {
	assert.deepEqual(classifyFailure('Quota limit exceeded', { exitCode: 1 }), { kind: 'quota_exhausted' });
	assert.deepEqual(classifyFailure('You have exceeded your quota', { exitCode: 1 }), { kind: 'quota_exhausted' });
	assert.deepEqual(classifyFailure('out of credits', {}), { kind: 'quota_exhausted' });
	assert.deepEqual(classifyFailure('insufficient credits', {}), { kind: 'quota_exhausted' });
});

test('classifyFailure: 429 / rate limit 归为 rate_limited', () => {
	assert.deepEqual(classifyFailure('HTTP 429: Too Many Requests', { exitCode: 1 }), { kind: 'rate_limited' });
	assert.deepEqual(classifyFailure('429 too many requests', { exitCode: 1 }), { kind: 'rate_limited' });
	assert.deepEqual(classifyFailure('rate limit exceeded', { exitCode: 1 }), { kind: 'rate_limited' });
	assert.deepEqual(classifyFailure('resource_exhausted', { exitCode: 1 }), { kind: 'rate_limited' });
	assert.deepEqual(classifyFailure('model overloaded', { exitCode: 1 }), { kind: 'rate_limited' });
});

test('classifyFailure: 带 retry-after 的限流', () => {
	assert.deepEqual(
		classifyFailure('429 Too Many Requests (retry after 12)', { exitCode: 1 }),
		{ kind: 'rate_limited', retryAfterMs: 12_000 },
	);
});

test('classifyFailure: 带 reset 时长的配额耗尽', () => {
	assert.deepEqual(
		classifyFailure('quota exhausted; resets in 1h30m', { exitCode: 1 }),
		{ kind: 'quota_exhausted', retryAfterMs: 5_400_000 },
	);
});

test('classifyFailure: exit 2 一律 usage_error，优先于文本分类', () => {
	assert.deepEqual(classifyFailure('429 too many requests', { exitCode: 2 }), { kind: 'usage_error' });
	assert.deepEqual(classifyFailure('quota limit exceeded', { exitCode: 2 }), { kind: 'usage_error' });
	assert.deepEqual(classifyFailure(undefined, { exitCode: 2 }), { kind: 'usage_error' });
});

test('classifyFailure: 无匹配文案归为 unknown', () => {
	assert.deepEqual(classifyFailure('something exploded', { exitCode: 1 }), { kind: 'unknown' });
	assert.deepEqual(classifyFailure(undefined, undefined), { kind: 'unknown' });
	assert.deepEqual(classifyFailure('', { exitCode: 1 }), { kind: 'unknown' });
});

test('classifyFailure: 大小写不敏感', () => {
	assert.deepEqual(classifyFailure('TOO MANY REQUESTS', { exitCode: 1 }), { kind: 'rate_limited' });
	assert.deepEqual(classifyFailure('QUOTA EXCEEDED', { exitCode: 1 }), { kind: 'quota_exhausted' });
});
