import type { TaskTypeName } from '@webai/consumer-cli';
import { StructuredOutputSupport, type ResponseFormatName, type TaskType } from '@webai/protocol';
import { OpenaiError } from './openai_error.js';
import type { ChatCompletionRequest } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponseFormatReader — reads a request's response_format, and refuses what cannot be produced
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads the `response_format` of one chat completion request, and refuses a request the chosen
 * model could only answer by ignoring it.
 *
 * The three fates of a `response_format` are the three fates `GenerationSettingsBuilder` gives a
 * generation control, decided the same way and for the same reason:
 *
 * - The task type honours the shape asked for: it is carried to the cluster as the client asked
 *   for it, in `GenerationSettings.responseFormat`, which the caller of this class puts there.
 *   Milestone 2 of [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) wrote
 *   that carrying path, having found that this class refused shapes and dropped what it read.
 *   Whether any task type honours any shape is `StructuredOutputSupport`'s to say, and it is what
 *   decides between this fate and the third one.
 * - The shape asked for is `text`, an absent field, or a `null` field: it is dropped without a
 *   word. All three mean the same thing, which is that nothing unusual was asked for, and a client
 *   that always sends `response_format: { "type": "text" }` must not be refused.
 * - Anything else: the request is refused. Being told is better than receiving an answer generated
 *   some other way and being told nothing, and here the answer received is prose where an object
 *   was asked for, which a client cannot read at all.
 */
export class ResponseFormatReader {
	/**
	 * Reads the response format of one request, or refuses the request.
	 *
	 * @param body The chat completion request, already read by `ChatCompletionRequestSchema`.
	 * @param taskTypeName The task type the request's model names, without the leading
	 * `task_type_`.
	 * @returns The response format to produce the answer in, or `undefined` when the request asked
	 * for nothing unusual, so that such a request is answered exactly as it was before this field
	 * was read at all.
	 * @throws OpenaiError when the model cannot produce the shape the request asked for.
	 */
	static read(body: ChatCompletionRequest, taskTypeName: TaskTypeName): ResponseFormatName | undefined {
		const responseFormat = body.response_format;
		if (responseFormat === undefined || responseFormat === null || responseFormat.type === 'text') {
			return undefined;
		}
		const taskType = `task_type_${taskTypeName}` as TaskType;
		if (StructuredOutputSupport.honours(taskType, responseFormat.type) === true) {
			return responseFormat.type;
		}
		throw OpenaiError.unhonourableResponseFormat(
			responseFormat.type,
			body.model,
			StructuredOutputSupport.honouredFormats(taskType),
		);
	}
}
