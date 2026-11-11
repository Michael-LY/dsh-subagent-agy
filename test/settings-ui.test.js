import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// lib/client.js is a lazy-CJS browser module: it installs a factory on
// window.__ModuleLoader__. We fake that global, capture the factory, and call it
// with a React stub so the pure settings helpers can be exercised under node.
const here = dirname(fileURLToPath(import.meta.url));
const clientPath = resolve(here, '../lib/client.js');

function reactStub() {
	return {
		createElement: function () { return null; },
		useState: function (initial) { return [typeof initial === 'function' ? initial() : initial, function () {}]; },
		useEffect: function () {},
		useRef: function () { return { current: null }; },
	};
}

async function loadClientModule() {
	let captured = null;
	const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
	const previous = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load: function (def) { captured = def; } } };
	try {
		await import(pathToFileURL(clientPath).href + '?case=' + Math.random());
	} finally {
		if (hadWindow) globalThis.window = previous;
		else delete globalThis.window;
	}
	assert.ok(captured && typeof captured.factory === 'function', 'captured the lazy-CJS factory');
	return captured.factory(function (id) {
		if (id === 'react' || id === 'react/jsx-runtime') return reactStub();
		throw new Error('unexpected require: ' + id);
	});
}

const mod = await loadClientModule();
const I = mod.__internals;

const CONFIG_FIELDS = [
	'providerName', 'executable', 'model', 'effort', 'env', 'permissionMode', 'extraArgs',
	'newProject', 'projectName', 'printTimeout', 'jsonSchema', 'addDirs', 'fallbackModel',
	'retryOnRateLimit', 'transport', 'acpProtocolVersion', 'acpRequestTimeoutMs',
	'acpPromptTimeoutMs', 'acpPermissionPolicy', 'acpFallbackToStreamJson', 'acpExtraArgs',
	'disposeGraceMs', 'geminiProfileDir', 'geminiPython', 'geminiHeadless', 'geminiTimeoutMs',
	'geminiChatTimeoutMs', 'geminiWorkerIdleMs', 'geminiWorkerMode', 'geminiDefaultModel',
	'geminiDefaultThinking', 'teamProviderName', 'teamEnabled', 'parallelToolName', 'parallelMaxTasks',
];

test('client module keeps Gemini panels, adds settings exports, keeps inject minimal', () => {
	assert.equal(typeof mod.apply, 'function');
	assert.equal(typeof mod.__panel, 'function');
	assert.equal(typeof mod.__chatPanel, 'function');
	assert.equal(typeof mod.__settingsSection, 'function');
	// configForms must stay OUT of the required inject list (safety: a deployment
	// without the settings plugin must still render the Gemini panels).
	assert.deepEqual(mod.inject, ['slots']);
});

test('field metadata covers exactly the 35 Config fields, one group each, valid controls', () => {
	const keys = I.FIELDS.map((f) => f.key);
	assert.equal(keys.length, 35);
	assert.equal(new Set(keys).size, keys.length, 'no duplicate field keys');
	assert.deepEqual([...keys].sort(), [...CONFIG_FIELDS].sort(), 'field keys match Config');
	const groupIds = I.FIELD_GROUPS.map((g) => g.id);
	assert.equal(groupIds.length, 5);
	const seen = new Set();
	for (const field of I.FIELDS) {
		assert.ok(groupIds.includes(field.group), 'unknown group: ' + field.group);
		assert.ok(['text', 'textarea', 'number', 'select', 'checkbox', 'list', 'keyvalue'].includes(field.control), 'unknown control: ' + field.control);
		assert.equal(typeof field.label, 'string');
		seen.add(field.group);
		if (field.control === 'select') assert.ok(Array.isArray(field.options) && field.options.length > 0, 'select needs options: ' + field.key);
	}
	for (const id of groupIds) assert.ok(seen.has(id), 'empty group: ' + id);
});

test('parseNumberField tolerates blanks/garbage and reports unset vs invalid vs set', () => {
	assert.deepEqual(I.parseNumberField(''), { kind: 'unset' });
	assert.deepEqual(I.parseNumberField('   '), { kind: 'unset' });
	assert.deepEqual(I.parseNumberField(undefined), { kind: 'unset' });
	assert.equal(I.parseNumberField('abc').kind, 'invalid');
	assert.equal(I.parseNumberField('oops').kind, 'invalid');
	assert.deepEqual(I.parseNumberField('42'), { kind: 'set', value: 42 });
	assert.deepEqual(I.parseNumberField(' 3.5 '), { kind: 'set', value: 3.5 });
	assert.deepEqual(I.parseNumberField('-1'), { kind: 'set', value: -1 });
	assert.equal(I.parseNumberField('3.5', { integer: true }).kind, 'invalid');
	assert.equal(I.parseNumberField('5', { min: 10 }).kind, 'invalid');
	assert.equal(I.parseNumberField('5', { max: 3 }).kind, 'invalid');
});

test('parseListText splits on newlines only, keeps paths intact, drops empties', () => {
	assert.deepEqual(I.parseListText('a\n b \n c'), ['a', 'b', 'c']);
	assert.deepEqual(I.parseListText('C:\\a,b\\c\nD'), ['C:\\a,b\\c', 'D']);
	assert.deepEqual(I.parseListText(''), []);
	assert.deepEqual(I.parseListText('  \n  '), []);
});

