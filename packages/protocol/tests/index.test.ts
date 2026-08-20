import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Test from 'node:test';
import {
	AccountAuthentication,
	AccountIdentity,
	AccountProfileSchema,
	ClientEnvelopeSchema,
	ClientMessageSchema,
	HistoryInputSchema,
	DiagnosticsBatchSchema,
	GeneratedText,
	GenerationControlSupport,
	GenerationSettingsSchema,
	PipelineSpecificationSchema,
	PipelineStageSchema,
	StageName,
	StagePayloadFactory,
	StagePayloadSchema,
	StructuredOutputSupport,
	TaskInput,
	ToolCallSchema,
	TaskState,
	maximumDiagnosticEntriesPerBatch,
	maximumLedgerPageSize,
	maximumSnapshotEventCount,
	protocolVersion,
} from '../src/index.js';
import type { ClientMessage, Task, TaskEvent } from '../src/index.js';
import { MessageLogger } from '../src/message/message_logger.js';
import type { LogEntry } from '../src/message/message_logger.js';
import { TaskProjection } from '../src/task/task_projection.js';
import { Envelope } from '../src/message/envelope.js';
import { SessionRenewal } from '../src/session_renewal.js';
import { ReconnectBackoff } from '../src/reconnect_backoff.js';
import { AccountIdentityFile } from '../src/accounting/account_identity_file.js';
import { AccountKeyFile } from '../src/accounting/account_key_file.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the shared protocol package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('accepts valid task input', () => {
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_dev_formula', input: 12.5 }), { taskType: 'task_type_dev_formula', input: 12.5 });
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' }), { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' }), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' }), { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' });
});

Test('rejects non-finite task input', () => {
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_dev_formula', input: Number.NaN }).success, false);
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_dev_formula', input: Infinity }).success, false);
});

Test('rejects task input that does not match its task type', () => {
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 5 }).success, false);
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: 5 }).success, false);
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 5 }).success, false);
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_dev_formula', input: '5' }).success, false);
});

Test('accepts a whole history only for the three task types whose worker can hand one to its chat template', () => {
	const history = { messages: [{ role: 'user', content: 'hello' }] };
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: history }), { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: history });
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_llama3_2_1b_full', input: history }), { taskType: 'task_type_llm_llama3_2_1b_full', input: history });
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_gemma_4_e2b_full', input: history }), { taskType: 'task_type_llm_gemma_4_e2b_full', input: history });
	// The same three task types still take one prompt too, exactly as before this existed.
	Assert.deepEqual(TaskInput.parse({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' }), { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' });
	// Every other task type refuses a history, rather than reading part of it or accepting a
	// shape its worker cannot hand to anything.
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_llm_qwen3_0_6b_sharded', input: history }).success, false);
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: history }).success, false);
	Assert.equal(TaskInput.safeParse({ taskType: 'task_type_dev_formula', input: history }).success, false);
});

Test('accepts a history with several roles, and refuses one that is empty, malformed, or carries an unknown field', () => {
	Assert.equal(HistoryInputSchema.safeParse({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] }).success, true);
	Assert.equal(HistoryInputSchema.safeParse({ messages: [] }).success, false);
	Assert.equal(HistoryInputSchema.safeParse({ messages: [{ role: 'narrator', content: 'Hi' }] }).success, false);
	Assert.equal(HistoryInputSchema.safeParse({ messages: [{ role: 'user', content: 'Hi' }], somethingUnexpected: true }).success, false);
	// Every message says something. A message with no content at all is refused rather than
	// travelling to a chat template that would render an empty turn.
	Assert.equal(HistoryInputSchema.safeParse({ messages: [{ role: 'assistant' }] }).success, false);
});

Test('accepts a history declaring tools, and refuses a declaration missing what a model needs to use it', () => {
	const weatherTool = {
		name: 'get_current_weather',
		description: 'Reports the current weather in one city.',
		parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
	};
	Assert.equal(HistoryInputSchema.safeParse({
		messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
		tools: [weatherTool],
	}).success, true);
	// The description is what the model reads when it decides whether to ask for a tool, but a tool
	// whose name says enough on its own is allowed to leave it out.
	Assert.equal(HistoryInputSchema.safeParse({
		messages: [{ role: 'user', content: 'Hi' }],
		tools: [{ name: 'get_current_weather', parametersJsonSchema: {} }],
	}).success, true);
	// A declaration with no arguments schema is refused: it is what a consumer converts the model's
	// untyped argument text back into typed values with, so a tool without one cannot be completed.
	Assert.equal(HistoryInputSchema.safeParse({
		messages: [{ role: 'user', content: 'Hi' }],
		tools: [{ name: 'get_current_weather' }],
	}).success, false);
	Assert.equal(HistoryInputSchema.safeParse({
		messages: [{ role: 'user', content: 'Hi' }],
		tools: [{ ...weatherTool, name: '' }],
	}).success, false);
	// Declaring tools is optional, and an empty list is refused rather than accepted as a way of
	// saying "no tools" — leaving the field out is how that is said.
	Assert.equal(HistoryInputSchema.safeParse({ messages: [{ role: 'user', content: 'Hi' }], tools: [] }).success, false);
});

Test('carries a whole tool round trip: the call the model asked for, and the result sent back to it', () => {
	const roundTrip = {
		messages: [
			{ role: 'user', content: 'What is the weather in Paris?' },
			// A model that asks for a tool writes no text at all, so the empty content is what such a
			// message really carries rather than a value that went missing.
			{ role: 'assistant', content: '', toolCalls: [{ name: 'get_current_weather', argumentValues: { city: 'Paris' } }] },
			{ role: 'tool', content: '{"celsius":31,"sky":"clear"}' },
		],
		tools: [{ name: 'get_current_weather', parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } } }],
	};
	Assert.equal(HistoryInputSchema.safeParse(roundTrip).success, true);

	// Every argument value is text, because the format the model writes them in carries no types at
	// all: `llm_qwen3_5_0_8b_full` writes `<parameter=city>Paris</parameter>` and nothing that says
	// what kind of value that is. A consumer converts them using the tool's own arguments schema.
	Assert.equal(ToolCallSchema.safeParse({ name: 'get_current_weather', argumentValues: { city: 'Paris' } }).success, true);
	Assert.equal(ToolCallSchema.safeParse({ name: 'set_temperature', argumentValues: { celsius: 31 } }).success, false);
	// A tool call carries no identifier, because no model this project runs generates one. A consumer
	// speaking the OpenAI Chat Completions interface mints one itself.
	Assert.equal(ToolCallSchema.safeParse({ id: 'call_0', name: 'get_current_weather', argumentValues: {} }).success, false);
	// A tool that takes no arguments asks for none, rather than being refused for asking for nothing.
	Assert.equal(ToolCallSchema.safeParse({ name: 'get_server_time', argumentValues: {} }).success, true);
	// An assistant message that asked for nothing leaves the field out rather than stating an empty list.
	Assert.equal(HistoryInputSchema.safeParse({ messages: [{ role: 'assistant', content: 'Hello.', toolCalls: [] }] }).success, false);
});

