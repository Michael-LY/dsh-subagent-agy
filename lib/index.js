/**
 * Profile-named Antigravity one-shot subagent provider.
 *
 * Every accepted run starts a fresh `agy --print --output-format stream-json`
 * in the delegating Session's workspace and publishes only after the CLI is
 * controllable. Antigravity has no follow-up channel, so the run is external:
 * one execution, no continuation.
 *
 * @module dsh-subagent-antigravity
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { NO_START_CAPABILITIES, assertPositiveFinite, assertUsableCwd } from '@deepseek-ai/dsh-subagent';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_ANTIGRAVITY_PERMISSION_MODE, DEFAULT_DISPOSE_GRACE_MS, ANTIGRAVITY_PERMISSION_MODES, startAntigravityRun, stripAnsi } from './run.js';

export const name = 'subagent-antigravity';
export const inject = ['subagents', 'subprocess'];

const PREFIX = 'subagent-antigravity';
const DEFAULT_PROVIDER_NAME = 'antigravity';
const DEFAULT_EXECUTABLE = join(homedir(), '.gemini', 'bin', 'agy.exe');

export const Config = z.object({
	providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
	executable: z.string().min(1).default(DEFAULT_EXECUTABLE),
	model: z.string().min(1),
	effort: z.union([...['low', 'medium', 'high', 'xhigh', 'max']]),
	env: z.dict(z.string()).default({}),
	permissionMode: z.union([...ANTIGRAVITY_PERMISSION_MODES]).default(DEFAULT_ANTIGRAVITY_PERMISSION_MODE),
	extraArgs: z.array(z.string()).default([]),
	printTimeout: z.string().min(1),
	jsonSchema: z.string().min(1),
	addDirs: z.array(z.string()),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
});

/** Inherited traces that would hijack the child into the delegating CLI session. */
const SCRUBBED_ENV = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'GEMINI_CLI', 'ANTIGRAVITY_SESSION_ID']);

class AntigravityProvider {
	capabilities = NO_START_CAPABILITIES;
	inheritsParentContext = false;

	constructor(name, ctx, config) {
		this.name = name;
		this.ctx = ctx;
		this.config = config;
	}

	start(request) {
		let cwd;
		try {
			cwd = assertUsableCwd(PREFIX, 'child cwd', request.cwd);
		} catch (error) {
			if (request.signal.aborted) throw new Error(`${PREFIX}: request was aborted before CLI startup`);
			throw error;
		}
		if (!existsSync(this.config.executable)) throw new Error(`${PREFIX}: Antigravity CLI not found at "${this.config.executable}"; install Antigravity or set the executable option`);
		const env = {};
		for (const key of SCRUBBED_ENV) env[key] = '';
		return startAntigravityRun(request, {
			cwd,
			executable: this.config.executable,
			...this.config.model === undefined ? {} : { model: this.config.model },
			...this.config.effort === undefined ? {} : { effort: this.config.effort },
			permissionMode: this.config.permissionMode,
			extraArgs: this.config.extraArgs,
			...this.config.printTimeout === undefined ? {} : { printTimeout: this.config.printTimeout },
			...this.config.jsonSchema === undefined ? {} : { jsonSchema: this.config.jsonSchema },
			...this.config.addDirs === undefined ? {} : { addDirs: this.config.addDirs },
			env: { ...env, ...this.config.env },
			disposeGraceMs: this.config.disposeGraceMs,
			spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
			writeStderr: (bytes) => {
				try {
					const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
					process.stderr.write(stripAnsi(text));
				} catch {}
			},
			onError: (error, stopReason) => {
				this.ctx.logger.warn(`${PREFIX} "${this.name}": child run failed (${stopReason}): ${error.message}`);
			},
		});
	}
}

/**
 * Register one Profile-named Antigravity provider.
 * @param {object} ctx context carrying shared subagent and subprocess services.
 * @param {object} config registry name, CLI path, model, effort, permission mode, and disposal grace.
 */
export function apply(ctx, config) {
	const resolved = {
		providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
		executable: config.executable ?? DEFAULT_EXECUTABLE,
		...config.model === undefined ? {} : { model: config.model },
		...config.effort === undefined ? {} : { effort: config.effort },
		env: config.env ?? {},
		permissionMode: config.permissionMode ?? DEFAULT_ANTIGRAVITY_PERMISSION_MODE,
		extraArgs: config.extraArgs ?? [],
		...config.printTimeout === undefined ? {} : { printTimeout: config.printTimeout },
		...config.jsonSchema === undefined ? {} : { jsonSchema: config.jsonSchema },
		...config.addDirs === undefined ? {} : { addDirs: config.addDirs },
		disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
	};
	assertPositiveFinite(PREFIX, 'disposeGraceMs', resolved.disposeGraceMs);
	if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) throw new Error(`${PREFIX}: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	ctx.subagents.registerProvider(new AntigravityProvider(resolved.providerName, ctx, resolved));
}