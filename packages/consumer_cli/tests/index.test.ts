import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Test from 'node:test';
import { ConsumerClient, type TaskSocket } from '../src/gateway_connection/consumer_client.js';
import { TaskInputFactory, taskTypeNames, taskTypeNamesAcceptingHistory } from '../src/libs/task_input_factory.js';
import { DeviceAvailability } from '../src/cluster_capacity/device_availability.js';
import { CapacityCalculator } from '../src/cluster_capacity/capacity_calculator.js';
import { ClusterCapacityReader } from '../src/cluster_capacity/cluster_capacity_reader.js';
import { ObserverClient } from '../src/gateway_connection/observer_client.js';
import { AccountIdentity, protocolVersion, type ClientMessage, type Device, type GatewayMessage, type LedgerEntry, type PipelineSpecification, type ProtocolError } from '@webai/protocol';
import { AccountClient } from '../src/account/account_client.js';
import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { AccountOutputFormatter, accountOutputFormats } from '../src/account/account_output_format.js';
import { AccountBalanceCommand } from '../src/commands/account_balance_command.js';
import { AccountHistoryCommand, accountHistoryDirections } from '../src/commands/account_history_command.js';
import { CliError } from '../src/libs/cli_errors.js';
import { StatusCommand, type StatusFormat } from '../src/commands/status_command.js';
import * as ConsumerCli from '@webai/consumer-cli';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the consumer command line package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('parses finite numeric input', () => {
	Assert.equal(TaskInputFactory.createTaskInput('dev_formula', '12.5').input, 12.5);
	Assert.equal(TaskInputFactory.createTaskInput('dev_formula', '-3').input, -3);
});

Test('rejects missing or non-finite input', () => {
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', undefined), /Input must be a finite number/);
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', 'not-a-number'), /Input must be a finite number/);
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', 'Infinity'), /Input must be a finite number/);
});

Test('validates large-language-model input', () => {
	Assert.equal(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', ' hello ').input, ' hello ');
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', '  '), /Input must be a non-empty string/);
});

Test('builds the task input for every task type a consumer may submit', () => {
	Assert.deepEqual(taskTypeNames, ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full', 'llm_qwen3_5_0_8b_full', 'llm_llama3_2_1b_full']);
	Assert.equal(TaskInputFactory.isTaskTypeName('llm_gemma_nano_chrome_full'), true);
	Assert.equal(TaskInputFactory.isTaskTypeName('task_type_llm_gemma_nano_chrome_full'), false);
	Assert.deepEqual(TaskInputFactory.createTaskInput('dev_formula', '5'), { taskType: 'task_type_dev_formula', input: 5 });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', 'hello'), { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello'), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', '  '), /Input must be a non-empty string/);
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_5_0_8b_full', 'hello'), { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_qwen3_5_0_8b_full', '  '), /Input must be a non-empty string/);
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_llama3_2_1b_full', 'hello'), { taskType: 'task_type_llm_llama3_2_1b_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_llama3_2_1b_full', '  '), /Input must be a non-empty string/);
});

Test('accepts a whole history for the two task types whose worker can hand one to its chat template, and refuses it for every other', () => {
	Assert.deepEqual(taskTypeNamesAcceptingHistory, ['llm_qwen3_5_0_8b_full', 'llm_llama3_2_1b_full']);
	Assert.equal(TaskInputFactory.acceptsHistory('llm_qwen3_5_0_8b_full'), true);
	Assert.equal(TaskInputFactory.acceptsHistory('llm_llama3_2_1b_full'), true);
	Assert.equal(TaskInputFactory.acceptsHistory('llm_qwen3_0_6b_sharded'), false);
	Assert.equal(TaskInputFactory.acceptsHistory('llm_gemma_nano_chrome_full'), false);
	Assert.equal(TaskInputFactory.acceptsHistory('dev_formula'), false);

	const history = { messages: [{ role: 'user' as const, content: 'What is the capital of France?' }] };
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_5_0_8b_full', history), { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: history });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_llama3_2_1b_full', history), { taskType: 'task_type_llm_llama3_2_1b_full', input: history });
	// A task type that only takes a prompt refuses a history plainly, rather than reading
	// some part of it or silently dropping the rest.
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', history), /takes a single prompt, not a whole history/);
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', history), /takes a single prompt, not a whole history/);
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', history), /takes a single prompt, not a whole history/);
});

Test('carries the generation settings a consumer asked for, and refuses one the task type cannot honour', () => {
	// A submission that asks for nothing carries no settings field at all, so it stays exactly
	// the submission this client sent before generation settings existed.
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello'), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello', { isStreaming: true }), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { isStreaming: true } });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', 'hello', { isStreaming: true }), { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello', generationSettings: { isStreaming: true } });
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', '5', { isStreaming: true }), /cannot produce its answer in pieces/);
	Assert.deepEqual(TaskInputFactory.createTaskInput('dev_formula', '5', { isStreaming: false }), { taskType: 'task_type_dev_formula', input: 5, generationSettings: { isStreaming: false } });
});