Test('restricts task states, and checks the shape of a stage name without listing them', () => {
	Assert.equal(TaskState.safeParse('completed').success, true);
	Assert.equal(TaskState.safeParse('unknown').success, false);
	Assert.equal(StageName.safeParse('stage_dev_formula_multiply').success, true);
	Assert.equal(StageName.safeParse('stage_llm_qwen3_0_6b_shard1of3').success, true);
	// A stage name this package has never heard of is accepted, because which stage names
	// exist is decided at run time by the pipelines the gateway has loaded.
	Assert.equal(StageName.safeParse('stage_invented_by_a_pipeline_file').success, true);
	// The shape is still checked, so a mistyped name is rejected rather than silently used.
	Assert.equal(StageName.safeParse('Stage-Formula-Multiply').success, false);
	Assert.equal(StageName.safeParse('9stage').success, false);
	Assert.equal(StageName.safeParse('').success, false);
	Assert.equal(StageName.safeParse('a'.repeat(101)).success, false);
});

Test('StagePayloadFactory builds each stage payload shape', () => {
	Assert.equal(StagePayloadFactory.formula(42), 42);
	Assert.deepEqual(StagePayloadFactory.llmPrompt('hello'), { text: 'hello' });
	Assert.deepEqual(StagePayloadFactory.llmHistory({ messages: [{ role: 'user', content: 'hello' }] }), { history: { messages: [{ role: 'user', content: 'hello' }] } });

	const tensors = { '/model/layers.9/input_layernorm/output_0': { dims: [1, 1, 4], type: 'float16', dataBase64: 'AA==' } };
	Assert.deepEqual(StagePayloadFactory.llmHandoff(tensors, [1, 2, 3], 0), { tensors, inputIds: [1, 2, 3], position: 0 });

	// A result that leaves the generation unfinished carries the piece that run produced and
	// never the answer so far, so its size does not depend on how much has been generated.
	Assert.deepEqual(StagePayloadFactory.llmContinue(' capital', 464, 20), { newText: ' capital', inputIds: [464], position: 20, done: false });
	Assert.deepEqual(StagePayloadFactory.llmPartialText(' capital'), { newText: ' capital', isContinuation: true, done: false });
	// The one result that finishes a task carries the whole answer, and carries the last piece
	// beside it when the run that finished the answer produced one.
	Assert.deepEqual(StagePayloadFactory.llmDone('The capital of France is Paris.'), { text: 'The capital of France is Paris.', done: true });
	Assert.deepEqual(StagePayloadFactory.llmDone('The capital of France is Paris.', ' Paris.'), { text: 'The capital of France is Paris.', newText: ' Paris.', done: true });
	// A run that finished an answer without adding to it says nothing about what it produced,
	// rather than saying it produced an empty piece.
	Assert.deepEqual(StagePayloadFactory.llmDone('The capital of France is Paris.', ''), { text: 'The capital of France is Paris.', done: true });
	// A worker whose engine can report usage passes it as a third argument, and it is carried
	// through unchanged; a worker that cannot leaves it out entirely, which is the case above.
	Assert.deepEqual(
		StagePayloadFactory.llmDone('The capital of France is Paris.', undefined, {
			promptTokenCount: 12,
			completionTokenCount: 7,
			stopReason: 'end_of_sequence',
		}),
		{ text: 'The capital of France is Paris.', done: true, promptTokenCount: 12, completionTokenCount: 7, stopReason: 'end_of_sequence' },
	);
});

Test('a task can end by asking for a tool instead of by writing an answer', () => {
	const toolCalls = [{ name: 'get_current_weather', argumentValues: { city: 'Paris' } }];
	// The answer text is empty rather than absent, because a model that asks for a tool writes no
	// text at all. Stating it is what lets every reader of a finished task go on reading `text`
	// without first working out which of the two kinds of ending it received.
	Assert.deepEqual(StagePayloadFactory.llmToolCalls(toolCalls), { text: '', toolCalls, done: true });
	Assert.deepEqual(
		StagePayloadFactory.llmToolCalls(toolCalls, { promptTokenCount: 320, completionTokenCount: 27, stopReason: 'interrupted' }),
		{ text: '', toolCalls, done: true, promptTokenCount: 320, completionTokenCount: 27, stopReason: 'interrupted' },
	);
	// A worker that stopped as soon as a complete tool call had been written reports `interrupted`,
	// which is what it did — it did not reach an end-of-sequence token and did not hit its cap.
	Assert.throws(() => StagePayloadFactory.llmToolCalls([]), /says nothing at all/);

	Assert.equal(StagePayloadSchema.safeParse({ text: '', toolCalls, done: true }).success, true);
	Assert.equal(StagePayloadSchema.safeParse({ text: '', toolCalls: [], done: true }).success, false);
	Assert.equal(StagePayloadSchema.safeParse({ text: '', toolCalls: [{ name: 'x', argumentValues: { n: 1 } }], done: true }).success, false);
	// The tool call travels back on the stage result the same way it travels out on a history,
	// under one schema, so what a worker returned can be put straight back into the next submission.
	Assert.equal(ToolCallSchema.safeParse(toolCalls[0]).success, true);
});

Test('StagePayloadSchema accepts and refuses the usage fields milestone 2 of issue #150 added', () => {
	Assert.equal(
		StagePayloadSchema.safeParse({ text: 'Paris.', done: true, promptTokenCount: 12, completionTokenCount: 7, stopReason: 'end_of_sequence' }).success,
		true,
	);
	Assert.equal(StagePayloadSchema.safeParse({ text: 'Paris.', done: true, stopReason: 'max_new_tokens' }).success, true);
	Assert.equal(StagePayloadSchema.safeParse({ text: 'Paris.', done: true, stopReason: 'interrupted' }).success, true);
	// There is no OpenAI value for anything but these three raw reasons, so nothing else is a
	// valid `stopReason`.
	Assert.equal(StagePayloadSchema.safeParse({ text: 'Paris.', done: true, stopReason: 'gave_up' }).success, false);
	Assert.equal(StagePayloadSchema.safeParse({ text: 'Paris.', done: true, promptTokenCount: -1 }).success, false);
});

