// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// local imports
import { ToolCallReader } from '../web/src/stages/tool_call_reader.js';

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
	// result already in the conversation.
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
	Assert.deepEqual(ToolCallReader.toChatTemplateTools([{ name: 'get_current_time', description: 'Reports the time.', parametersJsonSchema: { type: 'object' } }]), [
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
	Assert.deepEqual(ToolCallReader.toChatTemplateTools([{ name: 'get_current_time', parametersJsonSchema: {} }]), [
		{
			type: 'function',
			function: {
				name: 'get_current_time',
				parameters: {},
			},
		},
	]);
});
