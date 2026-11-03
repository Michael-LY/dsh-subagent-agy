import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_MODEL_CATALOG,
	DEFAULT_MODEL_OPTIONS,
	DEFAULT_THINKING_OPTIONS,
	matchModelOption,
	matchThinkingOption,
	normalizeModelCatalog,
	validateModel,
	validateThinking,
} from '../lib/gemini-models.js';

test('gemini-models: validateModel/validateThinking 允许空值并拒绝非法输入', () => {
	assert.equal(validateModel(undefined), '');
	assert.equal(validateModel(null), '');
	assert.equal(validateModel('  flash  '), 'flash');
	assert.throws(() => validateModel(42), /必须是字符串/);
	assert.throws(() => validateModel('x'.repeat(65)), /不能超过/);
	assert.throws(() => validateModel('bad\u0000model'), /非法字符/);
	assert.equal(validateThinking(' high '), 'high');
});

test('gemini-models: 静态兜底包含 4 Argon 与三档思考等级', () => {
	const argon = DEFAULT_MODEL_OPTIONS.find((item) => item.id === 'argon');
	assert.ok(argon);
	assert.match(argon.label, /Argon/);
	assert.deepEqual(argon.thinkingLevels, ['low', 'medium', 'high']);
	assert.deepEqual(DEFAULT_THINKING_OPTIONS.map((item) => item.id), ['low', 'medium', 'high']);
});

test('gemini-models: normalizeModelCatalog 处理实时目录与空数据', () => {
	const fallback = normalizeModelCatalog(null);
	assert.equal(fallback.source, 'fallback');
	assert.equal(fallback.models.length, DEFAULT_MODEL_CATALOG.models.length);

	const live = normalizeModelCatalog({
		source: 'live',
		models: [{ id: 'flash-lite', label: '3.5 Flash-Lite 极速回答', tokens: ['flash-lite'], thinkingLevels: ['low', 'medium', 'high'] }],
		thinking: [{ id: 'high', label: '高 超级详尽' }],
		deepThink: { supported: false, label: 'Deep Think' },
	});
	assert.equal(live.source, 'live');
	assert.equal(live.models[0].id, 'flash-lite');
	assert.deepEqual(live.thinking.map((item) => item.id), ['high']);
	assert.equal(live.deepThink.supported, false);
});

test('gemini-models: 按英文 token 匹配模型，不被 Flash-Lite 抢走 Flash', () => {
	assert.equal(matchModelOption('3.5 Flash-Lite 极速回答', DEFAULT_MODEL_OPTIONS).id, 'flash-lite');
	assert.equal(matchModelOption('3.8 Flash 全方位帮助', DEFAULT_MODEL_OPTIONS).id, 'flash');
	assert.equal(matchModelOption('3.1 Pro 高级推理', DEFAULT_MODEL_OPTIONS).id, 'pro');
	assert.equal(matchModelOption('4 Argon 复杂任务', DEFAULT_MODEL_OPTIONS).id, 'argon');
});

test('gemini-models: 思考等级按中文/英文 token 匹配', () => {
	assert.equal(matchThinkingOption('高 超级详尽', DEFAULT_THINKING_OPTIONS).id, 'high');
	assert.equal(matchThinkingOption('Balanced depth', DEFAULT_THINKING_OPTIONS).id, 'medium');
	assert.equal(matchThinkingOption('Quick and efficient', DEFAULT_THINKING_OPTIONS).id, 'low');
});
