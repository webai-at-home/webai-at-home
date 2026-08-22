// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// third-party imports
import { LogitsProcessor, LogitsProcessorList, StoppingCriteria, type Tensor } from '@huggingface/transformers';

// local imports
import { ResponseConstraintBuilder } from '../web/src/stages/structured_output/response_constraint_builder.js';
import { SampledTokenForwarder } from '../web/src/stages/structured_output/sampled_token_forwarder.js';
import { ToolCallReader } from '../web/src/stages/tool_call_reader.js';
import { ChatTemplateTools } from '../web/src/stages/chat_template_tools.js';
import { Gemma4E2bHistoryMessages } from '../web/src/stages/gemma_4_e2b_history_messages.js';
import { Gemma4E2bToolCallReader } from '../web/src/stages/gemma_4_e2b_tool_call_reader.js';
import { StageCatalog } from '../web/src/stages/stage_catalog.js';
import { EmptyAnswerRefusal } from '../web/src/stages/empty_answer_refusal.js';
import { ThoughtChannelCut } from '../web/src/stages/thought_channel_cut.js';
import { ThinkingBlockCut } from '../web/src/stages/thinking_block_cut.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallReader
//
//	Every answer text asserted against here is the raw text `onnx-community/Qwen3.5-0.8B-ONNX` at
//	`q4f16` really generated, captured from the live de-risk gate run for
//	[issue #115](https://github.com/webai-at-home/webai-at-home/issues/115), rather than a shape
//	written from what the format is believed to be. The difference is not academic: the gate was
//	first written expecting the JSON-inside-`<tool_call>` format that Qwen2.5 and Qwen3 use, and
//	reported "does not parse as JSON" against two otherwise perfect tool calls before the rendered
//	prompt was read and the real format found.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The tools the captured answers below were generated against. */
const declaredTools = [
	{
		name: 'get_current_weather',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				city: {
					type: 'string',
				},
			},
		},
	},
	{
		name: 'get_current_time',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				city: {
					type: 'string',
				},
			},
		},
	},
];

/** The raw text the model wrote when it was asked about the weather, captured from the live gate run. */
const capturedWeatherCall = '<tool_call>\n<function=get_current_weather>\n<parameter=city>\nParis\n</parameter>\n</function>\n</tool_call>';

Test('reads the tool call the model really wrote, with its name and its arguments', () => {
	Assert.deepEqual(ToolCallReader.read(capturedWeatherCall, declaredTools), [
		{
			name: 'get_current_weather',
			argumentValues: {
				city: 'Paris',
			},
		},
	]);
	// The same shape for the second tool, so choosing between tools is read as the choice it was.
	const capturedTimeCall = '<tool_call>\n<function=get_current_time>\n<parameter=city>\nParis\n</parameter>\n</function>\n</tool_call>';
	Assert.deepEqual(ToolCallReader.read(capturedTimeCall, declaredTools), [
		{
			name: 'get_current_time',
			argumentValues: {
				city: 'Paris',
			},
		},
	]);
});

Test('reads an answer in words as an answer, and never as a tool call', () => {
	// Both captured from the live gate run: the negative control, and the answer given from a tool
	// result already in the history.
	Assert.deepEqual(ToolCallReader.read('hello', declaredTools), []);
	Assert.deepEqual(ToolCallReader.read('The current weather in Paris is **31 degrees Celsius** with a **clear sky**.', declaredTools), []);
	// A model that merely writes about tools has not asked for one.
	Assert.deepEqual(ToolCallReader.read('I could call get_current_weather for you.', declaredTools), []);
});

Test('every argument value is text, because the format the model writes carries no types', () => {
	const numericCall = '<tool_call>\n<function=get_current_weather>\n<parameter=days>\n7\n</parameter>\n</function>\n</tool_call>';
	const [readCall] = ToolCallReader.read(numericCall, declaredTools);
	// Read as the characters "7" and not as the number 7. Nothing in what the model wrote says which
	// it meant, so converting it belongs to whichever consumer reads the tool's arguments schema.
	Assert.equal(readCall?.argumentValues.days, '7');
	Assert.equal(typeof readCall?.argumentValues.days, 'string');
});

Test('reads several arguments, and a value spanning several lines, as the template says it may', () => {
	const call = '<tool_call>\n<function=get_current_weather>\n<parameter=city>\nParis\n</parameter>\n<parameter=note>\nfirst line\nsecond line\n</parameter>\n</function>\n</tool_call>';
	Assert.deepEqual(ToolCallReader.read(call, declaredTools)[0]?.argumentValues, {
		city: 'Paris',
		note: 'first line\nsecond line',
	});
});