Test('registers and submits through the shared client', () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data) => sent.push(data),
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	/** Reads one frame this client sent, and checks the wrapper it travelled in. */
	const sentFrame = (index: number): { v: number; id: string; ts: string; body: Record<string, unknown> } => {
		const frame = JSON.parse(sent[index]) as { v: number; id: string; ts: string; body: Record<string, unknown> };
		Assert.equal(frame.v, protocolVersion);
		Assert.ok(frame.id.length > 0);
		Assert.ok(Number.isFinite(Date.parse(frame.ts)));
		return frame;
	};
	/** Wraps a gateway message the way the gateway does, so the client can read it. */
	const gatewayFrame = (body: unknown, inReplyToMessageId?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }), body });

	const client = new ConsumerClient(socket, {}, 'formula-consumer');
	socket.onopen?.();
	const authenticateFrame = sentFrame(0);
	Assert.deepEqual(authenticateFrame.body, { type: 'deviceAuthenticate', token: 'development-token' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	const registerFrame = sentFrame(1);
	Assert.deepEqual(registerFrame.body, { type: 'deviceRegister', role: 'consumer', name: 'formula-consumer' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceRegistered', deviceId: 'device-1' }, registerFrame.id) });
	client.submit({ taskType: 'task_type_dev_formula', input: 5 }, 'request-formula-1');
	const submitFrame = sentFrame(2);
	Assert.deepEqual(submitFrame.body, { type: 'task.submit', taskRequestId: 'request-formula-1', input: { taskType: 'task_type_dev_formula', input: 5 } });
	client.cancel('task-1', 'the caller went away');
	Assert.deepEqual(sentFrame(3).body, { type: 'task.cancel', taskId: 'task-1', reason: 'the caller went away' });
	// Each frame carries its own identifier, so two requests of the same kind can be told apart.
	Assert.notEqual(authenticateFrame.id, registerFrame.id);
	Assert.notEqual(registerFrame.id, submitFrame.id);
});

Test('reports an error the gateway sent with its code and its request identifier', () => {
	const errors: ProtocolError[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: () => undefined,
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	new ConsumerClient(socket, { onError: (error) => errors.push(error) });
	const gatewayError: ProtocolError = { type: 'error', code: 'RATE_LIMITED', message: 'The authIdentity has reached its active-task limit', taskRequestId: 'request-formula-1', retryable: true };
	socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: 'message-1', ts: new Date().toISOString(), body: gatewayError }) });
	Assert.deepEqual(errors, [gatewayError]);

	// A failure the client noticed itself is reported in the same shape, so a caller reading
	// the callback handles one shape rather than two.
	socket.onmessage?.({ data: 'not json at all' });
	Assert.deepEqual(errors[1], { type: 'error', code: 'INVALID_MESSAGE', message: 'The central gateway sent invalid data' });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DeviceAvailability
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('reads whether a worker device may take on another assignment', () => {
	const baseDevice: Device = {
		deviceId: 'worker-1', name: 'Worker 1', deviceRole: 'worker', stageNames: ['stage_a'],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
	};
	Assert.equal(DeviceAvailability.isAvailable(baseDevice), true);
	Assert.equal(DeviceAvailability.availableCapacity(baseDevice), 1);

	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, workerState: 'draining' }), false);
	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, ready: false }), false);
	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, maxConcurrentAssignments: 2, activeAssignments: 2 }), false);
	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, maxConcurrentAssignments: 2, activeAssignments: 1 }), true);

	Assert.equal(DeviceAvailability.availableCapacity({ ...baseDevice, maxConcurrentAssignments: 3, activeAssignments: 1 }), 2);
	Assert.equal(DeviceAvailability.availableCapacity({ ...baseDevice, workerState: 'draining', maxConcurrentAssignments: 3 }), 0);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCalculator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('estimates a sharded pipeline from its bottleneck shard, not from workers advertising every shard', () => {
	const shardStages = ['stage_llm_qwen3_0_6b_shard1of3', 'stage_llm_qwen3_0_6b_shard2of3', 'stage_llm_qwen3_0_6b_shard3of3'];
	const pipeline: PipelineSpecification = {
		pipelineId: 'llm_qwen3_0_6b_sharded', version: 1, taskType: 'task_type_llm_qwen3_0_6b_sharded', repeatsUntilDone: true,
		stages: shardStages.map((name) => ({ name, computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true })),
	};
	/** A worker device with the given stages, one free slot, connected and last seen at a fixed time. */
	const worker = (deviceId: string, stageNames: string[]): Device => ({
		deviceId, name: deviceId, deviceRole: 'worker', stageNames,
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 1, activeAssignments: 0,
	});
	// Each worker advertises one shard and nothing else, which is how the three shards are
	// actually deployed: prefersSameWorkerOnRetry sends each shard back to the worker that ran
	// that same shard, so the three shards never have to share one worker. 2 workers advertise
	// the first shard, 3 the second, 1 the third, so the third shard is the bottleneck.
	const devices: Device[] = [
		worker('worker-1', [shardStages[0] as string]), worker('worker-2', [shardStages[0] as string]),
		worker('worker-3', [shardStages[1] as string]), worker('worker-4', [shardStages[1] as string]), worker('worker-5', [shardStages[1] as string]),
		worker('worker-6', [shardStages[2] as string]),
	];
	const result = CapacityCalculator.calculate(pipeline, devices);
	Assert.equal(result.capacity, 1);
	Assert.equal(result.reason, 'stage_llm_qwen3_0_6b_shard3of3 is the narrowest stage of the pipeline, with 1 free slot across 1 worker');
});

