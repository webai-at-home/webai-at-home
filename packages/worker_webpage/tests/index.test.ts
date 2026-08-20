// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// local imports
import { ToolCallReader } from '../web/src/stages/tool_call_reader.js';
import { ChatTemplateTools } from '../web/src/stages/chat_template_tools.js';
import { Gemma4E2bHistoryMessages } from '../web/src/stages/gemma_4_e2b_history_messages.js';
import { Gemma4E2bToolCallReader } from '../web/src/stages/gemma_4_e2b_tool_call_reader.js';
import { StageCatalog } from '../web/src/stages/stage_catalog.js';
import { StageHelperLlmGemma4E2bFull } from '../web/src/stages/stage_helper_llm_gemma_4_e2b_full.js';
import { JsonGrammar } from '../web/src/stages/structured_output/json_grammar.js';
import { VocabularyTable } from '../web/src/stages/structured_output/vocabulary_table.js';
import { JsonGrammarMaskCache, type GrammarMask } from '../web/src/stages/structured_output/json_grammar_mask_cache.js';

// package imports
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import type { GenerationSettings, LlmStagePayload } from '@webai/protocol';

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
//	JsonGrammar
//
//	The reader that enforces `json_object`, from milestone 1 of
//	[issue #219](https://github.com/webai-at-home/webai-at-home/issues/219). It is the one part of
//	structured output that can be checked without a model at all, and it is the part that must not
//	be wrong: every entry of the vocabulary is judged by it at every step, so a reader that accepts
//	one illegal character makes the whole mask a decoration.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Reads a whole text from a fresh reader, and reports whether it was accepted and finished. */
function readWholeText(text: string): { isAccepted: boolean; isComplete: boolean } {
	const state = JsonGrammar.initialState(true);
	const isAccepted = JsonGrammar.acceptText(state, text);
	return {
		isAccepted: isAccepted,
		isComplete: isAccepted === true && JsonGrammar.isComplete(state),
	};
}

Test('accepts the JSON an object response format is meant to produce', () => {
	for (const text of [
		'{}',
		'{"a":1}',
		'{"a": 1, "b": [1,2,3]}',
		'{"a": {"b": {"c": null}}}',
		'{"a": true, "b": false, "c": null}',
		'{"a": -1.5e-10}',
		'{"a": "line\\nbreak \\u00e9"}',
		'{ "a" : [ ] }',
		'{"a":[{},{"b":[]}]}',
		'{"a":0}',
	]) {
		Assert.deepEqual(readWholeText(text), { isAccepted: true, isComplete: true }, text);
	}
});

Test('refuses text that is not a complete JSON object', () => {
	for (const text of [
		'[]',
		'1',
		'"hello"',
		'{"a":01}',
		'{"a":1,}',
		'{,}',
		'{"a"1}',
		'{"a":1',
		'{"a":+1}',
		'{"a":1.}',
		'{"a":1e}',
		'{"a":"un\tescaped"}',
		'{"a":.5}',
		'{"a":[1,]}',
		'{}x',
		'{"a":tru}',
	]) {
		const reading = readWholeText(text);
		Assert.equal(reading.isAccepted === true && reading.isComplete === true, false, text);
	}
});

Test('lets an answer start only with an object, because that is what json_object asks for', () => {
	const state = JsonGrammar.initialState(true);
	const legalFirstCharacters: string[] = [];
	for (let code = 32; code < 127; code = code + 1) {
		if (JsonGrammar.acceptsText(state, String.fromCharCode(code)) === true) {
			legalFirstCharacters.push(String.fromCharCode(code));
		}
	}

	Assert.equal(legalFirstCharacters.join(''), ' {');
});

Test('judges a token that closes two containers at once against the whole stack, not only its top', () => {
	// A vocabulary entry may carry several characters, so `}}` reaches two levels down. A reader that
	// looked only at the innermost container would accept `}}}` here and write one bracket too many.
	const state = JsonGrammar.initialState(true);
	JsonGrammar.acceptText(state, '{"a":{"b":1');

	Assert.equal(JsonGrammar.acceptsText(state, '}}'), true);
	Assert.equal(JsonGrammar.acceptsText(state, '}}}'), false);
});