Test('refuses a tool call it could not read, rather than dropping it or passing it on half-formed', () => {
	// The reason this is a failure and not an empty result: a calling program runs whatever tool call
	// it receives, so a call read wrongly is a call run wrongly on the caller's own machine.
	Assert.throws(() => ToolCallReader.read('<tool_call>\nget_current_weather(city=Paris)\n</tool_call>', declaredTools), /could not read/);
	Assert.throws(() => ToolCallReader.read('<tool_call>\n<function=>\n</function>\n</tool_call>', declaredTools), /no name/);
	// A model that invented a tool is reported, not believed. Running a tool nobody declared is the
	// worst of the ways this could fail.
	Assert.throws(
		() => ToolCallReader.read('<tool_call>\n<function=delete_everything>\n</function>\n</tool_call>', declaredTools),
		/never declared/,
	);
});

Test('reads a tool call the model left unfinished as far as it got, rather than silently missing it', () => {
	// This is what a generation cut short by the token cap leaves behind. It must not read as "the
	// model answered in words", which is what a parser requiring the closing markers would report.
	const truncated = '<tool_call>\n<function=get_current_weather>\n<parameter=city>\nPar';
	Assert.deepEqual(ToolCallReader.read(truncated, declaredTools), [
		{
			name: 'get_current_weather',
			argumentValues: {
				city: 'Par',
			},
		},
	]);
});

Test('says when a complete tool call has been written, so generation stops instead of reading on', () => {
	Assert.equal(ToolCallReader.hasCompleteToolCall(capturedWeatherCall), true);
	Assert.equal(ToolCallReader.hasCompleteToolCall('<tool_call>\n<function=get_current_weather>'), false);
	Assert.equal(ToolCallReader.hasCompleteToolCall('hello'), false);
	// Reached one piece at a time, the way the streaming callback really sees it: false every time
	// until the closing marker arrives, and true from then on.
	let writtenSoFar = '';
	const sawComplete: boolean[] = [];
	for (const piece of ['<tool_call>', '\n<function=get_current_weather>', '\n<parameter=city>\nParis\n</parameter>', '\n</function>', '\n</tool_call>']) {
		writtenSoFar += piece;
		sawComplete.push(ToolCallReader.hasCompleteToolCall(writtenSoFar));
	}
	Assert.deepEqual(sawComplete, [false, false, false, false, true]);
});

Test('builds the tool declarations in the shape the chat template reads them', () => {
	Assert.deepEqual(ChatTemplateTools.of([{ name: 'get_current_time', description: 'Reports the time.', parametersJsonSchema: { type: 'object' } }]), [
		{
			type: 'function',
			function: {
				name: 'get_current_time',
				description: 'Reports the time.',
				parameters: {
					type: 'object',
				},
			},
		},
	]);
	// A tool whose name says enough leaves the description out entirely, rather than declaring it empty.
	Assert.deepEqual(ChatTemplateTools.of([{ name: 'get_current_time', parametersJsonSchema: {} }]), [
		{
			type: 'function',
			function: {
				name: 'get_current_time',
				parameters: {},
			},
		},
	]);
});