Test('estimates a sharded pipeline running entirely on one worker as that worker\'s free capacity', () => {
	const shardStages = ['stage_llm_qwen3_0_6b_shard1of3', 'stage_llm_qwen3_0_6b_shard2of3', 'stage_llm_qwen3_0_6b_shard3of3'];
	const pipeline: PipelineSpecification = {
		pipelineId: 'llm_qwen3_0_6b_sharded', version: 1, taskType: 'task_type_llm_qwen3_0_6b_sharded', repeatsUntilDone: true,
		stages: shardStages.map((name) => ({ name, computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true })),
	};
	// One worker advertising all three shards with two free slots can host two concurrent runs,
	// because every shard of a run may be placed back on it.
	const devices: Device[] = [
		{
			deviceId: 'worker-1', name: 'worker-1', deviceRole: 'worker', stageNames: shardStages,
			connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
			maxConcurrentAssignments: 2, activeAssignments: 0,
		},
	];
	const result = CapacityCalculator.calculate(pipeline, devices);
	Assert.equal(result.capacity, 2);
});

Test('estimates independent-stage capacity as the bottleneck stage\'s free capacity', () => {
	const pipeline: PipelineSpecification = {
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
			{ name: 'stage_dev_formula_add', computation: 'dev_formula_add', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	};
	/** A worker device advertising one stage, with one free slot. */
	const worker = (deviceId: string, stageName: string): Device => ({
		deviceId, name: deviceId, deviceRole: 'worker', stageNames: [stageName],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 1, activeAssignments: 0,
	});
	// 7 workers can run the multiply stage, only 3 can run the add stage — each stage can run on
	// a different worker, so the add stage's 3 free slots are what limits the whole pipeline.
	const devices: Device[] = [
		...Array.from({ length: 7 }, (_, index) => worker(`multiply-${index}`, 'stage_dev_formula_multiply')),
		...Array.from({ length: 3 }, (_, index) => worker(`add-${index}`, 'stage_dev_formula_add')),
	];
	const result = CapacityCalculator.calculate(pipeline, devices);
	Assert.equal(result.capacity, 3);
	Assert.equal(result.reason, 'stage_dev_formula_add is the narrowest stage of the pipeline, with 3 free slots across 3 workers');
});

Test('tells a stage nobody runs apart from a stage whose every worker is too busy to take it', () => {
	const pipeline: PipelineSpecification = {
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
			{ name: 'stage_dev_formula_add', computation: 'dev_formula_add', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	};
	/** A worker device advertising one stage, with as many free slots as asked for. */
	const worker = (deviceId: string, stageName: string, activeAssignments: number): Device => ({
		deviceId, name: deviceId, deviceRole: 'worker', stageNames: [stageName],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 1, activeAssignments,
	});

	// Nobody at all runs the add stage, whatever the multiply stage has behind it.
	const noWorkerAtAll = CapacityCalculator.calculate(pipeline, [worker('multiply-0', 'stage_dev_formula_multiply', 0)]);
	Assert.equal(noWorkerAtAll.capacity, 0);
	Assert.equal(noWorkerAtAll.reason, 'no connected worker runs stage stage_dev_formula_add');

	// Both stages are unrun, so both are named rather than only the first.
	const noWorkersAtAll = CapacityCalculator.calculate(pipeline, []);
	Assert.equal(noWorkersAtAll.reason, 'no connected worker runs stages stage_dev_formula_multiply, stage_dev_formula_add');

	// Two workers do run the add stage, and both are already at their concurrency limit, which
	// is a different problem from nobody running it and is stated as one.
	const allBusy = CapacityCalculator.calculate(pipeline, [
		worker('multiply-0', 'stage_dev_formula_multiply', 0),
		worker('add-0', 'stage_dev_formula_add', 1), worker('add-1', 'stage_dev_formula_add', 1),
	]);
	Assert.equal(allBusy.capacity, 0);
	Assert.equal(allBusy.reason, 'every one of the 2 workers running stage_dev_formula_add is busy, draining, or not ready');
});

Test('says so plainly when every stage of the pipeline is equally free', () => {
	const shardStages = ['stage_llm_qwen3_0_6b_shard1of3', 'stage_llm_qwen3_0_6b_shard2of3', 'stage_llm_qwen3_0_6b_shard3of3'];
	const pipeline: PipelineSpecification = {
		pipelineId: 'llm_qwen3_0_6b_sharded', version: 1, taskType: 'task_type_llm_qwen3_0_6b_sharded', repeatsUntilDone: true,
		stages: shardStages.map((name) => ({ name, computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true })),
	};
	// One worker per shard, one free slot each: no shard is narrower than the others, so naming
	// one of them as the bottleneck would be an arbitrary choice presented as a finding.
	const devices: Device[] = shardStages.map((stageName, index) => ({
		deviceId: `worker-${index}`, name: `worker-${index}`, deviceRole: 'worker', stageNames: [stageName],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 1, activeAssignments: 0,
	}));
	const result = CapacityCalculator.calculate(pipeline, devices);
	Assert.equal(result.capacity, 1);
	Assert.equal(result.reason, 'every one of the 3 stages of the pipeline has 1 free slot behind it');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClusterCapacityReader
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// `capacity` with no `-t/--task_type` estimates every task type from the one snapshot the
// connection already fetches, and `consumer_openai` reads the same estimates to decide which
// models it may offer. See https://github.com/webai-at-home/webai-at-home/issues/177.
Test('estimates every task type from one snapshot, and reports an unserved task type as zero', () => {
	const pipeline: PipelineSpecification = {
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	};
	const devices: Device[] = [{
		deviceId: 'worker-1', name: 'worker-1', deviceRole: 'worker', stageNames: ['stage_dev_formula_multiply'],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 2, activeAssignments: 0,
	}];

	const results = ClusterCapacityReader.estimate([pipeline], devices);
	Assert.equal(results.length, taskTypeNames.length);
	Assert.deepEqual(results.map((result) => result.type), [...taskTypeNames]);

	const devFormula = results.find((result) => result.type === 'dev_formula');
	Assert.equal(devFormula?.capacity, 2);
	Assert.equal(devFormula?.pipelineId, 'dev_formula');

	// Every other task type has no pipeline registered in this snapshot, which is a capacity of
	// zero rather than a failure: one unserved task type must not stop the whole list.
	for (const result of results.filter((candidate) => candidate.type !== 'dev_formula')) {
		Assert.equal(result.capacity, 0);
		Assert.equal(result.pipelineId, undefined);
		Assert.equal(result.reason, 'no pipeline is registered for this task type');
	}

	// A retired pipeline serves nobody, and the highest version wins among those that remain.
	const retired: PipelineSpecification = { ...pipeline, version: 2, retired: true };
	Assert.equal(ClusterCapacityReader.estimate([pipeline, retired], devices, ['dev_formula'])[0]?.pipelineVersion, 1);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ObserverClient
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('tracks the live device list an observer connection reports', () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1, OPEN: 1, send: (data) => sent.push(data), close: () => undefined,
		onopen: null, onmessage: null, onerror: null, onclose: null,
	};
	/** Wraps a gateway message the way the gateway does, so the client can read it. */
	const gatewayFrame = (body: unknown, inReplyToMessageId?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }), body });

	const snapshots: Device[][] = [];
	new ObserverClient(socket, { onDevices: (devices) => snapshots.push(devices) }, 'observer-token');
	socket.onopen?.();
	const authenticateFrame = JSON.parse(sent[0] as string) as { id: string; body: Record<string, unknown> };
	Assert.deepEqual(authenticateFrame.body, { type: 'deviceAuthenticate', token: 'observer-token' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	Assert.deepEqual((JSON.parse(sent[1] as string) as { body: unknown }).body, { type: 'observe' });

	const worker: Device = {
		deviceId: 'worker-1', name: 'Worker 1', deviceRole: 'worker', stageNames: ['stage_a'],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 2, activeAssignments: 0,
	};
	socket.onmessage?.({ data: gatewayFrame({ type: 'devices', devices: [worker], deviceListRevision: 1 }) });
	Assert.deepEqual(snapshots[0], [worker]);

	const joinedWorker: Device = { ...worker, deviceId: 'worker-2', name: 'Worker 2' };
	socket.onmessage?.({ data: gatewayFrame({ type: 'device.joined', device: joinedWorker, deviceListRevision: 2 }) });
	Assert.deepEqual(snapshots[1]?.map((device) => device.deviceId), ['worker-1', 'worker-2']);

	// Only the changed activity fields are merged in, so a field an activity message left out
	// keeps the value the stored device already had — here, its stage list and concurrency limit.
	socket.onmessage?.({ data: gatewayFrame({ type: 'device.activity', devices: [{ deviceId: 'worker-1', lastSeenAt: '2026-01-01T00:01:00.000Z', activeAssignments: 1 }], deviceListRevision: 3 }) });
	const updatedWorker = snapshots[2]?.find((device) => device.deviceId === 'worker-1');
	Assert.equal(updatedWorker?.activeAssignments, 1);
	Assert.equal(updatedWorker?.maxConcurrentAssignments, 2);
	Assert.deepEqual(updatedWorker?.stageNames, ['stage_a']);

	socket.onmessage?.({ data: gatewayFrame({ type: 'device.left', deviceId: 'worker-2', deviceListRevision: 4 }) });
	Assert.deepEqual(snapshots[3]?.map((device) => device.deviceId), ['worker-1']);
});

Test('requests and reports the registered pipelines when asked to', () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1, OPEN: 1, send: (data) => sent.push(data), close: () => undefined,
		onopen: null, onmessage: null, onerror: null, onclose: null,
	};
	const gatewayFrame = (body: unknown, inReplyToMessageId?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }), body });

	const pipelinesReceived: PipelineSpecification[][] = [];
	new ObserverClient(socket, { onPipelines: (pipelines) => pipelinesReceived.push(pipelines) }, 'observer-token', true);
	socket.onopen?.();
	const authenticateFrame = JSON.parse(sent[0] as string) as { id: string };
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	Assert.deepEqual((JSON.parse(sent[1] as string) as { body: unknown }).body, { type: 'observe' });
	Assert.deepEqual((JSON.parse(sent[2] as string) as { body: unknown }).body, { type: 'pipelines.get' });

	const pipeline: PipelineSpecification = {
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' }],
	};
	socket.onmessage?.({ data: gatewayFrame({ type: 'pipelines', pipelines: [pipeline] }) });
	Assert.deepEqual(pipelinesReceived, [[pipeline]]);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Public Exports
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// This resolves `@webai/consumer-cli` through its package.json `exports` field, into the
// built `dist/index.js`, exactly as a package outside this one would import it, so it is a
// separate loaded module from the `../src/...` imports above rather than the same class —
// hence checking what it does, rather than reference-comparing it to the `src` version.
// Running this test therefore needs `npm run build --workspace @webai/consumer-cli` to have
// run first, the same requirement `@webai/consumer_openai` already has on this package.
Test('exposes the reusable consumer symbols through the package entry point after a build', () => {
	Assert.deepEqual(ConsumerCli.taskTypeNames, taskTypeNames);
	Assert.deepEqual(ConsumerCli.taskTypeNamesAcceptingHistory, taskTypeNamesAcceptingHistory);
	Assert.deepEqual(ConsumerCli.TaskInputFactory.createTaskInput('dev_formula', '5'), { taskType: 'task_type_dev_formula', input: 5 });

	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: () => undefined,
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	Assert.ok(new ConsumerCli.ConsumerClient(socket, {}, 'built-consumer') instanceof ConsumerCli.ConsumerClient);
	Assert.equal('Cli' in ConsumerCli, false);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The account commands
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** A temporary path for one test's key pair, so no test touches the user's own. */
const newKeyFilePath = (): string => Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), 'consumer-cli-account-')), 'account_key.json');