Test('an answer is reported only as far as its last finished character', () => {
	// The ordinary case: each round adds to the answer, and the addition is what is reported.
	Assert.equal(GeneratedText.reportable('The', 'The capital'), 'The capital');
	Assert.equal(GeneratedText.addition('The', 'The capital'), ' capital');

	// A character written across two tokens is decoded as a placeholder until the token that
	// finishes it arrives, and is then replaced rather than added to. Reporting the placeholder
	// would mean reporting something that has to be taken back, so the unfinished end is held
	// back and the round that finishes the character reports the whole character at once.
	Assert.equal(GeneratedText.reportable('Caf', 'Caf�'), 'Caf');
	Assert.equal(GeneratedText.addition('Caf', GeneratedText.reportable('Caf', 'Caf�')), '');
	Assert.equal(GeneratedText.reportable('Caf', 'Café'), 'Café');
	Assert.equal(GeneratedText.addition('Caf', 'Café'), 'é');

	// An emoji takes more than one placeholder while it is being written.
	Assert.equal(GeneratedText.reportable('Great ', 'Great ��'), 'Great ');
	Assert.equal(GeneratedText.reportable('Great ', 'Great 🎉 news'), 'Great 🎉 news');

	// A placeholder that is not at the end is one the rounds have settled on, so it is reported
	// like any other character rather than held back for ever.
	Assert.equal(GeneratedText.reportable('', 'a�b'), 'a�b');

	// Reporting is one-way. If the answer somehow stops starting with what was already reported,
	// nothing new is reported rather than text being taken back; the whole answer carried by the
	// result that ends the task is what puts a reader right.
	Assert.equal(GeneratedText.reportable('The capital', 'Something else'), 'The capital');
	Assert.equal(GeneratedText.addition('The capital', 'The capital'), '');
});

Test('StagePayloadFactory answers every task type with a first stage value', () => {
	Assert.equal(StagePayloadFactory.initial({ taskType: 'task_type_dev_formula', input: 5 }), 5);
	Assert.deepEqual(StagePayloadFactory.initial({ taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' }), { text: 'hello' });
	Assert.deepEqual(StagePayloadFactory.initial({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' }), { text: 'hello' });
	// A task submitted with a prompt still carries it as `text`, whichever of the two task types
	// it names, exactly as before a history could be submitted at all.
	Assert.deepEqual(StagePayloadFactory.initial({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' }), { text: 'hello' });
	// A task submitted with a whole history carries that history to its first stage
	// instead, rather than having it flattened into `text`.
	const history = { messages: [{ role: 'user' as const, content: 'hello' }] };
	Assert.deepEqual(StagePayloadFactory.initial({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: history }), { history });
	Assert.deepEqual(StagePayloadFactory.initial({ taskType: 'task_type_llm_llama3_2_1b_full', input: history }), { history });
	Assert.deepEqual(StagePayloadFactory.initial({ taskType: 'task_type_llm_gemma_4_e2b_full', input: history }), { history });
});

Test('validates every inbound client message shape', () => {
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_dev_formula', input: 5 } }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.result', taskId: 'task-1', stageAssignmentId: 'assignment-1', attempt: 1, stage: 'stage_dev_formula_multiply', value: 10 }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.result', taskId: 'task-1', stageAssignmentId: 'assignment-1', attempt: 1, stage: 'stage_llm_gemma_nano_chrome_full', value: { newText: ' capital', isContinuation: true, done: false } }).success, true);
	// The generation settings are optional, so every submission written before they existed is
	// still valid, and a setting the gateway has never heard of is refused rather than dropped:
	// a dropped setting would change the answer without telling the consumer anything.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { isStreaming: true } } }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: {} } }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { isStreaming: true, presencePenalty: 0.7 } } }).success, false);
	// Protocol version 6 added the five generation controls beside `isStreaming`, each within the
	// range the OpenAI Chat Completions interface states for it, so a value outside that range is
	// refused at submission rather than sent to a worker that would have to decide what to do
	// with it. See issue #151. This range check is a shape check `GenerationSettingsSchema` makes
	// on every task type alike, so any task type exercises it; `task_type_llm_gemma_nano_chrome_full`
	// is used here for the same reason it already is above, not because it honours any of the five.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { temperature: 0, topP: 0.9, maximumOutputTokenCount: 20, stopSequences: ['\nUser:'], randomSeed: 42 } } }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { temperature: 2.5 } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { topP: 0 } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { maximumOutputTokenCount: 0 } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { stopSequences: [] } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { isStreaming: 'yes' } } }).success, false);
	// Protocol version 9 added `reasoningEffort`, whose six levels are the ones LM Studio 0.4.20
	// names itself when it refuses a seventh. A level outside that set is refused here rather than
	// sent to a worker that would have to decide what to do with it. See issue #192.
	for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
		Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello', generationSettings: { reasoningEffort: level } } }).success, true);
	}
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello', generationSettings: { reasoningEffort: 'exhaustive' } } }).success, false);
	// Protocol version 10 added `responseFormat`, holding the two shapes the OpenAI Chat
	// Completions interface names. `text` is not one of them: it is that interface's own default,
	// asks for nothing unusual, and a consumer drops it rather than carrying it. See milestone 2 of
	// issue #221.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: { type: 'json_object' } } } }).success, true);
	// A `json_schema` carries the schema itself and not only the name of the shape, because the
	// bare name would leave the worker to invent a schema, and an answer matching an invented
	// schema is not the answer that was asked for.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: { type: 'json_schema', jsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } } } }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: { type: 'json_schema' } } } }).success, false);
	// The schema arrives exactly as it was written, nested keywords and all. A value schema that
	// stripped what it did not recognise would leave a worker enforcing a shape nobody asked for,
	// and the submission would succeed all the same, which is the one failure this field exists to
	// prevent.
	const askedSchema = { type: 'object', properties: { city: { type: 'string', minLength: 1 } }, required: ['city'], additionalProperties: false };
	Assert.deepEqual(GenerationSettingsSchema.parse({ responseFormat: { type: 'json_schema', jsonSchema: askedSchema } }), { responseFormat: { type: 'json_schema', jsonSchema: askedSchema } });
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: { type: 'json_object', jsonSchema: { type: 'object' } } } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: 'json_object' } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: { type: 'text' } } } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { responseFormat: { type: 'yaml' } } } }).success, false);
	// A shape travels beside the controls without disturbing them, because it is carried in the
	// same block and refused against a different table.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_gemma_4_e2b_full', input: 'hello', generationSettings: { isStreaming: true, temperature: 0, responseFormat: { type: 'json_object' } } } }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', input: { taskType: 'task_type_dev_formula', input: 5 } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.result', taskId: 'task-1', stage: 'stage_dev_formula_multiply', value: 10 }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'deviceRegister', role: 'consumer', name: 'consumer', unexpected: true }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.history', taskId: 'task-1' }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.history' }).success, false);
});

