import type { TaskTypeName } from '@webai/consumer-cli';
import { StructuredOutputSupport, type ResponseFormatName, type TaskType, type ToolDeclaration } from '@webai/protocol';
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
 *
 * A shape asked for beside declared tools is refused as well, whichever task type it names and
 * whichever shape it is. That refusal is not read out of `StructuredOutputSupport`, because it is
 * not a fact about one task type: a worker holds a model to a shape by allowing only the tokens that
 * shape permits, and every marker that opens a tool call is a token no shape permits, so the two
 * asked for together are two things no worker can both give. A task type whose every worker can one
 * day do both is the reason to look at this rule again.
 */
export class ResponseFormatReader {
	/**
	 * Reads the response format of one request, or refuses the request.
	 *
	 * @param body The chat completion request, already read by `ChatCompletionRequestSchema`.
	 * @param taskTypeName The task type the request's model names, without the leading
	 * `task_type_`.
	 * @param declaredTools The tools that will actually be declared to the model, which is not the
	 * same as the tools the request carries: a request asking for `tool_choice: "none"` declares
	 * none, and may ask for a shape.
	 * @returns The response format to produce the answer in, or `undefined` when the request asked
	 * for nothing unusual, so that such a request is answered exactly as it was before this field
	 * was read at all.
	 * @throws OpenaiError when the model cannot produce the shape the request asked for, or when the
	 * request asks for a shape beside tools it declares.
	 */
	static read(
		body: ChatCompletionRequest,
		taskTypeName: TaskTypeName,
		declaredTools?: readonly ToolDeclaration[],
	): ResponseFormatName | undefined {
		const responseFormat = body.response_format;
		if (responseFormat === undefined || responseFormat === null || responseFormat.type === 'text') {
			return undefined;
		}
		const taskType = `task_type_${taskTypeName}` as TaskType;
		// Whether the shape can be produced at all is asked first. A request that asks for a shape
		// this model never produces is not made answerable by removing its tools, so being told about
		// the tools would send its sender to fix the wrong half.
		if (StructuredOutputSupport.honours(taskType, responseFormat.type) === false) {
			throw OpenaiError.unhonourableResponseFormat(
				responseFormat.type,
				body.model,
				StructuredOutputSupport.honouredFormats(taskType),
			);
		}
		if (declaredTools !== undefined && declaredTools.length > 0) {
			throw OpenaiError.shapeBesideToolDeclarations(responseFormat.type, body.model);
		}
		return responseFormat.type;
	}
}
