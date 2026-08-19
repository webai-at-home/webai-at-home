// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// local imports
import { ToolCallReader } from '../web/src/stages/tool_call_reader.js';
import { ChatTemplateTools } from '../web/src/stages/chat_template_tools.js';
import { Gemma4E2bHistoryMessages } from '../web/src/stages/gemma_4_e2b_history_messages.js';
import { Gemma4E2bToolCallReader } from '../web/src/stages/gemma_4_e2b_tool_call_reader.js';
import { StageCatalog } from '../web/src/stages/stage_catalog.js';

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
