import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HistoryTypes — the history a language-model task carries, in place of one prompt
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Every name here is spelled the way this repository spells names, and not the way the OpenAI
// completion interface spells the same ideas on the connection. That interface's spellings belong
// in `packages/consumer_openai/src/api/openai_types.ts`, where they are part of a format an
// existing client reads and so cannot be renamed. This is this project's own protocol, so it uses
// this project's own naming.

/**
 * The largest number of messages one history may carry.
 *
 * A bound rather than a judgement about how long a history should be: every message travels
 * inside one gateway message on every submission, so an unbounded list is an unbounded frame.
 */
const maximumMessageCount = 1000;

/** The largest one message's content may be, in characters, matching `StagePayloadSchema`'s own text bound. */
const maximumContentLength = 100_000;

/** The largest number of tools one history may declare. */
const maximumToolCount = 64;

/** The largest number of tool calls one assistant message may carry. */
const maximumToolCallCount = 16;

/** The largest a tool or argument name may be, in characters. */
const maximumNameLength = 200;

/**
 * One tool a history declares, which the model may ask to have called.
 *
 * The tool is never run by this cluster. A worker generates the request to call it and nothing
 * more; running it belongs to the calling program, which is where the tool and the trust to run it
 * both live. See the reasoning under "Where the tool should run" in
 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78): running a caller's tool on
 * a volunteer's machine, network address, and signed-in browser session is a security problem
 * before it is an engineering one.
 */
export const ToolDeclarationSchema = z.object({
	/** The name the model writes when it asks for this tool. */
	name: z.string().min(1).max(maximumNameLength),
	/** What the tool does, in the words the model reads when it decides whether to ask for it. */
	description: z.string().max(maximumContentLength).optional(),
	/**
	 * The arguments this tool takes, as a JSON Schema object.
	 *
	 * Carried as already-parsed JSON rather than as a string of it, because it is handed straight to
	 * a chat template that renders it back out as JSON. It is not validated as a JSON Schema here:
	 * the model reads it as description rather than as a rule, and no part of this cluster enforces
	 * it. What it is genuinely needed for is the other direction — see `ToolCallSchema.argumentValues`.
	 */
	parametersJsonSchema: z.record(z.string().max(maximumNameLength), z.unknown()),
}).strict();
/** One tool a history declares, which the model may ask to have called. */
export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;

/**
 * One request from the model to have a tool called.
 *
 * Two things this deliberately does not carry, both because no worker could fill them in.
 *
 * There is **no identifier**. The OpenAI Chat Completions interface gives every tool call one, so
 * that a result can be matched back to the call it answers. No model this project runs generates
 * one: `llm_qwen3_5_0_8b_full` writes a tool call as `<function=name>` with no identifier anywhere
 * in it, measured in the de-risk gate for
 * [issue #115](https://github.com/webai-at-home/webai-at-home/issues/115). So a consumer that
 * speaks that interface mints the identifier itself, exactly as it translates `stopReason` into
 * `finish_reason` rather than the protocol borrowing that interface's spelling.
 *
 * The arguments are **text, not typed values**, for the same reason: the format the model writes
 * carries no types at all. See `argumentValues`.
 */