Test('names both response formats as honoured by the one task type whose two workers were both measured', () => {
	// Filled by milestone 6 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221),
	// and only then, because a row is the intersection of what both kinds of worker keep and this
	// table holds what a live run observed and nothing else. The worker browser tab constrains
	// generation with `@huggingface/transformers-response-constraint`; the `@webai/worker-openai`
	// process sends `response_format` to the local server it forwards to.
	Assert.equal(StructuredOutputSupport.honours('task_type_llm_gemma_4_e2b_full', 'json_object'), true);
	Assert.equal(StructuredOutputSupport.honours('task_type_llm_gemma_4_e2b_full', 'json_schema'), true);
	Assert.deepEqual(
		StructuredOutputSupport.honouredFormats('task_type_llm_gemma_4_e2b_full'),
		['json_object', 'json_schema'],
	);
	// Every other task type still produces no shape at all. `task_type_llm_llama3_2_1b_full` has a
	// native worker that could, and a worker browser tab that cannot, so the intersection is empty;
	// the three below run only in a browser tab, whose stage helpers ask for no constraint;
	// `task_type_dev_formula` generates no text to shape.
	for (const taskType of [
		'task_type_llm_llama3_2_1b_full',
		'task_type_llm_qwen3_5_0_8b_full',
		'task_type_llm_qwen3_0_6b_sharded',
		'task_type_llm_gemma_nano_chrome_full',
		'task_type_dev_formula',
	] as const) {
		Assert.deepEqual(StructuredOutputSupport.honouredFormats(taskType), []);
		Assert.equal(StructuredOutputSupport.honours(taskType, 'json_object'), false);
		Assert.equal(StructuredOutputSupport.honours(taskType, 'json_schema'), false);
	}
});

Test('names reasoning_effort as honoured only by the task type whose model thinks on both of its workers', () => {
	// A task type's contract is the intersection of what all of its workers honour, so this control
	// could only be entered here once both workers of `task_type_llm_qwen3_5_0_8b_full` were gated
	// live: `reasoning_effort` on the request to LM Studio 0.4.20, and `enable_thinking` on the chat
	// template in a real browser tab. See [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192).
	Assert.equal(GenerationControlSupport.honours('task_type_llm_qwen3_5_0_8b_full', 'reasoningEffort'), true);
	// Llama 3.2 1B never thought, so there is no thinking to budget.
	Assert.equal(GenerationControlSupport.honours('task_type_llm_llama3_2_1b_full', 'reasoningEffort'), false);
	// Qwen3-0.6B does think, but its sharded stage helper builds its prompt and drives its own
	// sampler rather than going through either gated seam, so whether it could honour this control
	// is unmeasured — and an unmeasured entry is the one thing this table must never hold.
	Assert.equal(GenerationControlSupport.honours('task_type_llm_qwen3_0_6b_sharded', 'reasoningEffort'), false);
	Assert.equal(GenerationControlSupport.honours('task_type_llm_gemma_nano_chrome_full', 'reasoningEffort'), false);
	Assert.equal(GenerationControlSupport.honours('task_type_dev_formula', 'reasoningEffort'), false);
	// Gemma 4 E2B does think, and its stage helper turns thinking off unconditionally rather than
	// letting a consumer budget it, so there is nothing to honour. Nothing about this task type has
	// been measured into this table yet; milestone 5 of
	// [issue #211](https://github.com/webai-at-home/webai-at-home/issues/211) is what widens it.
	Assert.equal(GenerationControlSupport.honours('task_type_llm_gemma_4_e2b_full', 'reasoningEffort'), false);
	// Adding this control took nothing away from the three that task type already honoured.
	Assert.deepEqual(
		GenerationControlSupport.honouredControls('task_type_llm_qwen3_5_0_8b_full'),
		['temperature', 'maximumOutputTokenCount', 'stopSequences', 'reasoningEffort'],
	);
});

