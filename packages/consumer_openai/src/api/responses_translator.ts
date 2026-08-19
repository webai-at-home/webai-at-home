// node imports
import Crypto from 'node:crypto';

// npm imports
import type { ToolCall, ToolDeclaration } from '@webai/protocol';

// local imports
import type { ChatCompletionMessage, ChatCompletionTool } from './openai_types.js';
import { ToolTranslator } from './tool_translator.js';
import {
	ResponsesFunctionCallItemSchema,
	ResponsesFunctionCallOutputItemSchema,
	ResponsesFunctionToolSchema,
	ResponsesMessageItemSchema,
	type ResponsesInputItem,
	type ResponsesMessageOutputItem,
	type ResponsesOutputItem,
	type ResponsesTool,
	type ResponsesUsage,
} from './responses_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponsesTranslator — carries a Responses request onto what this server already runs
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Carries a `POST /v1/responses` request onto the message list, the tool declarations, and the
 * answer shapes this server already has, so that the Responses interface adds a spelling and not a
 * second way of running a task.
 *
 * Nothing about the cluster is restated here. A translated message list goes on to `HistoryBuilder`
 * and a translated tool list goes on to `ToolTranslator`, exactly as a chat completion request's
 * own do.
 */
export class ResponsesTranslator {
	/**
	 * Turns the `instructions` and the `input` of a request into the message list this server
	 * already knows how to submit.
	 *
	 * `instructions` and every system or developer message of the history are joined into one
	 * system message at the front, in the order they were written. That is not tidying: the chat
	 * template of `llm_qwen3_5_0_8b_full` refuses a second system message outright, with
	 * `System message must be at the beginning`, and the Codex command-line program sends both an
	 * `instructions` field and a `developer` message in every request, which is exactly that case.
	 * Joining them keeps every word of both, where carrying them separately fails the whole request
	 * and dropping either would lose what the caller said.
	 *
	 * A `reasoning` item is left out: nothing in this cluster carries a model's own thinking, and a
	 * client that hands its thinking back is doing what its interface says, so refusing it would
	 * fail every second turn of a conversation.
	 *
	 * @param instructions The standing prompt of the request, absent when it carries none.
	 * @param input The history, either one piece of text or a list of items.
	 * @returns The messages to submit, the joined system message first.
	 */
	static toChatMessages(
		instructions: string | null | undefined,
		input: string | ResponsesInputItem[],
	): ChatCompletionMessage[] {
		const systemTexts: string[] = [];
		if (instructions !== null && instructions !== undefined && instructions !== '') {
			systemTexts.push(instructions);
		}

		const messages: ChatCompletionMessage[] = [];
		if (typeof input === 'string') {
			messages.push({
				role: 'user',
				content: input,
			});
		} else {
			for (const item of input) {
				const message = ResponsesTranslator._messageOf(item);
				if (message === undefined) {
					continue;
				}
				if (message.role === 'system' || message.role === 'developer') {
					systemTexts.push(message.content ?? '');
					continue;
				}
				messages.push(message);
			}
		}

		if (systemTexts.length === 0) {
			return messages;
		}
		return [
			{
				role: 'system',
				content: systemTexts.join('\n\n'),
			},
			...messages,
		];
	}

	/**
	 * Turns the flat tool declarations of this interface into the nested ones the chat completion
	 * interface uses, so that `ToolTranslator` carries them to the cluster unchanged.
	 *
	 * @param tools The `tools` field of the request, absent or null when it declared none.
	 * @returns The same tools in the nested spelling, or undefined when none were declared.
	 */
	static toChatTools(tools: ResponsesTool[] | null | undefined): ChatCompletionTool[] | undefined {
		if (tools === null || tools === undefined || tools.length === 0) {
			return undefined;
		}

		const chatTools: ChatCompletionTool[] = [];
		for (const tool of tools) {
			const asFunction = ResponsesFunctionToolSchema.safeParse(tool);
			if (asFunction.success === false) {
				continue;
			}
			const functionTool = asFunction.data;
			chatTools.push({
				type: 'function',
				function: {
					name: functionTool.name,
					...(functionTool.description === null || functionTool.description === undefined
						? {}
						: { description: functionTool.description }),
					...(functionTool.parameters === null || functionTool.parameters === undefined
						? {}
						: { parameters: functionTool.parameters }),
				},
			});
		}
		if (chatTools.length === 0) {
			return undefined;
		}
		return chatTools;
	}

	/**
	 * Names the kinds of tool a request declared that this server carries nowhere, so that the
	 * answer can say which ones were left out rather than leaving the caller to guess.
	 *
	 * @param tools The `tools` field of the request, absent or null when it declared none.
	 * @returns Each kind that is not `function`, once each, in the order they were first seen.
	 */
	static unsupportedToolKinds(tools: ResponsesTool[] | null | undefined): string[] {
		if (tools === null || tools === undefined) {
			return [];
		}

		const kinds: string[] = [];
		for (const tool of tools) {
			if (ResponsesFunctionToolSchema.safeParse(tool).success === true) {
				continue;
			}
			const kind = typeof tool.type === 'string' ? tool.type : 'unknown';
			if (kinds.includes(kind) === true) {
				continue;
			}
			kinds.push(kind);
		}
		return kinds;
	}

