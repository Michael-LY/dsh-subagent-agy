/**
 * Profile-named Antigravity one-shot subagent provider.
 *
 * @module dsh-subagent-antigravity
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export declare const name = 'subagent-antigravity';
export declare const inject: string[];

/** Native non-interactive permission modes this provider can enforce. */
export type AntigravityPermissionMode = 'auto' | 'dangerously-skip-permissions';

/** Reasoning effort accepted by the Antigravity CLI. */
export type AntigravityEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Deployment-owned CLI path, model, permission, environment, and process-release settings. */
export interface Config {
	/** Provider name on `ctx.subagents` (default `antigravity`). */
	providerName?: string;
	/** Absolute path to the `agy` executable (default `%USERPROFILE%/.gemini/bin/agy.exe`). */
	executable?: string;
	/** Native Antigravity model fixed for this instance; omitted to inherit CLI settings. */
	model?: string;
	/** Native reasoning effort fixed for this instance. */
	effort?: AntigravityEffort;
	/** Explicit environment entries layered over the scrubbed parent environment. */
	env?: Record<string, string>;
	/** Native non-interactive permission mode fixed for this Provider instance. */
	permissionMode?: AntigravityPermissionMode;
	/** Extra CLI arguments appended verbatim. */
	extraArgs?: string[];
	/** Go-style duration for `--print-timeout` (e.g. "180s", "10m"); omitted to wait until the turn completes. */
	printTimeout?: string;
	/** JSON schema (inline or file path) for `--json-schema`, constraining the final structured result. */
	jsonSchema?: string;
	/** Extra workspace directories passed as repeatable `--add-dir`. */
	addDirs?: string[];
	/** Fallback native model to retry once when the primary attempt is rate-limited or out of quota; omitted to disable fallback. */
	fallbackModel?: string;
	/** Retry once with a short backoff when the attempt is rate-limited (HTTP 429). */
	retryOnRateLimit?: boolean;
	/** Grace in milliseconds between managed-range termination tiers. */
	disposeGraceMs?: number;
}

export declare const Config: z<Config>;

/**
 * Register one Profile-named Antigravity provider.
 * @param ctx context carrying shared subagent and subprocess services.
 * @param config registry name, CLI path, model, permission mode, environment, and disposal grace.
 */
export declare function apply(ctx: Context, config: Config): void;
