import type { ToolDeclaration } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatTemplateTools — hands a history's tool declarations to a model's chat template
//
//	This is the one direction of tool calling that every model this project runs agrees on. Each
//	model writes a tool call in a format of its own, which is why there is one reader per model and
//	why neither reader can read the other's, but every chat template reads its declarations in the
//	shape the OpenAI Chat Completions interface spells them. Qwen3.5's template reads
//	`tool['function']['name']`, and so does Gemma 4 E2B's, each rendering it into its own markup
//	afterwards.
//
//	So this is the one place in this worker where that interface's spelling is rebuilt, from this
//	project's own naming, on the way into a chat template rather than on the way out to a client.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Builds the `tools` option a chat template reads, from the declarations a history carried. */
export class ChatTemplateTools {
	/**
	 * Builds the option to hand to `apply_chat_template`, or nothing at all when the history declared
	 * no tool.
	 *
	 * Nothing is added to the call when there are no tools, rather than an empty list, so that every
	 * task submitted before tool calling existed produces byte for byte the prompt it always did.
	 *
	 * @param declaredTools The tools the history declared.
	 * @returns The option to spread into the chat template call, empty when no tool was declared.
	 */
	static templateOption(declaredTools: readonly ToolDeclaration[]): Record<string, unknown> {
		if (declaredTools.length === 0) {
			return {};
		}
		return {
			tools: ChatTemplateTools.of(declaredTools),
		};
	}

	/**
	 * Builds the tool declarations themselves, in the shape a chat template reads them.
	 *
	 * @param declaredTools The tools the history declared.
	 * @returns The declarations in the shape `apply_chat_template` takes them.
	 */
	static of(declaredTools: readonly ToolDeclaration[]): Record<string, unknown>[] {
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
