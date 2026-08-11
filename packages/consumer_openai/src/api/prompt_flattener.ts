import type { ChatCompletionMessage } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PromptFlattener — turns a conversation into the single piece of text a task carries
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Turns the list of messages in a chat completion request into the single piece of text a
 * cluster task carries.
 *
 * A task input in this cluster holds one value, so a conversation of several messages has to
 * become one piece of text before it can be submitted. Two rules do that, and the package
 * README states both:
 *
 * - A request carrying one message sends that message's content unchanged, so the worker
 *   receives exactly what the caller wrote. This is also what makes the `dev_formula` model
 *   usable, because that task type accepts a number and nothing else.
 * - A request carrying several messages sends them labelled with their roles, one message per
 *   line, followed by a final `assistant:` line that invites the answer.
 */
export class PromptFlattener {
	/**
	 * Builds the prompt text for one request.
	 *
	 * @param messages The messages of the request, in the order they were sent.
	 * @returns The single piece of text to submit as the task input.
	 */
	static flatten(messages: ChatCompletionMessage[]): string {
		const onlyMessage = messages.length === 1 ? messages[0] : undefined;
		if (onlyMessage !== undefined) {
			// A message may now carry no content at all, because an assistant message that asked for a
			// tool writes none. Such a message reaching here means a client sent a tool round trip to a
			// model that flattens, which is refused before this point; the empty string is what a
			// message with nothing to say flattens to either way.
			return onlyMessage.content ?? '';
		}
		const labelledLines = messages.map((message) => `${message.role}: ${message.content ?? ''}`);
		return [...labelledLines, 'assistant:'].join('\n');
	}
}