Test('declaring no tool adds nothing at all to the chat template call, rather than an empty list', () => {
	// Byte for byte the prompt it always was, for every task submitted before tool calling existed.
	Assert.deepEqual(ChatTemplateTools.templateOption([]), {});
	Assert.deepEqual(ChatTemplateTools.templateOption([{ name: 'get_current_time', parametersJsonSchema: {} }]), {
		tools: [
			{
				type: 'function',
				function: {
					name: 'get_current_time',
					parameters: {},
				},
			},
		],
	});
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gemma4E2bToolCallReader
//
//	Every answer text asserted against here is the raw text `onnx-community/gemma-4-E2B-it-ONNX` at
//	`q4f16` on WebGPU really generated, captured from the live milestone 0 de-risk gate run for
//	[issue #216](https://github.com/webai-at-home/webai-at-home/issues/216), decoded with
//	`skip_special_tokens: false`. The two shapes written by hand say so where they are written, and
//	they are written only because both tools of that gate take one string and so no captured answer
//	carries a value of any other type.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The raw text the model wrote when it was asked about the weather, captured from the live gate run. */
const capturedGemmaWeatherCall = '<|tool_call>call:get_current_weather{city:<|"|>Paris<|"|>}<tool_call|><|tool_response>';

/** The raw text the model wrote when it was asked about the time, captured from the live gate run. */
const capturedGemmaTimeCall = '<|tool_call>call:get_current_time{city:<|"|>Paris<|"|>}<tool_call|><|tool_response>';

Test('reads the tool call Gemma 4 E2B really wrote, with its name and its arguments', () => {
	Assert.deepEqual(Gemma4E2bToolCallReader.read(capturedGemmaWeatherCall, declaredTools), [
		{
			name: 'get_current_weather',
			argumentValues: {
				city: 'Paris',
			},
		},
	]);
	Assert.deepEqual(Gemma4E2bToolCallReader.read(capturedGemmaTimeCall, declaredTools), [
		{
			name: 'get_current_time',
			argumentValues: {
				city: 'Paris',
			},
		},
	]);
});

Test('the <|tool_response> the model writes after a call is not read as a second tool call', () => {
	// It opens with the same five characters as the opening marker, and this export's own
	// generation_config.json names it an end-of-sequence token, so it ends every tool call this
	// reader will ever be given.
	Assert.equal(Gemma4E2bToolCallReader.read(capturedGemmaWeatherCall, declaredTools).length, 1);
});

Test('reports no tool call for the answers Gemma 4 E2B really wrote in words', () => {
	// Both captured from the live gate run. The trailing <turn|> is the end-of-turn marker, which
	// arrives because this stage has to decode with skip_special_tokens: false to see a tool call at
	// all, and which must not be mistaken for the opening of one.
	Assert.deepEqual(Gemma4E2bToolCallReader.read('hello<turn|>', declaredTools), []);
	Assert.deepEqual(
		Gemma4E2bToolCallReader.read('The current weather in Paris is 31 degrees Celsius and clear skies.<turn|>', declaredTools),
		[],
	);
});

Test('every argument value is text, even though this format does say which type the model meant', () => {
	// Written by hand: both tools of the gate take one string, so no captured answer carries a number,
	// a boolean, or a nested value. The shape is the one the chat template renders, read off the
	// pinned revision's own chat_template.jinja.
	const call = '<|tool_call>call:get_current_weather{city:<|"|>Paris<|"|>,days:7,brief:true,at:{hour:9},tags:[<|"|>a<|"|>,2]}<tool_call|>';
	// Text, not the number 7 and not the boolean true. That is the shape ToolCall.argumentValues
	// defines, and the consumer that reads the tool's arguments schema converts each value back.
	Assert.deepEqual(Gemma4E2bToolCallReader.read(call, declaredTools)[0]?.argumentValues, {
		city: 'Paris',
		days: '7',
		brief: 'true',
		at: '{"hour":9}',
		tags: '["a",2]',
	});
});

Test('a string value keeps the commas and braces written inside it', () => {
	// Written by hand, for the same reason as the test above. The string markers are what say where
	// a value ends, so a comma inside one must not end it.
	const call = '<|tool_call>call:get_current_weather{city:<|"|>Paris, France}<|"|>}<tool_call|>';
	Assert.deepEqual(Gemma4E2bToolCallReader.read(call, declaredTools)[0]?.argumentValues, {
		city: 'Paris, France}',
	});
});

Test('refuses a Gemma 4 E2B tool call it could not read, rather than dropping it or passing it on half-formed', () => {
	// The reason this is a failure and not an empty result: a calling program runs whatever tool call
	// it receives, so a call read wrongly is a call run wrongly on the caller's own machine.
	Assert.throws(() => Gemma4E2bToolCallReader.read('<|tool_call>get_current_weather(city=Paris)<tool_call|>', declaredTools), /could not read/);
	Assert.throws(() => Gemma4E2bToolCallReader.read('<|tool_call>call:{city:<|"|>Paris<|"|>}<tool_call|>', declaredTools), /no name/);
	Assert.throws(() => Gemma4E2bToolCallReader.read('<|tool_call>call:get_current_weather{:<|"|>Paris<|"|>}<tool_call|>', declaredTools), /no name/);
	// A model that invented a tool is reported, not believed. Running a tool nobody declared is the
	// worst of the ways this could fail.
	Assert.throws(
		() => Gemma4E2bToolCallReader.read('<|tool_call>call:delete_everything{}<tool_call|>', declaredTools),
		/never declared/,
	);
});

Test('reads a Gemma 4 E2B tool call the model left unfinished as far as it got, rather than silently missing it', () => {
	// This is what a generation cut short by the token cap leaves behind. It must not read as "the
	// model answered in words", which is what a reader demanding the closing marker would report.
	Assert.deepEqual(Gemma4E2bToolCallReader.read('<|tool_call>call:get_current_weather{city:<|"|>Par', declaredTools), [
		{
			name: 'get_current_weather',
			argumentValues: {
				city: 'Par',
			},
		},
	]);
	// Cut off before the arguments were opened. The name is still worth more to a caller than nothing.
	Assert.deepEqual(Gemma4E2bToolCallReader.read('<|tool_call>call:get_current_weather', declaredTools), [
		{
			name: 'get_current_weather',
			argumentValues: {},
		},
	]);
});

Test('says when Gemma 4 E2B has started a tool call, so a run does not report the opening of one as an answer', () => {
	Assert.equal(Gemma4E2bToolCallReader.hasStartedAToolCall(capturedGemmaWeatherCall), true);
	Assert.equal(Gemma4E2bToolCallReader.hasStartedAToolCall('hello<turn|>'), false);
	// Reached one piece at a time, the way the streaming callback really sees it: false every time
	// until the opening marker arrives, and true from then on.
	let writtenSoFar = '';
	const sawStarted: boolean[] = [];
	for (const piece of ['', '<|tool_call>', 'call:get_current_weather{', 'city:<|"|>Paris<|"|>}', '<tool_call|>']) {
		writtenSoFar += piece;
		sawStarted.push(Gemma4E2bToolCallReader.hasStartedAToolCall(writtenSoFar));
	}
	Assert.deepEqual(sawStarted, [false, true, true, true, true]);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gemma4E2bHistoryMessages
//
//	The identifiers minted here are not decoration. Gemma 4 E2B's chat template names a tool result
//	by matching the result's `tool_call_id` against a call's `id`, and this project's protocol
//	carries no identifier at all. Handing the template neither was measured against the real template
//	in milestone 3 of [issue #216](https://github.com/webai-at-home/webai-at-home/issues/216): with
//	one call it happens to work, and with two calls it names every result after the last call,
//	silently. That is what these tests exist to stop coming back.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('a prompt becomes one user message', () => {
	Assert.deepEqual(Gemma4E2bHistoryMessages.of('What is the weather?'), [
		{ role: 'user', content: 'What is the weather?' },
	]);
});

Test('a history with no tool call is passed through unchanged', () => {
	Assert.deepEqual(
		Gemma4E2bHistoryMessages.of({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }] }),
		[{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }],
	);
});

