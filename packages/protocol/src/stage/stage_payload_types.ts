import { z } from 'zod';
import { ConversationInputSchema, ToolCallSchema, type ConversationInput, type ToolCall } from '../task/conversation_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StagePayloadTypes — the value one pipeline stage consumes and returns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A named tensor carried inside a stage payload, encoded as text so it can travel
 * inside a JSON message. This is the probe encoding for the step-0 de-risking test
 * in https://github.com/webai-at-home/webai-at-home/issues/9 — not a final format.
 */
export type EncodedTensor = {
	dims: number[];
	type: string;
	dataBase64: string;
};

/**
 * The payload handed between LLM shard stages: the shard's hand-off tensors, and
 * (on the final shard) the generated text.
 */
export type LlmStagePayload = {
	tensors?: Record<string, EncodedTensor>;
	/**
	 * A whole piece of text, rather than a part of one: the prompt on the value handed to a
	 * task's first stage, and the complete answer on the result that finishes the task.
	 *
	 * A result that leaves the generation unfinished never carries this. Such a result carries
	 * `newText` instead, which is only what that one run produced. That is what keeps the
	 * bytes on the connection from growing with the square of the number of tokens generated:
	 * an answer that is re-sent in full once per token is sent once for every token that
	 * precedes it.
	 */
	text?: string;
	/**
	 * The whole conversation to answer, on the value handed to a task's first stage, when the
	 * consumer submitted a conversation rather than one prompt.
	 *
	 * Exactly one of this and `text` carries the work on that first value: a task submitted with a
	 * prompt carries `text`, and a task submitted with a conversation carries this. A stage helper
	 * that receives this hands the messages to its model's chat template, so each message reaches
	 * the slot that template already has for its role, instead of a flattened transcript arriving
	 * as a single user message.
	 *
	 * It never appears on a result. What a stage produces is text, or a request to call a tool.
	 */
	conversation?: ConversationInput;
	/**
	 * The tools the model asked to have called, on the result that finishes the task.
	 *
	 * Present only when the model asked for a tool instead of writing an answer, which is the whole
	 * of what such a result is: a model that asks for a tool produces no text, so a result carrying
	 * these carries no `text` worth reading. A task whose conversation declared no tool never
	 * carries this at all.
	 *
	 * The cluster does not run the tool, and never will: it generates the request and stops there.
	 * Running it belongs to the calling program, for the reason set out in
	 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) — a caller's tool run on
	 * a volunteer's machine, network address, and signed-in browser session is a security problem
	 * before it is an engineering one.
	 */
	toolCalls?: ToolCall[];
	/**
	 * The text this one stage run produced, beyond everything the runs before it produced.
	 *
	 * A run that produced nothing new leaves it out rather than stating it as empty, and the run
	 * that finds a generation already finished produces nothing new by definition. So a consumer
	 * joining these in order receives every piece exactly once, but must not wait for one on the
	 * result that finishes the task: that result carries the whole answer in `text` instead, and
	 * carries a piece only when the run that ended the generation also added to it.
	 */
	newText?: string;
	/** Token identifiers for the sequence positions covered by this stage payload's tensors. */
	inputIds?: number[];
	/** Position of the first token in `inputIds` within the full generated sequence. */
	position?: number;
	/**
	 * Set on a payload that continues a generation already under way in the memory of the
	 * device that produced the previous result, instead of starting a new one.
	 *
	 * The Chrome built-in language-model task needs this. Nothing else tells the two apart:
	 * the stage is a single stage that runs again and again, so a run that starts an answer and
	 * a run that carries one on receive the same stage under a different assignment. A worker
	 * that receives a continuation and holds no generation for the task refuses the stage,
	 * rather than starting a second answer to a prompt it no longer has.
	 */
	isContinuation?: boolean;
	/** Set by the final shard once generation should stop (end-of-sequence token or the token limit reached). */
	done?: boolean;
	/**
	 * How many tokens the prompt this task answered was counted as, by the worker that produced
	 * the result that finishes the task.
	 *
	 * Present only when that worker's engine can count tokens at all — token counts exist only
	 * where the model runs, and not every engine this cluster runs on can report them. Absent
	 * rather than estimated or set to `0`, so a consumer never mistakes an unknown count for a
	 * known one of zero. See milestone 2 of
	 * [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
	 */
	promptTokenCount?: number;
	/**
	 * How many tokens the whole answer this task produced was counted as, by the worker that
	 * produced the result that finishes the task.
	 *
	 * Present only when that worker's engine can count tokens at all, and only on the result that
	 * finishes the task, since it counts the whole answer rather than one piece of it. Absent
	 * rather than estimated or set to `0`, for the same reason `promptTokenCount` is.
	 */
	completionTokenCount?: number;
	/**
	 * The worker's own word for why generation stopped, on the result that finishes the task.
	 *
	 * Not an OpenAI value: this is the protocol, not the OpenAI Chat Completions interface, and it
	 * keeps the worker's own word for diagnosis and for the accounting ledger. A consumer that
	 * speaks the OpenAI Chat Completions interface translates this into the OpenAI value for
	 * `finish_reason`, or into an error when there is none, rather than the protocol borrowing that
	 * interface's spelling for itself.
	 *
	 * - `end_of_sequence` — the model produced its own end-of-sequence token.
	 * - `max_new_tokens` — generation reached the worker's token limit before an end-of-sequence
	 *   token appeared.
	 * - `interrupted` — generation was stopped before either of the above, such as by a cancelled
	 *   task. There is no OpenAI value for this.
	 */
	stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted';
};

/** The value carried by one stage: a plain number for the formula pipeline, or an LLM payload. */
export type StagePayload = number | LlmStagePayload;

/** The validation of one stage payload, as it arrives on a `stage.result` message. */
export const StagePayloadSchema = z.union([
	z.number().finite(),
	z.object({
		tensors: z.record(z.string().max(500), z.object({ dims: z.array(z.number().int()).max(8), type: z.string().max(100), dataBase64: z.string().max(8_000_000) })).optional(),
		text: z.string().max(100_000).optional(),
		conversation: ConversationInputSchema.optional(),
		toolCalls: z.array(ToolCallSchema).min(1).max(16).optional(),
		newText: z.string().max(100_000).optional(),
		inputIds: z.array(z.number().int()).max(100_000).optional(),
		position: z.number().int().nonnegative().optional(),
		isContinuation: z.boolean().optional(),
		done: z.boolean().optional(),
		promptTokenCount: z.number().int().nonnegative().optional(),
		completionTokenCount: z.number().int().nonnegative().optional(),
		stopReason: z.enum(['end_of_sequence', 'max_new_tokens', 'interrupted']).optional(),
	}).strict(),
]) as unknown as z.ZodType<StagePayload>;