	/**
	 * Builds the items of an answer: one message when the model wrote text, and one item per tool
	 * call it asked for.
	 *
	 * @param text The text the model wrote, empty when it only asked for tools.
	 * @param toolCalls The tool calls it asked for, absent when it asked for none.
	 * @param declaredTools The tools the request declared, read for the type each argument was
	 * declared with, which is what turns the text a worker reports back into a typed value.
	 * @returns The items of the answer, in the order a client reads them.
	 */
	static toOutputItems(
		text: string,
		toolCalls: ToolCall[] | undefined,
		declaredTools: ToolDeclaration[] | undefined,
	): ResponsesOutputItem[] {
		const items: ResponsesOutputItem[] = [];
		if (text !== '') {
			items.push(ResponsesTranslator.messageItemOf(text));
		}

		if (toolCalls === undefined || toolCalls.length === 0) {
			return items;
		}

		const openaiToolCalls = ToolTranslator.toOpenaiToolCalls(toolCalls, declaredTools ?? []);
		for (const toolCall of openaiToolCalls) {
			items.push({
				id: `fc_${Crypto.randomUUID()}`,
				type: 'function_call',
				call_id: toolCall.id,
				name: toolCall.function.name,
				arguments: toolCall.function.arguments,
				status: 'completed',
			});
		}
		return items;
	}

	/**
	 * Builds the one message item of an answer that is text.
	 *
	 * @param text The text the model wrote.
	 * @returns The item, already finished.
	 */
	static messageItemOf(text: string): ResponsesMessageOutputItem {
		return {
			id: `msg_${Crypto.randomUUID()}`,
			type: 'message',
			role: 'assistant',
			status: 'completed',
			content: [
				{
					type: 'output_text',
					text: text,
					annotations: [],
				},
			],
		};
	}

	/**
	 * Turns the two token counts a worker reported into the three numbers this interface carries.
	 *
	 * @param answer The counts as the cluster reported them, either of them absent when the worker
	 * reported none.
	 * @returns The usage, or undefined when either count is missing, because this server never
	 * estimates one.
	 */
	static toUsage(answer: {
		promptTokenCount: number | undefined;
		completionTokenCount: number | undefined;
	}): ResponsesUsage | undefined {
		if (answer.promptTokenCount === undefined || answer.completionTokenCount === undefined) {
			return undefined;
		}
		return {
			input_tokens: answer.promptTokenCount,
			output_tokens: answer.completionTokenCount,
			total_tokens: answer.promptTokenCount + answer.completionTokenCount,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Turns one item of the history into one message, or into nothing when the item carries
	 * something this cluster does not.
	 *
	 * @param item One item of the `input` field.
	 * @returns The message to submit, or undefined when the item is left out.
	 */
	private static _messageOf(item: ResponsesInputItem): ChatCompletionMessage | undefined {
		const asMessage = ResponsesMessageItemSchema.safeParse(item);
		if (asMessage.success === true) {
			return {
				// The `developer` role is this interface's newer name for `system`, and
				// `HistoryBuilder` already carries it to the system slot, so it is passed on as it
				// was written rather than renamed twice.
				role: asMessage.data.role,
				content: ResponsesTranslator._textOf(asMessage.data.content),
			};
		}

		const asFunctionCall = ResponsesFunctionCallItemSchema.safeParse(item);
		if (asFunctionCall.success === true) {
			const functionCall = asFunctionCall.data;
			return {
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: functionCall.call_id ?? functionCall.id ?? `call_${Crypto.randomUUID()}`,
						type: 'function',
						function: {
							name: functionCall.name,
							arguments: functionCall.arguments,
						},
					},
				],
			};
		}

		const asFunctionCallOutput = ResponsesFunctionCallOutputItemSchema.safeParse(item);
		if (asFunctionCallOutput.success === true) {
			return {
				role: 'tool',
				content: asFunctionCallOutput.data.output,
				tool_call_id: asFunctionCallOutput.data.call_id,
			};
		}

		// A `reasoning` item, and every item kind this server has never seen, is left out on
		// purpose. See the note on `toChatMessages`.
		return undefined;
	}

	/**
	 * Reads the text out of a message's content, which this interface writes either as one piece of
	 * text or as a list of parts.
	 *
	 * @param content The content of one message.
	 * @returns The text of every part, joined, which is one piece of text for the single-part case
	 * every request seen so far carries.
	 */
	private static _textOf(content: string | { type: string, text: string, }[]): string {
		if (typeof content === 'string') {
			return content;
		}
		return content.map((part) => part.text).join('');
	}
}