/**
 * A connection that answers this program the way the central gateway does.
 *
 * Every answer carries the identifier of the frame it answers, which is what the client matches on,
 * so a test states only what the gateway would say to each message type.
 */
const newAnsweringSocket = (answerFor: (message: ClientMessage) => GatewayMessage | undefined): { socket: TaskSocket; sent: ClientMessage[] } => {
	const sent: ClientMessage[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data: string): void => {
			const frame = JSON.parse(data) as { id: string; body: ClientMessage };
			sent.push(frame.body);
			const answer = answerFor(frame.body);
			if (answer === undefined) return;
			setImmediate(() => socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: 'message-answer', ts: new Date().toISOString(), inReplyToMessageId: frame.id, body: answer }) }));
		},
		close: (): void => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	// The client assigns onopen while it waits, so opening is announced after that assignment.
	setImmediate(() => socket.onopen?.());
	return { socket, sent };
};

/** Collects everything a command prints, so a test can read what a user would see. */
const captureConsoleOutput = async (run: () => Promise<void>): Promise<string> => {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...values: unknown[]): void => { lines.push(values.map((value) => String(value)).join(' ')); };
	try {
		await run();
	} finally {
		console.log = original;
	}
	return lines.join('\n');
};

Test('generating a key pair writes it readable by its owner only, and never overwrites one by accident', async () => {
	const keyFilePath = newKeyFilePath();
	const first = await AccountKeyFile.create(keyFilePath, false);

	// The account identifier is a digest of the public key, so it can be derived again from the file.
	Assert.equal(first.accountId, await AccountIdentity.accountIdFor(first.publicKeySpkiBase64));
	Assert.match(first.accountId, /^account-[0-9a-f]{32}$/);
	Assert.equal(first.signatureAlgorithmName, 'Ed25519');

	// The private key in this file is the whole account, so nobody but its owner may read it.
	Assert.equal((Fs.statSync(keyFilePath).mode & 0o777).toString(8), '600');

	// Overwriting it loses the account, so it has to be asked for.
	await Assert.rejects(async () => AccountKeyFile.create(keyFilePath, false), /Overwriting it loses the account/);
	const forced = await AccountKeyFile.create(keyFilePath, true);
	Assert.notEqual(forced.accountId, first.accountId);
});

