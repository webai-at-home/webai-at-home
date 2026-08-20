import type { TaskTypeName } from '@webai/consumer-cli';
import { GenerationControlSupport, type GenerationControlName, type GenerationSettings, type ResponseFormat, type TaskType } from '@webai/protocol';
import { OpenaiError } from './openai_error.js';
import type { ChatCompletionRequest } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationSettingsBuilder — turns a chat completion request's controls into task settings
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The request field each generation control was read from, spelled the way the OpenAI Chat
 * Completions interface spells it, against the name `GenerationSettingsSchema` gives the same
 * control inside the cluster.
 *
 * Both names are written out because neither can be derived from the other: `top_p` is `topP`,
 * `max_completion_tokens` is `maximumOutputTokenCount`, `seed` is `randomSeed`, and
 * `reasoning_effort` is `reasoningEffort`. The order is the order the OpenAI Chat Completions
 * interface documents the fields in, which is also the order a refusal lists them back to the
 * sender.
 */
const requestFieldByControlName: Record<GenerationControlName, string> = {
	temperature: 'temperature',
	topP: 'top_p',
	maximumOutputTokenCount: 'max_completion_tokens',
	stopSequences: 'stop',
	randomSeed: 'seed',
	reasoningEffort: 'reasoning_effort',
};

/** Every generation control this server reads, in the order a refusal lists them. */
const controlNames: readonly GenerationControlName[] = ['temperature', 'topP', 'maximumOutputTokenCount', 'stopSequences', 'randomSeed', 'reasoningEffort'];

/**
 * Turns the generation controls of one chat completion request into the generation settings a
 * cluster task carries, and refuses a request the chosen model could only answer by ignoring
 * part of it.
 *
 * The language-model task types sit on different engines that can each act on a different set of
 * controls, and a client sends one request to one interface without knowing which engine will
 * answer it. So a control has three possible fates, and this class decides between them exactly
 * as milestone 4 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151)
 * proposes. Which task type honours which control is read from `GenerationControlSupport` on every
 * request rather than written down here, so a task type may start or stop honouring one without
 * this class changing.
 *
 * - The model honours the control: it is carried to the cluster as the client asked for it,
 *   untranslated, because what a value means to an engine is that engine's stage helper's
 *   business.
 * - The model does not honour it and the value is this interface's own default: it is dropped
 *   without a word. A client that always sends `temperature: 1` is asking for nothing unusual and
 *   must not be refused by a model that cannot vary its temperature.
 * - The model does not honour it and the value is anything else: the request is refused. Being
 *   told is better than receiving an answer generated some other way and being told nothing.
 */