test('parseEnvText reads KEY=VALUE, preserves value spaces, reports malformed lines', () => {
	assert.deepEqual(I.parseEnvText('A=1\nB=2\n# comment\nD=\n'), { ok: true, value: { A: '1', B: '2', D: '' } });
	assert.deepEqual(I.parseEnvText('  X = hello world  '), { ok: true, value: { X: ' hello world  ' } });
	assert.deepEqual(I.parseEnvText(''), { ok: true, value: {} });
	const bad = I.parseEnvText('A=1\nbadline');
	assert.equal(bad.ok, false);
	assert.equal(bad.line, 2);
});

test('serialize round-trips list and env', () => {
	assert.equal(I.serializeList(['a', 'b']), 'a\nb');
	assert.equal(I.serializeList('x'), '');
	assert.equal(I.serializeEnv({ B: '', A: '1' }), 'A=1\nB=');
	assert.equal(I.serializeEnv(null), '');
});

test('projectFieldDefaults gives sane defaults per control', () => {
	assert.equal(I.projectFieldDefaults('model'), 'gemini-3.8-flash');
	assert.equal(I.projectFieldDefaults('transport'), 'acp');
	assert.equal(I.projectFieldDefaults('retryOnRateLimit'), false);
	assert.deepEqual(I.projectFieldDefaults('addDirs'), []);
	assert.deepEqual(I.projectFieldDefaults('env'), {});
	assert.equal(I.projectFieldDefaults('unknownField'), undefined);
});

test('isFieldOverridden reflects the user override layer', () => {
	assert.equal(I.isFieldOverridden({}, 'model'), false);
	assert.equal(I.isFieldOverridden(null, 'model'), false);
	assert.equal(I.isFieldOverridden({ model: 'x' }, 'model'), true);
	assert.equal(I.isFieldOverridden({ model: 'x' }, 'effort'), false);
});

test('model is a dropdown from the agy model catalog; effort defaults to medium', () => {
	const model = I.FIELDS.find((f) => f.key === 'model');
	const effort = I.FIELDS.find((f) => f.key === 'effort');
	assert.equal(model.control, 'select');
	assert.ok(Array.isArray(model.options) && model.options.length >= 5, 'model options present');
	assert.ok(model.options.some((o) => (o && o.value ? o.value : o) === 'gemini-3.8-flash'), 'flash base model listed');
	assert.equal(model.default, 'gemini-3.8-flash');
	assert.equal(effort.control, 'select');
	assert.equal(effort.default, 'medium');
	assert.ok(effort.options.includes('medium'));
});

test('valuesEqual compares scalars, arrays, and flat objects', () => {
	assert.equal(I.valuesEqual('a', 'a'), true);
	assert.equal(I.valuesEqual(['a', 'b'], ['a', 'b']), true);
	assert.equal(I.valuesEqual(['a'], ['a', 'b']), false);
	assert.equal(I.valuesEqual({ A: '1' }, { A: '1' }), true);
	assert.equal(I.valuesEqual({ A: '1' }, { A: '2' }), false);
});

test('normalizeEmptyValue treats blank/empty containers as undefined (so blur never writes them)', () => {
	assert.equal(I.normalizeEmptyValue(''), undefined);
	assert.equal(I.normalizeEmptyValue(undefined), undefined);
	assert.equal(I.normalizeEmptyValue(null), undefined);
	assert.equal(I.normalizeEmptyValue([]), undefined);
	assert.equal(I.normalizeEmptyValue({}), undefined);
	assert.deepEqual(I.normalizeEmptyValue(['a']), ['a']);
	assert.deepEqual(I.normalizeEmptyValue({ A: '1' }), { A: '1' });
	assert.equal(I.normalizeEmptyValue(0), 0);
});

test('apply works without configForms (settings plugin absent) and keeps Gemini panels', () => {
	const registrations = [];
	const slots = {
		inject: (name, cb) => {
			const off = cb();
			return typeof off === 'function' ? off : () => {};
		},
		register: (opts, Comp) => {
			registrations.push({ name: opts.name, key: opts.key, id: opts.id, comp: Comp });
			return () => {};
		},
	};
	const ctx = { slots }; // no inject(), no configForms
	assert.doesNotThrow(() => {
		const dispose = mod.apply(ctx);
		assert.equal(typeof dispose, 'function');
		dispose();
	});
	assert.ok(registrations.some((r) => r.name === 'main' && r.key === 'gemini-research'), 'Gemini panel still registered');
	assert.ok(!registrations.some((r) => r.name === 'settings.section'), 'no settings section without configForms');
});

test('apply registers the settings section when configForms is served', () => {
	const registrations = [];
	const fakeForm = {
		getSnapshot: () => ({ status: 'ready', writable: true, value: {}, user: {} }),
		subscribe: () => () => {},
		set: async () => true,
		unset: async () => true,
	};
	const slots = {
		inject: (name, cb) => {
			const off = cb();
			return typeof off === 'function' ? off : () => {};
		},
		register: (opts, Comp) => {
			registrations.push({ name: opts.name, id: opts.id, key: opts.key, comp: Comp });
			return () => {};
		},
	};
	const child = {
		slots,
		configForms: {
			whileServed: (namespaces, cb) => {
				const off = cb();
				return typeof off === 'function' ? off : () => {};
			},
			get: () => fakeForm,
		},
	};
	const ctx = {
		slots,
		inject: (deps, cb) => { cb(child); return () => {}; },
	};
	const dispose = mod.apply(ctx);
	assert.ok(registrations.some((r) => r.name === 'main' && r.key === 'gemini-research'), 'existing panel kept');
	assert.ok(registrations.some((r) => r.name === 'settings.section' && r.id === 'subagent-antigravity' && r.comp === mod.__settingsSection), 'settings section registered');
	assert.equal(typeof dispose, 'function');
	dispose();
});