Test('a key pair read back from its file signs a challenge its own public key verifies', async () => {
	const keyFilePath = newKeyFilePath();
	const stored = await AccountKeyFile.create(keyFilePath, false);
	const loaded = await AccountKeyFile.read(keyFilePath);

	Assert.equal(loaded.stored.accountId, stored.accountId);
	const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', loaded.privateKey, 'a challenge the gateway handed out');
	Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64: stored.publicKeySpkiBase64, challenge: 'a challenge the gateway handed out', signatureBase64 }), true);
});

Test('a missing key pair, and one written by a version this program cannot read, are both explained', async () => {
	const keyFilePath = newKeyFilePath();
	await Assert.rejects(async () => AccountKeyFile.read(keyFilePath), /No account key pair is kept at .*account_key\.json\. Run "consumer_cli account_key"/);


	await AccountKeyFile.create(keyFilePath, false);
	const stored = JSON.parse(Fs.readFileSync(keyFilePath, 'utf8')) as { schemaVersion: number };
	Fs.writeFileSync(keyFilePath, JSON.stringify({ ...stored, schemaVersion: 99 }), 'utf8');
	await Assert.rejects(async () => AccountKeyFile.read(keyFilePath), /states schema version 99, which this program cannot read/);
});

Test('the account commands accept the formats and directions they advertise, and no others', () => {
	Assert.deepEqual(accountOutputFormats, ['text', 'json']);
	Assert.equal(AccountOutputFormatter.isFormat('text'), true);
	Assert.equal(AccountOutputFormatter.isFormat('json'), true);
	Assert.equal(AccountOutputFormatter.isFormat('markdown'), false);

	Assert.deepEqual(accountHistoryDirections, ['earned', 'spent', 'both']);
	Assert.equal(AccountHistoryCommand.isDirection('earned'), true);
	Assert.equal(AccountHistoryCommand.isDirection('sideways'), false);
});

