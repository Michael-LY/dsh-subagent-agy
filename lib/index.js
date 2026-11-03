/**
 * Profile-named Antigravity one-shot subagent provider.
 *
 * Every accepted run starts a fresh `agy --print --output-format stream-json`
 * in the delegating Session's workspace and publishes only after the CLI is
 * controllable. Antigravity has no follow-up channel, so the run is external:
 * one execution, no continuation.
 *
 * @module dsh-subagent-agy
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { NO_START_CAPABILITIES, assertPositiveFinite, assertUsableCwd } from '@deepseek-ai/dsh-subagent';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_ANTIGRAVITY_PERMISSION_MODE, DEFAULT_DISPOSE_GRACE_MS, ANTIGRAVITY_PERMISSION_MODES, startAntigravityRun, startAntigravityRunWithRetry, stripAnsi } from './run.js';
import { setupGeminiWeb } from './gemini-web.js';
import { setupParallelTool } from './parallel.js';

export const name = 'subagent-antigravity';
export const inject = ['subagents', 'subprocess'];

const PREFIX = 'subagent-antigravity';
const DEFAULT_PROVIDER_NAME = 'antigravity';
const DEFAULT_TEAM_PROVIDER_NAME = 'antigravity-team';
const DEFAULT_PARALLEL_TOOL_NAME = 'subagent_agy_parallel';
const DEFAULT_MAX_PARALLEL_TASKS = 8;
const DEFAULT_EXECUTABLE = join(homedir(), '.gemini', 'bin', 'agy.exe');

/**
 * Directive used by the `antigravity-team` provider. `/teamwork` itself is an
 * interactive TUI command (it starts a scoping interview), so headless runs use
 * agy's underlying `invoke_subagent` tool instead: one call per independent
 * subtask in the same turn, which agy executes concurrently.
 */
export const NATIVE_TEAM_DIRECTIVE = [
	'You are in Antigravity parallel-team mode.',
	'When the task contains two or more independent subtasks, use the `invoke_subagent` tool to launch them concurrently in the same assistant turn.',
	'Call `invoke_subagent` once per subtask with `TypeName` set to `self` for implementation or general work, or `research` for read-only exploration, a short 2-5 word `Role`, and a fully self-contained `Prompt`.',
	'Use at most 4 subagents unless the user explicitly asks for a larger team.',
	'After they finish, integrate their results and cite which subagent produced what.',
	'If a subagent call fails, report the failure; never fabricate its result. If the task is not decomposable, complete it directly.',
].join('\n');

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
	fallbackModel: z.string().min(1),
	retryOnRateLimit: z.boolean().default(false),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
	geminiProfileDir: z.string().min(1),
	geminiPython: z.string().min(1).default('python'),
	geminiHeadless: z.boolean().default(true),
	geminiTimeoutMs: z.number().default(900000),
	teamProviderName: z.string().min(1).default(DEFAULT_TEAM_PROVIDER_NAME),
	teamEnabled: z.boolean().default(true),
	parallelToolName: z.string().min(1).default(DEFAULT_PARALLEL_TOOL_NAME),
	parallelMaxTasks: z.number().min(1).max(DEFAULT_MAX_PARALLEL_TASKS).default(DEFAULT_MAX_PARALLEL_TASKS),
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
		const spec = {
			cwd,
			executable: this.config.executable,
			...this.config.model === undefined ? {} : { model: this.config.model },
			...this.config.effort === undefined ? {} : { effort: this.config.effort },
			permissionMode: this.config.permissionMode,
			extraArgs: this.config.extraArgs,
			...this.config.promptPrefix === undefined ? {} : { promptPrefix: this.config.promptPrefix },
			...this.config.printTimeout === undefined ? {} : { printTimeout: this.config.printTimeout },
			...this.config.jsonSchema === undefined ? {} : { jsonSchema: this.config.jsonSchema },
			...this.config.addDirs === undefined ? {} : { addDirs: this.config.addDirs },
			...this.config.fallbackModel === undefined ? {} : { fallbackModel: this.config.fallbackModel },
			retryOnRateLimit: this.config.retryOnRateLimit,
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
		};
		return this.config.fallbackModel === undefined && this.config.retryOnRateLimit !== true
			? startAntigravityRun(request, spec)
			: startAntigravityRunWithRetry(request, spec);
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
		...config.fallbackModel === undefined ? {} : { fallbackModel: config.fallbackModel },
		retryOnRateLimit: config.retryOnRateLimit ?? false,
		disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
		geminiProfileDir: config.geminiProfileDir ?? join(homedir(), '.dsh', 'gemini-web-research', 'chrome-profile'),
		geminiPython: config.geminiPython ?? 'python',
		geminiHeadless: config.geminiHeadless ?? true,
		geminiTimeoutMs: config.geminiTimeoutMs ?? 900000,
		teamProviderName: config.teamProviderName ?? DEFAULT_TEAM_PROVIDER_NAME,
		teamEnabled: config.teamEnabled ?? true,
		parallelToolName: config.parallelToolName ?? DEFAULT_PARALLEL_TOOL_NAME,
		parallelMaxTasks: config.parallelMaxTasks ?? DEFAULT_MAX_PARALLEL_TASKS,
	};
	assertPositiveFinite(PREFIX, 'disposeGraceMs', resolved.disposeGraceMs);
	if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) throw new Error(`${PREFIX}: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	ctx.subagents.registerProvider(new AntigravityProvider(resolved.providerName, ctx, resolved));
	if (resolved.teamEnabled) {
		if (resolved.teamProviderName === resolved.providerName) throw new Error(`${PREFIX}: teamProviderName must differ from providerName`);
		ctx.subagents.registerProvider(new AntigravityProvider(resolved.teamProviderName, ctx, { ...resolved, promptPrefix: NATIVE_TEAM_DIRECTIVE }));
	}
	try {
		setupParallelTool(ctx, {
			provider: resolved.providerName,
			toolName: resolved.parallelToolName,
			maxTasks: resolved.parallelMaxTasks,
		});
	} catch (error) {
		ctx.logger?.warn(`${PREFIX}: 并发子智能体工具未启用：${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		setupGeminiWeb(ctx, {
			profileDir: resolved.geminiProfileDir,
			python: resolved.geminiPython,
			headless: resolved.geminiHeadless,
			timeoutMs: resolved.geminiTimeoutMs,
			scriptDir: fileURLToPath(new URL('../scripts/gemini_research', import.meta.url)),
		});
	} catch (error) {
		ctx.logger?.warn(`${PREFIX}: Gemini 网页调研面板未启用：${error instanceof Error ? error.message : String(error)}`);
	}
}