/**
 * Antigravity CLI (`agy`) stream adapter.
 *
 * `agy --print --output-format stream-json` emits one NDJSON envelope per line:
 *
 *   {"event":"init","conversation_id":"…","init":{…}}
 *   {"event":"step_update","step_update":{"step_index":n,"state":"ACTIVE|DONE",
 *                                          "step_type":"user_input|agent_response",
 *                                          "text_delta":"…"}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"…","usage":{…}}}
 *
 * This module owns only line framing, envelope validation, answer selection and
 * the observed-failure facts. Process lifecycle belongs to the run module.
 *
 * @module dsh-subagent-antigravity/wire
 */

/** Maximum buffered NDJSON bytes before a frame is treated as malformed. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Status strings `agy` reports on the terminal `result` envelope. */
const KNOWN_STATUSES = Object.freeze(['SUCCESS', 'ERROR', 'FAILURE', 'CANCELED', 'CANCELLED', 'INTERRUPTED']);

/** Map one terminal status to the shared stop reason. */
function stopReasonOf(status) {
	if (status === 'SUCCESS') return 'completed';
	if (status === 'CANCELED' || status === 'CANCELLED' || status === 'INTERRUPTED') return 'aborted';
	return 'error';
}

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * One `agy` invocation's NDJSON stream and the answer it produced.
 */
export class AntigravityStream {
	/** @type {string} */
	#prefix;
	/** @type {string} */
	#buffer = '';
	/** @type {string[]} */
	#textDeltas = [];
	/** @type {{status: string, response?: string} | undefined} */
	#terminal;
	/** @type {string | undefined} */
	#conversationId;
	/** @type {string | undefined} */
	#malformed;
	/** @type {{stage: string, category: string} | undefined} */
	#failure;
	/** @type {string} */
	#errorText = '';

	/**
	 * @param {string} prefix diagnostic prefix, e.g. `subagent-antigravity`.
	 */
	constructor(prefix) {
		this.#prefix = prefix;
	}

	/** Conversation id reported by the `init` envelope, once observed. */
	get conversationId() {
		return this.#conversationId;
	}

	/** Structural protocol error observed while parsing, if any. */
	get malformed() {
		return this.#malformed;
	}

	/** Raw error text from a failed result or error envelope, if any. */
	get errorText() {
		return this.#errorText.length > 0 ? this.#errorText : undefined;
	}

	/** Fixed failure facts for the terminal envelope, when it did not succeed. */
	collectFailure() {
		return this.#failure ?? { stage: 'turn', category: 'unknown' };
	}

	/** Whether a terminal `result` envelope was observed. */
	get terminalObserved() {
		return this.#terminal !== undefined;
	}

	/**
	 * Feed one raw stdout chunk.
	 * @param {Buffer | string} chunk
	 */
	push(chunk) {
		this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		if (this.#buffer.length > MAX_FRAME_BYTES) {
			this.#buffer = '';
			this.#malformed ??= `${this.#prefix}: stream-json frame exceeded ${MAX_FRAME_BYTES} bytes`;
			return;
		}
		let index;
		while ((index = this.#buffer.indexOf('\n')) !== -1) {
			const line = this.#buffer.slice(0, index);
			this.#buffer = this.#buffer.slice(index + 1);
			this.#consume(line);
		}
	}

	/** Flush a trailing frame that arrived without a final newline. */
	end() {
		const line = this.#buffer;
		this.#buffer = '';
		if (line.length > 0) this.#consume(line);
	}

	/**
	 * Resolve the shared subagent result from what the stream produced.
	 * @returns {{ output: {type: 'text', text: string}[], stopReason: string }}
	 */
	result() {
		const terminal = this.#terminal;
		const answer = terminal?.response ?? this.#textDeltas.join('');
		const output = answer.trim().length > 0 ? [{ type: 'text', text: answer }] : [];
		if (terminal === undefined) return { output, stopReason: 'error' };
		return { output, stopReason: stopReasonOf(terminal.status) };
	}

	#consume(raw) {
		if (raw.trim().length === 0) return;
		let envelope;
		try {
			envelope = JSON.parse(raw);
		} catch {
			this.#malformed ??= `${this.#prefix}: stream-json emitted a non-JSON line`;
			return;
		}
		if (!isRecord(envelope)) {
			this.#malformed ??= `${this.#prefix}: stream-json emitted a non-object envelope`;
			return;
		}
		const conversationId = text(envelope.conversation_id);
		if (conversationId !== undefined && this.#conversationId === undefined) this.#conversationId = conversationId;
		switch (envelope.event) {
			case 'step_update': {
				const step = envelope.step_update;
				if (!isRecord(step)) return;
				const delta = text(step.text_delta);
				if (step.step_type === 'agent_response' && delta !== undefined) this.#textDeltas.push(delta);
				return;
			}
			case 'result': {
				const result = envelope.result;
				if (!isRecord(result)) {
					this.#malformed ??= `${this.#prefix}: stream-json emitted an invalid result envelope`;
					return;
				}
				const status = text(result.status) ?? 'ERROR';
				if (!KNOWN_STATUSES.includes(status)) this.#malformed ??= `${this.#prefix}: agy reported unknown result status ${JSON.stringify(status)}`;
				this.#terminal = { status, ...(text(result.response) === undefined ? {} : { response: text(result.response) }) };
				if (status !== 'SUCCESS') {
					this.#failure = { stage: 'turn', category: 'product-error' };
					this.#errorText += `${this.#errorText.length > 0 ? '\n' : ''}${JSON.stringify(result).slice(0, 4000)}`;
				}
				return;
			}
			case 'error': {
				const error = envelope.error;
				const detail = isRecord(error) ? JSON.stringify(error).slice(0, 4000) : String(error ?? 'an error envelope');
				this.#malformed ??= `${this.#prefix}: agy reported ${isRecord(error) ? JSON.stringify(error).slice(0, 400) : 'an error envelope'}`;
				this.#errorText += `${this.#errorText.length > 0 ? '\n' : ''}${detail}`;
				return;
			}
			default: return;
		}
	}
}
