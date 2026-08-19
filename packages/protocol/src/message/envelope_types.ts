import { z } from 'zod';
import { Identifier } from '../identifier.js';
import { ClientMessageSchema } from './client_message.js';
import type { GatewayMessage } from './gateway_message.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	EnvelopeTypes — the protocol version, and the wrapper every frame travels in
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The version of this protocol that these programs speak.
 *
 * Every frame states the version it was written for, and the gateway refuses a version it
 * does not support at the moment a connection authenticates. A peer therefore learns
 * straight away whether it can talk to the other side, instead of discovering it through a
 * validation failure on some later message.
 *
 * Version 2 changed what a language-model stage result carries while a generation is still
 * running: the text produced by that one run, in `newText`, where version 1 carried the whole
 * answer so far in `text`. A gateway of version 1 does not accept a version 2 frame, so a
 * worker built after the change is refused by a gateway built before it at the moment it
 * authenticates, rather than having its first result refused for a shape that gateway's stage
 * payload schema does not allow.
 *
 * Version 3 renamed a set of message types and fields so each states what it identifies —
 * `authenticate`/`authenticated` became `deviceAuthenticate`/`deviceAuthenticated`,
 * `register`/`registered` became `deviceRegister`/`deviceRegistered`, `requestId` became
 * `taskRequestId`, `assignmentId` became `stageAssignmentId`, `principal` became
 * `authIdentity`, `inReplyTo` became `inReplyToMessageId`, and `revision` split into
 * `taskRevision` and `deviceListRevision`. No earlier version is accepted.
 *
 * Version 4 widened the value a language-model task carries. `TaskInput.input` now accepts a whole
 * history as well as one piece of text, for the task types whose stage helper can hand a
 * message list to its model — `task_type_llm_qwen3_5_0_8b_full` and, since
 * [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154),
 * `task_type_llm_llama3_2_1b_full`, and, since
 * [issue #211](https://github.com/webai-at-home/webai-at-home/issues/211),
 * `task_type_llm_gemma_4_e2b_full` (`task_type_llm_llama3_2_3b_full` accepted one too, from this
 * same version, until that task type was retired) — and the first stage value of such a task
 * carries that history in the new `history` field of `LlmStagePayload`. Both `TaskInput` and
 * `StagePayloadSchema` refuse that shape before this version, so a consumer or worker built after
 * the change is refused by a gateway built before it at the moment it authenticates. That refusal
 * is the point: it is what stops a worker built before the change from receiving a first stage
 * value whose `text` is absent and answering a prompt it was never given.
 *
 * Version 5 widened the result a language-model task's finishing stage carries. `LlmStagePayload`
 * now carries `promptTokenCount` and `completionTokenCount`, each present only when the worker
 * that produced the result counted it, and `stopReason`, the worker's own word for why generation
 * stopped — `end_of_sequence`, `max_new_tokens`, or `interrupted` — never an OpenAI value, since
 * translating it into one belongs to whichever consumer speaks the OpenAI Chat Completions
 * interface, not to the protocol. See milestone 2 of
 * [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150). `StagePayloadSchema`
 * refuses these fields before this version, so a worker built after the change is refused by a
 * gateway built before it at the moment it authenticates, rather than having its first result
 * refused for a shape that gateway's stage payload schema does not allow.
 *
 * Version 6 widened what a consumer may ask for about how its answer is generated.
 * `GenerationSettingsSchema` now carries `temperature`, `topP`, `maximumOutputTokenCount`,
 * `stopSequences`, and `randomSeed` beside `isStreaming`, and `task_type_llm_llama3_2_3b_full`
 * honoured all five, for as long as it existed — that task type has since been retired, and no
 * task type honours any of the five today; see [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
 * See milestone 1 of
 * [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151). Every earlier version
 * is refused because this is the first version in which a stage acts on a generation setting at
 * all: a gateway built before this version has no such field on its task input, its task input
 * members are not strict, and it therefore drops the whole block and answers as though nothing
 * had been asked for. Refusing that peer at authentication time is the point — it is what stops a
 * consumer that asked for `temperature: 0` from being answered by a worker that never received
 * the request.
 *
 * Version 7 let a history declare tools, and let a task end by asking for one to be called
 * rather than by writing an answer. `HistoryInputSchema` now carries `tools`, its messages
 * accept the role `tool` and carry `toolCalls` on an assistant message, and `LlmStagePayload`
 * carries `toolCalls` on the result that finishes the task. See
 * [issue #115](https://github.com/webai-at-home/webai-at-home/issues/115). Every earlier version is
 * refused because a gateway built before this one validates a task input with `StagePayloadSchema`
 * and `HistoryInputSchema` as they were, both `.strict()`, and refuses the tool fields
 * outright. Refusing that peer at authentication time is what stops a consumer that declared tools
 * from being answered by a cluster that dropped the declarations and answered in words as though
 * none had been sent.
 *
 * What version 7 deliberately does not carry is `tool_choice`, the OpenAI Chat Completions
 * interface's way of saying how much choice the model is left about asking for a tool. Nothing
 * could read it: enforcing it means constraining generation, which the chat template cannot express
 * and `@huggingface/transformers` does not offer. Defining it anyway would repeat exactly what was
 * added ahead of use and removed again in
 * [`38aa026`](https://github.com/webai-at-home/webai-at-home/commit/38aa026).
 *
 * Version 8 let a stage say that generation stopped on a stop sequence the consumer asked for.
 * `LlmStagePayload.stopReason` now carries `stop_sequence` beside `end_of_sequence`,
 * `max_new_tokens`, and `interrupted`. See step 3 of
 * [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196). Every earlier version is
 * refused for two reasons at once, and either alone would be enough. A gateway built before this
 * version validates a stage result with a `stopReason` enum that does not list `stop_sequence`,
 * so it refuses the result outright and the answer is lost. And a worker built before this version
 * ignores the generation controls a newer consumer sends, so that consumer receives an answer
 * generated some other way and is told nothing went wrong — which is the exact fault
 * `generation_control_support.ts` exists to prevent, and it cannot be caught anywhere except here,
 * because no field is added for a consumer to notice the absence of.
 *
 * Version 9 let a consumer say how much of its output budget a model that thinks before it answers
 * may spend on thinking. `GenerationSettingsSchema` now carries `reasoningEffort`, and
 * `task_type_llm_qwen3_5_0_8b_full` honours it. See
 * [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192). Every earlier version is
 * refused because `GenerationSettingsSchema` is `.strict()`: a gateway or a worker built before this
 * version refuses the whole settings block outright once it carries the new field, so a consumer
 * that asked for a thinking budget would lose every other control it asked for in the same block.
 */
export const protocolVersion = 9;

/** The protocol versions the gateway accepts. No earlier version is accepted. */
export const supportedProtocolVersions: number[] = [9];

/**
 * The wrapper around every frame sent in either direction.
 *
 * Nothing in the protocol travels bare. The wrapper carries what a message needs to say
 * about itself and could not say before: which protocol version wrote it, which frame it is,
 * when it was sent, and — on an answer from the gateway — which request it answers.
 */
export const EnvelopeSchema = z.object({
	/** The protocol version this frame was written for. */
	v: z.number().int().positive(),
	/** This frame's own identifier, generated by whoever sent it. */
	id: Identifier,
	/** When this frame was sent, in ISO 8601 format. */
	ts: z.string().datetime(),
	/**
	 * The `id` of the request this frame answers.
	 *
	 * Present on every gateway answer to a client request, and absent on every unsolicited
	 * message the gateway pushes. That is the whole distinction: a push is a frame with no
	 * `inReplyToMessageId`, rather than a message type that happens to have been chosen for pushes.
	 */
	inReplyToMessageId: Identifier.optional(),
});

/** A frame received from a client, once its body has been validated. */
export const ClientEnvelopeSchema = EnvelopeSchema.extend({ body: ClientMessageSchema }).strict();
/** The wrapper a client message travels in. */
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;

/** A frame sent by the gateway. */
export type GatewayEnvelope = z.infer<typeof EnvelopeSchema> & { body: GatewayMessage };