Test('reports a value as unfinished until its last bracket is written', () => {
	const state = JsonGrammar.initialState(true);
	JsonGrammar.acceptText(state, '{"a":{"b":1}');

	Assert.equal(JsonGrammar.isComplete(state), false);
	Assert.equal(JsonGrammar.acceptText(state, '}'), true);
	Assert.equal(JsonGrammar.isComplete(state), true);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VocabularyTable and JsonGrammarMaskCache
//
//	Checked against a vocabulary written out by hand rather than a loaded model, so that every
//	entry's expected verdict can be read off the page. The shapes it is fed are the shapes
//	`@huggingface/transformers` 4.2.0 really produces, including the `Map` its `get_vocab()` returns
//	where its own type declaration says a plain record — the trap that made the first live run of
//	the milestone 0 gate mask nothing at all.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The text each entry of the hand-written vocabulary writes, indexed by token identifier. */
const vocabularyTexts = ['<eos>', '<turn|>', '', '{', '}', '"', 'a', '":', '{"', '1'];

/** The identifiers of the hand-written vocabulary that end a sequence. */
const endOfSequenceTokenIds = [0, 1];

/**
 * A stand-in for a loaded tokenizer, answering the three questions `VocabularyTable` asks it.
 *
 * @param texts The text each entry writes.
 * @param specialIdentifiers The identifiers the tokenizer marks as special.
 * @returns Something shaped like the part of a tokenizer that is read.
 */
function tokenizerOver(texts: readonly string[], specialIdentifiers: readonly number[]): PreTrainedTokenizer {
	const vocabulary = new Map<string, number>();
	for (let identifier = 0; identifier < texts.length; identifier = identifier + 1) {
		vocabulary.set(`entry_${identifier}`, identifier);
	}
	const addedTokensDecoder = new Map<number, { content: string; special: boolean }>();
	for (const identifier of specialIdentifiers) {
		addedTokensDecoder.set(identifier, { content: texts[identifier], special: true });
	}
	return {
		get_vocab: () => vocabulary,
		decode: (tokenIds: number[]) => tokenIds.map((tokenId) => texts[tokenId]).join(''),
		_tokenizer: {
			get_added_tokens_decoder: () => addedTokensDecoder,
		},
	} as unknown as PreTrainedTokenizer;
}

/**
 * The identifiers one mask leaves legal, whichever of the two forms the mask took.
 *
 * @param mask The mask to read.
 * @param size How many entries the vocabulary has.
 * @returns The legal identifiers, in ascending order.
 */
function legalIdentifiersOf(mask: GrammarMask, size: number): number[] {
	if (mask.namesTheEntriesToKeep === true) {
		return [...mask.tokenIds];
	}
	const removed = new Set(mask.tokenIds);
	const legalIdentifiers: number[] = [];
	for (let identifier = 0; identifier < size; identifier = identifier + 1) {
		if (removed.has(identifier) === false) {
			legalIdentifiers.push(identifier);
		}
	}
	return legalIdentifiers;
}

/** A mask cache over the hand-written vocabulary. */
function maskCacheOverTheHandWrittenVocabulary(): JsonGrammarMaskCache {
	const vocabularyTable = VocabularyTable.build(tokenizerOver(vocabularyTexts, endOfSequenceTokenIds));
	return new JsonGrammarMaskCache(vocabularyTable, endOfSequenceTokenIds);
}

Test('reads a vocabulary handed back as a Map, which is what the tokenizer really returns', () => {
	const vocabularyTable = VocabularyTable.build(tokenizerOver(vocabularyTexts, endOfSequenceTokenIds));

	Assert.equal(vocabularyTable.size, vocabularyTexts.length);
	Assert.equal(vocabularyTable.textOf(3), '{');
});

Test('sorts every entry into the text a grammar can judge, a marker, or something unusable', () => {
	const vocabularyTable = VocabularyTable.build(tokenizerOver(vocabularyTexts, endOfSequenceTokenIds));

	Assert.equal(vocabularyTable.kindOf(0), 'special');
	Assert.equal(vocabularyTable.kindOf(1), 'special');
	Assert.equal(vocabularyTable.kindOf(2), 'unusable');
	Assert.equal(vocabularyTable.kindOf(3), 'text');
	Assert.deepEqual(vocabularyTable.countByKind, { text: 7, special: 2, unusable: 1 });
});

Test('leaves legal, at the start, only the entries that can open an object', () => {
	const maskCache = maskCacheOverTheHandWrittenVocabulary();
	const state = JsonGrammar.initialState(true);

	// `{` and `{"`, and neither the two markers nor the entry that writes nothing.
	Assert.deepEqual(legalIdentifiersOf(maskCache.maskFor(state), vocabularyTexts.length), [3, 8]);
});

Test('leaves legal, after an opening brace, only a key or the closing brace', () => {
	const maskCache = maskCacheOverTheHandWrittenVocabulary();
	const state = JsonGrammar.initialState(true);
	JsonGrammar.acceptText(state, '{');

	// `}`, `"`, and `":`, whose colon is an ordinary character inside the key it opens.
	Assert.deepEqual(legalIdentifiersOf(maskCache.maskFor(state), vocabularyTexts.length), [4, 5, 7]);
});

Test('leaves legal, once the value is finished, nothing but the end of the turn', () => {
	const maskCache = maskCacheOverTheHandWrittenVocabulary();
	const state = JsonGrammar.initialState(true);
	JsonGrammar.acceptText(state, '{}');

	// Not even whitespace, which JSON would allow: a model free to write spaces until its budget runs
	// out would stop on the budget rather than on the answer.
	Assert.deepEqual(legalIdentifiersOf(maskCache.maskFor(state), vocabularyTexts.length), endOfSequenceTokenIds);
});

Test('names the entries to remove when most of the vocabulary is legal, and the entries to keep when few are', () => {
	// This is the whole of what milestone 0 measured: applying a mask costs one write per entry it
	// names, so a mask that named its 261040 legal entries cost 47 milliseconds where one naming its
	// few illegal entries costs nothing. Inside a string almost everything is legal.
	const maskCache = maskCacheOverTheHandWrittenVocabulary();
	const atTheStart = JsonGrammar.initialState(true);
	const insideAKey = JsonGrammar.initialState(true);
	JsonGrammar.acceptText(insideAKey, '{"');

	Assert.equal(maskCache.maskFor(atTheStart).namesTheEntriesToKeep, true);
	Assert.equal(maskCache.maskFor(insideAKey).namesTheEntriesToKeep, false);
	Assert.deepEqual(maskCache.maskFor(insideAKey).tokenIds, [0, 1, 2]);
});

Test('leaves the model its own scores among the entries it keeps, whichever form the mask took', () => {
	const maskCache = maskCacheOverTheHandWrittenVocabulary();
	const atTheStart = JsonGrammar.initialState(true);
	const insideAKey = JsonGrammar.initialState(true);
	JsonGrammar.acceptText(insideAKey, '{"');
	const originalScores = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((identifier) => identifier / 10);
	// Rounded before it is compared, because a `Float32Array` cannot hold 0.3 and keeps
	// 0.30000001192092896 instead. What is being checked is which entries survived, not the precision
	// of a score the mask never touched.
	const survivorsOf = (scores: Float32Array) => [...scores].map(
		(score) => (score === Number.NEGATIVE_INFINITY ? 'masked' : Number(score.toFixed(3))),
	);

	const namingWhatToKeep = Float32Array.from(originalScores);
	maskCache.apply(maskCache.maskFor(atTheStart), namingWhatToKeep);
	Assert.deepEqual(survivorsOf(namingWhatToKeep), [
		'masked', 'masked', 'masked', 0.3, 'masked', 'masked', 'masked', 'masked', 0.8, 'masked',
	]);

	const namingWhatToRemove = Float32Array.from(originalScores);
	maskCache.apply(maskCache.maskFor(insideAKey), namingWhatToRemove);
	Assert.deepEqual(survivorsOf(namingWhatToRemove), [
		'masked', 'masked', 'masked', 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
	]);
});

Test('works a mask out once per grammar state, however many steps reach that state', () => {
	// 8 distinct states carried the 36 steps of the answer milestone 0 measured, so this is what keeps
	// the vocabulary scan off all but a few steps — and, shared across tasks, off all but the first
	// answer a loaded model produces.
	const maskCache = maskCacheOverTheHandWrittenVocabulary();
	const state = JsonGrammar.initialState(true);
	maskCache.maskFor(state);
	maskCache.maskFor(JsonGrammar.copy(state));
	maskCache.maskFor(JsonGrammar.copy(state));

	Assert.equal(maskCache.workedOutMaskCount, 1);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmGemma4E2bFull, the response format it produces
//
//	Milestone 3 of [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) made this
//	stage produce a `json_object`. Producing one needs the model, so what is asserted here is the
//	half that does not: the two requests this stage refuses rather than answering by ignoring what
//	was asked for. Both are refused before the model is reached, which is why they can be asserted
//	at all — a run that would really generate would download about 3111 megabytes.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The tool declaration used to ask this stage for a shape and a tool call at the same time. */
const oneDeclaredTool = [
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
];

/**
 * Runs one stage computation and reports how it refused, rather than what it produced.
 *
 * @param payload The stage payload a task would submit.
 * @param generationSettings What the consumer asked for.
 * @returns The message the stage refused with, or a note saying it did not refuse.
 */
async function refusalOf(payload: LlmStagePayload, generationSettings: GenerationSettings): Promise<string> {
	try {
		await StageHelperLlmGemma4E2bFull.compute('task-1', 'assignment-1', payload, generationSettings);
		return '(the stage did not refuse)';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

Test('refuses a request for json_schema rather than answering it with whatever object the model writes', async () => {
	// This stage enforces well-formed JSON and not a schema. Answering a schema request with an
	// object whose keys are the model's own guess, and reporting it as though the schema had been
	// kept, is the exact failure `structured_output_support.ts` exists to prevent.
	const refusal = await refusalOf({ text: 'Reply with a greeting object.' }, { responseFormat: 'json_schema' });

	Assert.match(refusal, /json_object and not json_schema/);
});

Test('refuses to produce a shape and call a tool at once, because a masked answer can hold no tool call', async () => {
	// Every marker a tool call is written with is a special token of this tokenizer, measured live by
	// milestone 0 of issue #216, and the mask leaves no special token legal until the object is
	// finished. So the two asked for together are two things that cannot both be given.
	const refusal = await refusalOf(
		{ history: { messages: [{ role: 'user', content: 'What is the weather in Paris?' }], tools: oneDeclaredTool } },
		{ responseFormat: 'json_object' },
	);

	Assert.match(refusal, /cannot both produce a response format of json_object and call a tool/);
});

Test('refuses neither of those for a task that asked for no shape, so nothing about such a task changes', async () => {
	// The refusal is reached before the model is, so a task that asked for no shape gets past it and
	// fails for the ordinary reason instead: it has nothing to answer.
	const refusal = await refusalOf({ text: '' }, {});

	Assert.equal(refusal, 'A prompt is needed to start an answer.');
});