Test('keeps task inputs and stage values in the log, since only credentials are redacted', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'message-logger-'));
	const logFilePath = Path.join(directoryPath, 'log.log_entry.jsonl');
	const logger = new MessageLogger(logFilePath);
	const counterpart = { role: 'consumer', deviceId: 'device-1' };

	logger.log('received', counterpart, 'task.submit', { type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'What is the capital of France?' } });
	logger.log('sent', counterpart, 'stage.assign', { type: 'stage.assign', taskId: 'task-1', stage: 'stage_dev_formula_multiply', value: 5 });
	logger.log('received', counterpart, 'task.submit', { type: 'task.submit', taskRequestId: 'request-2', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?', generationSettings: { isStreaming: true } } });

	const entries = Fs.readFileSync(logFilePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LogEntry);
	Fs.rmSync(directoryPath, { recursive: true, force: true });

	Assert.deepEqual(entries[0].messagePayload, { type: 'task.submit', taskRequestId: 'request-1', input: { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'What is the capital of France?' } });
	Assert.deepEqual(entries[1].messagePayload, { type: 'stage.assign', taskId: 'task-1', stage: 'stage_dev_formula_multiply', value: 5 });
	Assert.deepEqual(entries[2].messagePayload, { type: 'task.submit', taskRequestId: 'request-2', input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?', generationSettings: { isStreaming: true } } });

	// An answer streamed one piece at a time is kept just like an answer sent whole, on both the
	// update that reports it and the task snapshot that carries the answer so far for a consumer
	// that reconnected and missed some.
	const streamed = MessageLogger.redactMessagePayload({ type: 'task.updated', update: { taskId: 'task-1', taskRevision: 7, newText: ' capital', generatedText: 'The capital' } });
	Assert.deepEqual(streamed, { type: 'task.updated', update: { taskId: 'task-1', taskRevision: 7, newText: ' capital', generatedText: 'The capital' } });

	// A credential is redacted no matter how deeply it is nested, including inside a relayed
	// `signal` message whose body the schema declares as unknown.
	const relayed = MessageLogger.redactMessagePayload({
		type: 'signal',
		to: 'device-2',
		data: { input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'a prompt', generationSettings: { isStreaming: true, text: 'A PROMPT', nested: { token: 'A CREDENTIAL' } } } },
	});
	Assert.deepEqual(relayed, {
		type: 'signal',
		to: 'device-2',
		data: { input: { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'a prompt', generationSettings: { isStreaming: true, text: 'A PROMPT', nested: { token: '[redacted]' } } } },
	});
});

Test('keeps the task result and the values inside completed stages, redacting only a nested credential', () => {
	const redacted = MessageLogger.redactMessagePayload({
		type: 'task.updated',
		update: { taskId: 'task-1', state: 'completed', result: { text: 'THE ANSWER' } },
	}) as { update: { result: unknown } };
	Assert.deepEqual(redacted.update.result, { text: 'THE ANSWER' });

	const snapshot = MessageLogger.redactMessagePayload({
		type: 'task.snapshot',
		task: { taskId: 'task-1', completedStages: [{ name: 'stage_llm_qwen3_0_6b_shard1of3', value: { text: 'STAGE OUTPUT' } }] },
	}) as { task: { completedStages: { name: string; value: unknown }[] } };
	Assert.deepEqual(snapshot.task.completedStages, [{ name: 'stage_llm_qwen3_0_6b_shard1of3', value: { text: 'STAGE OUTPUT' } }]);

	// A credential still gets redacted when nested inside another message, which is the shape a
	// gateway message carrying a task takes.
	const nested = MessageLogger.redactMessagePayload({
		type: 'stage.assign',
		assignment: { taskId: 'task-1', value: { text: 'A PROMPT' }, token: 'A CREDENTIAL' },
	}) as { assignment: { value: unknown; token: unknown } };
	Assert.deepEqual(nested.assignment.value, { text: 'A PROMPT' });
	Assert.equal(nested.assignment.token, '[redacted]');
});

Test('redacts the authentication token', () => {
	const redacted = MessageLogger.redactMessagePayload({ type: 'deviceAuthenticate', token: 'development-token' }) as { token: unknown };
	Assert.equal(redacted.token, '[redacted]');
});

Test('leaves the message it redacts unmodified', () => {
	const original = { type: 'deviceAuthenticate', token: 'development-token' };
	MessageLogger.redactMessagePayload(original);
	Assert.equal(original.token, 'development-token');
});

Test('accepts a lease heartbeat and the stage settings that control leasing', () => {
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.heartbeat', taskId: 'task-1', stageAssignmentId: 'assignment-1', attempt: 1 }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.heartbeat', taskId: 'task-1', stageAssignmentId: 'assignment-1' }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.heartbeat', taskId: 'task-1', stageAssignmentId: 'assignment-1', attempt: 0 }).success, false);

	const stage = { name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' } as const;
	Assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: 60_000, prefersSameWorkerOnRetry: true }).success, true);
	// A stage that states neither setting is valid, and takes the gateway's --lease-ms default.
	Assert.equal(PipelineStageSchema.safeParse(stage).success, true);
	Assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: 0 }).success, false);
	Assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: -1 }).success, false);
});

