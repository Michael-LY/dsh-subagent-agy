import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AntigravityStream } from '../lib/wire.js';

/** 把若干 envelope 对象拼成 NDJSON 文本（带结尾换行）。 */
function ndjson(...envelopes) {
	return envelopes.map((envelope) => `${JSON.stringify(envelope)}\n`).join('');
}

test('AntigravityStream: 7 字节分片重组，终态 result.response 优先', () => {
	const payload = ndjson(
		{ event: 'init', conversation_id: 'c1', init: {} },
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'par' } },
		{ event: 'result', result: { status: 'SUCCESS', response: 'partial answer' } },
	);
	const stream = new AntigravityStream('test');
	for (let i = 0; i < payload.length; i += 7) stream.push(payload.slice(i, i + 7));
	stream.end();

	assert.equal(stream.conversationId, 'c1');
	assert.equal(stream.terminalObserved, true);
	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'partial answer' }],
		stopReason: 'completed',
	});
});

test('AntigravityStream: 多个 text_delta 拼起来作为兜底', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson(
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hello ' } },
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'world' } },
		{ event: 'result', result: { status: 'SUCCESS' } },
	));
	stream.end();

	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'hello world' }],
		stopReason: 'completed',
	});
});

test('AntigravityStream: 终态 response 为空时用 text_delta 兜底', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson(
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'streamed text' } },
		{ event: 'result', result: { status: 'SUCCESS', response: '' } },
	));
	stream.end();

	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'streamed text' }],
		stopReason: 'completed',
	});
});

test('AntigravityStream: 没有终态帧 → stopReason error', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson(
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'partial' } },
	));
	stream.end();

	assert.equal(stream.terminalObserved, false);
	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'partial' }],
		stopReason: 'error',
	});
});

test('AntigravityStream: 无任何输出 → output 为空数组', () => {
	const stream = new AntigravityStream('test');
	stream.push('\n\n');
	stream.end();

	assert.deepEqual(stream.result(), { output: [], stopReason: 'error' });
});

test('AntigravityStream: 空白 response 不产出文本块', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson({ event: 'result', result: { status: 'SUCCESS', response: '   ' } }));
	stream.end();

	assert.deepEqual(stream.result(), { output: [], stopReason: 'completed' });
});

test('AntigravityStream: 终态 status 映射 completed/aborted/error', () => {
	const cases = [
		['SUCCESS', 'completed'],
		['CANCELED', 'aborted'],
		['CANCELLED', 'aborted'],
		['INTERRUPTED', 'aborted'],
		['ERROR', 'error'],
		['FAILURE', 'error'],
	];
	for (const [status, expected] of cases) {
		const stream = new AntigravityStream('test');
		stream.push(ndjson({ event: 'result', result: { status, response: 'x' } }));
		stream.end();
		assert.equal(stream.result().stopReason, expected, `status ${status}`);
	}
});

test('AntigravityStream: 未知 status 记 malformed 且按 error 处理', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson({ event: 'result', result: { status: 'WEIRD', response: 'x' } }));
	stream.end();

	assert.match(stream.malformed, /unknown result status "WEIRD"/);
	assert.equal(stream.result().stopReason, 'error');
});

test('AntigravityStream: 跨 chunk 的 JSON 行与一个 chunk 多行都能解析', () => {
	const line = JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'ok' } });
	const stream = new AntigravityStream('test');
	stream.push(line.slice(0, 10));
	stream.push(line.slice(10));
	stream.push('\n');
	stream.push(ndjson({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }));
	stream.end();

	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'done' }],
		stopReason: 'completed',
	});
});

test('AntigravityStream: end() 处理没有结尾换行的尾帧', () => {
	const stream = new AntigravityStream('test');
	stream.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }));
	stream.end();

	assert.equal(stream.terminalObserved, true);
	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'done' }],
		stopReason: 'completed',
	});
});

test('AntigravityStream: 支持 Buffer chunk', () => {
	const stream = new AntigravityStream('test');
	stream.push(Buffer.from(ndjson({ event: 'result', result: { status: 'SUCCESS', response: 'buffered' } })));
	stream.end();

	assert.deepEqual(stream.result(), {
		output: [{ type: 'text', text: 'buffered' }],
		stopReason: 'completed',
	});
});

test('AntigravityStream: 非 agent_response 的 text_delta 不计入答案', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson(
		{ event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'echo' } },
		{ event: 'result', result: { status: 'SUCCESS' } },
	));
	stream.end();

	assert.deepEqual(stream.result(), { output: [], stopReason: 'completed' });
});

test('AntigravityStream: conversation_id 只取第一次出现的值', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson(
		{ event: 'init', conversation_id: 'c1' },
		{ event: 'init', conversation_id: 'c2' },
	));
	stream.end();

	assert.equal(stream.conversationId, 'c1');
});

test('AntigravityStream: 非 JSON 行 / 非对象 envelope / 无效 result 都记 malformed', () => {
	const nonJson = new AntigravityStream('test');
	nonJson.push('not json\n');
	nonJson.end();
	assert.match(nonJson.malformed, /non-JSON line/);

	const nonObject = new AntigravityStream('test');
	nonObject.push('[]\n');
	nonObject.end();
	assert.match(nonObject.malformed, /non-object envelope/);

	const badResult = new AntigravityStream('test');
	badResult.push(ndjson({ event: 'result', result: 'nope' }));
	badResult.end();
	assert.match(badResult.malformed, /invalid result envelope/);
	assert.equal(badResult.terminalObserved, false);
});

test('AntigravityStream: 失败终态收集 errorText 与 product-error 失败事实', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson({ event: 'result', result: { status: 'ERROR', response: 'boom', error: { message: 'quota exceeded' } } }));
	stream.end();

	assert.equal(stream.result().stopReason, 'error');
	assert.deepEqual(stream.collectFailure(), { stage: 'turn', category: 'product-error' });
	assert.match(stream.errorText, /quota exceeded/);
});

test('AntigravityStream: 失败 result 追加而非覆盖已有 errorText', () => {
	const early = new AntigravityStream('test');
	early.push(ndjson(
		{ event: 'error', error: { message: 'early stderr hint' } },
		{ event: 'result', result: { status: 'ERROR', response: 'boom', error: { message: 'terminal error' } } },
	));
	early.end();
	assert.match(early.errorText, /early stderr hint[\s\S]*terminal error/);

	const late = new AntigravityStream('test');
	late.push(ndjson(
		{ event: 'result', result: { status: 'ERROR', response: 'boom' } },
		{ event: 'error', error: { message: 'late stderr hint' } },
	));
	late.end();
	assert.match(late.errorText, /"status":"ERROR"[\s\S]*late stderr hint/);
});

test('AntigravityStream: error envelope 累积 errorText 并记 malformed', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson(
		{ event: 'error', error: { message: '429 too many requests' } },
		{ event: 'error', error: { message: 'retry later' } },
	));
	stream.end();

	assert.match(stream.errorText, /429 too many requests[\s\S]*retry later/);
	assert.match(stream.malformed, /agy reported/);
	assert.deepEqual(stream.collectFailure(), { stage: 'turn', category: 'unknown' });
});

test('AntigravityStream: 成功终态不设置失败事实', () => {
	const stream = new AntigravityStream('test');
	stream.push(ndjson({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }));
	stream.end();

	assert.equal(stream.errorText, undefined);
	assert.deepEqual(stream.collectFailure(), { stage: 'turn', category: 'unknown' });
});