Test('each tool result is given the identifier of the call it answers, paired by position', () => {
	// Two calls is the case that fails without identifiers: the template names both results after the
	// last call. The order of the messages is what says which call a result answers, so that is what
	// the pairing reads.
	const messages = Gemma4E2bHistoryMessages.of({
		messages: [
			{ role: 'user', content: 'Weather and time in Paris?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{ name: 'get_current_weather', argumentValues: { city: 'Paris' } },
					{ name: 'get_current_time', argumentValues: { city: 'Paris' } },
				],
			},
			{ role: 'tool', content: '{"celsius":31}' },
			{ role: 'tool', content: '{"hour":9}' },
		],
	});
	Assert.deepEqual(messages, [
		{ role: 'user', content: 'Weather and time in Paris?' },
		{
			role: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'call_1_0', type: 'function', function: { name: 'get_current_weather', arguments: { city: 'Paris' } } },
				{ id: 'call_1_1', type: 'function', function: { name: 'get_current_time', arguments: { city: 'Paris' } } },
			],
		},
		{ role: 'tool', content: '{"celsius":31}', tool_call_id: 'call_1_0' },
		{ role: 'tool', content: '{"hour":9}', tool_call_id: 'call_1_1' },
	]);
});

Test('the pairing stops at the first message that is not a tool result, as the template scan does', () => {
	// A tool result that does not follow a call is not rendered by this template at all, so giving it
	// the identifier of an older call would pair it with a call it does not answer.
	const messages = Gemma4E2bHistoryMessages.of({
		messages: [
			{ role: 'user', content: 'Weather in Paris?' },
			{ role: 'assistant', content: '', toolCalls: [{ name: 'get_current_weather', argumentValues: { city: 'Paris' } }] },
			{ role: 'tool', content: '{"celsius":31}' },
			{ role: 'assistant', content: 'It is 31 degrees Celsius.' },
			{ role: 'tool', content: 'stray' },
		],
	});
	Assert.equal((messages[2] as unknown as { tool_call_id?: string }).tool_call_id, 'call_1_0');
	Assert.equal((messages[4] as unknown as { tool_call_id?: string }).tool_call_id, undefined);
});

Test('a second assistant message asking for tools mints identifiers of its own', () => {
	// Identifiers have to be unique across the whole history, not within one message, or a later
	// result would match an earlier call.
	const messages = Gemma4E2bHistoryMessages.of({
		messages: [
			{ role: 'user', content: 'Weather in Paris?' },
			{ role: 'assistant', content: '', toolCalls: [{ name: 'get_current_weather', argumentValues: { city: 'Paris' } }] },
			{ role: 'tool', content: '{"celsius":31}' },
			{ role: 'user', content: 'And in Lyon?' },
			{ role: 'assistant', content: '', toolCalls: [{ name: 'get_current_weather', argumentValues: { city: 'Lyon' } }] },
			{ role: 'tool', content: '{"celsius":29}' },
		],
	});
	Assert.equal((messages[2] as unknown as { tool_call_id?: string }).tool_call_id, 'call_1_0');
	Assert.equal((messages[5] as unknown as { tool_call_id?: string }).tool_call_id, 'call_4_0');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageCatalog, for the Gemma 4 E2B stage
//
//	`worker_stage_offer.ts` is what puts this stage into its own full-model list, and it is not
//	asserted here: importing it pulls in `stage_helper_llm_qwen3_0_6b_sharded.ts`, which reads
//	`import.meta.env.BASE_URL` at module scope and so needs Vite rather than plain Node. That list
//	being separate from the other two is checked by running the worker page instead. Do not merge
//	the three full-model lists: a tab offering one of the other two would then be made to download
//	Gemma 4 E2B's roughly 3111 MB, several times either of theirs.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('the settings panel lists the Gemma 4 E2B stage, so a volunteer can choose it', () => {
	const entry = StageCatalog.entries.find((one) => one.name === 'stage_llm_gemma_4_e2b_full');

	Assert.notEqual(entry, undefined);
	Assert.ok(entry?.description.includes('WebGPU'));
});