Test('the account client presents the token, then proves which account is on the connection', async () => {
	const keyFilePath = newKeyFilePath();
	const stored = await AccountKeyFile.create(keyFilePath, false);
	let signatureBase64 = '';
	const { socket, sent } = newAnsweringSocket((message) => {
		if (message.type === 'deviceAuthenticate') return { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.challenge.request') return { type: 'account.challenge', challenge: 'c0ffee', expiresAt: new Date(Date.now() + 60_000).toISOString() };
		if (message.type === 'account.authenticate') {
			signatureBase64 = message.signatureBase64;
			return { type: 'account.authenticated', accountId: message.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		}
		return undefined;
	});
	const client = new AccountClient({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, socketFactory: (): TaskSocket => socket });
	await client.connect();
	const accountId = await client.authenticateAccount();

	Assert.equal(accountId, stored.accountId);
	Assert.deepEqual(sent.map((message) => message.type), ['deviceAuthenticate', 'account.challenge.request', 'account.authenticate']);

	// The signature it sent is a real signature over the challenge it was handed, by this key pair.
	Assert.equal(await AccountIdentity.verifyChallengeSignature({ signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64: stored.publicKeySpkiBase64, challenge: 'c0ffee', signatureBase64 }), true);
});

Test('an error the gateway sends fails the command with the exit code that error deserves', async () => {
	const keyFilePath = newKeyFilePath();
	await AccountKeyFile.create(keyFilePath, false);
	const { socket } = newAnsweringSocket((message) => {
		if (message.type === 'deviceAuthenticate') return { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.challenge.request') return { type: 'account.challenge', challenge: 'c0ffee', expiresAt: new Date(Date.now() + 60_000).toISOString() };
		if (message.type === 'account.authenticate') return { type: 'error', code: 'ACCOUNT_NOT_FOUND', message: 'Register this account before authenticating as it', retryable: false };
		return undefined;
	});
	const client = new AccountClient({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, socketFactory: (): TaskSocket => socket });
	await client.connect();

	// An unregistered account is told what to do about it, rather than only what went wrong.
	await Assert.rejects(async () => client.authenticateAccount(), (error: unknown) => {
		Assert.equal(error instanceof CliError, true);
		Assert.match((error as CliError).message, /Run "consumer_cli account_register" first/);
		return true;
	});
});

Test('account_balance prints what the account holds, as lines or as JSON', async () => {
	const keyFilePath = newKeyFilePath();
	const stored = await AccountKeyFile.create(keyFilePath, false);
	const answerFor = (message: ClientMessage): GatewayMessage | undefined => {
		if (message.type === 'deviceAuthenticate') return { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.challenge.request') return { type: 'account.challenge', challenge: 'c0ffee', expiresAt: new Date(Date.now() + 60_000).toISOString() };
		if (message.type === 'account.authenticate') return { type: 'account.authenticated', accountId: stored.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.balance.get') return { type: 'account.balance', summary: { accountId: stored.accountId, balance: 12, earnedStageCount: 14, spentStageCount: 2 } };
		return undefined;
	};

	const text = await captureConsoleOutput(async () => AccountBalanceCommand.run({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, format: 'text', socketFactory: (): TaskSocket => newAnsweringSocket(answerFor).socket }));
	Assert.match(text, /balance {2,}\+12 credit\(s\)/);
	Assert.match(text, /stages completed as a worker {2,}14/);
	Assert.match(text, /stages run as a consumer {2,}2/);

	const json = await captureConsoleOutput(async () => AccountBalanceCommand.run({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, format: 'json', socketFactory: (): TaskSocket => newAnsweringSocket(answerFor).socket }));
	Assert.deepEqual(JSON.parse(json), { accountId: stored.accountId, balance: 12, earnedStageCount: 14, spentStageCount: 2 });
});

Test('account_history prints one side of the ledger newest first, and says when more is left unread', async () => {
	const keyFilePath = newKeyFilePath();
	const stored = await AccountKeyFile.create(keyFilePath, false);
	const entry = (ledgerEntryId: string, creditDelta: 1 | -1, stageName: string, recordedAt: string): LedgerEntry => ({
		ledgerEntryId,
		recordedAt,
		accountId: stored.accountId,
		creditDelta,
		taskId: 'task-1',
		stageName: stageName as LedgerEntry['stageName'],
		stageAssignmentId: 'stageAssignment-1',
		workerDeviceId: 'device-worker',
		consumerDeviceId: 'device-consumer',
		stageDurationMs: 7,
	});
	const pages: Record<string, Extract<GatewayMessage, { type: 'account.ledger' }>> = {
		first: { type: 'account.ledger', accountId: stored.accountId, direction: 'earned', entries: [entry('ledgerEntry-2', 1, 'stage_dev_formula_add', '2026-08-05T12:00:02.000Z')], nextCursor: 'ledgerEntry-2' },
		second: { type: 'account.ledger', accountId: stored.accountId, direction: 'earned', entries: [entry('ledgerEntry-1', 1, 'stage_dev_formula_multiply', '2026-08-05T12:00:01.000Z')] },
	};
	const answerFor = (message: ClientMessage): GatewayMessage | undefined => {
		if (message.type === 'deviceAuthenticate') return { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.challenge.request') return { type: 'account.challenge', challenge: 'c0ffee', expiresAt: new Date(Date.now() + 60_000).toISOString() };
		if (message.type === 'account.authenticate') return { type: 'account.authenticated', accountId: stored.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.ledger.get') return message.before === undefined ? pages.first : pages.second;
		return undefined;
	};

	// One page asked for, and the gateway holds more: the command says so rather than looking complete.
	const onePage = await captureConsoleOutput(async () => AccountHistoryCommand.run({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, direction: 'earned', limit: 1, isEverythingRequested: false, format: 'text', socketFactory: (): TaskSocket => newAnsweringSocket(answerFor).socket }));
	Assert.match(onePage, /earned, newest first/);
	Assert.match(onePage, /\+1 {2,}stage_dev_formula_add/);
	Assert.equal(onePage.includes('stage_dev_formula_multiply'), false);
	Assert.match(onePage, /Further entries exist/);

	// Asked for everything, it follows the cursor until the gateway offers none.
	const everything = await captureConsoleOutput(async () => AccountHistoryCommand.run({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, direction: 'earned', limit: 1, isEverythingRequested: true, format: 'json', socketFactory: (): TaskSocket => newAnsweringSocket(answerFor).socket }));
	const printed = JSON.parse(everything) as { entries: LedgerEntry[]; isMoreLeftUnread: boolean };
	Assert.deepEqual(printed.entries.map((item) => item.stageName), ['stage_dev_formula_add', 'stage_dev_formula_multiply']);
	Assert.equal(printed.isMoreLeftUnread, false);
});

Test('an account with no entries is told so plainly, rather than shown an empty table', async () => {
	const keyFilePath = newKeyFilePath();
	const stored = await AccountKeyFile.create(keyFilePath, false);
	const answerFor = (message: ClientMessage): GatewayMessage | undefined => {
		if (message.type === 'deviceAuthenticate') return { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.challenge.request') return { type: 'account.challenge', challenge: 'c0ffee', expiresAt: new Date(Date.now() + 60_000).toISOString() };
		if (message.type === 'account.authenticate') return { type: 'account.authenticated', accountId: stored.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'account.ledger.get') return { type: 'account.ledger', accountId: stored.accountId, direction: 'spent', entries: [] };
		return undefined;
	};

	const text = await captureConsoleOutput(async () => AccountHistoryCommand.run({ url: 'ws://gateway.test', authToken: 'test-token', timeoutMs: 1_000, keyFilePath, direction: 'spent', limit: 20, isEverythingRequested: false, format: 'text', socketFactory: (): TaskSocket => newAnsweringSocket(answerFor).socket }));
	Assert.equal(text, `${stored.accountId} has no spent accounting entries yet.`);
});

Test('a consumer holding a key pair proves its account before it registers, so nothing is submitted anonymously', async () => {
	const keyFilePath = newKeyFilePath();
	const stored = await AccountKeyFile.create(keyFilePath, false);
	const accountKeyPair = await AccountKeyFile.readIfPresent(keyFilePath);
	const sent: ClientMessage[] = [];
	let settledAccountId: string | undefined | 'not settled' = 'not settled';

	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data: string): void => {
			const message = (JSON.parse(data) as { body: ClientMessage }).body;
			sent.push(message);
			const answer = message.type === 'deviceAuthenticate' ? { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
				: message.type === 'account.register' ? { type: 'account.registered', account: { accountId: stored.accountId, signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64: stored.publicKeySpkiBase64, emailAddress: '', displayName: '', createdAt: stored.createdAt }, isNewAccount: true }
				: message.type === 'account.challenge.request' ? { type: 'account.challenge', challenge: 'c0ffee', expiresAt: new Date(Date.now() + 60_000).toISOString() }
				: message.type === 'account.authenticate' ? { type: 'account.authenticated', accountId: stored.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
				: message.type === 'deviceRegister' ? { type: 'deviceRegistered', deviceId: 'device-test' }
				: undefined;
			if (answer === undefined) return;
			setImmediate(() => socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: 'message-answer', ts: new Date().toISOString(), body: answer }) }));
		},
		close: (): void => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};

	const client = new ConsumerClient(socket, { onAccountSettled: (accountId) => { settledAccountId = accountId; } }, 'consumer-one', 'test-token', accountKeyPair);
	socket.onopen?.();
	for (let attempt = 0; attempt < 100 && settledAccountId === 'not settled'; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	// Registration is what lets a task be submitted, so proving the account has to come first: a task
	// submitted before it would have its stages recorded against the shared development account.
	Assert.deepEqual(sent.map((message) => message.type), ['deviceAuthenticate', 'account.register', 'account.challenge.request', 'account.authenticate', 'deviceRegister']);
	Assert.equal(settledAccountId, stored.accountId);
	Assert.equal(client instanceof ConsumerClient, true);
});

Test('a consumer holding no key pair registers straight away, and says its work is recorded against nobody', async () => {
	const keyFilePath = newKeyFilePath();
	Assert.equal(await AccountKeyFile.readIfPresent(keyFilePath), undefined);
	const sent: ClientMessage[] = [];

	const { socket } = newAnsweringSocket((message) => {
		sent.push(message);
		if (message.type === 'deviceAuthenticate') return { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
		if (message.type === 'deviceRegister') return { type: 'deviceRegistered', deviceId: 'device-test' };
		return undefined;
	});
	let registeredDeviceId: string | undefined;
	let isAccountSettledWithNone = false;
	new ConsumerClient(socket, {
		onRegistered: (deviceId) => { registeredDeviceId = deviceId; },
		onAccountSettled: (accountId) => { isAccountSettledWithNone = accountId === undefined; },
	}, 'consumer-one', 'test-token', undefined);
	for (let attempt = 0; attempt < 100 && registeredDeviceId === undefined; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	// Nobody is stopped from contributing or consuming for want of an account.
	Assert.deepEqual(sent.map((message) => message.type), ['deviceAuthenticate', 'deviceRegister']);
	Assert.equal(registeredDeviceId, 'device-test');

	// The caller is told which of the two happened, rather than only hearing when there is an account.
	Assert.equal(isAccountSettledWithNone, true);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Worker Address In `status`
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reaches the two steps `status` takes with a device list, both of which are private to
 * `StatusCommand` because nothing outside it builds or writes a snapshot in the running program.
 */
const statusCommandInternals = StatusCommand as unknown as {
	_buildSnapshot: (devices: Device[], gatewayUrl: string) => { gatewayUrl: string; workers: { name: string; ipAddress: string }[] };
	_format: (snapshot: unknown, format: StatusFormat) => string;
};

/** One connected worker, as the gateway describes it to `status`. */
const statusWorker = (name: string, ipAddress?: string): Device => ({
	deviceId: `device-${name}`,
	name,
	deviceRole: 'worker',
	stageNames: ['stage_dev_formula_multiply'],
	connectedAt: '2026-01-01T00:00:00.000Z',
	lastSeenAt: '2026-01-01T00:00:00.000Z',
	workerState: 'ready',
	ready: true,
	maxConcurrentAssignments: 1,
	activeAssignments: 0,
	...(ipAddress === undefined ? {} : { ipAddress }),
});

Test('a status snapshot carries the address the gateway observed for each worker', () => {
	const snapshot = statusCommandInternals._buildSnapshot([statusWorker('worker-one', '203.0.113.7')], 'ws://localhost:8080');

	Assert.equal(snapshot.workers[0]?.ipAddress, '203.0.113.7');
});

Test('a worker the gateway recorded no address for reads as no address, rather than as a missing field', () => {
	const snapshot = statusCommandInternals._buildSnapshot([statusWorker('worker-one')], 'ws://localhost:8080');

	Assert.equal(snapshot.workers[0]?.ipAddress, '');
});

Test('every status format writes the address of each worker', () => {
	const snapshot = statusCommandInternals._buildSnapshot([statusWorker('worker-one', '203.0.113.7')], 'ws://localhost:8080');

	const text = statusCommandInternals._format(snapshot, 'text');
	Assert.equal(text.includes('IP ADDRESS'), true);
	Assert.equal(text.includes('203.0.113.7'), true);

	const markdown = statusCommandInternals._format(snapshot, 'markdown');
	Assert.equal(markdown.includes('| NAME | IP ADDRESS | STATE | CAPACITY | STAGES |'), true);
	Assert.equal(markdown.includes('| worker-one | 203.0.113.7 | ready | 0/1 | stage_dev_formula_multiply |'), true);

	Assert.equal((JSON.parse(statusCommandInternals._format(snapshot, 'json')) as { workers: { ipAddress: string }[] }).workers[0]?.ipAddress, '203.0.113.7');
});

Test('every status format writes the address of the central gateway the snapshot was read from', () => {
	const snapshot = statusCommandInternals._buildSnapshot([statusWorker('worker-one', '203.0.113.7')], 'ws://localhost:8080');

	Assert.equal(snapshot.gatewayUrl, 'ws://localhost:8080');
	Assert.equal(statusCommandInternals._format(snapshot, 'text').includes('gateway ws://localhost:8080'), true);
	Assert.equal(statusCommandInternals._format(snapshot, 'markdown').includes('gateway ws://localhost:8080'), true);
	Assert.equal((JSON.parse(statusCommandInternals._format(snapshot, 'json')) as { gatewayUrl: string }).gatewayUrl, 'ws://localhost:8080');
});

Test('a worker with no observed address is written as a dash in both tables, and as an empty address in JSON', () => {
	const snapshot = statusCommandInternals._buildSnapshot([statusWorker('worker-one')], 'ws://localhost:8080');

	Assert.equal(statusCommandInternals._format(snapshot, 'text').includes('worker-one  -         '), true);
	Assert.equal(statusCommandInternals._format(snapshot, 'markdown').includes('| worker-one | - | ready | 0/1 |'), true);
	Assert.equal((JSON.parse(statusCommandInternals._format(snapshot, 'json')) as { workers: { ipAddress: string }[] }).workers[0]?.ipAddress, '');
});
