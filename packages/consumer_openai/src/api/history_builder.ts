import type { HistoryInput, HistoryMessage, ToolDeclaration } from '@webai/protocol';
import type { ChatCompletionMessage } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HistoryBuilder — turns a request's messages into the history a task carries
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds the `HistoryInput` a task carries, from the message list of a chat completion
 * request, for a model whose task type accepts a whole history rather than only one prompt
 * (see `TaskInputFactory.acceptsHistory` in `@webai/consumer-cli`).
 *
 * This is what `PromptFlattener` was standing in for on these models. Flattening joined every
 * message into one piece of text and handed a worker a single user turn to make sense of; this
 * keeps each message's own role instead, so a worker's chat template places it in the slot that
 * template already has for that role — a system message reaches the system slot rather than
 * becoming a line of text inside a user turn.
 */
export class HistoryBuilder {
	/**
	 * Builds the history to submit for one request.
	 *
	 * @param messages The messages of the request, in the order they were sent.
	 * @returns The history to submit as the task input.
	 */
	static build(messages: ChatCompletionMessage[], tools?: ToolDeclaration[]): HistoryInput {
		return {
			messages: messages.map(HistoryBuilder.messageOf),
			// Left out entirely rather than stated as empty when the request declared no tool, so that
			// a request that asked for nothing about tools submits exactly what it always did.
			...(tools === undefined || tools.length === 0 ? {} : { tools }),
		};
	}

	/**
	 * Turns one request message into the shape a task carries.
	 *
	 * The OpenAI completion interface's `developer` role is its newer name for what it used to
	 * call `system`. No chat template this project drives knows a fourth name for that slot, so a
	 * `developer` message is carried as `system` here, rather than reaching a worker under a role
	 * its chat template does not recognise.
	 *
	 * @param message One message of the request.
	 * @returns The same message, in the protocol's own shape.
	 */
	private static messageOf(message: ChatCompletionMessage): HistoryMessage {
		return {
			role: message.role === 'developer' ? 'system' : message.role,
			// A model that asks for a tool writes no text, and an OpenAI client hands that message
			// straight back with `content` absent or `null`. Both mean the same thing here, and the
			// protocol says a message always states what it carries, so both become the empty string.
			content: message.content ?? '',
			// A tool call is carried back so the chat template can render it into the form the model
			// itself writes, which is what lets the model read its own earlier request rather than a
			// rewriting of it. The identifier this interface gave it is dropped: no chat template this
			// project drives reads one, and the order of the messages is what says which call a
			// result answers.
			...(message.tool_calls === undefined || message.tool_calls.length === 0
				? {}
				: {
					toolCalls: message.tool_calls.map((toolCall) => ({
						name: toolCall.function.name,
						argumentValues: HistoryBuilder.argumentValuesOf(toolCall.function.arguments),
					})),
				}),
		};
	}

	/**
	 * Reads the argument values out of the JSON string this interface carries a tool call's
	 * arguments in.
	 *
	 * Every value becomes text again, because text is what the protocol carries and what the model
	 * itself wrote in the first place. A value that was a number on the way out is written back as
	 * the characters of that number, which is what the chat template renders either way.
	 *
	 * @param argumentsJson The arguments exactly as the client sent them, which this interface
	 * defines as a string because a model does not always generate valid JSON.
	 * @returns The argument values keyed by name, empty when the string could not be read as an
	 * object of arguments.
	 */
	private static argumentValuesOf(argumentsJson: string): Record<string, string> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(argumentsJson);
		} catch {
			return {};
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		const argumentValues: Record<string, string> = {};
		for (const [argumentName, value] of Object.entries(parsed)) {
			argumentValues[argumentName] = typeof value === 'string' ? value : JSON.stringify(value);
		}
		return argumentValues;
	}
}
