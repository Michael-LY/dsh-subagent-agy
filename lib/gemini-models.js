/**
 * Static Gemini model catalog and normalization helpers.
 *
 * The live catalog is read from the Gemini page by the worker; these defaults
 * cover selector/API failures and keep the panels usable offline.
 */

/** Fallback model entries. Tokens are matched against the live menu text. */
export const DEFAULT_MODEL_OPTIONS = Object.freeze([
	{ id: 'flash-lite', label: 'Flash-Lite', displayName: 'Flash-Lite', tokens: ['3.5 flash-lite', 'flash-lite', 'flash lite'], thinkingLevels: ['low', 'medium', 'high'] },
	{ id: 'flash', label: 'Flash', displayName: 'Flash', tokens: ['3.8 flash', 'flash'], thinkingLevels: ['low', 'medium', 'high'] },
	{ id: 'pro', label: 'Pro', displayName: 'Pro', tokens: ['3.1 pro', 'pro'], thinkingLevels: ['low', 'medium', 'high'] },
	{ id: 'argon', label: 'Argon', displayName: '4 Argon', tokens: ['4 argon', 'argon'], thinkingLevels: ['low', 'medium', 'high'] },
]);

/** Fallback thinking levels (model menu -> 思考等级). */
export const DEFAULT_THINKING_OPTIONS = Object.freeze([
	{ id: 'low', label: '低（快速高效）', tokens: ['低', '快速高效', 'low', 'quick and efficient'] },
	{ id: 'medium', label: '中（深度适中）', tokens: ['中', '深度适中', 'medium', 'balanced depth'] },
	{ id: 'high', label: '高（超级详尽）', tokens: ['高', '超级详尽', 'high', 'extra thorough'] },
]);

/** Full fallback catalog. */
export const DEFAULT_MODEL_CATALOG = Object.freeze({
	models: DEFAULT_MODEL_OPTIONS,
	thinking: DEFAULT_THINKING_OPTIONS,
	deepThink: { supported: false, label: 'Deep Think' },
	source: 'fallback',
});

function slug(value) {
	return String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

function tokenList(value, fallback) {
	const tokens = Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
	return tokens.length > 0 ? tokens.map((item) => item.trim().toLowerCase()) : fallback;
}

/**
 * Normalize a worker catalog payload into the stable shape used by the API.
 * Unknown/invalid fields fall back rather than throwing: the panel must remain
 * usable even if the page layout changed.
 */
export function normalizeModelCatalog(payload) {
	if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.models) || payload.models.length === 0) {
		return { ...DEFAULT_MODEL_CATALOG, models: DEFAULT_MODEL_OPTIONS.slice(), thinking: DEFAULT_THINKING_OPTIONS.slice(), source: 'fallback' };
	}
	const models = [];
	for (const item of payload.models) {
		if (item === null || typeof item !== 'object') continue;
		const label = typeof item.label === 'string' && item.label.trim().length > 0 ? item.label.trim() : '';
		const id = typeof item.id === 'string' && item.id.trim().length > 0 ? slug(item.id) : slug(label);
		if (!id || !label) continue;
		models.push({
			id,
			label,
			displayName: typeof item.displayName === 'string' && item.displayName.trim().length > 0 ? item.displayName.trim() : label,
			tokens: tokenList(item.tokens, [label.toLowerCase()]),
			thinkingLevels: Array.isArray(item.thinkingLevels) ? item.thinkingLevels.filter((level) => typeof level === 'string') : [],
		});
	}
	if (models.length === 0) return { ...DEFAULT_MODEL_CATALOG, models: DEFAULT_MODEL_OPTIONS.slice(), thinking: DEFAULT_THINKING_OPTIONS.slice(), source: 'fallback' };
	const thinking = [];
	if (Array.isArray(payload.thinking)) {
		for (const item of payload.thinking) {
			if (item === null || typeof item !== 'object') continue;
			const label = typeof item.label === 'string' && item.label.trim().length > 0 ? item.label.trim() : '';
			const id = typeof item.id === 'string' && item.id.trim().length > 0 ? slug(item.id) : slug(label);
			if (!id || !label) continue;
			thinking.push({ id, label, tokens: tokenList(item.tokens, [label.toLowerCase()]) });
		}
	}
	return {
		models,
		thinking: thinking.length > 0 ? thinking : DEFAULT_THINKING_OPTIONS.slice(),
		deepThink: payload.deepThink && typeof payload.deepThink === 'object'
			? { supported: payload.deepThink.supported === true, label: typeof payload.deepThink.label === 'string' ? payload.deepThink.label : 'Deep Think' }
			: { supported: false, label: 'Deep Think' },
		source: payload.source === 'live' ? 'live' : 'fallback',
	};
}

function normalizeChoice(value, field) {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
	const choice = value.trim();
	if (choice.length === 0) return '';
	if (choice.length > 64) throw new Error(`${field} 不能超过 64 个字符`);
	if (/[\u0000-\u001f\u007f]/.test(choice)) throw new Error(`${field} 包含非法字符`);
	return choice;
}

/** Validate an optional model id (empty means "follow the web default"). */
export function validateModel(value) {
	return normalizeChoice(value, 'model');
}

/** Validate an optional thinking level id (empty means "follow the web default"). */
export function validateThinking(value) {
	return normalizeChoice(value, 'thinking');
}

function normalized(value) {
	return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Find the best matching model entry by English token / label. */
export function matchModelOption(text, models = DEFAULT_MODEL_OPTIONS) {
	const haystack = normalized(text);
	let best = null;
	let bestLength = 0;
	for (const model of models) {
		const tokens = [model.id, ...(model.tokens ?? []), model.label].map(normalized);
		for (const token of tokens) {
			if (token.length > bestLength && haystack.includes(token)) {
				best = model;
				bestLength = token.length;
			}
		}
	}
	return best;
}

/** Find the best matching thinking entry by id / label / text. */
export function matchThinkingOption(text, thinking = DEFAULT_THINKING_OPTIONS) {
	const haystack = normalized(text);
	let best = null;
	let bestLength = 0;
	for (const level of thinking) {
		const tokens = [level.id, ...(level.tokens ?? []), level.label].map(normalized);
		for (const token of tokens) {
			if (token.length > bestLength && haystack.includes(token)) {
				best = level;
				bestLength = token.length;
			}
		}
	}
	return best;
}