Test('rejects malformed and oversized identity-bearing task messages', () => {
	Assert.equal(ClientMessageSchema.safeParse({ type: 'task.submit', taskRequestId: '', input: { taskType: 'task_type_dev_formula', input: 5 } }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.result', taskId: 'task-1', stageAssignmentId: 'assignment-1', attempt: 0, stage: 'stage_dev_formula_multiply', value: 10 }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'stage.failed', taskId: 'task-1', stageAssignmentId: 'assignment-1', attempt: 1, stage: 'stage_dev_formula_multiply', error: 'x'.repeat(10_001) }).success, false);
});

/**
 * Builds a task record that has run many language-model shards, so the growth of the
 * stored record can be told apart from the size of what goes over the connection.
 *
 * @param shardCount - How many shard assignments the task has already run.
 * @returns The stored task record.
 */
function buildLlmTask(shardCount: number): Task {
	const tensorPayload = StagePayloadFactory.llmHandoff({ hidden: { dataBase64: 'A'.repeat(4_000), dims: [1, 2], type: 'float32' } }, [1], 0);
	const stageAssignmentAttempts = Array.from({ length: shardCount }, (_unused, index) => ({
		workerDeviceId: 'device-worker',
		stageAssignmentId: `assignment-${index}`,
		attempt: 1,
		stage: 'stage_llm_qwen3_0_6b_shard1of3' as const,
		value: tensorPayload,
		leaseUntil: '2026-01-01T00:00:15.000Z',
	}));
	const events: TaskEvent[] = Array.from({ length: shardCount }, (_unused, index) => ({
		type: 'stage_assignment_created' as const,
		timestamp: '2026-01-01T00:00:00.000Z',
		stageAssignmentId: `assignment-${index}`,
		attempt: 1,
	}));
	return {
		taskId: 'task-1',
		taskRequestId: 'request-1',
		consumerDeviceId: 'device-consumer',
		consumerAuthIdentity: 'authIdentity-1',
		input: { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'What is the capital of France?' },
		state: 'running',
		completedStages: stageAssignmentAttempts.map((stageAssignment) => ({ name: stageAssignment.stage, value: tensorPayload })),
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:01.000Z',
		stageAssignment: stageAssignmentAttempts.at(-1),
		stageAssignmentAttempts,
		currentStageAttempts: 1,
		events,
		submissionDeadlineAt: '2026-01-01T00:00:30.000Z',
		taskRevision: shardCount,
	};
}

Test('the task update sent on every revision does not grow as a task runs more stages', () => {
	const shortTask = buildLlmTask(3);
	const longTask = buildLlmTask(300);

	const shortUpdateBytes = JSON.stringify(TaskProjection.update(shortTask)).length;
	const longUpdateBytes = JSON.stringify(TaskProjection.update(longTask)).length;

	// The stored record grows with the number of stages run; the task update must not.
	Assert.ok(JSON.stringify(longTask).length > JSON.stringify(shortTask).length * 50);
	// The only difference between the two updates is the extra digits in the revision, the
	// completed stage count, and the assignment identifier, so it grows with the number of
	// digits rather than with the number of stages.
	Assert.equal(longUpdateBytes - shortUpdateBytes, 6);
	Assert.ok(longUpdateBytes < 400);
});

Test('no stage value appears in a task update, and none appears twice', () => {
	const update = TaskProjection.update(buildLlmTask(5));
	const serialised = JSON.stringify(update);

	Assert.equal(serialised.includes('dataBase64'), false);
	Assert.equal(serialised.includes('AAAA'), false);
	Assert.equal('value' in (update.stageAssignment ?? {}), false);
	Assert.equal(update.completedStageCount, 5);
	Assert.equal(update.currentStage, 'stage_llm_qwen3_0_6b_shard1of3');
	// A task that asked for no pieces reports none, so its updates are exactly what they were
	// before pieces existed.
	Assert.equal('newText' in update, false);
});

Test('a task update carries the text one revision produced, and never the answer so far', () => {
	const task = buildLlmTask(5);
	const update = TaskProjection.update({ ...task, newText: ' capital', generatedText: 'The capital' });

	// The piece and not the answer so far: an update stays the same size however long the
	// answer becomes, which is the whole reason a task update exists apart from the task.
	Assert.equal(update.newText, ' capital');
	Assert.equal(JSON.stringify(update).includes('The capital'), false);
	// Everything generated so far is on the task for a consumer that reconnects and asks for it,
	// which is a snapshot rather than an update.
	Assert.equal(TaskProjection.snapshot({ ...task, generatedText: 'The capital' }).generatedText, 'The capital');
});

Test('the task snapshot drops the attempt history and truncates the change log', () => {
	const task = buildLlmTask(50);
	const snapshot = TaskProjection.snapshot(task);

	Assert.equal('stageAssignmentAttempts' in snapshot, false);
	Assert.equal('events' in snapshot, false);
	Assert.equal(snapshot.recentEvents.length, maximumSnapshotEventCount);
	Assert.deepEqual(snapshot.recentEvents.at(-1), task.events.at(-1));
	Assert.equal('value' in (snapshot.stageAssignment ?? {}), false);
	Assert.equal(snapshot.input.input, 'What is the capital of France?');
});

Test('a pipeline stage names the computation a worker must run, and a pipeline may repeat', () => {
	const stage = { name: 'stage_anything', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' } as const;
	// The stage name is free; the computation is what a worker matches on.
	Assert.equal(PipelineStageSchema.safeParse(stage).success, true);
	Assert.equal(PipelineStageSchema.safeParse({ ...stage, computation: undefined }).success, false);
	Assert.equal(PipelineStageSchema.safeParse({ ...stage, computation: 'Formula Multiply' }).success, false);

	Assert.equal(PipelineSpecificationSchema.safeParse({
		pipelineId: 'invented', version: 1, taskType: 'task_type_dev_formula', repeatsUntilDone: true, stages: [stage],
	}).success, true);
	Assert.equal(PipelineSpecificationSchema.safeParse({
		pipelineId: 'invented', version: 1, taskType: 'task_type_dev_formula', stages: [stage, stage],
	}).success, false);
});

Test('every frame states its version, its own identifier, and when it was sent', () => {
	const frame = Envelope.fromClient({ type: 'deviceAuthenticate', token: 'development-token' });
	Assert.equal(frame.v, protocolVersion);
	Assert.ok(frame.id.length > 0);
	Assert.ok(Number.isFinite(Date.parse(frame.ts)));
	Assert.equal(ClientEnvelopeSchema.safeParse(frame).success, true);

	// Two frames of the same kind can be told apart, which is what lets a client match two
	// requests in flight at once to their own answers.
	Assert.notEqual(Envelope.fromClient({ type: 'devices.resync' }).id, Envelope.fromClient({ type: 'devices.resync' }).id);

	// A frame with no message in it, an unknown field, or a bad timestamp is refused.
	Assert.equal(ClientEnvelopeSchema.safeParse({ v: 1, id: 'message-1', ts: new Date().toISOString() }).success, false);
	Assert.equal(ClientEnvelopeSchema.safeParse({ ...frame, unexpected: true }).success, false);
	Assert.equal(ClientEnvelopeSchema.safeParse({ ...frame, ts: 'not-a-time' }).success, false);
});

Test('a gateway answer names the request it answers, and a push names nothing', () => {
	const request = Envelope.fromClient({ type: 'devices.resync' });
	const answer = Envelope.fromGateway({ type: 'devices', devices: [], deviceListRevision: 1 }, request.id);
	const push = Envelope.fromGateway({ type: 'devices', devices: [], deviceListRevision: 2 });

	Assert.equal(answer.inReplyToMessageId, request.id);
	// The push carries the same message type as the answer. The absence of inReplyToMessageId is
	// the only thing that tells them apart, which is the point of the field.
	Assert.equal(push.inReplyToMessageId, undefined);
	Assert.notEqual(answer.id, push.id);
});

Test('recognises a message sent without its wrapper, and reports which versions are supported', () => {
	Assert.equal(Envelope.isUnwrappedMessage({ type: 'deviceAuthenticate', token: 'development-token' }), true);
	Assert.equal(Envelope.isUnwrappedMessage(Envelope.fromClient({ type: 'devices.resync' })), false);
	Assert.equal(Envelope.isUnwrappedMessage('not an object'), false);

	Assert.equal(Envelope.supportsVersion(protocolVersion), true);
	Assert.equal(Envelope.supportsVersion(protocolVersion + 1), false);
});

Test('diagnostics travel off the scheduling connection, under a schema rather than as unknown', () => {
	// The scheduling connection no longer carries diagnostic traffic at all.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'log.entry', direction: 'sent', messageType: 'stage.result', timestamp: new Date().toISOString(), payload: {} }).success, false);

	const validBatch = {
		deviceId: 'device-11111111-2222-3333-4444-555555555555',
		entries: [{ direction: 'sent' as const, messageType: 'stage.result', timestamp: new Date().toISOString(), messageId: 'message-1' }],
	};
	Assert.equal(DiagnosticsBatchSchema.safeParse(validBatch).success, true);

	// A report carries timing only. Anything carrying a message body is refused outright,
	// which is what keeps task data off this path rather than relying on redaction alone.
	const withBody = { ...validBatch, entries: [{ ...validBatch.entries[0], payload: { input: 'a secret prompt' } }] };
	Assert.equal(DiagnosticsBatchSchema.safeParse(withBody).success, false);

	// The batch size is bounded, so one report cannot be arbitrarily large.
	const oversized = {
		deviceId: validBatch.deviceId,
		entries: Array.from({ length: maximumDiagnosticEntriesPerBatch + 1 }, () => validBatch.entries[0]),
	};
	Assert.equal(DiagnosticsBatchSchema.safeParse(oversized).success, false);

	Assert.equal(DiagnosticsBatchSchema.safeParse({ deviceId: validBatch.deviceId, entries: [] }).success, false);
	Assert.equal(DiagnosticsBatchSchema.safeParse({ entries: validBatch.entries }).success, false);
});

Test('a long-lived client renews halfway through its session', () => {
	const now = Date.parse('2026-07-29T12:00:00.000Z');

	// Halfway through, so a renewal that is lost or late still leaves as much time again for
	// another attempt before the session actually runs out.
	Assert.equal(SessionRenewal.renewAfterMs('2026-07-29T13:00:00.000Z', now), 1_800_000);
	Assert.equal(SessionRenewal.renewAfterMs('2026-07-29T12:00:10.000Z', now), 5_000);

	// A session already expired, or about to be, never produces a zero or negative wait that
	// would spin the client.
	Assert.equal(SessionRenewal.renewAfterMs('2026-07-29T11:00:00.000Z', now), 1_000);
	Assert.equal(SessionRenewal.renewAfterMs('2026-07-29T12:00:00.000Z', now), 1_000);
	Assert.equal(SessionRenewal.renewAfterMs('not a date', now), 1_000);
});

Test('a client that lost its connection waits longer after each attempt, up to one minute', () => {
	// No random extra, so the wait each attempt produces is exactly the doubling itself.
	const backoff = new ReconnectBackoff(() => 0);

	Assert.equal(backoff.attemptCount, 0);
	Assert.deepEqual(
		[backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs()],
		[1_000, 2_000, 4_000, 8_000, 16_000],
	);
	Assert.equal(backoff.attemptCount, 5);

	// The doubling stops at one minute, so a gateway that is down for hours is not asked more
	// often than that, however many attempts have already been made.
	Assert.deepEqual([backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs()], [32_000, 60_000, 60_000]);
	for (let attempt = 0; attempt < 50; attempt += 1) {
		Assert.equal(backoff.nextDelayMs(), 60_000);
	}

	// A client that holds a usable connection again starts from the first wait, so the next
	// connection it loses is retried after one second rather than after a minute.
	backoff.reset();
	Assert.equal(backoff.attemptCount, 0);
	Assert.equal(backoff.nextDelayMs(), 1_000);
});

Test('the wait a client hands out carries a random extra, so a whole cluster does not come back at one instant', () => {
	// The largest random extra is 30 per cent of the wait it is added to.
	Assert.equal(new ReconnectBackoff(() => 0.999_999).nextDelayMs(), 1_300);
	Assert.equal(new ReconnectBackoff(() => 0.5).nextDelayMs(), 1_150);

	// The extra is taken from the wait the rule is currently on, including the one-minute
	// ceiling, so no wait is ever shorter than that wait or more than 30 per cent longer.
	const backoff = new ReconnectBackoff(Math.random);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const delayMs = backoff.nextDelayMs();
		const delayWithoutExtraMs = Math.min(1_000 * 2 ** attempt, 60_000);
		Assert.ok(delayMs >= delayWithoutExtraMs, `${String(delayMs)} is shorter than ${String(delayWithoutExtraMs)}`);
		Assert.ok(delayMs <= delayWithoutExtraMs * 1.3, `${String(delayMs)} is more than 30 per cent longer than ${String(delayWithoutExtraMs)}`);
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Accounts
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('an account identifier is derived from the public key, so the same key is always the same account', async () => {
	const first = await AccountIdentity.generateKeyPair('Ed25519');
	const second = await AccountIdentity.generateKeyPair('Ed25519');
	const firstPublicKey = await AccountIdentity.exportPublicKeySpkiBase64(first.publicKey);
	const secondPublicKey = await AccountIdentity.exportPublicKeySpkiBase64(second.publicKey);

	// The identifier is a digest of the key rather than a value the gateway hands out, so a
	// participant returning on a new connection, or to a different gateway, is the same account.
	Assert.equal(await AccountIdentity.accountIdFor(firstPublicKey), await AccountIdentity.accountIdFor(firstPublicKey));
	Assert.notEqual(await AccountIdentity.accountIdFor(firstPublicKey), await AccountIdentity.accountIdFor(secondPublicKey));
	Assert.match(await AccountIdentity.accountIdFor(firstPublicKey), /^account-[0-9a-f]{32}$/);
});

Test('what an account signs names this project and this purpose, and not the challenge alone', () => {
	const signed = new TextDecoder().decode(AccountIdentity.signedMessageBytesFor('abc123'));

	// A signature produced to authenticate an account must not be presentable as a signature over
	// something else the same key pair might one day be asked to sign.
	Assert.equal(signed, 'webai-at-home:account-authentication:v1:abc123');
	Assert.equal(signed.startsWith(AccountIdentity.signedMessagePrefix), true);
});

Test('a signature is accepted only for the challenge it was made over, and only for its own account', async () => {
	for (const algorithmName of ['Ed25519', 'ECDSA-P-256'] as const) {
		const keyPair = await AccountIdentity.generateKeyPair(algorithmName);
		const otherKeyPair = await AccountIdentity.generateKeyPair(algorithmName);
		const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
		const otherPublicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(otherKeyPair.publicKey);
		const challenge = 'e6f0c0a4bd1c4f2e9f0a1b2c3d4e5f60';
		const signatureBase64 = await AccountIdentity.signChallenge(algorithmName, keyPair.privateKey, challenge);

		Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: algorithmName, publicKeySpkiBase64, challenge, signatureBase64 }), true, algorithmName);
		Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: algorithmName, publicKeySpkiBase64, challenge: `${challenge}0`, signatureBase64 }), false, algorithmName);
		Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: algorithmName, publicKeySpkiBase64: otherPublicKeySpkiBase64, challenge, signatureBase64 }), false, algorithmName);

		// Text that is not a signature at all is refused rather than throwing out of the gateway's
		// message handling.
		Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: algorithmName, publicKeySpkiBase64, challenge, signatureBase64: 'not a signature' }), false, algorithmName);
	}
});

