import type { HistoryInput } from '@webai/protocol';
import type { Message } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gemma4E2bHistoryMessages — puts a history into the shape Gemma 4 E2B's chat template reads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Builds the message list Gemma 4 E2B's chat template is handed, from a prompt or a history. */
export class Gemma4E2bHistoryMessages {
	/**
	 * Builds the message list handed to the text-generation pipeline, from either a prompt or a
	 * history.
	 *
	 * A single prompt becomes one user message. A history becomes its messages, each carrying the role
	 * it was given, so `@huggingface/transformers` applies the model's own chat template to real turns
	 * — a system message reaches the slot the template has for it — instead of receiving one user
	 * message whose content happens to be a flattened transcript.
	 *
	 * An assistant message that asked for tools is handed back in the shape the template reads, so the
	 * template renders it into the same form the model itself writes. That is what lets a history
	 * carrying a finished tool round trip be answered: the model reads its own earlier request written
	 * the way it would have written it, not a rewriting of it.
	 *
	 * **An identifier is minted for each tool call here, and it exists only inside this rendering.**
	 * The protocol carries none, deliberately, because no model this project runs generates one — see
	 * `ToolCallSchema`. This template needs one all the same: it names a tool result by matching a
	 * result's `tool_call_id` against a call's `id`, and falls back to a `name` on the result. Handing
	 * it neither is not the safe option it looks like. With one call it happens to work, because the
	 * template compares one absent value against another and they match. With **two** calls it names
	 * every result after the last call, silently, which was measured against this template in
	 * milestone 3 of https://github.com/webai-at-home/webai-at-home/issues/216 rather than reasoned
	 * about. So each call is given an identifier and each result is given the identifier of the call
	 * it answers, paired by position — which is what the protocol already says decides it.
	 *
	 * The pairing stops at the first message that is not a tool result, because the template's own
	 * scan does: a tool result that does not follow a call is not rendered by this template at all.
	 *
	 * One infidelity is left as it is. `ToolCall.argumentValues` carries text, so a number the model
	 * wrote as `days:7` is rendered back as a string, `days:<|"|>7<|"|>`. The Qwen3.5-0.8B helper has
	 * the same infidelity for the same reason. Converting it back would need the tool's declared
	 * schema, and nothing has measured whether the difference changes what the model does, so it is
	 * recorded rather than guessed at.
	 *
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @returns The message list to pass to the text-generation pipeline.
	 */
	static of(promptOrHistory: string | HistoryInput): Message[] {
		if (typeof promptOrHistory === 'string') {
			return [{ role: 'user', content: promptOrHistory }];
		}
		const messages: Message[] = [];
		// The identifiers of the tool calls asked for by the assistant message most recently passed,
		// and how many of them the tool results since have used up.
		let pendingToolCallIds: string[] = [];
		let usedToolCallIdCount = 0;
		for (const [messageIndex, message] of promptOrHistory.messages.entries()) {
			if (message.role === 'tool') {
				const toolCallId = pendingToolCallIds[usedToolCallIdCount];
				usedToolCallIdCount += 1;
				if (toolCallId === undefined) {
					messages.push({ role: message.role, content: message.content });
					continue;
				}
				// `Message` declares `role` and `content` and nothing else, while this template reads a
				// `tool_call_id` beside them. The cast is that gap, and is kept to the messages that need
				// it rather than widening the whole list's type.
				messages.push({ role: message.role, content: message.content, tool_call_id: toolCallId } as unknown as Message);
				continue;
			}
			pendingToolCallIds = [];
			usedToolCallIdCount = 0;
			if (message.toolCalls === undefined) {
				messages.push({ role: message.role, content: message.content });
				continue;
			}
			pendingToolCallIds = message.toolCalls.map((_toolCall, toolCallIndex) => `call_${messageIndex}_${toolCallIndex}`);
			messages.push({
				role: message.role,
				content: message.content,
				tool_calls: message.toolCalls.map((toolCall, toolCallIndex) => ({
					id: pendingToolCallIds[toolCallIndex],
					type: 'function',
					function: {
						name: toolCall.name,
						arguments: toolCall.argumentValues,
					},
				})),
			} as unknown as Message);
		}
		return messages;
	}
}