Test('the settings panel says how large the Gemma 4 E2B download is, which no other stage needs to', () => {
	const entry = StageCatalog.entries.find((one) => one.name === 'stage_llm_gemma_4_e2b_full');

	Assert.ok(entry?.description.includes('3111 MB'));
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponseConstraintBuilder and SampledTokenForwarder
//
//	Milestone 3 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221). What a
//	constrained run really writes was measured live against Gemma 4 E2B in milestone 0 of the same
//	issue, and is recorded in
//	`packages/_onnx_experiments/public/gemma4-e2b-response-constraint-measurement/README.md`. No
//	model is loaded here: what is asserted below is the two decisions this page makes around the
//	package, both of which would otherwise only show up in a volunteer's browser tab after a model
//	download of about 3111 megabytes.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The smallest tokenizer the response constraint accepts, in the direct form it takes when `tokens`
 * is already an array of byte arrays.
 *
 * Four one-byte tokens are enough to build a constraint, and building one is all these tests do.
 */
const smallestTokenizer = {
	tokens: [
		Uint8Array.of(0x7b),
		Uint8Array.of(0x7d),
		Uint8Array.of(0x22),
		Uint8Array.of(0x61),
	],
	eosTokenId: 0,
};

/** A logits processor that changes nothing, to stand in for one of the package's own. */
class NoOpLogitsProcessor extends LogitsProcessor {
	/**
	 * @param _inputIds Every token of every sequence, unread.
	 * @param logits The logits of this step, passed straight back.
	 * @returns The same logits, untouched.
	 */
	_call(_inputIds: bigint[][], logits: Tensor): Tensor {
		return logits;
	}
}

/** A stopping criterion that stops nothing, to stand in for the package's own. */
class NoOpStoppingCriteria extends StoppingCriteria {
	/**
	 * @param inputIds Every token of every sequence, read only for how many sequences there are.
	 * @returns `false` for every sequence.
	 */
	_call(inputIds: number[][]): boolean[] {
		return inputIds.map(() => false);
	}
}

Test('a json_schema is constrained with fixed whitespace, and the schema a consumer sent is not changed', () => {
	// All three of the package's `x-guidance` options, and the three belong together. Milestone 0
	// measured five of seven ordinary schemas running to the token limit writing whitespace with the
	// grammar's flexible whitespace left on, because greedy decoding has a fixed point there. The
	// first live run of milestone 3 measured what closing it costs on its own — `{"city": ", "}`,
	// which satisfies its schema and says nothing — and what the two separators give back:
	// `{"city": "Paris"}` in 8 tokens.
	const jsonSchema = {
		type: 'object',
		properties: {
			city: {
				type: 'string',
			},
		},
		required: ['city'],
		additionalProperties: false,
	};
	Assert.deepEqual(ResponseConstraintBuilder.packageFormatOf({ type: 'json_schema', jsonSchema }), {
		type: 'json_schema',
		json_schema: {
			...jsonSchema,
			'x-guidance': {
				whitespace_flexible: false,
				key_separator: ': ',
				item_separator: ', ',
			},
		},
	});
	// The schema the consumer sent is left as it was, because it is carried on the task and read
	// again by every run that carries the answer on.
	Assert.equal('x-guidance' in jsonSchema, false);
});

Test('a json_object is passed on as it stands, and never as the json_schema of an object', () => {
	// The other half of the same decision, and it goes the other way. `json_object` cannot carry
	// `x-guidance` at all, and rewriting it as the `json_schema` of `{"type":"object"}` to reach the
	// control was measured to cost the answer itself: asked for any object, the model wrote a whole
	// weather object in 131 tokens, and the same question under `{"type":"object"}` with the control
	// on wrote `{"weather":{}}` in 6.
	Assert.deepEqual(ResponseConstraintBuilder.packageFormatOf({ type: 'json_object' }), {
		type: 'json_object',
	});
});

Test('an x-guidance a consumer somehow sent is overwritten, never respected', () => {
	// The keyword belongs to no JSON Schema draft and to no OpenAI interface, so nothing sent through
	// this project's interfaces carries it on purpose. Whether a run of this stage finishes at all is
	// this stage's to decide.
	Assert.deepEqual(ResponseConstraintBuilder.packageFormatOf({
		type: 'json_schema',
		jsonSchema: {
			'x-guidance': {
				whitespace_flexible: true,
			},
			type: 'object',
		},
	}), {
		type: 'json_schema',
		json_schema: {
			type: 'object',
			'x-guidance': {
				whitespace_flexible: false,
				key_separator: ': ',
				item_separator: ', ',
			},
		},
	});
});

Test('a built constraint carries the forwarder before the package own processor, in both halves', () => {
	const constraint = ResponseConstraintBuilder.build(smallestTokenizer, { type: 'json_object' });
	Assert.equal(constraint.logitsProcessor.processors.length, 2, 'the forwarder and the package own processor');
	Assert.equal(constraint.stoppingCriteria.criteria.length, 2, 'the forwarder criterion and the package own');
	// The second of each pair is the package's, so the first of each is this page's. Announcing the
	// sampled token before the package is asked anything is the whole point of the order.
	Assert.equal(typeof (constraint.logitsProcessor.processors[1] as unknown as { onTokensSampled?: unknown }).onTokensSampled, 'function');
});

Test('the installed @huggingface/transformers still does not call onTokensSampled itself', () => {
	// The reason `SampledTokenForwarder` exists at all. Pull request #1733 of `transformers.js` adds
	// `LogitsProcessorList.onTokensSampled` and calls it from the generation loop; the released 4.2.0
	// this project installs has neither. If this ever fails, the runtime has started making the calls
	// and `ResponseConstraintBuilder.build` stands the forwarder aside on its own — a grammar told
	// about the same token twice would consume it twice.
	Assert.equal(SampledTokenForwarder.isHookCalledByTheRuntime(), false);
});

Test('the forwarder announces every sampled token exactly once, and never announces the prompt', () => {
	const announced: number[][] = [];
	const forwarder = new SampledTokenForwarder({
		onTokensSampled: (tokenIds: number[]) => {
			announced.push(tokenIds);
		},
	});
	// The first look is the prompt, whatever length it has, and nothing in it was sampled.
	forwarder.announceNewTokens([[10n, 11n, 12n]]);
	Assert.deepEqual(announced, []);
	// One token appeared since the last look, so exactly that one is announced.
	forwarder.announceNewTokens([[10n, 11n, 12n, 20n]]);
	Assert.deepEqual(announced, [[20]]);
	// The same array again, from the second place the generation loop offers it: nothing is new, so
	// nothing is announced twice. This is what lets the forwarder read both the logits processor call
	// and the stopping criterion call of one step.
	forwarder.announceNewTokens([[10n, 11n, 12n, 20n]]);
	Assert.deepEqual(announced, [[20]]);
	// Two steps at once are announced in the order they were sampled.
	forwarder.announceNewTokens([[10n, 11n, 12n, 20n, 21n, 22n]]);
	Assert.deepEqual(announced, [[20], [21], [22]]);
});

Test('the forwarder refuses a constraint whose shape it was not written for', () => {
	// It reaches into the package's list by position, so a package that returned two processors would
	// leave it announcing to the wrong one. That is a silently unconstrained run, which is the one
	// failure this whole file exists to prevent, so it is refused loudly instead.
	const logitsProcessor = new LogitsProcessorList();
	logitsProcessor.push(new NoOpLogitsProcessor());
	logitsProcessor.push(new NoOpLogitsProcessor());
	Assert.throws(
		() => SampledTokenForwarder.around({
			logits_processor: logitsProcessor,
			stopping_criteria: new NoOpStoppingCriteria(),
		}),
		/returned 2 logits processors/,
	);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	EmptyAnswerRefusal
//
//	[issue #225](https://github.com/webai-at-home/webai-at-home/issues/225). Every stage helper of
//	this page reported an empty answer as a finished one whatever ended it, so a model that ran its
//	whole budget without writing a word reached the consumer as a model with nothing to say. The one
//	stage where that really happens is Gemma 4 E2B: `ThoughtChannelCut` drops everything after a
//	thought channel opened and never closed, so a model still thinking when its budget ran out
//	leaves no answer behind at all. No model is loaded here — the rule is the whole of what is
//	asserted, which is why it lives in a module of its own rather than in four stage helpers.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('refuses an answer holding no text that ran out of room, and says how many tokens went nowhere', () => {
	Assert.throws(
		() => EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'max_new_tokens', 1024, false),
		/all 1024 tokens it was allowed/,
	);
});

Test('says what to ask for instead when the run let the model think, since thinking is what produces this', () => {
	Assert.throws(
		() => EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'max_new_tokens', 1024, true),
		/reasoningEffort of "none"/,
	);
});