Test('the three account messages are accepted, and nothing beyond what they declare is', async () => {
	const keyPair = await AccountIdentity.generateKeyPair('Ed25519');
	const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);

	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, emailAddress: 'volunteer@example.com', displayName: 'Volunteer' }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.challenge.request' }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.authenticate', accountId: 'account-0123456789abcdef0123456789abcdef', signatureBase64: 'c2lnbmF0dXJl' }).success, true);

	// An algorithm the gateway cannot verify, a missing key, and a private key sent where a public
	// one belongs are all refused before any handler sees them.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.register', signatureAlgorithmName: 'RSA', publicKeySpkiBase64 }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.register', signatureAlgorithmName: 'Ed25519' }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, privateKeySpkiBase64: publicKeySpkiBase64 }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.authenticate', accountId: 'account-0123456789abcdef0123456789abcdef' }).success, false);
});

Test('an account profile is what the gateway stores, with an empty email address and display name allowed', async () => {
	const keyPair = await AccountIdentity.generateKeyPair('Ed25519');
	const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
	const accountId = await AccountIdentity.accountIdFor(publicKeySpkiBase64);

	// A volunteer opening a worker browser page has not agreed to give an email address, and the page
	// registers an account for that volunteer either way.
	const profile = { accountId, signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, emailAddress: '', displayName: '', createdAt: '2026-08-05T12:00:00.000Z' };
	Assert.equal(AccountProfileSchema.safeParse(profile).success, true);
	Assert.equal(AccountProfileSchema.safeParse({ ...profile, accountId: '' }).success, false);
	Assert.equal(AccountProfileSchema.safeParse({ ...profile, balance: 12 }).success, false);
});