export class GenerationSettingsBuilder {
	/**
	 * Builds the generation settings for one request, or refuses the request.
	 *
	 * @param body The chat completion request, already read by `ChatCompletionRequestSchema`.
	 * @param taskTypeName The task type the request's model names, without the leading
	 * `task_type_`.
	 * @param isStreaming Whether the caller asked for the answer in pieces.
	 * @param responseFormat The shape the answer is to be produced in, as `ResponseFormatReader`
	 * read it, carrying the schema when the request named one, or `undefined` when the request asked
	 * for nothing unusual. It is carried rather than read here, because a response format is refused
	 * against `StructuredOutputSupport` and a generation control against `GenerationControlSupport`,
	 * and the two tables are separate.
	 * @returns The settings to submit the task with, or `undefined` when the request asked for
	 * nothing at all, so that such a request submits no settings block rather than an empty one.
	 * @throws OpenaiError when the model cannot honour a control the request asked for at a value
	 * that is not this interface's own default.
	 */
	static build(
		body: ChatCompletionRequest,
		taskTypeName: TaskTypeName,
		isStreaming: boolean,
		responseFormat?: ResponseFormat,
	): GenerationSettings | undefined {
		const taskType = `task_type_${taskTypeName}` as TaskType;
		const askedFor = GenerationSettingsBuilder.askedForControlsOf(body);
		for (const controlName of controlNames) {
			if (askedFor[controlName] === undefined) {
				continue;
			}
			if (GenerationControlSupport.honours(taskType, controlName) === true) {
				continue;
			}
			throw OpenaiError.unhonourableGenerationControl(
				requestFieldByControlName[controlName],
				taskTypeName,
				GenerationSettingsBuilder.honouredFieldsOf(taskType),
			);
		}
		const settings: GenerationSettings = isStreaming === true ? { isStreaming: true, ...askedFor } : { ...askedFor };
		if (responseFormat !== undefined) {
			settings.responseFormat = responseFormat;
		}
		if (Object.keys(settings).length === 0) {
			return undefined;
		}
		return settings;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading The Request
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the six generation controls of a request, leaving out every one the request asked
	 * nothing for.
	 *
	 * A control asks for nothing when its field is absent, when it is `null`, and when it holds
	 * this interface's own default: `temperature` and `top_p` both default to `1`, and the other
	 * four default to not being applied at all, so any value of theirs is something asked for. An
	 * empty `stop` list asks for nothing either, since it names no text to stop at.
	 *
	 * `reasoning_effort` has no default on this interface, so every level a request names is
	 * something asked for, `"none"` included. A client that sends `"none"` is asking the model not
	 * to think, which is a request a task type either honours or is refused for — not a way of
	 * saying nothing.
	 *
	 * @param body The chat completion request, already read by `ChatCompletionRequestSchema`.
	 * @returns The controls the request asked for, named as the cluster names them, with a control
	 * asking for nothing left out rather than set to `undefined`.
	 */
	private static askedForControlsOf(body: ChatCompletionRequest): GenerationSettings {
		const askedFor: GenerationSettings = {};
		if (body.temperature !== undefined && body.temperature !== null && body.temperature !== 1) {
			askedFor.temperature = body.temperature;
		}
		if (body.top_p !== undefined && body.top_p !== null && body.top_p !== 1) {
			askedFor.topP = body.top_p;
		}
		// `max_tokens` is the older spelling of `max_completion_tokens` on this interface, and a
		// client that sends both means the newer one, which is why it is read first.
		const maximumOutputTokenCount = body.max_completion_tokens ?? body.max_tokens;
		if (maximumOutputTokenCount !== undefined && maximumOutputTokenCount !== null) {
			askedFor.maximumOutputTokenCount = maximumOutputTokenCount;
		}
		const stopSequences = GenerationSettingsBuilder.stopSequencesOf(body.stop);
		if (stopSequences !== undefined) {
			askedFor.stopSequences = stopSequences;
		}
		if (body.seed !== undefined && body.seed !== null) {
			askedFor.randomSeed = body.seed;
		}
		if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
			askedFor.reasoningEffort = body.reasoning_effort;
		}
		return askedFor;
	}

	/**
	 * Reads the `stop` field, which this interface allows to be either one piece of text or a
	 * list of up to four.
	 *
	 * @param stop The field as the request carried it.
	 * @returns The stop sequences as a list, or `undefined` when the request named none.
	 */
	private static stopSequencesOf(stop: string | string[] | null | undefined): string[] | undefined {
		if (stop === undefined || stop === null) {
			return undefined;
		}
		const sequences = (typeof stop === 'string' ? [stop] : stop).filter((sequence) => sequence !== '');
		if (sequences.length === 0) {
			return undefined;
		}
		return sequences;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Lists the request fields a task type honours, spelled the way this interface spells them,
	 * for a refusal to name back to the sender.
	 *
	 * @param taskType The task type behind the model the request named.
	 * @returns The request field names, in the order {@link controlNames} declares them.
	 */
	private static honouredFieldsOf(taskType: TaskType): string[] {
		const honoured = GenerationControlSupport.honouredControls(taskType);
		return controlNames
			.filter((controlName) => honoured.includes(controlName))
			.map((controlName) => requestFieldByControlName[controlName]);
	}
}