Test('names no reasoning effort when the run did not let the model think, rather than sending a consumer to the wrong setting', () => {
	// `stage_helper_llm_llama3_2_1b_full.ts` and `stage_helper_llm_qwen3_0_6b_sharded.ts` run models
	// that cannot think at all, and their task types offer no `reasoningEffort` to change.
	Assert.throws(
		() => EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'max_new_tokens', 160, false),
		(error: unknown) => {
			Assert.match((error as Error).message, /all 160 tokens it was allowed/);
			Assert.equal((error as Error).message.includes('reasoningEffort'), false);
			return true;
		},
	);
});

Test('says every token it was allowed when the stage counted none, rather than naming a number nobody reported', () => {
	Assert.throws(
		() => EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'max_new_tokens', undefined, false),
		/every token it was allowed/,
	);
});

Test('still reports an empty answer the model ended of its own accord, which says something an interrupted one does not', () => {
	// The [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) decision, which
	// this rule must not undo: a model that stopped writing because it had finished, having written
	// nothing, has said what it had to say.
	EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'end_of_sequence', 0, true);
});

Test('still reports an empty answer that ended on a stop sequence or was interrupted, both being what a caller asked for', () => {
	EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'stop_sequence', 4, true);
	EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('', 'interrupted', 4, true);
});