Test('the three accounting reads are accepted, and a page larger than one page may hold is refused', () => {
	// Each names no account by default and is answered for the account the connection authenticated as.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.get' }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.balance.get' }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.ledger.get' }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.ledger.get', accountId: 'account-0123456789abcdef0123456789abcdef', direction: 'earned', limit: 10, before: 'ledgerEntry-1' }).success, true);

	// A limit beyond what one page may hold is refused as the message is validated, rather than
	// silently answered with less than was asked for.
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.ledger.get', limit: maximumLedgerPageSize }).success, true);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.ledger.get', limit: maximumLedgerPageSize + 1 }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.ledger.get', limit: 0 }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.ledger.get', direction: 'sideways' }).success, false);
	Assert.equal(ClientMessageSchema.safeParse({ type: 'account.balance.get', accountId: 'account-1', includeEveryAccount: true }).success, false);
});

Test('the account history registers, signs the challenge it is handed, and settles with the account', async () => {
	const keyPair = await AccountIdentity.generateKeyPair('Ed25519');
	const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
	const accountId = await AccountIdentity.accountIdFor(publicKeySpkiBase64);
	const sent: ClientMessage[] = [];
	let settledAccountId: string | undefined | 'not settled' = 'not settled';

	const authentication = new AccountAuthentication({ signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, accountId, privateKey: keyPair.privateKey }, (message) => sent.push(message), {
		onSettled: (settled) => { settledAccountId = settled; },
	});
	authentication.begin();
	Assert.equal(sent[0]?.type, 'account.register');

	Assert.equal(authentication.handleMessage({ type: 'account.registered' }), true);
	Assert.equal(sent[1]?.type, 'account.challenge.request');

	Assert.equal(authentication.handleMessage({ type: 'account.challenge', challenge: 'c0ffee' }), true);
	// Signing goes through the Web Cryptography API, so the signature is sent once that finishes.
	await new Promise((resolve) => setTimeout(resolve, 10));
	const authenticate = sent[2];
	Assert.equal(authenticate?.type, 'account.authenticate');
	Assert.equal(settledAccountId, 'not settled');

	// What it signed is a real signature over that challenge, by this key pair.
	Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, challenge: 'c0ffee', signatureBase64: (authenticate as { signatureBase64: string }).signatureBase64 }), true);

	Assert.equal(authentication.handleMessage({ type: 'account.authenticated', accountId }), true);
	Assert.equal(settledAccountId, accountId);

	// A message that is not part of this history is left to whoever else is listening.
	Assert.equal(authentication.handleMessage({ type: 'task.updated' }), false);
});

Test('a gateway that will not give an account releases the participant to work without one', async () => {
	const keyPair = await AccountIdentity.generateKeyPair('Ed25519');
	const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
	const accountId = await AccountIdentity.accountIdFor(publicKeySpkiBase64);

	for (const code of ['ACCOUNT_SIGNATURE_REJECTED', 'INVALID_MESSAGE', 'UNSUPPORTED', 'VALIDATION']) {
		let settledAccountId: string | undefined | 'not settled' = 'not settled';
		const notes: string[] = [];
		const authentication = new AccountAuthentication({ signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, accountId, privateKey: keyPair.privateKey }, () => undefined, {
			onSettled: (settled) => { settledAccountId = settled; },
			onNote: (note) => notes.push(note),
		});
		authentication.begin();

		// A gateway built before accounts existed answers these messages with INVALID_MESSAGE or
		// VALIDATION, which is exactly the case a participant has to survive rather than stall on.
		Assert.equal(authentication.handleMessage({ type: 'error', code, message: 'no' }), true);
		Assert.equal(settledAccountId, undefined, code);
		Assert.match(notes[0] ?? '', /recorded against the shared development account/);

		// Settling happens once: an error arriving later belongs to whatever else the connection is
		// doing, and is left to it.
		Assert.equal(authentication.handleMessage({ type: 'error', code: 'ACCOUNT_REQUIRED' }), false);
	}
});

Test('reads the account identity file, and reads an absent file as an empty profile', () => {
	const configDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'account-identity-'));
	const identityFilePath = AccountIdentityFile.pathInConfigDir(configDir);

	// The name inside the configuration directory is fixed, so nothing has to spell it out.
	Assert.equal(Path.basename(identityFilePath), 'default.identity.json');

	// A participant that has never written the file registers with an empty profile rather than
	// failing, which is the same anonymous profile a worker browser tab registers with.
	Assert.deepEqual(AccountIdentityFile.read(identityFilePath), { displayName: '', emailAddress: '' });

	Fs.writeFileSync(identityFilePath, JSON.stringify({ displayName: 'my laptop', emailAddress: 'volunteer@example.com' }), 'utf8');
	Assert.deepEqual(AccountIdentityFile.read(identityFilePath), { displayName: 'my laptop', emailAddress: 'volunteer@example.com' });

	// A field that is missing, or is not text, reads as empty for that field alone.
	Fs.writeFileSync(identityFilePath, JSON.stringify({ emailAddress: 12 }), 'utf8');
	Assert.deepEqual(AccountIdentityFile.read(identityFilePath), { displayName: '', emailAddress: '' });

	Fs.writeFileSync(identityFilePath, 'not json at all', 'utf8');
	Assert.throws(() => AccountIdentityFile.read(identityFilePath), /is not readable as JSON/);

	Fs.rmSync(configDir, { recursive: true, force: true });
});

Test('names the account key file inside a configuration directory', () => {
	Assert.equal(AccountKeyFile.pathInConfigDir(Path.join('some', 'config')), Path.join('some', 'config', 'default.account_key.json'));
});
