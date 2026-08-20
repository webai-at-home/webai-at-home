import type { TaskTypeName } from '@webai/consumer-cli';
import { StructuredOutputSupport, type ResponseFormat, type TaskType, type ToolDeclaration } from '@webai/protocol';
import { OpenaiError } from './openai_error.js';
import { ResponseFormatEnforcement } from './response_format_enforcement.js';
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
 *   Milestone 2 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221) wrote
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
 * Two further refusals live here, both added by milestone 5 of
 * [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221), and both about a shape
 * the cluster could carry but could not keep:
 *
 * - A schema the constraint package cannot enforce. `ResponseFormatEnforcement` asks the package
 *   itself, so no list of supported keywords is kept here.
 * - A shape asked for beside declared tools. The two cannot both be honoured, and a model asked for
 *   both writes the shape and invents what the tool was declared to fetch.
 */
export class ResponseFormatReader {
	/**
	 * Reads the response format of one request, or refuses the request.
	 *
	 * @param body The chat completion request, already read by `ChatCompletionRequestSchema`.
	 * @param taskTypeName The task type the request's model names, without the leading
	 * `task_type_`.
	 * @param declaredTools The tools the request will really declare to the model, `undefined` when
	 * it declares none. It is what the caller worked out rather than the request's own `tools`
	 * field, because a request sending `tool_choice: "none"` declares nothing whatever it listed,
	 * and a model told about no tool can be made to write a shape.
	 * @returns The response format to produce the answer in, carrying the schema itself when the
	 * request asked for one, or `undefined` when the request asked for nothing unusual, so that such
	 * a request is answered exactly as it was before this field was read at all.
	 * @throws OpenaiError when the model cannot produce the shape the request asked for, when the
	 * schema cannot be enforced, or when a shape was asked for beside declared tools.
	 */
	static read(
		body: ChatCompletionRequest,
		taskTypeName: TaskTypeName,
		declaredTools: readonly ToolDeclaration[] | undefined,
	): ResponseFormat | undefined {
		const responseFormat = body.response_format;
		if (responseFormat === undefined || responseFormat === null || responseFormat.type === 'text') {
			return undefined;
		}
		const taskType = `task_type_${taskTypeName}` as TaskType;
		if (StructuredOutputSupport.honours(taskType, responseFormat.type) === false) {
			throw OpenaiError.unhonourableResponseFormat(
				responseFormat.type,
				body.model,
				StructuredOutputSupport.honouredFormats(taskType),
			);
		}
		if (declaredTools !== undefined && declaredTools.length > 0) {
			throw OpenaiError.responseFormatWithTools(responseFormat.type);
		}
		if (responseFormat.type === 'json_object') {
			return {
				type: 'json_object',
			};
		}
		// The OpenAI Chat Completions interface makes `schema` optional inside its `json_schema`
		// wrapper, and a request that leaves it out has asked for JSON and described nothing about
		// it. The empty JSON Schema says exactly that — every JSON value satisfies it — so it is
		// what is carried, rather than the request being refused for a shape the task type honours
		// or answered in prose. The wrapper's `name`, `description`, and `strict` are not carried,
		// for the reasons `ResponseFormatSchema` gives.
		const schema = responseFormat.json_schema.schema;
		const carried: ResponseFormat = {
			type: 'json_schema',
			jsonSchema: schema === undefined ? {} : schema,
		};
		const refusal = ResponseFormatEnforcement.refusalOf(carried);
		if (refusal !== undefined) {
			throw OpenaiError.unenforceableSchema(refusal);
		}
		return carried;
	}
}