Test('still reports an answer that ran out of room after writing something, since that answer is real as far as it goes', () => {
	// A `maximumOutputTokenCount` of 1 ends a perfectly good answer at its limit. Only an answer
	// that never began is refused.
	EmptyAnswerRefusal.refuseAnswerThatRanOutBeforeItBegan('In', 'max_new_tokens', 1, true);
});

/**
 * A tokenizer that decodes one identifier at a time, standing in for the real one so that
 * {@link ThoughtChannelCut} can be read without loading a model.
 *
 * Identifier 1 is the channel opener and identifier 2 is the channel closer, spelled exactly as
 * Gemma 4 E2B's tokenizer configuration spells them. Every other identifier decodes to a word.
 *
 * @param wordByTokenId The word each ordinary identifier stands for.
 * @returns Something with the one `decode` method {@link ThoughtChannelCut} calls.
 */
const fakeChannelTokenizer = (wordByTokenId: Record<number, string>): Parameters<typeof ThoughtChannelCut.outsideEveryChannel>[0] => ({
	decode: (tokenIds: number[]): string => {
		const [tokenId] = tokenIds;
		if (tokenId === 1) {
			return '<|channel>';
		}
		if (tokenId === 2) {
			return '<channel|>';
		}
		return wordByTokenId[tokenId as number] ?? '';
	},
} as unknown as Parameters<typeof ThoughtChannelCut.outsideEveryChannel>[0]);

Test('a thought channel opened and never closed leaves no answer at all, which is what makes the refusal above necessary', () => {
	// This is the whole of [issue #225](https://github.com/webai-at-home/webai-at-home/issues/225)
	// on Gemma 4 E2B: the model was still thinking when its budget ran out, so every token it
	// generated is inside a channel that never closed, and nothing survives the cut. Reported as an
	// answer, that is a model with nothing to say; refused, it is a stage the gateway can run again.
	const tokenizer = fakeChannelTokenizer({ 10: 'Thinking', 11: ' about', 12: ' it' });
	Assert.deepEqual(ThoughtChannelCut.outsideEveryChannel(tokenizer, [1, 10, 11, 12]), []);
});

