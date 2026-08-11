// node imports
import Crypto from 'node:crypto';

// npm imports
import type { ToolCall, ToolDeclaration } from '@webai/protocol';

// local imports
import type { ChatCompletionTool, ChatCompletionToolCall } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolTranslator — carries tools between the OpenAI spelling and this project's own
//
//	Two things this cluster cannot produce have to be supplied here, and both are supplied here
//	rather than in the protocol because both are requirements of the OpenAI Chat Completions
//	interface and of nothing else.
//
//	**The identifier.** That interface gives every tool call one, so that a result can be matched
//	back to the call it answers. No model this project runs generates one — `llm_qwen3_5_0_8b_full`
//	writes `<function=name>` with no identifier anywhere in it, measured in the de-risk gate for
//	[issue #115](https://github.com/webai-at-home/webai-at-home/issues/115) — so this server mints
//	it, exactly as `FinishReasonTranslator` supplies a `finish_reason` the protocol does not carry.
//
//	**The types.** That interface carries a tool call's arguments as a string of JSON. A worker
//	reports them as text keyed by argument name, because the format the model writes them in says
//	nothing about types: it names each argument and gives its value as the characters between two
//	markers. Turning `"31"` back into the number `31` needs the type the tool itself declared, which
//	is what `parametersJsonSchema` is read for here.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The JSON Schema fragment describing one argument, as much of it as this translator reads. */
type ArgumentSchema = {
	/** The JSON Schema type name, when the tool declared one. */
	type?: unknown;
};

/** Carries tool declarations to the cluster, and tool calls back to an OpenAI client. */
export class ToolTranslator {
	/**
	 * Turns the tools a request declared into the shape a task carries.
	 *
	 * @param tools The `tools` field of the request, absent or `null` when it declared none.
	 * @returns The declarations to carry, or `undefined` when none were declared, so that a request
	 * declaring no tool submits exactly the history it did before tools existed.
	 */
	static toProtocolTools(tools: ChatCompletionTool[] | null | undefined): ToolDeclaration[] | undefined {
		if (tools === null || tools === undefined || tools.length === 0) {
			return undefined;
		}
		return tools.map((tool) => ({
			name: tool.function.name,
			...(tool.function.description === undefined ? {} : { description: tool.function.description }),
			// A tool declared with no arguments at all is carried as an empty schema rather than
			// refused: a tool that takes nothing is a real tool, and the model still has to be told
			// it exists.
			parametersJsonSchema: tool.function.parameters ?? {},
		}));
	}

	/**
	 * Turns the tool calls a worker reported into the shape an OpenAI client reads.
	 *
	 * @param toolCalls The tool calls the worker reported, in the order the model asked for them.
	 * @param declaredTools The tools the request declared, read for the types each argument was
	 * declared with.
	 * @returns The tool calls to answer with, each carrying a freshly minted identifier and its
	 * arguments as a string of JSON.
	 */
	static toOpenaiToolCalls(toolCalls: readonly ToolCall[], declaredTools: readonly ToolDeclaration[]): ChatCompletionToolCall[] {
		return toolCalls.map((toolCall) => ({
			id: `call_${Crypto.randomUUID()}`,
			type: 'function',
			function: {
				name: toolCall.name,
				arguments: JSON.stringify(ToolTranslator._typedArgumentsOf(toolCall, declaredTools)),
			},
		}));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Converts one tool call's argument text into the types its tool declared them with.
	 *
	 * A value that does not convert is carried through as the text the model wrote, rather than
	 * dropped or replaced. The model's own words are the most useful thing this server can hand a
	 * caller when it cannot do better: a caller that receives `"thirty one"` where a number was
	 * declared can say so, while a caller that receives nothing, or a `0` invented here, cannot.
	 *
	 * @param toolCall The tool call the worker reported.
	 * @param declaredTools The tools the request declared.
	 * @returns The arguments as an object, ready to be written out as JSON.
	 */
	private static _typedArgumentsOf(toolCall: ToolCall, declaredTools: readonly ToolDeclaration[]): Record<string, unknown> {
		const properties = ToolTranslator._propertiesOf(declaredTools.find((tool) => tool.name === toolCall.name));
		const typedArguments: Record<string, unknown> = {};
		for (const [argumentName, writtenValue] of Object.entries(toolCall.argumentValues)) {
			typedArguments[argumentName] = ToolTranslator._typedValueOf(writtenValue, properties[argumentName]);
		}
		return typedArguments;
	}

	/**
	 * Reads the per-argument schemas out of one tool's declared arguments schema.
	 *
	 * @param declaredTool The tool the model asked for, or `undefined` when the request declared no
	 * tool of that name.
	 * @returns The schema of each argument, keyed by argument name, empty when there is none to read.
	 */
	private static _propertiesOf(declaredTool: ToolDeclaration | undefined): Record<string, ArgumentSchema | undefined> {
		const properties = declaredTool?.parametersJsonSchema.properties;
		if (typeof properties !== 'object' || properties === null) {
			return {};
		}
		return properties as Record<string, ArgumentSchema | undefined>;
	}

	/**
	 * Converts one written value into the type its argument was declared with.
	 *
	 * @param writtenValue The value exactly as the model wrote it.
	 * @param argumentSchema The schema the tool declared for this argument, `undefined` when it
	 * declared none.
	 * @returns The converted value, or the written text when it was declared as text, when no type
	 * was declared, or when it does not convert.
	 */
	private static _typedValueOf(writtenValue: string, argumentSchema: ArgumentSchema | undefined): unknown {
		const declaredType = argumentSchema?.type;
		if (declaredType === 'number' || declaredType === 'integer') {
			const asNumber = Number(writtenValue);
			return writtenValue.trim() !== '' && Number.isFinite(asNumber) ? asNumber : writtenValue;
		}
		if (declaredType === 'boolean') {
			if (writtenValue === 'true') {
				return true;
			}
			if (writtenValue === 'false') {
				return false;
			}
			return writtenValue;
		}
		if (declaredType === 'object' || declaredType === 'array') {
			try {
				return JSON.parse(writtenValue);
			} catch {
				return writtenValue;
			}
		}
		return writtenValue;
	}
}
