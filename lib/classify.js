/**
 * Failure classification for Antigravity CLI runs.
 *
 * Pure and dependency-free so it can be unit-tested without the Host packages.
 *
 * @module dsh-subagent-antigravity/classify
 */

/** Parse an approximate retry/reset delay (ms) from textual hints. */
export function parseRetryAfterMs(text) {
	const after = /retry[\s_-]*after[^0-9]{0,12}(\d{1,6})/i.exec(text);
	if (after !== null) return Math.min(Number(after[1]), 3600) * 1000;
	const reset = /reset(?:s)?\s+in\s+(?:(\d{1,3})h)?\s*(?:(\d{1,3})m)?\s*(?:(\d{1,3})s)?/i.exec(text);
	if (reset !== null && (reset[1] || reset[2] || reset[3])) {
		const h = Number(reset[1] ?? 0);
		const m = Number(reset[2] ?? 0);
		const s = Number(reset[3] ?? 0);
		return ((h * 3600) + (m * 60) + s) * 1000;
	}
	return undefined;
}

/**
 * Classify a failed run from its textual error and process outcome.
 * @param {string | undefined} text raw error text (result/error envelope + stderr)
 * @param {{exitCode?: number | null, signal?: string | null} | undefined} outcome child process outcome
 * @returns {{kind: 'usage_error' | 'rate_limited' | 'quota_exhausted' | 'unknown', retryAfterMs?: number}}
 */
export function classifyFailure(text, outcome) {
	if (outcome !== undefined && outcome.exitCode === 2) return { kind: 'usage_error' };
	const t = (text ?? '').toLowerCase();
	const retryAfterMs = parseRetryAfterMs(t);
	if (/too many requests|rate[\s_-]*limit|\b429\b|resource[_ ]?exhausted|overloaded/.test(t)) {
		return retryAfterMs === undefined ? { kind: 'rate_limited' } : { kind: 'rate_limited', retryAfterMs };
	}
	if (/quota|limit exceeded|exceeded your|out of credits|insufficient/.test(t)) {
		return retryAfterMs === undefined ? { kind: 'quota_exhausted' } : { kind: 'quota_exhausted', retryAfterMs };
	}
	return { kind: 'unknown' };
}