Test('a thought channel that closed leaves the answer written after it, which is the usual case', () => {
	const tokenizer = fakeChannelTokenizer({ 10: 'Thinking', 20: 'Paris' });
	Assert.deepEqual(ThoughtChannelCut.outsideEveryChannel(tokenizer, [1, 10, 2, 20]), [20]);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ThinkingBlockCut
//
//	[issue #226](https://github.com/webai-at-home/webai-at-home/issues/226). Asked for a
//	`reasoningEffort` above `none`, `stage_helper_llm_qwen3_5_0_8b_full.ts` sent the model's own
//	thinking to the consumer as the answer, where the native worker of the same task type sent the
//	answer alone. Everything asserted here is read against
//	`packages/_onnx_experiments/public/qwen3_5-thinking-cut-measurement/`, which generated the text
//	below live on WebGPU at the pinned revision, decoded the way the stage helper decodes what it
//	serves. No model is loaded here.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Exactly what the model wrote when asked `What is the capital of France?` with thinking on, in 218 tokens,
 * decoded with `skip_special_tokens: true`. One line per line of the answer, so that the closing marker and the
 * two newlines after it can be read here rather than counted out of an escaped string.
 */
const RECORDED_ANSWER_WITH_THINKING = [
	'Thinking Process:',
	'',
	'1.  **Identify the core question:** The user is asking "What is the capital of France?"',
	'2.  **Retrieve knowledge:** Access knowledge about the capital of France.',
	'3.  **Verify the answer:** The capital of France is Paris.',
	'4.  **Formulate the response:** State the answer clearly and concisely.',
	'5.  **Check for any potential nuances:** Is there any ambiguity? No, Paris is the capital.',
	'6.  **Final Output:** "The capital of France is Paris."',
	'',
	'Wait, I need to check if there are any specific formatting requirements or if I should just answer '
		+ 'directly. The user just asked a simple question. I should answer directly.',
	'',
	'Plan:',
	'- State the capital clearly.',
	'- Keep it short and direct.',
	'',
	'Draft: The capital of France is Paris.',
	'',
	'Refinement: Ensure it\'s accurate. Yes, Paris is the capital.',
	'',
	'Final Answer: The capital of France is Paris.',
	'</think>',
	'',
	'The capital of France is **Paris**.',
].join('\n');

/** The answer alone, which is what a consumer must receive out of {@link RECORDED_ANSWER_WITH_THINKING}. */
const RECORDED_ANSWER_ALONE = 'The capital of France is **Paris**.';

/**
 * Feeds one text through a cut in the pieces named, the way the generation stream feeds it chunk by chunk.
 *
 * @param isThinkingEnabled Whether the run being stood in for let the model think.
 * @param chunks The pieces the model wrote, in order.
 * @returns Everything the cut forwarded, joined, which is the answer the consumer receives.
 */
const answerAfterCutting = (isThinkingEnabled: boolean, chunks: readonly string[]): string => {
	const thinkingBlockCut = new ThinkingBlockCut(isThinkingEnabled);
	return chunks.map((chunk) => thinkingBlockCut.accept(chunk)).join('');
};

Test('cuts the thinking out of the answer the model really wrote, leaving the answer alone', () => {
	Assert.equal(answerAfterCutting(true, [RECORDED_ANSWER_WITH_THINKING]), RECORDED_ANSWER_ALONE);
});

Test('cuts the same thinking out when the answer arrives in the pieces the model wrote it in', () => {
	// The measurement recorded the closing marker arriving as one whole piece, `"</think>\n\n"`, with the first
	// word of the answer in the piece after it. A consumer asking for pieces must receive what a consumer asking
	// for the whole answer receives, so both ways of arriving are read here.
	const [thinking] = RECORDED_ANSWER_WITH_THINKING.split('\n</think>\n\n');
	Assert.equal(
		answerAfterCutting(true, [thinking as string, '</think>\n\n', 'The capital of France is ', '**Paris**.']),
		RECORDED_ANSWER_ALONE,
	);
});

Test('forwards nothing at all while the model is still thinking, since a forwarded piece cannot be recalled', () => {
	const thinkingBlockCut = new ThinkingBlockCut(true);
	Assert.equal(thinkingBlockCut.accept('Thinking Process:\n\n1.  **Identify the core question:**'), '');
	Assert.equal(thinkingBlockCut.accept(' The user is asking about France.'), '');
	Assert.equal(thinkingBlockCut.hasBegunTheAnswer, false);
});

Test('finds a closing marker split across two pieces, which no piece on its own holds', () => {
	Assert.equal(answerAfterCutting(true, ['Still thinking.\n</thi', 'nk>\n\nParis.']), 'Paris.');
});

Test('drops the newlines between the closing marker and the answer even when they arrive as their own piece', () => {
	// The chat template drops them too, in `content.split('</think>')[-1].lstrip('\n')`, so an answer that thought
	// begins on the same character as an answer that did not.
	Assert.equal(answerAfterCutting(true, ['Thinking.</think>', '\n\n', 'Paris.']), 'Paris.');
});

Test('leaves no answer behind when the model thought for its whole budget without ever closing', () => {
	// Phase 2 of the measurement: 2048 tokens in 82639 ms against the issue #192 multi-turn history, the cap
	// reached, and no closing marker anywhere. `EmptyAnswerRefusal` is what refuses the run this leaves behind.
	const thinkingBlockCut = new ThinkingBlockCut(true);
	Assert.equal(thinkingBlockCut.accept('Thinking Process:\n\n1.  **Analyze the Request:**'), '');
	Assert.equal(thinkingBlockCut.accept(' Wait, I need to check if I should output the number "42".'), '');
	Assert.equal(thinkingBlockCut.hasBegunTheAnswer, false);
});

Test('hands back every piece unchanged when the run asked for no thinking, cutting nothing out of it', () => {
	// Phase 3 of the measurement: with thinking off the template closes the thinking block in the prompt itself,
	// so the model writes no marker and every word it writes is its answer. A cut applied to that run would empty
	// every answer this model gives with thinking off.
	const recordedWithThinkingOff = 'The capital of France is **Paris**.\n\nLocated in the region of '
		+ 'Île-de-France, Paris is the largest city in France and serves as the country\'s political, cultural, '
		+ 'and economic center.';
	Assert.equal(answerAfterCutting(false, [recordedWithThinkingOff]), recordedWithThinkingOff);
	Assert.equal(new ThinkingBlockCut(false).hasBegunTheAnswer, true);
});

Test('still forwards a marker a model writes inside an answer it did not think for, since nothing was cut', () => {
	Assert.equal(answerAfterCutting(false, ['The tag is </think> in this template.']), 'The tag is </think> in this template.');
});
