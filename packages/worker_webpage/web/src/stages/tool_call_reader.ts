import type { ToolCall, ToolDeclaration } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallReader — reads the tool calls Qwen3.5 writes out of its generated text
//
//	Nothing forwards a tool call here. The model writes one as text, in the middle of everything
//	else it writes, and this project has to find it and read it back. The format is the one the
//	model's own chat template instructs it to use, measured in the de-risk gate for
//	[issue #115](https://github.com/webai-at-home/webai-at-home/issues/115) rather than assumed:
//
//	```text
//	<tool_call>
//	<function=get_current_weather>
//	<parameter=city>
//	Paris
//	</parameter>
//	</function>
//	</tool_call>
//	```
//
//	It is not the JSON-inside-`<tool_call>` format that Qwen2.5 and Qwen3 use, which is what anyone
//	who knows those models reaches for first. The gate was written expecting that format and
//	reported "does not parse as JSON" against two otherwise perfect tool calls before the rendered
//	prompt was read and the real format found.
//
//	`<tool_call>` and `</tool_call>` are added tokens of this tokenizer with `special: false`, read
//	off the pinned revision's own `tokenizer.json`, so they survive the `skip_special_tokens: true`
//	decoding this stage has always used and no decoding setting has to change for them to arrive.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The marker that opens a tool call in the generated text. */
const openingMarker = '<tool_call>';

/** The marker that closes a tool call in the generated text. */
const closingMarker = '</tool_call>';

/** Reads the tool calls a Qwen3.5 model wrote, and says when it has finished writing one. */
export class ToolCallReader {
	/**
	 * Reports whether the text generated so far contains a complete tool call.
	 *
	 * This is what lets generation stop the moment the model has asked for a tool, rather than
	 * reading a whole answer out of it. Nothing after a complete tool call is wanted, and on a
	 * volunteer's browser the tokens that would follow are not cheap.
	 *
	 * @param generatedText Everything the model has written so far.
	 * @returns `true` once a closing marker has followed an opening one.
	 */
	static hasCompleteToolCall(generatedText: string): boolean {
		const openedAt = generatedText.indexOf(openingMarker);
		return openedAt !== -1 && generatedText.indexOf(closingMarker, openedAt + openingMarker.length) !== -1;
	}

	/**
	 * Reports whether the model has begun writing a tool call.
	 *
	 * A run that has seen this must not report what it has read as an answer, because what it has
	 * read is the opening of a tool call rather than the opening of a sentence.
	 *
	 * @param generatedText Everything the model has written so far.
	 * @returns `true` once an opening marker has appeared.
	 */
	static hasStartedAToolCall(generatedText: string): boolean {
		return generatedText.includes(openingMarker);
	}

	/**
	 * Reads every tool call out of one generated answer.
	 *
	 * A tool call the model wrote incorrectly is reported as a failure naming what could not be
	 * read, never silently dropped and never passed on half-formed. The reason is worth stating: a
	 * calling program that receives a tool call runs it, and a call read wrongly is a call run
	 * wrongly, on the caller's own machine, with the caller's own credentials. Answering "the model
	 * asked for something I could not read" is the only safe answer.
	 *
	 * @param generatedText The whole text the model wrote.
	 * @param declaredTools The tools the history declared, used to refuse a call naming a tool
	 * that was never offered.
	 * @returns The tool calls, in the order the model wrote them. Empty when it wrote none, which is
	 * the ordinary case of a model that answered in words.
	 * @throws {Error} If a tool call was opened and could not be read, or names a tool that was
	 * never declared.
	 */
	static read(generatedText: string, declaredTools: readonly ToolDeclaration[]): ToolCall[] {
		if (ToolCallReader.hasStartedAToolCall(generatedText) === false) {
			return [];
		}
		const declaredNames = new Set(declaredTools.map((tool) => tool.name));
		const toolCalls: ToolCall[] = [];
		for (const callMatch of generatedText.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)) {
			const body = (callMatch[1] ?? '').trim();
			const functionMatch = /<function=([^>]*)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
			if (functionMatch === null) {
				throw new Error(`The model opened a tool call this worker could not read: no <function=…> block inside ${JSON.stringify(body)}.`);
			}
			const name = functionMatch[1] ?? '';
			if (name === '') {
				throw new Error(`The model asked for a tool with no name, in ${JSON.stringify(body)}.`);
			}
			if (declaredNames.has(name) === false) {
				throw new Error(`The model asked for a tool named ${JSON.stringify(name)}, which this history never declared. The tools declared were ${[...declaredNames].join(', ') || 'none'}.`);
			}
			const argumentValues: Record<string, string> = {};
			for (const parameterMatch of (functionMatch[2] ?? '').matchAll(/<parameter=([^>]*)>([\s\S]*?)(?:<\/parameter>|$)/g)) {
				const argumentName = parameterMatch[1] ?? '';
				if (argumentName === '') {
					throw new Error(`The model gave an argument with no name to ${JSON.stringify(name)}.`);
				}
				// Every value is text, because this format says nothing about types. Converting one to
				// the type its tool declared belongs to whichever consumer hands the call over in a
				// typed form, which is where the arguments schema is read.
				argumentValues[argumentName] = (parameterMatch[2] ?? '').trim();
			}
			toolCalls.push({
				name,
				argumentValues,
			});
		}
		if (toolCalls.length === 0) {
			throw new Error(`The model opened a tool call this worker could not read: ${JSON.stringify(generatedText)}.`);
		}
		return toolCalls;
	}

	/**
	 * Builds the tool declarations to hand to the chat template, from the ones the history
	 * carried.
	 *
	 * The template renders these back out as JSON into the prompt, in the shape the OpenAI Chat
	 * Completions interface spells them, which is the shape it was written against. So this is the
	 * one place in this worker where that interface's spelling is rebuilt, from this project's own
	 * naming, on the way into a chat template rather than on the way out to a client.
	 *
	 * @param declaredTools The tools the history declared.
	 * @returns The declarations in the shape `apply_chat_template` takes them.
	 */
	static toChatTemplateTools(declaredTools: readonly ToolDeclaration[]): Record<string, unknown>[] {
		return declaredTools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				parameters: tool.parametersJsonSchema,
			},
		}));
	}
}