export const ToolCallSchema = z.object({
	/** The name of the tool the model asked to have called. */
	name: z.string().min(1).max(maximumNameLength),
	/**
	 * The arguments the model filled in, each exactly as it wrote it, keyed by argument name.
	 *
	 * Every value is text, because the format the model writes them in has no types: it names each
	 * argument and gives its value as the characters between two markers, so a number and the
	 * characters of a number are indistinguishable by the time a worker sees them. Converting a
	 * value to the type its tool declared, using `ToolDeclaration.parametersJsonSchema`, belongs to
	 * whichever consumer hands the call to a calling program in a typed form — it is that consumer's
	 * interface that requires types, not this protocol.
	 *
	 * A worker never repairs or drops a value it could not make sense of. A tool call that could not
	 * be read at all is a failed stage that names what could not be read, rather than a call passed
	 * on half-formed.
	 */
	argumentValues: z.record(z.string().max(maximumNameLength), z.string().max(maximumContentLength)),
}).strict();
/** One request from the model to have a tool called. */
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * One message of a history.
 *
 * The four roles are the four a chat template has slots for. The OpenAI completion interface also
 * has a `developer` role, which is its newer name for what it used to call `system`; a consumer
 * that receives one sends it here as `system`, because no chat template this project drives knows
 * a fourth name for that slot.
 *
 * A message whose role is `tool` carries what a tool returned, as text, in `content`. It is not
 * matched to the call it answers by an identifier, because there is none to match with — see
 * `ToolCallSchema`. The order of the messages is what says which call a result answers, which is
 * also all the chat template needs: `llm_qwen3_5_0_8b_full` renders a tool result as a
 * `<tool_response>` block in the turn following the call, and never reads an identifier.
 */
export const HistoryMessageSchema = z.object({
	/** Who said this: the instructions, the caller, the model, or a tool the model asked for. */
	role: z.enum(['system', 'user', 'assistant', 'tool']),
	/**
	 * What was said, or what a tool returned.
	 *
	 * Empty on an assistant message that asked for a tool instead of writing an answer, which is
	 * what such a message really is: a model that asks for a tool writes no text at all.
	 */
	content: z.string().max(maximumContentLength),
	/**
	 * The tools this assistant message asked to have called, when it asked for any.
	 *
	 * Present only on an assistant message. It is what lets a history carrying a completed
	 * tool round trip be submitted again: the chat template renders these back into the form the
	 * model itself writes, so the model reads its own earlier request in the form it expects rather
	 * than in a rewritten one.
	 */
	toolCalls: z.array(ToolCallSchema).min(1).max(maximumToolCallCount).optional(),
}).strict();
/** One message of a history. */
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/**
 * The whole history a language-model task carries, in place of one piece of text.
 *
 * A task carried one prompt before this existed, and still may: `TaskInput` accepts either, so a
 * consumer with one prompt and nothing else to say submits a prompt. This shape exists for the
 * consumer that has more to say than one prompt can hold, such as several turns or a system
 * message.
 *
 * What this replaces is worth stating plainly, because the failure it removes is easy to miss.
 * Before it, a history was flattened into lines of `role: content` text and handed to the
 * model as a single user message, so the model saw one turn whose content happened to be a
 * transcript, and every chat template wrapped one set of turn markers around the whole thing. A
 * system message became a line of text inside a user turn. Carrying the messages as messages is
 * what lets each one reach the slot its chat template already has for it.
 */
export const HistoryInputSchema = z.object({
	/** The messages of the history, oldest first. */
	messages: z.array(HistoryMessageSchema).min(1).max(maximumMessageCount),
	/**
	 * The tools the model may ask to have called, when the consumer declared any.
	 *
	 * Absent rather than empty when the consumer declared none, so that a task asking for nothing
	 * about tools sends the same history it always did.
	 *
	 * There is deliberately no companion field saying how much choice the model is left about
	 * asking for a tool — the OpenAI Chat Completions interface's `tool_choice`. Nothing could read
	 * it. That interface leaves the choice to the server, and the way a server enforces it is by
	 * constraining generation, which is a thing the chat template cannot express and
	 * `@huggingface/transformers` does not offer. A field defined here and read by nothing is
	 * exactly what was added to this protocol ahead of use and removed again in
	 * [`38aa026`](https://github.com/webai-at-home/webai-at-home/commit/38aa026), on the grounds
	 * that it is strict-schema surface a consumer could fill in and have silently ignored. That
	 * reasoning has not changed, so the field is left out until something can honour it.
	 */
	tools: z.array(ToolDeclarationSchema).min(1).max(maximumToolCount).optional(),
}).strict();
/** The whole history a language-model task carries, in place of one piece of text. */
export type HistoryInput = z.infer<typeof HistoryInputSchema>;
