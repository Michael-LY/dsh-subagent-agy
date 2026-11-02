/**
 * Parallel agy subagent tool.
 *
 * One tool call can start several independent Antigravity activations in the
 * same assistant turn. `startActivation` publishes each child immediately, so
 * this tool returns their ids without waiting for reports; DSH delivers each
 * result through the normal parent notification path.
 *
 * @module dsh-subagent-antigravity/parallel
 */

/** Default model-facing tool name. */
export const DEFAULT_PARALLEL_TOOL_NAME = 'subagent_agy_parallel';

/** Default maximum number of tasks in one call. */
export const DEFAULT_MAX_PARALLEL_TASKS = 8;

/** Maximum fallback description length, in characters. */
const DESCRIPTION_FALLBACK_LENGTH = 40;

/**
 * Require a non-empty string and return its trimmed value.
 * @param {unknown} value raw value
 * @param {string} label field label for diagnostics
 * @returns {string}
 */
function requireNonEmptyString(value, label) {
	if (typeof value !== 'string') throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
	return trimmed;
}

/**
 * Validate and normalize the tasks accepted by the parallel tool.
 * @param {unknown} tasks raw `tasks` array
 * @param {number} [maxTasks] maximum number of tasks
 * @returns {{description: string, prompt: string, cwd?: string}[]}
 */
export function normalizeParallelTasks(tasks, maxTasks = DEFAULT_MAX_PARALLEL_TASKS) {
	if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error('maxTasks must be a positive integer');
	if (!Array.isArray(tasks)) throw new Error('tasks must be an array');
	if (tasks.length === 0) throw new Error('tasks must contain at least one task');
	if (tasks.length > maxTasks) throw new Error(`tasks must contain at most ${maxTasks} tasks`);

	return tasks.map((task, index) => {
		const label = `tasks[${index}]`;
		if (task === null || typeof task !== 'object' || Array.isArray(task)) throw new Error(`${label} must be an object`);

		const prompt = requireNonEmptyString(task.prompt, `${label}.prompt`);
		let description;
		if (task.description === undefined || task.description === null) {
			description = prompt.slice(0, DESCRIPTION_FALLBACK_LENGTH);
		} else if (typeof task.description === 'string') {
			const trimmed = task.description.trim();
			description = trimmed.length > 0 ? trimmed : prompt.slice(0, DESCRIPTION_FALLBACK_LENGTH);
		} else {
			throw new Error(`${label}.description must be a string`);
		}

		const normalized = { description, prompt };
		if (task.cwd !== undefined) normalized.cwd = requireNonEmptyString(task.cwd, `${label}.cwd`);
		return normalized;
	});
}

/**
 * Render one concise start/failure line for the model.
 * @param {{started?: {description: string, subagentId: string}[], failed?: {description: string, error: string}[]}} result
 * @returns {string}
 */
export function renderParallelStart(result) {
	const started = Array.isArray(result?.started) ? result.started.length : 0;
	const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
	const parts = [`已启动 ${started} 个 agy 子智能体`];
	if (failed > 0) {
		const details = result.failed.map((item) => `${item.description}: ${item.error}`).join('；');
		parts.push(`${failed} 个启动失败：${details}`);
	}
	return parts.join('，');
}

/** Build the tool's parameter JSON Schema. */
function toolParameters(maxTasks) {
	return {
		type: 'object',
		properties: {
			tasks: {
				type: 'array',
				description: `Independent agy subagent tasks to start concurrently (1-${maxTasks}).`,
				items: {
					type: 'object',
					properties: {
						description: {
							type: 'string',
							description: 'A short (3-5 word) display label; defaults to the first 40 characters of prompt.',
						},
						prompt: {
							type: 'string',
							description: 'A fully self-contained task prompt for one subagent.',
						},
						cwd: {
							type: 'string',
							description: 'Optional initial working directory; omitted inherits the parent directory.',
						},
					},
					required: ['prompt'],
					additionalProperties: false,
				},
			},
		},
		required: ['tasks'],
		additionalProperties: false,
	};
}

/** Build the tool's result JSON Schema. */
function toolOutputSchema() {
	return {
		type: 'object',
		properties: {
			started: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						description: { type: 'string' },
						subagentId: { type: 'string' },
					},
					required: ['description', 'subagentId'],
					additionalProperties: false,
				},
			},
			failed: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						description: { type: 'string' },
						error: { type: 'string' },
					},
					required: ['description', 'error'],
					additionalProperties: false,
				},
			},
		},
		required: ['started', 'failed'],
		additionalProperties: false,
	};
}

/** Turn an unknown rejection reason into a stable message. */
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Register the `subagent_agy_parallel` tool on a DSH context.
 *
 * @param {object} ctx Cordis context carrying `inject`.
 * @param {{provider: string, toolName?: string, maxTasks?: number}} options
 * @returns {unknown} the disposer returned by `ctx.inject`, when any
 */
export function setupParallelTool(ctx, options = {}) {
	if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') {
		throw new Error('setupParallelTool requires a Cordis context with inject()');
	}
	const provider = requireNonEmptyString(options.provider, 'provider');
	const toolName = requireNonEmptyString(options.toolName ?? DEFAULT_PARALLEL_TOOL_NAME, 'toolName');
	const maxTasks = options.maxTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
	if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error('maxTasks must be a positive integer');

	const parameters = toolParameters(maxTasks);
	const outputSchema = toolOutputSchema();

	return ctx.inject(['tools', 'subagents'], (tctx) => {
		tctx.effect(() => tctx.tools.register({
			name: toolName,
			description: 'Start multiple independent agy subagents concurrently in one assistant turn and return their ids immediately. Use this when the user asks for several independent research, implementation, or analysis tasks to run in parallel. Results arrive asynchronously through the normal parent notification path.',
			parameters,
			output: {
				schema: outputSchema,
				render: (_args, value) => [{ type: 'text', text: renderParallelStart(value) }],
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				if (exec === undefined || exec === null || exec.agent === undefined || exec.agent === null) {
					throw new Error('subagent_agy_parallel requires a calling agent (exec.agent was undefined)');
				}
				const tasks = normalizeParallelTasks(args?.tasks, maxTasks);
				const settled = await Promise.allSettled(tasks.map(async (task) => await tctx.subagents.startActivation({
					provider,
					label: task.description,
					request: {
						prompt: [{ type: 'text', text: task.prompt }],
						parent: exec.agent,
						...(task.cwd === undefined ? {} : { cwd: task.cwd }),
					},
					signal: exec.signal,
					delivery: 'parent',
				})));

				const started = [];
				const failed = [];
				settled.forEach((outcome, index) => {
					const task = tasks[index];
					if (outcome.status === 'fulfilled') {
						const subagentId = outcome.value !== null && typeof outcome.value === 'object' ? outcome.value.childId : undefined;
						if (typeof subagentId !== 'string' || subagentId.length === 0) {
							failed.push({ description: task.description, error: 'startActivation returned no childId' });
						} else {
							started.push({ description: task.description, subagentId });
						}
					} else {
						failed.push({ description: task.description, error: errorText(outcome.reason) });
					}
				});

				if (started.length === 0) {
					throw new Error(`all parallel agy subagents failed: ${failed.map((item) => `${item.description}: ${item.error}`).join('; ')}`);
				}
				return { started, failed };
			},
		}), 'subagent-antigravity: parallel tool');
	});
}
