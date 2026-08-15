// node imports
import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Http from 'node:http';
import Path from 'node:path';
import Os from 'node:os';
import Test from 'node:test';

// local imports
import { MessageLogger } from '@webai/protocol/message_logger';
import { ClientIpAddress } from '../src/connection/client_ip_address.js';
import { ConnectionHub } from '../src/connection/connection_hub.js';
import { DeviceAnnouncer } from '../src/device/device_announcer.js';
import { HttpRoutes } from '../src/connection/http_routes.js';
import type { PageDevServer } from '../src/connection/http_routes.js';
import { DeviceRegistry } from '../src/device/device_registry.js';
import { TaskStore } from '../src/task/task_store.js';
import { PipelineRegistry, builtinPipelineSpecifications } from '../src/task/pipeline_registry.js';
import { StagePolicyResolver } from '../src/task/stage_policy_resolver.js';
import { DiagnosticsRateLimiter } from '../src/libs/diagnostics_rate_limiter.js';
import { SessionRegistry } from '../src/task/session_registry.js';
import { AccountMessageHandler } from '../src/accounting/account_message_handler.js';
import { AccountRegistry } from '../src/accounting/account_registry.js';
import { ChallengeRegistry } from '../src/accounting/challenge_registry.js';
import { AccountingQueryHandler } from '../src/accounting/accounting_query_handler.js';
import { AccountingSummaryHandler } from '../src/accounting/accounting_summary_handler.js';
import { AccountingRecorder } from '../src/accounting/accounting_recorder.js';
import { LedgerStore } from '../src/accounting/ledger_store.js';
import type { LedgerEntryDraft } from '../src/accounting/ledger_store.js';
import { TaskScheduler } from '../src/task/task_scheduler.js';
import { ClientMessageHandler } from '../src/task/client_message_handler.js';
import { WorkerPlacement } from '../src/device/worker_placement.js';
import { Dashboard } from '../src/dashboard.js';
import { WebsocketHeartbeat } from '../src/connection/websocket_heartbeat.js';
import { AccountIdentity } from '@webai/protocol';
import type { AccountCryptoKeyPair, AccountProfile, ClientMessage, GatewayMessage, LedgerEntry, StageName, TaskInput } from '@webai/protocol';
import type { WebSocketServer } from 'ws';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const worker = (deviceId: string, stageNames: StageName[] = ['stage_dev_formula_multiply', 'stage_dev_formula_add']) => ({
	deviceId,
	name: `worker-${deviceId}`,
	deviceRole: 'worker' as const,
	stageNames,
	connectedAt: '2026-01-01T00:00:00.000Z',
	lastSeenAt: '2026-01-01T00:00:00.000Z',
});

/**
 * Creates a task the way the gateway does: by selecting a pipeline for the task input and
 * storing the stage sequence on the task. Every task carries a pipeline, so a task built
 * without one cannot be advanced.
 */
const createTask = (store: TaskStore, input: TaskInput, consumerDeviceId?: string, taskRequestId?: string) => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	const pipeline = registry.select(input)!;
	return store.create(input, consumerDeviceId, taskRequestId, undefined, {
		pipelineId: pipeline.pipelineId,
		pipelineVersion: pipeline.version,
		pipelineStages: pipeline.stages.map((stage) => stage.name),
		...(pipeline.repeatsUntilDone === true ? { pipelineRepeatsUntilDone: true } : {}),
	});
};

const consumer = (deviceId: string) => ({
	deviceId,
	name: `consumer-${deviceId}`,
	deviceRole: 'consumer' as const,
	stageNames: [] as [],
	connectedAt: '2026-01-01T00:00:00.000Z',
	lastSeenAt: '2026-01-01T00:00:00.000Z',
});

Test('dashboard payload keeps workers and consumers available as separate groups', () => {
	const devices = Dashboard.splitDevices([worker('one'), consumer('two')]);

	Assert.deepEqual(devices.worker.map((device) => device.deviceId), ['one']);
	Assert.deepEqual(devices.consumer.map((device) => device.deviceId), ['two']);
});

Test('calculates enabled-stage percentages using all advertised capabilities', () => {
	const statistics = Dashboard.stageStatistics([
		worker('one', ['stage_dev_formula_multiply', 'stage_dev_formula_add']),
		worker('two', ['stage_dev_formula_multiply']),
	]);

	Assert.equal(statistics.total, 3);
	Assert.deepEqual(statistics.stages.map(({ stageName, count, percentage }) => ({
		stageName,
		count,
		percentage: Number(percentage.toFixed(1)),
	})), [
		{ stageName: 'stage_dev_formula_add', count: 1, percentage: 33.3 },
		{ stageName: 'stage_dev_formula_multiply', count: 2, percentage: 66.7 },
	]);
});

Test('a display name only one device carries is shown on its own, and one two devices share carries each device identifier', () => {
	const labels = Dashboard.displayLabelByDeviceId([
		{ ...worker('device-1111111122222222'), name: 'llm-qwen3-0-6b-shard1of3' },
		{ ...worker('device-3333333344444444'), name: 'llm-qwen3-0-6b-shard1of3' },
		{ ...worker('device-5555555566666666'), name: 'llm-qwen3-0-6b-shard2of3' },
	]);

	Assert.equal(labels.get('device-1111111122222222'), 'llm-qwen3-0-6b-shard1of3 · 11111111');
	Assert.equal(labels.get('device-3333333344444444'), 'llm-qwen3-0-6b-shard1of3 · 33333333');
	Assert.equal(labels.get('device-5555555566666666'), 'llm-qwen3-0-6b-shard2of3');
});

Test('finds workers by capability and excludes devices', () => {
	const registry = new DeviceRegistry();
	registry.add(worker('one', ['stage_dev_formula_multiply']));
	registry.add(worker('two', ['stage_dev_formula_add']));

	Assert.equal(registry.findWorker('stage_dev_formula_multiply')?.deviceId, 'one');
	Assert.equal(registry.findWorker('stage_dev_formula_multiply', ['one']), undefined);
});

Test('two workers registered under the same display name are both kept, and removing one leaves the other', () => {
	const registry = new DeviceRegistry();
	registry.add({ ...worker('one'), name: 'llm-qwen3-0-6b-shard1of3' });
	registry.add({ ...worker('two'), name: 'llm-qwen3-0-6b-shard1of3' });

	Assert.deepEqual(registry.list().map((device) => device.deviceId), ['one', 'two']);
	Assert.equal(registry.findWorker('stage_dev_formula_multiply')?.deviceId, 'one');
	Assert.equal(registry.findWorker('stage_dev_formula_multiply', ['one'])?.deviceId, 'two');

	registry.remove('one');

	Assert.deepEqual(registry.list().map((device) => device.deviceId), ['two']);
});

Test('selects a pinned compatible pipeline version and rejects invalid definitions', () => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	Assert.equal(registry.select({ taskType: 'task_type_dev_formula', input: 5 })?.pipelineId, 'dev_formula');
	Assert.equal(registry.select({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' })?.pipelineId, 'llm_gemma_nano_chrome_full');
	Assert.equal(registry.select({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' })?.pipelineId, 'llm_qwen3_5_0_8b_full');
	Assert.equal(registry.select({ taskType: 'task_type_llm_llama3_2_1b_full', input: 'hello' })?.pipelineId, 'llm_llama3_2_1b_full');
	Assert.equal(registry.select({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula', 1)?.version, 1);
	Assert.throws(() => registry.add({ pipelineId: 'bad', version: 1, taskType: 'task_type_dev_formula', stages: [] }));
});

Test('the Qwen3.5-0.8B full pipeline has exactly one stage that repeats until done', () => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	const specification = registry.select({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' });
	Assert.equal(specification?.repeatsUntilDone, true);
	Assert.deepEqual(specification?.stages.map((stage) => stage.name), ['stage_llm_qwen3_5_0_8b_full']);
	Assert.equal(specification?.stages[0]?.prefersSameWorkerOnRetry, true);
	Assert.equal(registry.definesStage('stage_llm_qwen3_5_0_8b_full'), true);
});

Test('the Llama 3.2 1B Instruct full pipeline has exactly one stage that repeats until done', () => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	const specification = registry.select({ taskType: 'task_type_llm_llama3_2_1b_full', input: 'hello' });
	Assert.equal(specification?.repeatsUntilDone, true);
	Assert.deepEqual(specification?.stages.map((stage) => stage.name), ['stage_llm_llama3_2_1b_full']);
	Assert.equal(specification?.stages[0]?.prefersSameWorkerOnRetry, true);
	Assert.equal(registry.definesStage('stage_llm_llama3_2_1b_full'), true);
});

Test('creates tasks and advances through both stages', () => {
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_dev_formula', input: 5 });

	Assert.equal(task.state, 'queued');
	Assert.equal(TaskStore.nextStage(task), 'stage_dev_formula_multiply');

	const afterMultiply = store.addStage(task.taskId, { name: 'stage_dev_formula_multiply', value: 10 });
	Assert.equal(TaskStore.nextStage(afterMultiply), 'stage_dev_formula_add');

	const afterAdd = store.addStage(task.taskId, { name: 'stage_dev_formula_add', value: 17 });
	const completed = store.update(afterAdd.taskId, { state: 'completed', result: 17 });
	Assert.equal(TaskStore.nextStage(completed), undefined);
	Assert.equal(store.get(task.taskId)?.result, 17);
});

Test('keeps consumer request identifiers and assignment ownership in task state', () => {
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');

	Assert.equal(store.findByTaskRequest('consumer-1', 'request-1')?.taskId, task.taskId);
	Assert.equal(store.findByTaskRequest('consumer-2', 'request-1'), undefined);

	const assigned = store.assign(task.taskId, 'worker-1', 'stage_dev_formula_multiply', 5);
	Assert.deepEqual(assigned.stageAssignment, {
		workerDeviceId: 'worker-1',
		stageAssignmentId: assigned.stageAssignment?.stageAssignmentId,
		attempt: 1,
		stage: 'stage_dev_formula_multiply',
		value: 5,
	leaseUntil: assigned.stageAssignment?.leaseUntil,
	});

	const completed = store.addStage(task.taskId, { name: 'stage_dev_formula_multiply', value: 10 });
	Assert.equal(completed.stageAssignment, undefined);
});

Test('keeps repeated request identifiers idempotent and rejects stale assignment state', () => {
	const store = new TaskStore();
	const original = store.create({ taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');
	Assert.equal(store.findByTaskRequest('consumer-1', 'request-1')?.taskId, original.taskId);
	const first = store.assign(original.taskId, 'worker-1', 'stage_dev_formula_multiply', 5);
	const replacement = store.assign(original.taskId, 'worker-2', 'stage_dev_formula_multiply', 5, 'worker_relinquished');
	Assert.notEqual(first.stageAssignment?.stageAssignmentId, replacement.stageAssignment?.stageAssignmentId);
	Assert.equal(replacement.stageAssignment?.workerDeviceId, 'worker-2');
	Assert.equal(replacement.stageAssignmentAttempts.length, 2);
});

Test('records deterministic lease attempts, acknowledgement, and cancellation', () => {
	const now = new Date('2026-01-01T00:00:00.000Z');
	const store = new TaskStore(() => now, 1000, 500);
	const task = createTask(store, { taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');
	Assert.equal(task.state, 'queued');
	Assert.equal(task.submissionDeadlineAt, '2026-01-01T00:00:01.000Z');

	const assigned = store.assign(task.taskId, 'worker-1', 'stage_dev_formula_multiply', 5);
	Assert.equal(assigned.state, 'assigned');
	Assert.equal(assigned.stageAssignment?.leaseUntil, '2026-01-01T00:00:00.500Z');
	const running = store.acceptAssignment(task.taskId);
	Assert.equal(running.state, 'running');
	Assert.equal(running.stageAssignment?.acceptedAt, '2026-01-01T00:00:00.000Z');
	const retried = store.assign(task.taskId, 'worker-2', 'stage_dev_formula_multiply', 5, 'lease_expired');
	Assert.equal(retried.stageAssignment?.attempt, 2);
	Assert.equal(retried.events.at(-1)?.reason, 'lease_expired');
	const cancelled = store.cancel(task.taskId, 'consumer_requested');
	Assert.equal(cancelled.state, 'cancelled');
	Assert.equal(cancelled.stageAssignment, undefined);
});

Test('restores durable task records and idempotency after a new TaskStore instance', () => {
	const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'webai-task-store-'));
	const stateFile = Path.join(directory, 'state.json');
	try {
		const first = new TaskStore(undefined, 30_000, 15_000, stateFile);
		const task = createTask(first, { taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');
		first.assign(task.taskId, 'worker-1', 'stage_dev_formula_multiply', 5);

		const restored = new TaskStore(undefined, 30_000, 15_000, stateFile);
		Assert.equal(restored.findByTaskRequest('consumer-1', 'request-1')?.taskId, task.taskId);
		Assert.equal(restored.get(task.taskId)?.stageAssignment?.stage, 'stage_dev_formula_multiply');
	} finally {
		Fs.rmSync(directory, { recursive: true, force: true });
	}
});

Test('loops an LLM task through its three shards once per generated token', () => {
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'What is the capital of France?' });

	Assert.equal(TaskStore.nextStage(task), 'stage_llm_qwen3_0_6b_shard1of3');

	let current = task;
	for (const stage of ['stage_llm_qwen3_0_6b_shard1of3', 'stage_llm_qwen3_0_6b_shard2of3'] as const) {
		current = store.addStage(current.taskId, { name: stage, value: { tensors: {} } });
	}
	Assert.equal(TaskStore.nextStage(current), 'stage_llm_qwen3_0_6b_shard3of3');

	const afterFirstToken = store.addStage(current.taskId, { name: 'stage_llm_qwen3_0_6b_shard3of3', value: { text: 'The', done: false } });
	Assert.equal(TaskStore.nextStage(afterFirstToken), 'stage_llm_qwen3_0_6b_shard1of3');

	current = afterFirstToken;
	for (const stage of ['stage_llm_qwen3_0_6b_shard1of3', 'stage_llm_qwen3_0_6b_shard2of3'] as const) {
		current = store.addStage(current.taskId, { name: stage, value: { tensors: {} } });
	}
	const afterSecondToken = store.addStage(current.taskId, { name: 'stage_llm_qwen3_0_6b_shard3of3', value: { text: 'The capital', done: true } });
	Assert.equal(TaskStore.nextStage(afterSecondToken), undefined);
});

Test('repeats the single Chrome built-in language-model stage until it reports the answer finished', () => {
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?' });

	Assert.equal(task.pipelineId, 'llm_gemma_nano_chrome_full');
	Assert.deepEqual(task.pipelineStages, ['stage_llm_gemma_nano_chrome_full']);
	Assert.equal(TaskStore.nextStage(task), 'stage_llm_gemma_nano_chrome_full');

	// Each run of the stage reads one more piece of the answer, so the stage runs again for as
	// long as its results say the answer is not finished.
	const afterFirstPiece = store.addStage(task.taskId, { name: 'stage_llm_gemma_nano_chrome_full', value: { newText: 'The', isContinuation: true, done: false } });
	Assert.equal(TaskStore.nextStage(afterFirstPiece), 'stage_llm_gemma_nano_chrome_full');

	const afterSecondPiece = store.addStage(afterFirstPiece.taskId, { name: 'stage_llm_gemma_nano_chrome_full', value: { newText: ' capital', isContinuation: true, done: false } });
	Assert.equal(TaskStore.nextStage(afterSecondPiece), 'stage_llm_gemma_nano_chrome_full');

	const afterLastPiece = store.addStage(afterSecondPiece.taskId, { name: 'stage_llm_gemma_nano_chrome_full', value: { text: 'The capital of France is Paris.', done: true } });
	Assert.equal(TaskStore.nextStage(afterLastPiece), undefined);
});

Test('keeps a state-holding stage on its own device and moves a stateless one away', () => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	const resolver = new StagePolicyResolver(registry, 15_000);
	const store = new TaskStore();

	// This is the decision the gateway makes when it hands out the stage that follows a
	// finished one: a stage that keeps state in the memory of one device must be allowed back
	// onto the device that just ran a stage of the task, and a stage that keeps none is
	// preferably moved elsewhere. Each stage says which it is, so no task type decides it.
	const builtInModelTask = createTask(store, { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.equal(resolver.resolve(builtInModelTask, 'stage_llm_gemma_nano_chrome_full').prefersSameWorkerOnRetry, true);

	const shardTask = createTask(store, { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });
	Assert.equal(resolver.resolve(shardTask, 'stage_llm_qwen3_0_6b_shard2of3').prefersSameWorkerOnRetry, true);

	const fullModelTask = createTask(store, { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' });
	Assert.equal(resolver.resolve(fullModelTask, 'stage_llm_qwen3_5_0_8b_full').prefersSameWorkerOnRetry, true);

	const formulaTask = createTask(store, { taskType: 'task_type_dev_formula', input: 5 });
	Assert.equal(resolver.resolve(formulaTask, 'stage_dev_formula_add').prefersSameWorkerOnRetry, false);

	// The built-in language-model stage and the Qwen3.5-0.8B full-model stage also state a
	// longer lease than the gateway default, because creating the model session can take much
	// longer than reading one piece of an answer.
	Assert.equal(resolver.resolve(builtInModelTask, 'stage_llm_gemma_nano_chrome_full').leaseMs, 60_000);
	Assert.equal(resolver.resolve(fullModelTask, 'stage_llm_qwen3_5_0_8b_full').leaseMs, 60_000);
	Assert.equal(resolver.resolve(formulaTask, 'stage_dev_formula_add').leaseMs, 15_000);
});

Test("a repeating stage is placed back on the device holding the task's answer", () => {
	const resolver = new StagePolicyResolver(new PipelineRegistry(builtinPipelineSpecifications), 15_000);
	const store = new TaskStore();
	const stage: StageName = 'stage_llm_gemma_nano_chrome_full';
	const registry = new DeviceRegistry();
	// Two worker browser tabs advertise the same stage. The tab that does not hold the answer is
	// stored first, so a search for any free worker finds that one, which is what used to happen
	// for every run after the first.
	registry.add({ ...worker('device-two', [stage]), workerState: 'ready', ready: true, maxConcurrentAssignments: 1, activeAssignments: 0 });
	registry.add({ ...worker('device-one', [stage]), workerState: 'ready', ready: true, maxConcurrentAssignments: 1, activeAssignments: 0 });
	Assert.equal(registry.findWorker(stage)?.deviceId, 'device-two');

	const task = createTask(store, { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	store.assign(task.taskId, 'device-one', stage, { text: 'hello' });
	const afterFirstPiece = store.addStage(task.taskId, { name: stage, value: { text: 'The', done: false } });

	// The device that ran the stage is recorded on the task, so the run that reads the next
	// piece of the same answer goes back to the tab holding the open generation.
	Assert.deepEqual(afterFirstPiece.stageWorkerDeviceIds, { [stage]: 'device-one' });
	const policy = resolver.resolve(afterFirstPiece, stage);
	const preferredDeviceId = WorkerPlacement.preferredWorkerDeviceId(afterFirstPiece, stage, policy, 'device-one');
	Assert.equal(preferredDeviceId, 'device-one');
	Assert.equal(WorkerPlacement.reusableWorker(registry, preferredDeviceId!, stage, { isPreviousAssignmentReleased: true })?.deviceId, 'device-one');

	// A task waiting in the queue, with no device having just finished anything, is still pinned
	// to the tab holding the answer rather than to whichever tab is free.
	Assert.equal(WorkerPlacement.preferredWorkerDeviceId(afterFirstPiece, stage, policy), 'device-one');
});

Test('the capacity check is not loosened when the previous assignment was already released', () => {
	const registry = new DeviceRegistry();
	const stage: StageName = 'stage_llm_gemma_nano_chrome_full';
	const busy = { ...worker('device-one', [stage]), workerState: 'ready' as const, ready: true, maxConcurrentAssignments: 1, activeAssignments: 1 };
	registry.add(busy);

	// A stage result releases the assignment before the next stage is placed, so the counter is
	// already correct. Discounting one here would let the worker hold two assignments while its
	// own limit is one.
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-one', stage, { isPreviousAssignmentReleased: true }), undefined);
	// A lease expiry replaces an assignment the worker still holds, so that one assignment is
	// discounted and the worker can take the stage again.
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-one', stage, { isPreviousAssignmentReleased: false })?.deviceId, 'device-one');

	registry.add({ ...busy, activeAssignments: 0 });
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-one', stage, { isPreviousAssignmentReleased: true })?.deviceId, 'device-one');
	registry.add({ ...busy, maxConcurrentAssignments: 2, activeAssignments: 1 });
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-one', stage, { isPreviousAssignmentReleased: true })?.deviceId, 'device-one');

	// Every other condition a search for a free worker applies is applied to a named worker too.
	registry.add({ ...busy, activeAssignments: 0, workerState: 'draining', ready: false });
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-one', stage, { isPreviousAssignmentReleased: true }), undefined);
	registry.add({ ...busy, activeAssignments: 0, stageNames: ['stage_dev_formula_add'] });
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-one', stage, { isPreviousAssignmentReleased: true }), undefined);
	Assert.equal(WorkerPlacement.reusableWorker(registry, 'device-absent', stage, { isPreviousAssignmentReleased: true }), undefined);
});

Test('each shard of a repeating pipeline returns to the device that ran that same shard', () => {
	const resolver = new StagePolicyResolver(new PipelineRegistry(builtinPipelineSpecifications), 15_000);
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });

	// One round of the three shards, spread over two devices.
	const placements: [StageName, string][] = [
		['stage_llm_qwen3_0_6b_shard1of3', 'device-a'],
		['stage_llm_qwen3_0_6b_shard2of3', 'device-b'],
		['stage_llm_qwen3_0_6b_shard3of3', 'device-b'],
	];
	let current = task;
	for (const [stage, deviceId] of placements) {
		store.assign(current.taskId, deviceId, stage, { tensors: {} });
		current = store.addStage(current.taskId, { name: stage, value: { text: 'The', done: false } });
	}
	Assert.deepEqual(current.stageWorkerDeviceIds, {
		stage_llm_qwen3_0_6b_shard1of3: 'device-a',
		stage_llm_qwen3_0_6b_shard2of3: 'device-b',
		stage_llm_qwen3_0_6b_shard3of3: 'device-b',
	});

	// The second round starts again at the first shard. The device holding the key-value cache
	// for that shard is the device that ran it in the previous round, not the device that
	// happened to finish last.
	const upcoming = TaskStore.nextStage(current)!;
	Assert.equal(upcoming, 'stage_llm_qwen3_0_6b_shard1of3');
	Assert.equal(WorkerPlacement.preferredWorkerDeviceId(current, upcoming, resolver.resolve(current, upcoming), 'device-b'), 'device-a');

	// A stage of this task that has never run yet falls back to the device that just finished,
	// which is where a hand-off from the previous shard is held.
	const withoutThirdShard = { ...current, stageWorkerDeviceIds: { stage_llm_qwen3_0_6b_shard1of3: 'device-a' } };
	Assert.equal(WorkerPlacement.preferredWorkerDeviceId(withoutThirdShard, 'stage_llm_qwen3_0_6b_shard3of3', resolver.resolve(current, 'stage_llm_qwen3_0_6b_shard3of3'), 'device-b'), 'device-b');
});

Test('a stage that keeps no state is pinned to no device at all', () => {
	const resolver = new StagePolicyResolver(new PipelineRegistry(builtinPipelineSpecifications), 15_000);
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_dev_formula', input: 5 });
	store.assign(task.taskId, 'device-one', 'stage_dev_formula_multiply', 5);
	const afterMultiply = store.addStage(task.taskId, { name: 'stage_dev_formula_multiply', value: 10 });

	// The device is still recorded, because recording it costs nothing and does not depend on
	// the stage. What decides the placement is the stage's own policy, which says the next stage
	// is preferably moved to a different device.
	Assert.deepEqual(afterMultiply.stageWorkerDeviceIds, { stage_dev_formula_multiply: 'device-one' });
	const policy = resolver.resolve(afterMultiply, 'stage_dev_formula_add');
	Assert.equal(WorkerPlacement.preferredWorkerDeviceId(afterMultiply, 'stage_dev_formula_add', policy, 'device-one'), undefined);
});

Test('resets the retry budget after each successful LLM stage', () => {
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });
	let current = store.assign(task.taskId, 'worker-1', 'stage_llm_qwen3_0_6b_shard1of3', { text: 'hello' });
	Assert.equal(current.stageAssignment?.attempt, 1);
	current = store.addStage(current.taskId, { name: 'stage_llm_qwen3_0_6b_shard1of3', value: { tensors: {} } });
	Assert.equal(current.currentStageAttempts, 0);
	current = store.assign(current.taskId, 'worker-2', 'stage_llm_qwen3_0_6b_shard2of3', { tensors: {} });
	Assert.equal(current.stageAssignment?.attempt, 1);
	current = store.addStage(current.taskId, { name: 'stage_llm_qwen3_0_6b_shard2of3', value: { tensors: {} } });
	current = store.assign(current.taskId, 'worker-3', 'stage_llm_qwen3_0_6b_shard3of3', { tensors: {} });
	current = store.addStage(current.taskId, { name: 'stage_llm_qwen3_0_6b_shard3of3', value: { text: 'The', done: false } });
	current = store.assign(current.taskId, 'worker-1', 'stage_llm_qwen3_0_6b_shard1of3', { text: 'The', done: false });
	Assert.equal(current.stageAssignment?.attempt, 1);
});

Test('tells a device joining apart from a change to its description, its activity, and its liveness', () => {
	const registry = new DeviceRegistry();
	const first = registry.add(worker('one', ['stage_dev_formula_multiply']));
	Assert.equal(first.kind, 'joined');

	const stored = registry.get('one')!;
	const touched = registry.add({ ...stored, lastSeenAt: '2026-01-01T00:00:05.000Z' });
	const busy = registry.add({ ...registry.get('one')!, activeAssignments: 1, lastSeenAt: '2026-01-01T00:00:06.000Z' });
	const renamed = registry.add({ ...registry.get('one')!, name: 'worker-renamed' });
	const restaged = registry.add({ ...registry.get('one')!, stageNames: ['stage_dev_formula_add'] });

	Assert.equal(touched.kind, 'unchanged');
	Assert.equal(busy.kind, 'activity_changed');
	Assert.equal(renamed.kind, 'stable_changed');
	Assert.equal(restaged.kind, 'stable_changed');
	// A refreshed liveness timestamp is stored but spends no device-list revision, so a
	// device that merely keeps sending messages does not move the revision counter.
	Assert.equal(touched.deviceListRevision, first.deviceListRevision);
	Assert.equal(registry.get('one')?.lastSeenAt, '2026-01-01T00:00:06.000Z');
	Assert.equal(registry.currentDeviceListRevision(), restaged.deviceListRevision);
});

Test('a lease renewal extends the lease without raising the task revision', () => {
	const store = new TaskStore(undefined, 30_000, 2_000);
	const task = createTask(store, { taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');
	const assigned = store.assign(task.taskId, 'worker-1', 'stage_dev_formula_multiply', 5);
	const before = store.get(task.taskId)!;

	const leaseUntil = store.renewLease(task.taskId, 60_000)!;
	const after = store.get(task.taskId)!;

	Assert.ok(Date.parse(leaseUntil) > Date.parse(assigned.stageAssignment!.leaseUntil));
	Assert.equal(after.stageAssignment?.leaseUntil, leaseUntil);
	// A heartbeat says only that the worker is still alive. Raising the revision would send a
	// task update to every reader on every heartbeat.
	Assert.equal(after.taskRevision, before.taskRevision);
	Assert.equal(after.updatedAt, before.updatedAt);
	// The per-attempt history holds the same assignment and must not drift from it.
	Assert.equal(after.stageAssignmentAttempts.at(-1)?.leaseUntil, leaseUntil);
});

Test('a stage assignment can be given a lease shorter or longer than the store default', () => {
	const store = new TaskStore(undefined, 30_000, 2_000);
	const task = createTask(store, { taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');
	const assigned = store.assign(task.taskId, 'worker-1', 'stage_dev_formula_multiply', 5, undefined, 60_000);
	Assert.ok(Date.parse(assigned.stageAssignment!.leaseUntil) - Date.now() > 30_000);
});

Test('stage settings come from the pipeline specification, and language-model shards keep their worker', () => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	registry.add({
		pipelineId: 'dev_formula', version: 2, taskType: 'task_type_dev_formula',
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json', leaseMs: 9_000, prefersSameWorkerOnRetry: true },
			{ name: 'stage_dev_formula_add', computation: 'dev_formula_add', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	});
	const resolver = new StagePolicyResolver(registry, 2_000);
	const store = new TaskStore(undefined, 30_000, 2_000);

	const specified = store.create({ taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1', undefined, { pipelineId: 'dev_formula', pipelineVersion: 2 });
	Assert.deepEqual(resolver.resolve(specified, 'stage_dev_formula_multiply'), { leaseMs: 9_000, prefersSameWorkerOnRetry: true });
	// A stage that states no lease of its own falls back to the gateway's --lease-ms default.
	Assert.deepEqual(resolver.resolve(specified, 'stage_dev_formula_add'), { leaseMs: 2_000, prefersSameWorkerOnRetry: false });

	// The language-model pipeline is an ordinary specification like any other. Its shards
	// state that they keep their worker, so a retry does not throw away the key-value cache.
	const llm = store.create({ taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' }, 'consumer-1', 'request-2', undefined, { pipelineId: 'llm_qwen3_0_6b_sharded', pipelineVersion: 1 });
	Assert.deepEqual(resolver.resolve(llm, 'stage_llm_qwen3_0_6b_shard1of3'), { leaseMs: 2_000, prefersSameWorkerOnRetry: true });
	// A stage the task's own pipeline does not list falls back to the defaults.
	Assert.deepEqual(resolver.resolve(llm, 'stage_dev_formula_multiply'), { leaseMs: 2_000, prefersSameWorkerOnRetry: false });
});

Test('a pipeline file may introduce a stage name that appears nowhere in the source', () => {
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	registry.add({
		pipelineId: 'invented', version: 7, taskType: 'task_type_dev_formula', stages: [
			{ name: 'stage_invented_first', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
			{ name: 'stage_invented_second', computation: 'dev_formula_add', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	});

	Assert.equal(registry.definesStage('stage_invented_first'), true);
	Assert.equal(registry.definesStage('stage_never_defined'), false);
	Assert.ok(registry.stageNames().includes('stage_invented_second'));

	// A higher version wins, so the invented pipeline is what a formula task now runs.
	const store = new TaskStore();
	const pipeline = registry.select({ taskType: 'task_type_dev_formula', input: 5 })!;
	Assert.equal(pipeline.pipelineId, 'invented');
	const task = store.create({ taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1', undefined, {
		pipelineId: pipeline.pipelineId, pipelineVersion: pipeline.version, pipelineStages: pipeline.stages.map((stage) => stage.name),
	});
	Assert.equal(TaskStore.nextStage(task), 'stage_invented_first');
	const afterFirst = store.addStage(task.taskId, { name: 'stage_invented_first', value: 10 });
	Assert.equal(TaskStore.nextStage(afterFirst), 'stage_invented_second');
	const afterSecond = store.addStage(task.taskId, { name: 'stage_invented_second', value: 17 });
	Assert.equal(TaskStore.nextStage(afterSecond), undefined);
});

Test('a repeating pipeline runs its stages again until a result reports it is done', () => {
	const store = new TaskStore();
	const registry = new PipelineRegistry(builtinPipelineSpecifications);
	registry.add({
		pipelineId: 'two_step_loop', version: 1, taskType: 'task_type_llm_qwen3_0_6b_sharded', repeatsUntilDone: true, stages: [
			{ name: 'stage_loop_first', computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json' },
			{ name: 'stage_loop_second', computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json' },
		],
	});
	const pipeline = registry.get('two_step_loop', 1)!;
	let current = store.create({ taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' }, 'consumer-1', 'request-1', undefined, {
		pipelineId: pipeline.pipelineId, pipelineVersion: pipeline.version, pipelineStages: pipeline.stages.map((stage) => stage.name), pipelineRepeatsUntilDone: true,
	});

	Assert.equal(TaskStore.nextStage(current), 'stage_loop_first');
	current = store.addStage(current.taskId, { name: 'stage_loop_first', value: { tensors: {} } });
	Assert.equal(TaskStore.nextStage(current), 'stage_loop_second');
	// The cycle ended without reporting it is done, so the pipeline starts again.
	current = store.addStage(current.taskId, { name: 'stage_loop_second', value: { text: 'The', done: false } });
	Assert.equal(TaskStore.nextStage(current), 'stage_loop_first');

	current = store.addStage(current.taskId, { name: 'stage_loop_first', value: { tensors: {} } });
	current = store.addStage(current.taskId, { name: 'stage_loop_second', value: { text: 'The capital', done: true } });
	Assert.equal(TaskStore.nextStage(current), undefined);
});

Test('a restored task that carries no pipeline is failed rather than left stuck', () => {
	const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'webai-task-store-legacy-'));
	const stateFile = Path.join(directory, 'state.json');
	try {
		const first = new TaskStore(undefined, 30_000, 15_000, stateFile);
		// A task created without a pipeline, the way an earlier gateway wrote them.
		const stranded = first.create({ taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-1');
		const finished = first.create({ taskType: 'task_type_dev_formula', input: 5 }, 'consumer-1', 'request-2');
		first.update(finished.taskId, { state: 'completed', result: 17 });

		const second = new TaskStore(undefined, 30_000, 15_000, stateFile);
		Assert.equal(second.get(stranded.taskId)?.state, 'failed');
		Assert.equal(second.get(stranded.taskId)?.error, 'NO_PIPELINE_ON_RESTORED_TASK');
		// A task that already finished is left exactly as it was.
		Assert.equal(second.get(finished.taskId)?.state, 'completed');
		Assert.equal(second.get(finished.taskId)?.result, 17);
	} finally {
		Fs.rmSync(directory, { recursive: true, force: true });
	}
});

Test('diagnostic reporting is capped per device over a rolling window', () => {
	const limiter = new DiagnosticsRateLimiter(10, 1_000);
	const start = 1_000_000;

	Assert.equal(limiter.accept('device-a', 6, start).isAccepted, true);
	const second = limiter.accept('device-a', 4, start + 100);
	Assert.equal(second.isAccepted, true);
	Assert.equal(second.remaining, 0);

	// The allowance is spent, so the next report is refused rather than partly recorded.
	const refused = limiter.accept('device-a', 1, start + 200);
	Assert.equal(refused.isAccepted, false);
	Assert.ok(refused.retryAfterMs > 0);

	// One device's traffic never spends another device's allowance.
	Assert.equal(limiter.accept('device-b', 10, start + 200).isAccepted, true);

	// The window rolls: once the earliest entries age out, that much allowance returns.
	Assert.equal(limiter.accept('device-a', 6, start + 1_050).isAccepted, true);
	Assert.equal(limiter.accept('device-a', 5, start + 1_050).isAccepted, false);

	// A disconnected device's allowance is released with it.
	limiter.forget('device-a');
	Assert.equal(limiter.accept('device-a', 10, start + 1_060).isAccepted, true);
});

Test('two different credentials never become the same principal', () => {
	// The principal used to be the first twelve characters of the token, so any two tokens
	// sharing a prefix collided into one principal and shared its task quota.
	const collidingPrefixes = ['development-token', 'development-token-two', 'development-tokenXYZ', 'development-'];
	const principals = collidingPrefixes.map((token) => SessionRegistry.authIdentityFor(token));
	Assert.equal(new Set(principals).size, collidingPrefixes.length);

	// The same credential always resolves to the same principal, so a task submitted before a
	// renewal and one submitted after count against the same quota.
	Assert.equal(SessionRegistry.authIdentityFor('development-token'), SessionRegistry.authIdentityFor('development-token'));

	// No part of the credential is readable in the principal, which is recorded on every task
	// and written to every log file.
	for (const [index, token] of collidingPrefixes.entries()) Assert.equal(principals[index]?.includes(token), false);
});

Test('an advertised session expiry is actually enforced, and survives re-authenticating', () => {
	const registry = new SessionRegistry(1_000);
	const start = 5_000_000;

	const session = registry.open('device-a', 'development-token', start);
	Assert.equal(session.expiresAt, start + 1_000);
	Assert.equal(registry.active('device-a', start + 999)?.authIdentity, session.authIdentity);

	// Once the advertised moment passes the session is gone, rather than lasting as long as
	// the connection stays open.
	Assert.equal(registry.active('device-a', start + 1_000), undefined);
	Assert.equal(registry.active('device-a', start + 5_000), undefined);

	// Authenticating again on the same connection opens a fresh session.
	const renewed = registry.open('device-a', 'development-token', start + 5_000);
	Assert.equal(renewed.expiresAt, start + 6_000);
	Assert.equal(registry.active('device-a', start + 5_500)?.authIdentity, renewed.authIdentity);

	// One connection's expiry never affects another's.
	registry.open('device-b', 'development-token', start + 5_000);
	registry.close('device-a');
	Assert.equal(registry.active('device-a', start + 5_500), undefined);
	Assert.notEqual(registry.active('device-b', start + 5_500), undefined);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HTTP Routing
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs a test body against a real HTTP server answering through `HttpRoutes`, and takes the
 * server and its temporary log directory down afterwards.
 *
 * The body is given a way to request one path and read back the status, and the list of paths
 * the page transform was asked for, which is how a test sees which page route entry a request
 * resolved to.
 */
const withHttpRoutesServer = async (
	body: (server: {
		statusOf: (requestTarget: string) => Promise<number>;
		headersOf: (requestTarget: string) => Promise<Headers>;
		redirectLocationOf: (requestTarget: string) => Promise<string | null>;
		transformedUrls: string[];
	}) => Promise<void>,
): Promise<void> => {
	const logsDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'gateway-http-routes-'));
	const deviceRegistry = new DeviceRegistry();
	const messageLogger = new MessageLogger(Path.join(logsDirectory, 'gateway.log_entry.jsonl'));
	const hub = new ConnectionHub(deviceRegistry, messageLogger, logsDirectory);
	const announcer = new DeviceAnnouncer(deviceRegistry, hub, 0);

	// Each page is read from disk and handed to this stand-in instead of to Vite, so the routing
	// is exercised without starting a development server.
	const transformedUrls: string[] = [];
	const pageDevServer: PageDevServer = {
		middlewares: (_request, _response, next): void => next(),
		transformIndexHtml: async (url: string, html: string): Promise<string> => {
			transformedUrls.push(url);
			return html;
		},
		close: async (): Promise<unknown> => undefined,
	};
	const routes = new HttpRoutes(
		hub,
		announcer,
		new SessionRegistry(),
		new DiagnosticsRateLimiter(),
		'development-token',
		pageDevServer,
		'test-commit-sha',
	);
	const httpServer = Http.createServer((request, response) => routes.handleRequest(request, response));
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
	const address = httpServer.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;

	try {
		await body({
			// Each request gives up rather than waiting forever. A request target that ends the
			// server process leaves its own request unanswered, and without a deadline here that
			// arrives as a test run which hangs instead of one which fails.
			statusOf: async (requestTarget: string): Promise<number> =>
				(await fetch(`http://127.0.0.1:${port}${requestTarget}`, { signal: AbortSignal.timeout(5_000) })).status,
			headersOf: async (requestTarget: string): Promise<Headers> =>
				(await fetch(`http://127.0.0.1:${port}${requestTarget}`, { signal: AbortSignal.timeout(5_000) })).headers,
			// Fetches with redirects left unfollowed, so a test can see the redirect response itself
			// rather than the page it points to.
			redirectLocationOf: async (requestTarget: string): Promise<string | null> =>
				(
					await fetch(`http://127.0.0.1:${port}${requestTarget}`, {
						redirect: 'manual',
						signal: AbortSignal.timeout(5_000),
					})
				).headers.get('location'),
			transformedUrls,
		});
	} finally {
		announcer.stop();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		Fs.rmSync(logsDirectory, { recursive: true, force: true });
	}
};

Test('a page answers whether or not its address was typed with a trailing slash', async () => {
	await withHttpRoutesServer(async ({ statusOf, transformedUrls }) => {
		Assert.equal(await statusOf('/monitor'), 200);
		Assert.equal(await statusOf('/monitor/'), 200);
		Assert.equal(await statusOf('/'), 200);

		// Both spellings resolve to the single route entry the page is listed under, rather than
		// the trailing-slash spelling reaching a second entry of its own. The root redirects to
		// the home page rather than being a route entry of its own.
		Assert.deepEqual(transformedUrls, ['/monitor', '/monitor', '/home']);

		// A path no page is listed under is still answered as missing.
		Assert.equal(await statusOf('/nope'), 404);
		Assert.equal(await statusOf('/nope/'), 404);
	});
});

Test('the site root redirects to the home page', async () => {
	await withHttpRoutesServer(async ({ redirectLocationOf }) => {
		Assert.equal(await redirectLocationOf('/'), '/home/');
	});
});

Test('a request target naming another host is refused, and the server keeps answering', async () => {
	await withHttpRoutesServer(async ({ statusOf }) => {
		// Reaching the URL parser with one of these used to throw out of the request handler and
		// end the whole gateway process, so every request afterwards went unanswered.
		Assert.equal(await statusOf('//'), 404);
		Assert.equal(await statusOf('//another.example/monitor'), 404);

		Assert.equal(await statusOf('/health'), 200);
		Assert.equal(await statusOf('/monitor'), 200);
	});
});

Test('browser ONNX Runtime assets allow cross-origin fetches', async () => {
	await withHttpRoutesServer(async ({ headersOf }) => {
		const runtimeHeaders = await headersOf('/ort-wasm-simd-threaded.jsep.mjs');
		Assert.equal(runtimeHeaders.get('access-control-allow-origin'), '*');
	});
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Client Message Dispatch
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A fake WebSocket good enough for `ConnectionHub.send`: it reports itself open, and records
 * every frame written to it, and every attempt to close it, instead of touching a real network
 * connection.
 */
type FakeSocket = { readyState: number; OPEN: number; sent: GatewayEnvelopeLike[]; closeReasons: string[]; send: (data: string) => void; close: (code: number, reason: string) => void };

/** The shape `ConnectionHub.send` writes, read back out of a fake socket's recorded frames. */
type GatewayEnvelopeLike = { body: GatewayMessage };

/**
 * A fake WebSocket good enough for `WebsocketHeartbeat`: it counts how many times it was
 * pinged, records whether it was terminated, and lets a test answer with a `pong` on demand,
 * instead of touching a real network connection.
 */
type FakeHeartbeatSocket = { pingCount: number; terminated: boolean; ping: () => void; terminate: () => void; on: (event: string, listener: () => void) => void; answerWithPong: () => void };

const newFakeHeartbeatSocket = (): FakeHeartbeatSocket => {
	let pongListener: (() => void) | undefined;
	const socket: FakeHeartbeatSocket = {
		pingCount: 0,
		terminated: false,
		ping: (): void => { socket.pingCount++; },
		terminate: (): void => { socket.terminated = true; },
		on: (event, listener): void => { if (event === 'pong') pongListener = listener; },
		answerWithPong: (): void => pongListener?.(),
	};
	return socket;
};

/**
 * A fake WebSocket server good enough for `WebsocketHeartbeat`: it tracks the connections
 * handed to it and lets a test announce a new one, instead of accepting real network
 * connections.
 */
type FakeHeartbeatServer = { clients: Set<FakeHeartbeatSocket>; on: (event: string, listener: (socket: FakeHeartbeatSocket) => void) => void; announceConnection: (socket: FakeHeartbeatSocket) => void };

const newFakeHeartbeatServer = (): FakeHeartbeatServer => {
	let connectionListener: ((socket: FakeHeartbeatSocket) => void) | undefined;
	const server: FakeHeartbeatServer = {
		clients: new Set(),
		on: (event, listener): void => { if (event === 'connection') connectionListener = listener; },
		announceConnection: (socket): void => {
			server.clients.add(socket);
			connectionListener?.(socket);
		},
	};
	return server;
};

/** Waits for real time to pass, so a `WebsocketHeartbeat` built on a real timer can be observed. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the `task.submit` input for the two-stage `dev_formula` pipeline these tests drive. */
const devFormulaInput = (value: number): TaskInput => ({ taskType: 'task_type_dev_formula', input: value });

const newFakeSocket = (): FakeSocket => {
	const socket: FakeSocket = {
		readyState: 1,
		OPEN: 1,
		sent: [],
		closeReasons: [],
		send: (data: string): void => { socket.sent.push(JSON.parse(data)); },
		close: (_code: number, reason: string): void => { socket.closeReasons.push(reason); },
	};
	return socket;
};

/**
 * Builds a `ClientMessageHandler` wired to real collaborators, the way the gateway itself
 * assembles them, so a test drives the same dispatch and authorisation rules a live connection
 * would meet.
 *
 * @param leaseMs How long an assignment's lease lasts. A test that wants an expired lease passes 0,
 * so the very next recovery sweep retries the stage, rather than waiting out a real one.
 */
const buildClientMessageHandlerHarness = (leaseMs = 15_000) => {
	const authToken = 'test-token';
	const logsDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'gateway-dispatch-'));
	const deviceRegistry = new DeviceRegistry();
	const messageLogger = new MessageLogger(Path.join(logsDirectory, 'gateway.log_entry.jsonl'));
	const hub = new ConnectionHub(deviceRegistry, messageLogger, logsDirectory);
	const taskStore = new TaskStore(undefined, 30_000, leaseMs);
	const pipelineRegistry = new PipelineRegistry(builtinPipelineSpecifications);
	const sessionRegistry = new SessionRegistry();
	const stagePolicyResolver = new StagePolicyResolver(pipelineRegistry, leaseMs);
	const announcer = new DeviceAnnouncer(deviceRegistry, hub, 0);
	const scheduler = new TaskScheduler(taskStore, deviceRegistry, stagePolicyResolver, hub, announcer, 3);
	const accountRegistry = new AccountRegistry();
	const challengeRegistry = new ChallengeRegistry();
	const accountMessageHandler = new AccountMessageHandler(hub, accountRegistry, challengeRegistry, sessionRegistry);
	const ledgerStore = new LedgerStore(Path.join(logsDirectory, 'gateway-ledger.jsonl'));
	const accountingRecorder = new AccountingRecorder(ledgerStore, sessionRegistry);
	const accountingQueryHandler = new AccountingQueryHandler(hub, accountRegistry, ledgerStore, sessionRegistry);
	const accountingSummaryHandler = new AccountingSummaryHandler(hub, accountRegistry, ledgerStore);
	const handler = new ClientMessageHandler(hub, deviceRegistry, taskStore, pipelineRegistry, sessionRegistry, stagePolicyResolver, scheduler, announcer, authToken, 2, accountMessageHandler, accountingRecorder, accountingQueryHandler, accountingSummaryHandler);

	const sockets = new Map<string, FakeSocket>();
	let frameCounter = 0;

	/**
	 * Sends one message as a named device, registering its fake socket with the hub on first
	 * use the same way accepting a real connection would.
	 *
	 * @returns The gateway messages sent back to this device during this one call.
	 */
	const drive = (deviceId: string, message: ClientMessage): GatewayMessage[] => {
		let socket = sockets.get(deviceId);
		if (socket === undefined) {
			socket = newFakeSocket();
			sockets.set(deviceId, socket);
			hub.socketMap.set(deviceId, socket as unknown as Parameters<typeof handler.handle>[0]);
		}
		const before = socket.sent.length;
		handler.handle(socket as unknown as Parameters<typeof handler.handle>[0], deviceId, message, `frame-${++frameCounter}`);
		return socket.sent.slice(before).map((frame) => frame.body);
	};

	/** Authenticates a device, the way any connection must before sending anything else. */
	const authenticate = (deviceId: string, token = authToken): GatewayMessage[] => drive(deviceId, { type: 'deviceAuthenticate', token });

	/** Authenticates and registers a worker, ready by default. */
	const registerWorker = (deviceId: string, name: string, stageNames: StageName[] = ['stage_dev_formula_multiply', 'stage_dev_formula_add']): GatewayMessage[] => {
		authenticate(deviceId);
		return drive(deviceId, { type: 'deviceRegister', role: 'worker', name, stageNames });
	};

	/** Authenticates and registers a consumer. */
	const registerConsumer = (deviceId: string, name: string): GatewayMessage[] => {
		authenticate(deviceId);
		return drive(deviceId, { type: 'deviceRegister', role: 'consumer', name });
	};

	/**
	 * Every gateway message ever sent to one device's socket, including a push the scheduler
	 * wrote on its own initiative rather than in answer to something that device sent.
	 */
	const allSentTo = (deviceId: string): GatewayMessage[] => (sockets.get(deviceId)?.sent ?? []).map((frame) => frame.body);

	/** Every reason one device's connection was closed with, which is empty while it stays open. */
	const closeReasonsOf = (deviceId: string): string[] => sockets.get(deviceId)?.closeReasons ?? [];

	/**
	 * Sends one account message and waits for the answer it produces.
	 *
	 * An account message is answered asynchronously, because deriving an account identifier and
	 * verifying a signature both go through the Web Cryptography API, so the answer is not in what
	 * `drive` returns. This waits for the answer to arrive rather than for a fixed number of turns of
	 * the event loop, because the Web Cryptography API in Node.js finishes its work on a thread of
	 * its own and how many turns that takes is not something a test should depend on.
	 *
	 * @returns The gateway messages sent back to this device while the message was being answered.
	 */
	const driveAccountMessage = async (deviceId: string, message: ClientMessage): Promise<GatewayMessage[]> => {
		const sentBefore = sockets.get(deviceId)?.sent.length ?? 0;
		drive(deviceId, message);
		for (let attempt = 0; attempt < 1_000; attempt += 1) {
			if ((sockets.get(deviceId)?.sent.length ?? 0) > sentBefore) break;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		return (sockets.get(deviceId)?.sent ?? []).slice(sentBefore).map((frame) => frame.body);
	};

	/**
	 * Authenticates an account on one connection, the way a worker browser page or a consumer does.
	 *
	 * @returns The account identifier the connection now authenticates as.
	 */
	const authenticateAccount = async (deviceId: string): Promise<string> => {
		const keyPair = await AccountIdentity.generateKeyPair('Ed25519');
		const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
		const accountId = await AccountIdentity.accountIdFor(publicKeySpkiBase64);
		await driveAccountMessage(deviceId, { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 });
		const [challenge] = await driveAccountMessage(deviceId, { type: 'account.challenge.request' });
		const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', keyPair.privateKey, (challenge as { challenge: string }).challenge);
		await driveAccountMessage(deviceId, { type: 'account.authenticate', accountId, signatureBase64 });
		return accountId;
	};

	return { drive, driveAccountMessage, authenticate, authenticateAccount, registerWorker, registerConsumer, allSentTo, closeReasonsOf, authToken, hub, taskStore, deviceRegistry, sessionRegistry, accountRegistry, challengeRegistry, ledgerStore, scheduler };
};

Test('every message needs an active session first, before any rule specific to that message type is even reached', () => {
	const { drive } = buildClientMessageHandlerHarness();

	// An unauthenticated connection is refused for AUTHENTICATION_REQUIRED, not for whatever
	// that message type would normally check first — here CONSUMER_REQUIRED, since the sender
	// is registered as nothing at all yet.
	const [reply] = drive('device-a', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(reply?.type, 'error');
	Assert.equal((reply as { code: string }).code, 'AUTHENTICATION_REQUIRED');

	// The rule applies just as much to the messages a connection may send before registering.
	const [observeReply] = drive('device-b', { type: 'observe' });
	Assert.equal(observeReply?.type, 'error');
	Assert.equal((observeReply as { code: string }).code, 'AUTHENTICATION_REQUIRED');
});

Test('an authenticated but unregistered connection is refused NOT_REGISTERED for anything outside the before-registration group', () => {
	const { drive, authenticate } = buildClientMessageHandlerHarness();
	authenticate('device-a');

	const [reply] = drive('device-a', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(reply?.type, 'error');
	Assert.equal((reply as { code: string }).code, 'NOT_REGISTERED');

	// The before-registration group itself needs only authentication, not registration.
	const [pipelinesReply] = drive('device-a', { type: 'pipelines.get' });
	Assert.equal(pipelinesReply?.type, 'pipelines');
});

Test('only a registered consumer may submit a task', () => {
	const { drive, registerWorker } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');

	const [reply] = drive('worker-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.deepEqual(reply, { type: 'error', code: 'CONSUMER_REQUIRED', message: 'Only consumer browser tabs may submit tasks', taskRequestId: 'request-1' });
});

Test('a task is refused at once when no connected worker offers a stage it requires', () => {
	const { drive, registerConsumer } = buildClientMessageHandlerHarness();
	registerConsumer('consumer-1', 'consumer-one');

	const [reply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.deepEqual(reply, {
		type: 'error',
		code: 'CAPACITY_EXHAUSTED',
		message: 'One or more stages this task requires have no connected worker',
		taskRequestId: 'request-1',
		retryable: true,
		details: { missingStageNames: ['stage_dev_formula_multiply', 'stage_dev_formula_add'] },
	});
});

Test('a task is refused at once when only some of its required stages have a connected worker', () => {
	const { drive, registerWorker, registerConsumer } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one', ['stage_dev_formula_multiply']);
	registerConsumer('consumer-1', 'consumer-one');

	const [reply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(reply?.type, 'error');
	Assert.equal((reply as { code: string }).code, 'CAPACITY_EXHAUSTED');
	Assert.deepEqual((reply as unknown as { details: { missingStageNames: string[] } }).details.missingStageNames, ['stage_dev_formula_add']);
});

Test('a task is accepted and queued, rather than refused, when the only worker offering its stage is merely busy', () => {
	const { drive, registerWorker, registerConsumer, taskStore } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');

	// The one worker takes the first task's first stage, which is all its default
	// maxConcurrentAssignments of 1 allows, so it is connected and offers the stage but has no
	// free capacity left for a second task.
	const [firstReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(firstReply?.type, 'task.accepted');

	const [secondReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-2', input: devFormulaInput(5) });
	Assert.equal(secondReply?.type, 'task.accepted');
	const secondTaskId = (secondReply as { task: { taskId: string } }).task.taskId;
	Assert.equal(taskStore.get(secondTaskId)?.state, 'queued');
});

Test('resubmitting the same taskRequestId with the same input replays the original acceptance, and a changed input is refused', () => {
	const { drive, registerWorker, registerConsumer } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');

	const [firstReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(firstReply?.type, 'task.accepted');
	const taskId = (firstReply as { task: { taskId: string } }).task.taskId;

	const [replayReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(replayReply?.type, 'task.accepted');
	Assert.equal((replayReply as { task: { taskId: string } }).task.taskId, taskId);

	const [conflictReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(6) });
	Assert.equal(conflictReply?.type, 'error');
	Assert.equal((conflictReply as { code: string }).code, 'TASK_REQUEST_ID_CONFLICT');
});

Test('a principal is refused once its active tasks reach the configured limit', () => {
	const { drive, registerWorker, registerConsumer } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');

	const [firstReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(firstReply?.type, 'task.accepted');
	const [secondReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-2', input: devFormulaInput(5) });
	Assert.equal(secondReply?.type, 'task.accepted');

	// The harness is built with a limit of two active tasks per principal.
	const [thirdReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-3', input: devFormulaInput(5) });
	Assert.equal(thirdReply?.type, 'error');
	Assert.equal((thirdReply as { code: string }).code, 'RATE_LIMITED');
});

Test('two worker connections registering under the same name both stay connected and both take work', () => {
	// Opening one debug page twice gives every shard two worker browser tabs registered under the
	// one name that debug page writes into its inline frames, and all of them have to stay
	// connected (see https://github.com/webai-at-home/webai-at-home/issues/135).
	const { registerWorker, closeReasonsOf, deviceRegistry } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'llm-qwen3-0-6b-shard1of3', ['stage_dev_formula_multiply']);
	const [secondReply] = registerWorker('worker-2', 'llm-qwen3-0-6b-shard1of3', ['stage_dev_formula_multiply']);

	Assert.equal(secondReply?.type, 'deviceRegistered');
	Assert.deepEqual(deviceRegistry.list().map((device) => device.deviceId), ['worker-1', 'worker-2']);
	Assert.deepEqual(closeReasonsOf('worker-1'), []);
	Assert.deepEqual(closeReasonsOf('worker-2'), []);
	Assert.equal(deviceRegistry.findWorker('stage_dev_formula_multiply')?.deviceId, 'worker-1');
	Assert.equal(deviceRegistry.findWorker('stage_dev_formula_multiply', ['worker-1'])?.deviceId, 'worker-2');
});

for (const message of [
	{ type: 'worker.state' as const, state: 'ready' as const },
	{ type: 'stage.heartbeat' as const, taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1 },
	{ type: 'stage.accepted' as const, taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1 },
	{ type: 'stage.relinquish' as const, taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1 },
	{ type: 'stage.result' as const, taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1, stage: 'stage_dev_formula_add' as const, value: 1 },
	{ type: 'stage.failed' as const, taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1, stage: 'stage_dev_formula_add' as const, error: 'boom' },
] satisfies ClientMessage[]) {
	Test(`a registered consumer may not send "${message.type}", which every worker-only stage message refuses`, () => {
		const { drive, registerConsumer } = buildClientMessageHandlerHarness();
		registerConsumer('consumer-1', 'consumer-one');

		const [reply] = drive('consumer-1', message);
		Assert.equal(reply?.type, 'error');
		Assert.equal((reply as { code: string }).code, 'WORKER_REQUIRED');
	});
}

Test('a worker cannot extend, accept, or return a result for an assignment it does not currently hold', () => {
	const { drive, registerWorker } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');

	const [heartbeatReply] = drive('worker-1', { type: 'stage.heartbeat', taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1 });
	Assert.equal(heartbeatReply?.type, 'stage.cancel');
	Assert.equal((heartbeatReply as { reason: string }).reason, 'assignment_superseded');

	const [acceptedReply] = drive('worker-1', { type: 'stage.accepted', taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1 });
	Assert.deepEqual(acceptedReply, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: 'task-x' });

	const [resultReply] = drive('worker-1', { type: 'stage.result', taskId: 'task-x', stageAssignmentId: 'assignment-x', attempt: 1, stage: 'stage_dev_formula_add', value: 1 });
	Assert.deepEqual(resultReply, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: 'task-x' });
});

Test('a submitted task is assigned to a matching worker, and runs both stages to completion through the message handler alone', () => {
	const { drive, registerWorker, registerConsumer, allSentTo } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');

	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	Assert.equal(submitReply?.type, 'task.accepted');
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;

	// Assigning the first stage is a side effect of task.submit: the worker is pushed a
	// "stage.assign" for it unprompted, rather than asking for one.
	const firstAssignment = allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	Assert.equal(firstAssignment?.taskId, taskId);
	Assert.equal(firstAssignment?.stage, 'stage_dev_formula_multiply');

	// Accepting draws no direct reply: task updates go only to the consumer and any observers,
	// never to the worker holding the assignment.
	const acceptedReplies = drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt });
	Assert.deepEqual(acceptedReplies, []);

	// Completing the first stage carries two messages back to this same worker: the next
	// stage's assignment, pushed as a side effect before the reply that follows it.
	const firstResultMessages = drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });
	const firstResultReply = firstResultMessages.find((sent) => sent.type === 'stage.result.accepted');
	Assert.equal((firstResultReply as { status: string } | undefined)?.status, 'assigned');

	// The second stage keeps no state on the worker, so the scheduler is free to place it
	// anywhere; with only one worker connected, it comes back to the same one.
	const secondAssignment = firstResultMessages.find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	Assert.equal(secondAssignment?.stage, 'stage_dev_formula_add');
	Assert.notEqual(secondAssignment?.stageAssignmentId, firstAssignment?.stageAssignmentId);

	drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: secondAssignment!.stageAssignmentId, attempt: secondAssignment!.attempt });
	const [secondResultReply] = drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: secondAssignment!.stageAssignmentId, attempt: secondAssignment!.attempt, stage: 'stage_dev_formula_add', value: 17 });
	Assert.deepEqual(secondResultReply, { type: 'stage.result.accepted', taskId, stageAssignmentId: secondAssignment!.stageAssignmentId, attempt: secondAssignment!.attempt, taskRevision: (secondResultReply as { taskRevision: number }).taskRevision, status: 'completed' });

	const [taskReply] = drive('consumer-1', { type: 'task.get', taskId });
	Assert.equal(taskReply?.type, 'task.snapshot');
	Assert.equal((taskReply as { task: { state: string; result: unknown } }).task.state, 'completed');
	Assert.equal((taskReply as { task: { state: string; result: unknown } }).task.result, 17);
});

Test('a task that asked for its answer in pieces reports each piece on the revision that produced it', () => {
	const store = new TaskStore();
	const streamingInput: TaskInput = { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?', generationSettings: { isStreaming: true } };
	const task = createTask(store, streamingInput);
	const stage = 'stage_llm_gemma_nano_chrome_full';

	const afterFirstPiece = store.addStage(task.taskId, { name: stage, value: { newText: 'The', isContinuation: true, done: false } });
	Assert.equal(afterFirstPiece.newText, 'The');
	Assert.equal(afterFirstPiece.generatedText, 'The');

	// The piece belongs to the revision that produced it and to no other. The revision that
	// assigns the next run produces no text, so it must not repeat the piece before it —
	// a consumer joining the pieces would otherwise receive every one of them twice.
	const afterAssigning = store.assign(afterFirstPiece.taskId, 'worker-1', stage, { isContinuation: true });
	Assert.equal(afterAssigning.newText, undefined);
	Assert.equal(afterAssigning.generatedText, 'The');

	const afterSecondPiece = store.addStage(afterAssigning.taskId, { name: stage, value: { newText: ' capital', isContinuation: true, done: false } });
	Assert.equal(afterSecondPiece.newText, ' capital');
	Assert.equal(afterSecondPiece.generatedText, 'The capital');

	// The result that finishes the answer carries the whole answer and no piece, because every
	// piece has already been reported. Adding the whole answer to what was reported would send
	// the answer a second time. The whole answer replaces what the pieces were joined into,
	// because the device that generated it is the authority on what the answer is.
	const afterLastPiece = store.addStage(afterSecondPiece.taskId, { name: stage, value: { text: 'The capital of France is Paris.', done: true } });
	Assert.equal(afterLastPiece.newText, undefined);
	Assert.equal(afterLastPiece.generatedText, 'The capital of France is Paris.');
});

Test('the finished answer replaces what the pieces were joined into, rather than being added to it', () => {
	const store = new TaskStore();
	const streamingInput: TaskInput = { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'Say hi', generationSettings: { isStreaming: true } };
	const task = createTask(store, streamingInput);
	const stage = 'stage_llm_qwen3_0_6b_shard3of3';

	// A piece is the device's own account of how the answer grew, and a device cannot always
	// report an addition: a character written across two tokens is read as a placeholder and then
	// replaced, so a piece can restate what came before it. Joining is how the answer is followed
	// while it is written; what it is, is what the result that finishes it carries.
	const afterRestatement = store.addStage(task.taskId, { name: stage, value: { newText: 'Caf�', done: false } });
	Assert.equal(afterRestatement.generatedText, 'Caf�');

	const finished = store.addStage(afterRestatement.taskId, { name: stage, value: { text: 'Café', done: true } });
	Assert.equal(finished.generatedText, 'Café');
});

Test('a task that asked for no pieces records none, however much text its results carry', () => {
	const store = new TaskStore();
	const task = createTask(store, { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?' });

	const afterPiece = store.addStage(task.taskId, { name: 'stage_llm_gemma_nano_chrome_full', value: { newText: 'The', isContinuation: true, done: false } });
	Assert.equal(afterPiece.newText, undefined);
	Assert.equal(afterPiece.generatedText, undefined);
});

Test('the generation settings a task was submitted with reach the worker on every stage of that task', () => {
	const { drive, registerWorker, registerConsumer, allSentTo } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');

	const input: TaskInput = { ...devFormulaInput(5), generationSettings: { isStreaming: true } };
	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;

	const assignments = () => allSentTo('worker-1').filter((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	const firstAssignment = assignments()[0];
	Assert.deepEqual(firstAssignment?.generationSettings, { isStreaming: true });

	// The settings are read off the stored task rather than remembered from the submission, so
	// the stage that follows carries them too, without the first stage's result passing them on.
	drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt });
	drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });
	Assert.deepEqual(assignments()[1]?.generationSettings, { isStreaming: true });
});

Test('every piece of an answer reaches the consumer that asked for its answer in pieces', () => {
	const { drive, registerWorker, registerConsumer, allSentTo } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one', ['stage_llm_gemma_nano_chrome_full']);
	registerConsumer('consumer-1', 'consumer-one');

	const input: TaskInput = { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?', generationSettings: { isStreaming: true } };
	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;

	const assignments = () => allSentTo('worker-1').filter((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	/** Returns one piece of the answer from the worker, the way one run of the stage does. */
	const returnPiece = (value: unknown): void => {
		const assignment = assignments().at(-1)!;
		drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: assignment.stageAssignmentId, attempt: assignment.attempt });
		drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: assignment.stageAssignmentId, attempt: assignment.attempt, stage: 'stage_llm_gemma_nano_chrome_full', value: value as never });
	};

	returnPiece({ newText: 'The', isContinuation: true, done: false });
	returnPiece({ newText: ' capital', isContinuation: true, done: false });
	returnPiece({ text: 'The capital', done: true });

	const updates = allSentTo('consumer-1').filter((sent): sent is Extract<GatewayMessage, { type: 'task.updated' }> => sent.type === 'task.updated');
	// Every piece arrives exactly once. The revision that produced a piece is the only one that
	// carries it, and it is sent; the revisions that follow it drop it rather than repeating it.
	Assert.deepEqual(updates.flatMap((sent) => sent.update.newText === undefined ? [] : [sent.update.newText]), ['The', ' capital']);
	// Joining the pieces gives the same answer the task completed with, which is what a consumer
	// showing an answer as it is written ends up having shown.
	const completed = updates.filter((sent) => sent.update.state === 'completed').at(-1);
	Assert.equal((completed?.update.result as { text: string }).text, 'The capital');
});

Test('assigning a stage again to the same tab does not first tell that tab to let go of the answer', () => {
	const { drive, registerWorker, registerConsumer, allSentTo, taskStore, scheduler } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one', ['stage_llm_gemma_nano_chrome_full']);
	registerConsumer('consumer-1', 'consumer-one');

	const input: TaskInput = { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?', generationSettings: { isStreaming: true } };
	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	const assignments = () => allSentTo('worker-1').filter((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	const first = assignments()[0]!;

	drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: first.stageAssignmentId, attempt: first.attempt });
	drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: first.stageAssignmentId, attempt: first.attempt, stage: 'stage_llm_gemma_nano_chrome_full', value: { newText: 'The', isContinuation: true, done: false } });
	const second = assignments()[1]!;
	drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: second.stageAssignmentId, attempt: second.attempt });

	// The lease runs out while the tab is still reading its next piece, so the gateway assigns
	// the stage again. The answer is in that tab's memory, so the retry comes back to it — and
	// the tab must not first be told to let go of the answer the retry was sent to carry on.
	const expired = taskStore.get(taskId)!.stageAssignment!;
	taskStore.update(taskId, { stageAssignment: { ...expired, leaseUntil: new Date(Date.now() - 1_000).toISOString() } });
	const before = allSentTo('worker-1').length;
	scheduler.recoverAssignments();

	const sentSince = allSentTo('worker-1').slice(before);
	Assert.deepEqual(sentSince.filter((sent) => sent.type === 'stage.cancel'), []);
	const retry = sentSince.find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	Assert.equal(retry?.taskId, taskId);
	Assert.notEqual(retry?.stageAssignmentId, second.stageAssignmentId);
});

Test('a run that carries an answer on is never placed on a device that is not holding it', () => {
	const { drive, registerWorker, registerConsumer, allSentTo, taskStore, scheduler } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one', ['stage_llm_gemma_nano_chrome_full']);
	registerConsumer('consumer-1', 'consumer-one');

	const input: TaskInput = { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?', generationSettings: { isStreaming: true } };
	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	const first = allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign')!;

	drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: first.stageAssignmentId, attempt: first.attempt });
	drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: first.stageAssignmentId, attempt: first.attempt, stage: 'stage_llm_gemma_nano_chrome_full', value: { newText: 'The', isContinuation: true, done: false } });

	// A second tab appears while the first one is holding the answer. The answer is in the first
	// tab's memory and nowhere else, so the run that carries it on cannot be given to the second,
	// where it could only fail — and a failed stage fails the whole task. The task waits instead,
	// which the submission deadline bounds.
	registerWorker('worker-2', 'worker-two', ['stage_llm_gemma_nano_chrome_full']);
	taskStore.update(taskId, { state: 'queued', stageAssignment: undefined });
	drive('worker-1', { type: 'worker.state', state: 'draining' });
	scheduler.scheduleQueuedTasks();

	Assert.deepEqual(allSentTo('worker-2').filter((sent) => sent.type === 'stage.assign'), []);
	Assert.equal(taskStore.get(taskId)?.state, 'queued');
});

Test('a task submitted without generation settings puts no settings field on the assignment', () => {
	const { drive, registerWorker, registerConsumer, allSentTo } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');

	drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });

	const assignment = allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	Assert.equal(assignment === undefined, false);
	Assert.equal('generationSettings' in assignment!, false);
});

Test('a task may only be cancelled by the consumer that owns it', () => {
	const { drive, registerWorker, registerConsumer } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');
	registerConsumer('consumer-2', 'consumer-two');

	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;

	const [strangerReply] = drive('consumer-2', { type: 'task.cancel', taskId, reason: 'no longer needed' });
	Assert.deepEqual(strangerReply, { type: 'error', code: 'TASK_OWNER_MISMATCH', message: 'Only the task owner may cancel this task', taskId });

	const [ownerReply] = drive('consumer-1', { type: 'task.cancel', taskId, reason: 'no longer needed' });
	Assert.equal(ownerReply?.type, 'task.updated');
	Assert.equal((ownerReply as { update: { state: string } }).update.state, 'cancelled');
});

Test('a consumer may read its own task, but not a task belonging to someone else without an observer grant', () => {
	const { drive, registerWorker, registerConsumer } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');
	registerConsumer('consumer-1', 'consumer-one');
	registerConsumer('consumer-2', 'consumer-two');

	const [submitReply] = drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;

	const [ownerReply] = drive('consumer-1', { type: 'task.get', taskId });
	Assert.equal(ownerReply?.type, 'task.snapshot');

	const [strangerReply] = drive('consumer-2', { type: 'task.get', taskId });
	Assert.deepEqual(strangerReply, { type: 'error', code: 'AUTHORISATION', message: 'This connection is not allowed to read the task', retryable: false, taskId });

	drive('consumer-1', { type: 'task.observer.grant', taskId, consumerDeviceId: 'consumer-2' });
	const [afterGrantReply] = drive('consumer-2', { type: 'task.get', taskId });
	Assert.equal(afterGrantReply?.type, 'task.snapshot');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Accounts and key pair authentication
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Generates one account key pair and writes down its public key the way a message carries it. */
const newAccountKeyPair = async (): Promise<{ keyPair: AccountCryptoKeyPair; publicKeySpkiBase64: string; accountId: string }> => {
	const keyPair = await AccountIdentity.generateKeyPair('Ed25519');
	const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
	return { keyPair, publicKeySpkiBase64, accountId: await AccountIdentity.accountIdFor(publicKeySpkiBase64) };
};

Test('registering a public key the gateway already knows returns the stored profile and changes nothing', async () => {
	const { publicKeySpkiBase64, accountId } = await newAccountKeyPair();
	const registry = new AccountRegistry();

	const first = registry.register({ accountId, signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, emailAddress: 'first@example.com', displayName: 'First' });
	Assert.equal(first.isNewAccount, true);
	Assert.equal(first.account.accountId, accountId);

	// Registration does not prove the sender holds the private key, so a second registration of the
	// same key must not be able to rewrite the profile of the account somebody else owns.
	const second = registry.register({ accountId, signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, emailAddress: 'stranger@example.com', displayName: 'Stranger' });
	Assert.equal(second.isNewAccount, false);
	Assert.equal(second.account.emailAddress, 'first@example.com');
	Assert.equal(second.account.displayName, 'First');
	Assert.equal(registry.list().length, 1);
});

Test('accounts survive a gateway restart, and an account file this gateway cannot read stops it', async () => {
	const { publicKeySpkiBase64, accountId } = await newAccountKeyPair();
	const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'gateway-accounts-'));
	const accountFilePath = Path.join(directory, 'gateway-accounts.json');

	const before = new AccountRegistry(accountFilePath);
	before.register({ accountId, signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, emailAddress: 'volunteer@example.com', displayName: 'Volunteer' });

	const after = new AccountRegistry(accountFilePath);
	Assert.deepEqual(after.get(accountId), before.get(accountId));

	// Starting with an empty registry instead would hand every returning participant a second
	// account, so an unreadable account file stops the gateway rather than being ignored.
	Fs.writeFileSync(accountFilePath, JSON.stringify({ schemaVersion: 99, accounts: [] }), 'utf8');
	Assert.throws(() => new AccountRegistry(accountFilePath), /Unsupported account file schema/);
});

Test('a challenge may be signed once, is refused after it expires, and a new one replaces the old', () => {
	let currentTime = 1_000_000;
	const registry = new ChallengeRegistry(60_000, () => currentTime);

	const issued = registry.issue('device-a');
	Assert.equal(issued.challenge.length, 64);
	Assert.equal(issued.expiresAt, currentTime + 60_000);

	// Taking the challenge is what makes a captured signature useless: the value is gone whether the
	// signature over it was accepted or refused.
	Assert.deepEqual(registry.consume('device-a'), { verdict: 'accepted', challenge: issued.challenge });
	Assert.deepEqual(registry.consume('device-a'), { verdict: 'unknown' });

	// A challenge issued to one connection cannot be signed by another.
	registry.issue('device-a');
	Assert.deepEqual(registry.consume('device-b'), { verdict: 'unknown' });

	const second = registry.issue('device-a');
	Assert.notEqual(second.challenge, issued.challenge);
	currentTime += 60_000;
	Assert.deepEqual(registry.consume('device-a'), { verdict: 'expired' });
});

Test('a connection becomes a named account by registering a public key and signing the challenge it is handed', async () => {
	const { driveAccountMessage, authenticate, sessionRegistry } = buildClientMessageHandlerHarness();
	const { keyPair, publicKeySpkiBase64, accountId } = await newAccountKeyPair();
	authenticate('device-a');

	const [registered] = await driveAccountMessage('device-a', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64, emailAddress: 'volunteer@example.com', displayName: 'Volunteer' });
	Assert.equal(registered?.type, 'account.registered');
	Assert.equal((registered as { isNewAccount: boolean }).isNewAccount, true);
	Assert.equal((registered as { account: AccountProfile }).account.accountId, accountId);

	// The shared token alone says nothing about which participant presented it, so a session carries
	// no account until a signature proves which private key is on the connection.
	Assert.equal(sessionRegistry.active('device-a')?.accountId, undefined);

	const [challenge] = await driveAccountMessage('device-a', { type: 'account.challenge.request' });
	Assert.equal(challenge?.type, 'account.challenge');
	const challengeValue = (challenge as { challenge: string }).challenge;

	const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', keyPair.privateKey, challengeValue);
	const [authenticated] = await driveAccountMessage('device-a', { type: 'account.authenticate', accountId, signatureBase64 });
	Assert.equal(authenticated?.type, 'account.authenticated');
	Assert.equal((authenticated as { accountId: string }).accountId, accountId);
	Assert.equal(sessionRegistry.active('device-a')?.accountId, accountId);
});

Test('two participants presenting the same shared token become two different accounts', async () => {
	const { driveAccountMessage, authenticate, sessionRegistry } = buildClientMessageHandlerHarness();
	const first = await newAccountKeyPair();
	const second = await newAccountKeyPair();

	for (const [deviceId, participant] of [['device-a', first], ['device-b', second]] as const) {
		authenticate(deviceId);
		await driveAccountMessage(deviceId, { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64: participant.publicKeySpkiBase64 });
		const [challenge] = await driveAccountMessage(deviceId, { type: 'account.challenge.request' });
		const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', participant.keyPair.privateKey, (challenge as { challenge: string }).challenge);
		await driveAccountMessage(deviceId, { type: 'account.authenticate', accountId: participant.accountId, signatureBase64 });
	}

	// This is the whole point of the milestone: the two connections presented the identical shared
	// token, so their authIdentity is the same, and their accounts are not.
	Assert.equal(sessionRegistry.active('device-a')?.authIdentity, sessionRegistry.active('device-b')?.authIdentity);
	Assert.notEqual(first.accountId, second.accountId);
	Assert.equal(sessionRegistry.active('device-a')?.accountId, first.accountId);
	Assert.equal(sessionRegistry.active('device-b')?.accountId, second.accountId);
});

Test('a signature over the wrong challenge is refused, and the attempt spends the challenge', async () => {
	const { driveAccountMessage, authenticate, sessionRegistry } = buildClientMessageHandlerHarness();
	const { keyPair, publicKeySpkiBase64, accountId } = await newAccountKeyPair();
	authenticate('device-a');
	await driveAccountMessage('device-a', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 });
	await driveAccountMessage('device-a', { type: 'account.challenge.request' });

	const signatureOverSomethingElse = await AccountIdentity.signChallenge('Ed25519', keyPair.privateKey, 'a value this gateway never handed out');
	const [rejected] = await driveAccountMessage('device-a', { type: 'account.authenticate', accountId, signatureBase64: signatureOverSomethingElse });
	Assert.equal((rejected as { code: string }).code, 'ACCOUNT_SIGNATURE_REJECTED');
	Assert.equal(sessionRegistry.active('device-a')?.accountId, undefined);

	// The refused attempt used the challenge up, so the sender has to ask for another value to sign
	// rather than keep trying against the same one.
	const [afterRefusal] = await driveAccountMessage('device-a', { type: 'account.authenticate', accountId, signatureBase64: signatureOverSomethingElse });
	Assert.equal((afterRefusal as { code: string }).code, 'ACCOUNT_CHALLENGE_INVALID');
});

Test('a signature made by a different key pair than the account it claims is refused', async () => {
	const { driveAccountMessage, authenticate, sessionRegistry } = buildClientMessageHandlerHarness();
	const owner = await newAccountKeyPair();
	const impostor = await newAccountKeyPair();
	authenticate('device-a');
	await driveAccountMessage('device-a', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64: owner.publicKeySpkiBase64 });

	const [challenge] = await driveAccountMessage('device-a', { type: 'account.challenge.request' });
	const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', impostor.keyPair.privateKey, (challenge as { challenge: string }).challenge);
	const [rejected] = await driveAccountMessage('device-a', { type: 'account.authenticate', accountId: owner.accountId, signatureBase64 });
	Assert.equal((rejected as { code: string }).code, 'ACCOUNT_SIGNATURE_REJECTED');
	Assert.equal(sessionRegistry.active('device-a')?.accountId, undefined);
});

Test('authenticating as an account the gateway does not know, and authenticating with no challenge, are told apart', async () => {
	const { driveAccountMessage, authenticate } = buildClientMessageHandlerHarness();
	const { keyPair, publicKeySpkiBase64, accountId } = await newAccountKeyPair();
	authenticate('device-a');

	const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', keyPair.privateKey, 'anything');
	const [unknownAccount] = await driveAccountMessage('device-a', { type: 'account.authenticate', accountId, signatureBase64 });
	Assert.equal((unknownAccount as { code: string }).code, 'ACCOUNT_NOT_FOUND');

	await driveAccountMessage('device-a', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 });
	const [noChallenge] = await driveAccountMessage('device-a', { type: 'account.authenticate', accountId, signatureBase64 });
	Assert.equal((noChallenge as { code: string }).code, 'ACCOUNT_CHALLENGE_INVALID');
});

Test('an account message from a connection that has presented nothing at all is refused before it is read', async () => {
	const { driveAccountMessage } = buildClientMessageHandlerHarness();
	const { publicKeySpkiBase64 } = await newAccountKeyPair();

	// Account registration is not open to a stranger: the connection has to authenticate with the
	// gateway's shared token first, so the account file cannot be filled by anyone who can open a
	// socket.
	const [refused] = await driveAccountMessage('device-a', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 });
	Assert.equal((refused as { code: string }).code, 'AUTHENTICATION_REQUIRED');
});

Test('an account survives its connection, and a new connection authenticates as it again without registering', async () => {
	const { driveAccountMessage, authenticate, sessionRegistry } = buildClientMessageHandlerHarness();
	const { keyPair, publicKeySpkiBase64, accountId } = await newAccountKeyPair();

	authenticate('device-a');
	const [registered] = await driveAccountMessage('device-a', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 });
	Assert.equal((registered as { isNewAccount: boolean }).isNewAccount, true);

	// The same participant coming back on a second connection is told the account already exists,
	// which is what a worker browser page needs: it registers on every visit rather than remembering
	// whether it has registered before.
	authenticate('device-b');
	const [again] = await driveAccountMessage('device-b', { type: 'account.register', signatureAlgorithmName: 'Ed25519', publicKeySpkiBase64 });
	Assert.equal((again as { isNewAccount: boolean }).isNewAccount, false);

	const [challenge] = await driveAccountMessage('device-b', { type: 'account.challenge.request' });
	const signatureBase64 = await AccountIdentity.signChallenge('Ed25519', keyPair.privateKey, (challenge as { challenge: string }).challenge);
	const [authenticated] = await driveAccountMessage('device-b', { type: 'account.authenticate', accountId, signatureBase64 });
	Assert.equal(authenticated?.type, 'account.authenticated');
	Assert.equal(sessionRegistry.active('device-b')?.accountId, accountId);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The append-only accounting ledger
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Builds a ledger store on a file of its own, with a fixed clock and countable entry identifiers. */
const buildLedgerStore = (): { store: LedgerStore; ledgerFilePath: string; reopen: () => LedgerStore } => {
	const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'gateway-ledger-'));
	const ledgerFilePath = Path.join(directory, 'gateway-ledger.jsonl');
	let recordedCount = 0;
	const newLedgerEntryId = (): string => `ledgerEntry-${String(++recordedCount).padStart(4, '0')}`;
	const at = new Date('2026-08-05T12:00:00.000Z');
	return {
		store: new LedgerStore(ledgerFilePath, () => at, newLedgerEntryId),
		ledgerFilePath,
		reopen: (): LedgerStore => new LedgerStore(ledgerFilePath, () => at),
	};
};

/** One completed stage, as the recorder of the next milestone will state it. */
const stageEvent = (accountId: string, creditDelta: 1 | -1, stageNumber: number): LedgerEntryDraft => ({
	accountId,
	creditDelta,
	taskId: 'task-1',
	stageName: 'stage_dev_formula_multiply',
	stageAssignmentId: `stageAssignment-${stageNumber}`,
	workerDeviceId: 'device-worker',
	consumerDeviceId: 'device-consumer',
	stageDurationMs: 120,
});

Test('a balance is what an account\'s entries add up to, and each side of the ledger is counted', () => {
	const { store } = buildLedgerStore();

	for (const stageNumber of [1, 2, 3]) store.append(stageEvent('account-worker', 1, stageNumber));
	for (const stageNumber of [1, 2, 3]) store.append(stageEvent('account-consumer', -1, stageNumber));
	store.append(stageEvent('account-worker', -1, 4));

	Assert.deepEqual(store.summaryFor('account-worker'), { accountId: 'account-worker', balance: 2, earnedStageCount: 3, spentStageCount: 1 });

	// A consumer goes negative and is not stopped: Version 1 has no floor, which is exactly what the
	// worked example of issue #122 describes.
	Assert.deepEqual(store.summaryFor('account-consumer'), { accountId: 'account-consumer', balance: -3, earnedStageCount: 0, spentStageCount: 3 });

	// An account that has neither earned nor spent anything is a real state, not a missing one.
	Assert.deepEqual(store.summaryFor('account-nobody'), { accountId: 'account-nobody', balance: 0, earnedStageCount: 0, spentStageCount: 0 });
});

Test('the ledger is one JSON object per line, appended and never rewritten', () => {
	const { store, ledgerFilePath } = buildLedgerStore();

	const first = store.append(stageEvent('account-worker', 1, 1));
	const afterFirst = Fs.readFileSync(ledgerFilePath, 'utf8');
	const second = store.append(stageEvent('account-worker', 1, 2));
	const afterSecond = Fs.readFileSync(ledgerFilePath, 'utf8');

	// The file after the second entry is the file after the first with one line added to the end, so
	// nothing already written was touched to record what came next.
	Assert.equal(afterSecond.startsWith(afterFirst), true);
	Assert.deepEqual(afterSecond.trim().split('\n').map((line) => JSON.parse(line).ledgerEntryId), [first.ledgerEntryId, second.ledgerEntryId]);
	Assert.equal(first.recordedAt, '2026-08-05T12:00:00.000Z');
});

Test('balances survive a gateway restart, because they are rebuilt from the file', () => {
	const { store, reopen } = buildLedgerStore();
	store.append(stageEvent('account-worker', 1, 1));
	store.append(stageEvent('account-worker', 1, 2));
	store.append(stageEvent('account-consumer', -1, 1));

	const afterRestart = reopen();
	Assert.deepEqual(afterRestart.summaryFor('account-worker'), store.summaryFor('account-worker'));
	Assert.deepEqual(afterRestart.summaryFor('account-consumer'), store.summaryFor('account-consumer'));
	Assert.equal(afterRestart.summaries().length, 2);

	// A restarted gateway keeps appending to the same history rather than starting a new one.
	afterRestart.append(stageEvent('account-worker', 1, 3));
	Assert.equal(afterRestart.readAll().length, 4);
});

Test('a ledger line this gateway cannot read stops the read and names the line, rather than being skipped', () => {
	const { store, ledgerFilePath, reopen } = buildLedgerStore();
	store.append(stageEvent('account-worker', 1, 1));
	store.append(stageEvent('account-worker', 1, 2));

	// Skipping what cannot be parsed would report a balance wrong by however much was skipped, with
	// nothing to say anything was missing.
	Fs.appendFileSync(ledgerFilePath, 'this line is not a ledger entry\n', 'utf8');
	Assert.throws(() => reopen(), /Unreadable accounting ledger entry .* line 3/);

	// A credit change Version 1 does not have is refused just as firmly as text that is not JSON, so
	// a larger number cannot be written into the same ledger without widening the definition first.
	const { store: other, ledgerFilePath: otherPath, reopen: reopenOther } = buildLedgerStore();
	other.append(stageEvent('account-worker', 1, 1));
	Fs.appendFileSync(otherPath, `${JSON.stringify({ ...stageEvent('account-worker', 1, 2), ledgerEntryId: 'ledgerEntry-x', recordedAt: '2026-08-05T12:00:00.000Z', creditDelta: 7 })}\n`, 'utf8');
	Assert.throws(() => reopenOther(), /Unreadable accounting ledger entry .* line 2/);
});

Test('history is read newest first, one side of the ledger at a time, one page at a time', () => {
	const { store } = buildLedgerStore();
	const earned = [1, 2, 3].map((stageNumber) => store.append(stageEvent('account-worker', 1, stageNumber)));
	const spent = [4, 5].map((stageNumber) => store.append(stageEvent('account-worker', -1, stageNumber)));
	store.append(stageEvent('account-someone-else', 1, 1));

	const everything = store.entriesFor('account-worker');
	Assert.deepEqual(everything.entries.map((entry) => entry.ledgerEntryId), [...earned, ...spent].reverse().map((entry) => entry.ledgerEntryId));
	Assert.equal(everything.nextCursor, undefined);

	Assert.deepEqual(store.entriesFor('account-worker', { direction: 'earned' }).entries.map((entry) => entry.creditDelta), [1, 1, 1]);
	Assert.deepEqual(store.entriesFor('account-worker', { direction: 'spent' }).entries.map((entry) => entry.creditDelta), [-1, -1]);

	// One account's history holds nothing belonging to another account.
	Assert.equal(store.entriesFor('account-worker').entries.every((entry) => entry.accountId === 'account-worker'), true);

	const firstPage = store.entriesFor('account-worker', { limit: 2 });
	Assert.equal(firstPage.entries.length, 2);
	Assert.equal(firstPage.nextCursor, firstPage.entries.at(-1)?.ledgerEntryId);

	const secondPage = store.entriesFor('account-worker', { limit: 2, before: firstPage.nextCursor });
	const thirdPage = store.entriesFor('account-worker', { limit: 2, before: secondPage.nextCursor });
	Assert.deepEqual([...firstPage.entries, ...secondPage.entries, ...thirdPage.entries].map((entry) => entry.ledgerEntryId), everything.entries.map((entry) => entry.ledgerEntryId));

	// The reader stops because the last page offers no cursor, rather than by counting.
	Assert.equal(thirdPage.nextCursor, undefined);
});

Test('a cursor that names no entry of this account returns nothing, rather than the newest page again', () => {
	const { store } = buildLedgerStore();
	store.append(stageEvent('account-worker', 1, 1));
	const otherAccountEntry = store.append(stageEvent('account-someone-else', 1, 1));

	Assert.deepEqual(store.entriesFor('account-worker', { before: 'ledgerEntry-does-not-exist' }).entries, []);
	Assert.deepEqual(store.entriesFor('account-worker', { before: otherAccountEntry.ledgerEntryId }).entries, []);
});

Test('a ledger with no file to write to is refused, rather than kept in memory and lost on restart', () => {
	Assert.throws(() => new LedgerStore(''), /A ledger file path is required/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Recording the two accounting events
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs one whole two-stage `dev_formula` task to completion, the way the four earlier tests of the
 * dispatch harness do, and returns the identifier of the task that ran.
 */
const runWholeDevFormulaTask = (harness: ReturnType<typeof buildClientMessageHandlerHarness>): string => {
	const [submitReply] = harness.drive('consumer-1', { type: 'task.submit', taskRequestId: `request-${Math.random()}`, input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	const firstAssignment = harness.allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign' && sent.taskId === taskId);
	harness.drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt });
	const afterFirst = harness.drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });
	const secondAssignment = afterFirst.find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	harness.drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: secondAssignment!.stageAssignmentId, attempt: secondAssignment!.attempt });
	harness.drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: secondAssignment!.stageAssignmentId, attempt: secondAssignment!.attempt, stage: 'stage_dev_formula_add', value: 17 });
	return taskId;
};

Test('every completed stage earns the worker one credit and costs the consumer one credit', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerConsumer('consumer-1', 'consumer-one');
	const taskId = runWholeDevFormulaTask(harness);

	// Two stages ran, so four entries exist: the worker earned twice and the consumer spent twice.
	const entries = harness.ledgerStore.readAll();
	Assert.equal(entries.length, 4);
	Assert.deepEqual(entries.map((entry) => entry.creditDelta), [1, -1, 1, -1]);
	Assert.deepEqual(entries.map((entry) => entry.stageName), ['stage_dev_formula_multiply', 'stage_dev_formula_multiply', 'stage_dev_formula_add', 'stage_dev_formula_add']);
	Assert.equal(entries.every((entry) => entry.taskId === taskId), true);
	Assert.equal(entries.every((entry) => entry.workerDeviceId === 'worker-1' && entry.consumerDeviceId === 'consumer-1'), true);

	// The two entries of one completed stage carry the same assignment identifier, which is what lets
	// one stage be followed from either side of the ledger.
	Assert.equal(entries[0]?.stageAssignmentId, entries[1]?.stageAssignmentId);
	Assert.notEqual(entries[0]?.stageAssignmentId, entries[2]?.stageAssignmentId);

	// Every stage was held by a worker that accepted its assignment, so every entry carries how long
	// that took. It changes no balance: both sides moved by exactly one credit per stage.
	Assert.equal(entries.every((entry) => typeof entry.stageDurationMs === 'number'), true);
});

Test('a worker earns into its own account, and the consumer spends from its own', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	const workerAccountId = await harness.authenticateAccount('worker-1');
	harness.registerConsumer('consumer-1', 'consumer-one');
	const consumerAccountId = await harness.authenticateAccount('consumer-1');

	runWholeDevFormulaTask(harness);

	Assert.notEqual(workerAccountId, consumerAccountId);
	Assert.deepEqual(harness.ledgerStore.summaryFor(workerAccountId), { accountId: workerAccountId, balance: 2, earnedStageCount: 2, spentStageCount: 0 });
	Assert.deepEqual(harness.ledgerStore.summaryFor(consumerAccountId), { accountId: consumerAccountId, balance: -2, earnedStageCount: 0, spentStageCount: 2 });
	Assert.deepEqual(harness.ledgerStore.summaryFor(AccountingRecorder.sharedDevelopmentAccountId), { accountId: AccountingRecorder.sharedDevelopmentAccountId, balance: 0, earnedStageCount: 0, spentStageCount: 0 });
});

Test('a participant that has authenticated no account of its own is recorded against the shared development account', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerConsumer('consumer-1', 'consumer-one');

	// Both connections presented the gateway's shared token and nothing else, which says nothing about
	// who presented it, so their work is attributed to nobody rather than dropped.
	runWholeDevFormulaTask(harness);
	Assert.deepEqual(harness.ledgerStore.summaryFor(AccountingRecorder.sharedDevelopmentAccountId), { accountId: AccountingRecorder.sharedDevelopmentAccountId, balance: 0, earnedStageCount: 2, spentStageCount: 2 });
});

Test('a consumer spends from the account it submitted under, even once that consumer has gone', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerConsumer('consumer-1', 'consumer-one');
	const consumerAccountId = await harness.authenticateAccount('consumer-1');

	const [submitReply] = harness.drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	Assert.equal(harness.taskStore.get(taskId)?.consumerAccountId, consumerAccountId);

	// A consumer that submitted batch work is expected to be gone by the time its stages complete, so
	// the account is read from the task rather than from a session that no longer exists.
	harness.sessionRegistry.close('consumer-1');

	const firstAssignment = harness.allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	harness.drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt });
	harness.drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: firstAssignment!.stageAssignmentId, attempt: firstAssignment!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });

	Assert.equal(harness.ledgerStore.summaryFor(consumerAccountId).spentStageCount, 1);
});

Test('a stage that fails earns nothing and costs nothing', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerConsumer('consumer-1', 'consumer-one');

	const [submitReply] = harness.drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	const assignment = harness.allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	harness.drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: assignment!.stageAssignmentId, attempt: assignment!.attempt });
	harness.drive('worker-1', { type: 'stage.failed', taskId, stageAssignmentId: assignment!.stageAssignmentId, attempt: assignment!.attempt, stage: 'stage_dev_formula_multiply', error: 'the shard fell over' });

	Assert.deepEqual(harness.ledgerStore.readAll(), []);
});

Test('a stage handed back and finished by another worker earns one credit and costs one credit, not one per attempt', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerWorker('worker-2', 'worker-two');
	harness.registerConsumer('consumer-1', 'consumer-one');

	const [submitReply] = harness.drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;

	// The first worker hands the assignment back rather than running it, which places the same stage on
	// the other worker under a new assignment identifier.
	const firstAttempt = harness.taskStore.get(taskId)?.stageAssignment;
	harness.drive(firstAttempt!.workerDeviceId, { type: 'stage.relinquish', taskId, stageAssignmentId: firstAttempt!.stageAssignmentId, attempt: firstAttempt!.attempt });
	Assert.deepEqual(harness.ledgerStore.readAll(), []);

	const secondAttempt = harness.taskStore.get(taskId)?.stageAssignment;
	Assert.notEqual(secondAttempt?.stageAssignmentId, firstAttempt?.stageAssignmentId);
	Assert.notEqual(secondAttempt?.workerDeviceId, firstAttempt?.workerDeviceId);

	harness.drive(secondAttempt!.workerDeviceId, { type: 'stage.accepted', taskId, stageAssignmentId: secondAttempt!.stageAssignmentId, attempt: secondAttempt!.attempt });
	harness.drive(secondAttempt!.workerDeviceId, { type: 'stage.result', taskId, stageAssignmentId: secondAttempt!.stageAssignmentId, attempt: secondAttempt!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });

	// One completion happened, so one credit and one debit exist, and they name the attempt that
	// actually finished and the worker that actually ran it.
	const forThatStage = harness.ledgerStore.readAll().filter((entry) => entry.stageName === 'stage_dev_formula_multiply');
	Assert.equal(forThatStage.length, 2);
	Assert.deepEqual(forThatStage.map((entry) => entry.creditDelta), [1, -1]);
	Assert.equal(forThatStage.every((entry) => entry.stageAssignmentId === secondAttempt?.stageAssignmentId), true);
	Assert.equal(forThatStage.every((entry) => entry.workerDeviceId === secondAttempt?.workerDeviceId), true);
});

Test('a stale result that the gateway has already recorded is not recorded a second time', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerConsumer('consumer-1', 'consumer-one');

	const [submitReply] = harness.drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	const assignment = harness.allSentTo('worker-1').find((sent): sent is Extract<GatewayMessage, { type: 'stage.assign' }> => sent.type === 'stage.assign');
	harness.drive('worker-1', { type: 'stage.accepted', taskId, stageAssignmentId: assignment!.stageAssignmentId, attempt: assignment!.attempt });
	harness.drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: assignment!.stageAssignmentId, attempt: assignment!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });
	const afterFirstResult = harness.ledgerStore.readAll().length;

	// A worker whose connection dropped as it sent its result sends that result again on reconnecting.
	// The gateway answers that the result is already in hand, and the ledger must not move for it: the
	// stage completed once.
	const [repeatedReply] = harness.drive('worker-1', { type: 'stage.result', taskId, stageAssignmentId: assignment!.stageAssignmentId, attempt: assignment!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });
	Assert.equal(repeatedReply?.type, 'stage.result.accepted');
	Assert.equal(harness.ledgerStore.readAll().length, afterFirstResult);
});

Test('a stage whose lease expired and is retried earns one credit and costs one credit, not one per attempt', () => {
	const harness = buildClientMessageHandlerHarness(0);
	// Two workers, because this stage keeps no state on the device running it, so the recovery sweep
	// deliberately places the retry somewhere other than the worker that went quiet.
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerWorker('worker-2', 'worker-two');
	harness.registerConsumer('consumer-1', 'consumer-one');

	const [submitReply] = harness.drive('consumer-1', { type: 'task.submit', taskRequestId: 'request-1', input: devFormulaInput(5) });
	const taskId = (submitReply as { task: { taskId: string } }).task.taskId;
	const firstAttempt = harness.taskStore.get(taskId)?.stageAssignment;

	// The most common retry: a worker that went quiet, whose lease ran out, and whose stage the
	// recovery sweep places again. Nothing is recorded for the attempt that was abandoned.
	harness.scheduler.recoverAssignments();
	Assert.deepEqual(harness.ledgerStore.readAll(), []);

	const secondAttempt = harness.taskStore.get(taskId)?.stageAssignment;
	Assert.equal(secondAttempt?.attempt, 2);
	Assert.notEqual(secondAttempt?.stageAssignmentId, firstAttempt?.stageAssignmentId);

	harness.drive(secondAttempt!.workerDeviceId, { type: 'stage.accepted', taskId, stageAssignmentId: secondAttempt!.stageAssignmentId, attempt: secondAttempt!.attempt });
	harness.drive(secondAttempt!.workerDeviceId, { type: 'stage.result', taskId, stageAssignmentId: secondAttempt!.stageAssignmentId, attempt: secondAttempt!.attempt, stage: 'stage_dev_formula_multiply', value: 10 });

	const forThatStage = harness.ledgerStore.readAll().filter((entry) => entry.stageName === 'stage_dev_formula_multiply');
	Assert.equal(forThatStage.length, 2);
	Assert.deepEqual(forThatStage.map((entry) => entry.creditDelta), [1, -1]);
	Assert.equal(forThatStage.every((entry) => entry.stageAssignmentId === secondAttempt?.stageAssignmentId), true);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Reading accounting information back out
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('an account reads its own profile, its own balance, and its own history', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	const workerAccountId = await harness.authenticateAccount('worker-1');
	harness.registerConsumer('consumer-1', 'consumer-one');
	const consumerAccountId = await harness.authenticateAccount('consumer-1');
	runWholeDevFormulaTask(harness);

	const [profile] = harness.drive('worker-1', { type: 'account.get' });
	Assert.equal(profile?.type, 'account.profile');
	Assert.equal((profile as { account: AccountProfile }).account.accountId, workerAccountId);
	Assert.equal((profile as { account: AccountProfile }).account.signatureAlgorithmName, 'Ed25519');

	// The worker completed both stages, and the consumer paid for both.
	const [workerBalance] = harness.drive('worker-1', { type: 'account.balance.get' });
	Assert.deepEqual(workerBalance, { type: 'account.balance', summary: { accountId: workerAccountId, balance: 2, earnedStageCount: 2, spentStageCount: 0 } });
	const [consumerBalance] = harness.drive('consumer-1', { type: 'account.balance.get' });
	Assert.deepEqual(consumerBalance, { type: 'account.balance', summary: { accountId: consumerAccountId, balance: -2, earnedStageCount: 0, spentStageCount: 2 } });

	const [history] = harness.drive('worker-1', { type: 'account.ledger.get' });
	Assert.equal(history?.type, 'account.ledger');
	const page = history as { accountId: string; direction: string; entries: LedgerEntry[]; nextCursor?: string };
	Assert.equal(page.accountId, workerAccountId);
	Assert.equal(page.direction, 'both');
	Assert.equal(page.entries.length, 2);

	// Newest first, and one account's history holds nothing belonging to another account.
	Assert.deepEqual(page.entries.map((entry) => entry.stageName), ['stage_dev_formula_add', 'stage_dev_formula_multiply']);
	Assert.equal(page.entries.every((entry) => entry.accountId === workerAccountId), true);
	Assert.equal(page.nextCursor, undefined);
});

Test('a history read states the side of the ledger it read, and pages through with the cursor it gives', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	const workerAccountId = await harness.authenticateAccount('worker-1');
	harness.registerConsumer('consumer-1', 'consumer-one');
	await harness.authenticateAccount('consumer-1');
	runWholeDevFormulaTask(harness);
	runWholeDevFormulaTask(harness);

	const [earned] = harness.drive('worker-1', { type: 'account.ledger.get', direction: 'earned' });
	Assert.equal((earned as { direction: string }).direction, 'earned');
	Assert.equal((earned as { entries: LedgerEntry[] }).entries.length, 4);
	Assert.equal((earned as { entries: LedgerEntry[] }).entries.every((entry) => entry.creditDelta === 1), true);

	// A worker never spends, so the other side of its ledger is empty rather than absent.
	const [spent] = harness.drive('worker-1', { type: 'account.ledger.get', direction: 'spent' });
	Assert.deepEqual(spent, { type: 'account.ledger', accountId: workerAccountId, direction: 'spent', entries: [] });

	const [firstPage] = harness.drive('worker-1', { type: 'account.ledger.get', limit: 3 });
	const firstCursor = (firstPage as { nextCursor?: string }).nextCursor;
	Assert.equal((firstPage as { entries: LedgerEntry[] }).entries.length, 3);
	Assert.notEqual(firstCursor, undefined);

	const [secondPage] = harness.drive('worker-1', { type: 'account.ledger.get', limit: 3, before: firstCursor });
	Assert.equal((secondPage as { entries: LedgerEntry[] }).entries.length, 1);
	Assert.equal((secondPage as { nextCursor?: string }).nextCursor, undefined);
});

Test('a connection may read its own account and no other', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	const workerAccountId = await harness.authenticateAccount('worker-1');
	harness.registerConsumer('consumer-1', 'consumer-one');
	const consumerAccountId = await harness.authenticateAccount('consumer-1');
	runWholeDevFormulaTask(harness);

	// Naming its own account is allowed, and is how a client states which account it believes it is.
	const [named] = harness.drive('worker-1', { type: 'account.balance.get', accountId: workerAccountId });
	Assert.equal(named?.type, 'account.balance');

	// Naming somebody else's is refused for all three reads, rather than answered with their figures.
	for (const message of [
		{ type: 'account.get' as const, accountId: consumerAccountId },
		{ type: 'account.balance.get' as const, accountId: consumerAccountId },
		{ type: 'account.ledger.get' as const, accountId: consumerAccountId },
	]) {
		const [refused] = harness.drive('worker-1', message);
		Assert.equal((refused as { code: string }).code, 'AUTHORISATION');
		Assert.equal((refused as unknown as { details: { authenticatedAccountId: string } }).details.authenticatedAccountId, workerAccountId);
	}
});

Test('a connection that has authenticated no account is told to authenticate one, not that it may not read', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');

	// The shared token names no participant, so there is no account of this connection's own to read.
	for (const message of [{ type: 'account.get' as const }, { type: 'account.balance.get' as const }, { type: 'account.ledger.get' as const }]) {
		const [refused] = harness.drive('worker-1', message);
		Assert.equal((refused as { code: string }).code, 'ACCOUNT_REQUIRED');
		Assert.equal((refused as { retryable: boolean }).retryable, true);
	}
});

Test('an account that has neither earned nor spent anything reads a balance of zero and an empty history', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerConsumer('consumer-1', 'consumer-one');
	const accountId = await harness.authenticateAccount('consumer-1');

	Assert.deepEqual(harness.drive('consumer-1', { type: 'account.balance.get' })[0], { type: 'account.balance', summary: { accountId, balance: 0, earnedStageCount: 0, spentStageCount: 0 } });
	Assert.deepEqual(harness.drive('consumer-1', { type: 'account.ledger.get' })[0], { type: 'account.ledger', accountId, direction: 'both', entries: [] });
});

Test('an accounting read is answered before the connection registers as anything, and never without a session', async () => {
	const harness = buildClientMessageHandlerHarness();

	// Nothing at all presented yet: the session gate refuses it before any accounting rule is reached.
	const [noSession] = harness.drive('device-a', { type: 'account.balance.get' });
	Assert.equal((noSession as { code: string }).code, 'AUTHENTICATION_REQUIRED');

	// A command line program that only wants to read its balance never registers as a worker or a
	// consumer, so the read is answered without registration.
	harness.authenticate('device-a');
	const accountId = await harness.authenticateAccount('device-a');
	Assert.equal(harness.deviceRegistry.get('device-a'), undefined);
	Assert.deepEqual(harness.drive('device-a', { type: 'account.balance.get' })[0], { type: 'account.balance', summary: { accountId, balance: 0, earnedStageCount: 0, spentStageCount: 0 } });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The cluster-wide accounting summary, for an observer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('only an observer connection may read the accounting summary of every account', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');

	// A registered worker is not an observer, so it is refused just as a stranger would be — this read
	// reaches no further than an observer already sees, and a worker is not one.
	const [refused] = harness.drive('worker-1', { type: 'accounting.summaries.get' });
	Assert.equal((refused as { code: string }).code, 'AUTHORISATION');

	harness.authenticate('device-observer');
	const [observed] = harness.drive('device-observer', { type: 'accounting.summaries.get' });
	Assert.equal(observed?.type, 'error');

	harness.drive('device-observer', { type: 'observe' });
	const [answered] = harness.drive('device-observer', { type: 'accounting.summaries.get' });
	Assert.equal(answered?.type, 'accounting.summaries');
});

Test('the accounting summary joins the ledger with the account profile, and includes an account that has only one of the two', async () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	const workerAccountId = await harness.authenticateAccount('worker-1');
	harness.registerConsumer('consumer-1', 'consumer-one');
	const consumerAccountId = await harness.authenticateAccount('consumer-1');
	runWholeDevFormulaTask(harness);

	// Registered but never done anything: no ledger entries, and must still be listed.
	harness.authenticate('device-idle');
	const idleAccountId = await harness.authenticateAccount('device-idle');

	harness.authenticate('device-observer');
	harness.drive('device-observer', { type: 'observe' });
	const [answered] = harness.drive('device-observer', { type: 'accounting.summaries.get' });
	const summaries = (answered as { summaries: { accountId: string; displayName: string; createdAt?: string; balance: number; earnedStageCount: number; spentStageCount: number }[] }).summaries;

	const worker = summaries.find((row) => row.accountId === workerAccountId);
	Assert.deepEqual(worker, { accountId: workerAccountId, displayName: '', createdAt: worker?.createdAt, balance: 2, earnedStageCount: 2, spentStageCount: 0 });
	Assert.equal(typeof worker?.createdAt, 'string');

	const consumer = summaries.find((row) => row.accountId === consumerAccountId);
	Assert.deepEqual(consumer, { accountId: consumerAccountId, displayName: '', createdAt: consumer?.createdAt, balance: -2, earnedStageCount: 0, spentStageCount: 2 });

	// Registered, no ledger entries: present with a zero balance rather than left out.
	const idle = summaries.find((row) => row.accountId === idleAccountId);
	Assert.deepEqual(idle, { accountId: idleAccountId, displayName: '', createdAt: idle?.createdAt, balance: 0, earnedStageCount: 0, spentStageCount: 0 });

	// Ordered by balance, highest first.
	Assert.deepEqual([...summaries].sort((left, right) => right.balance - left.balance || left.accountId.localeCompare(right.accountId)), summaries);
});

Test('the accounting summary lists the shared development account too, though it has no profile', () => {
	const harness = buildClientMessageHandlerHarness();
	harness.registerWorker('worker-1', 'worker-one');
	harness.registerConsumer('consumer-1', 'consumer-one');

	// Neither connection authenticated an account, so both halves of every stage land on the shared
	// development account. It was never registered, so it has no profile to join to, and an operator
	// still has to see how much work is going unattributed.
	runWholeDevFormulaTask(harness);

	harness.authenticate('device-observer');
	harness.drive('device-observer', { type: 'observe' });
	const [answered] = harness.drive('device-observer', { type: 'accounting.summaries.get' });
	const summaries = (answered as { summaries: { accountId: string; displayName: string; createdAt?: string; balance: number; earnedStageCount: number; spentStageCount: number }[] }).summaries;

	Assert.deepEqual(summaries, [{ accountId: 'account-shared-development', displayName: '', balance: 0, earnedStageCount: 2, spentStageCount: 2 }]);
});

Test('the websocket heartbeat pings a connection that keeps answering, and terminates one that stops answering', async () => {
	const intervalMs = 50;
	const server = newFakeHeartbeatServer();
	const heartbeat = new WebsocketHeartbeat(server as unknown as WebSocketServer, intervalMs);
	try {
		const responsive = newFakeHeartbeatSocket();
		const silent = newFakeHeartbeatSocket();
		server.announceConnection(responsive);
		server.announceConnection(silent);

		// After the first sweep (comfortably past one interval, comfortably before two): both
		// connections were still assumed alive from when they connected, so both were pinged and
		// marked as not yet having answered.
		await delay(intervalMs * 1.5);
		Assert.equal(responsive.pingCount, 1);
		Assert.equal(silent.pingCount, 1);
		Assert.equal(responsive.terminated, false);
		Assert.equal(silent.terminated, false);

		responsive.answerWithPong();

		// After the second sweep (comfortably past two intervals, comfortably before three): the
		// responsive connection answered, so it was pinged again; the silent one did not, so it was
		// terminated instead of being pinged a second time.
		await delay(intervalMs);
		Assert.equal(responsive.pingCount, 2);
		Assert.equal(responsive.terminated, false);
		Assert.equal(silent.terminated, true);
	} finally {
		heartbeat.stop();
	}
});

Test('the websocket heartbeat reports every connection that answered a ping', async () => {
	const intervalMs = 50;
	const server = newFakeHeartbeatServer();
	const answeredSockets: FakeHeartbeatSocket[] = [];
	const heartbeat = new WebsocketHeartbeat(
		server as unknown as WebSocketServer,
		intervalMs,
		(socket) => answeredSockets.push(socket as unknown as FakeHeartbeatSocket),
	);
	try {
		const responsive = newFakeHeartbeatSocket();
		const silent = newFakeHeartbeatSocket();
		server.announceConnection(responsive);
		server.announceConnection(silent);

		await delay(intervalMs * 1.5);
		responsive.answerWithPong();

		Assert.deepEqual(answeredSockets, [responsive]);
	} finally {
		heartbeat.stop();
	}
});

Test('a device that answers a ping has its last seen time refreshed and announced', async () => {
	const logsDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'gateway-heartbeat-activity-'));
	const deviceRegistry = new DeviceRegistry();
	const messageLogger = new MessageLogger(Path.join(logsDirectory, 'gateway.log_entry.jsonl'));
	const hub = new ConnectionHub(deviceRegistry, messageLogger, logsDirectory);
	const announcer = new DeviceAnnouncer(deviceRegistry, hub, 0);

	deviceRegistry.add(worker('one'));
	const observerSocket = newFakeSocket();
	hub.socketMap.set('device-observer', observerSocket as unknown as Parameters<typeof hub.send>[0]);
	hub.deviceSubscriberIds.add('device-observer');

	announcer.noteDeviceAnsweredPing('one');

	// The stored liveness time moved off the one the device connected with, even though the
	// device itself sent no protocol message.
	Assert.notEqual(deviceRegistry.get('one')?.lastSeenAt, '2026-01-01T00:00:00.000Z');

	// Activity is batched, so the announcement is read after the batching window closes.
	await delay(10);
	const activityMessages = observerSocket.sent
		.map((frame) => frame.body)
		.filter((message) => message.type === 'device.activity');
	Assert.equal(activityMessages.length, 1);
	Assert.equal((activityMessages[0] as { devices: { deviceId: string; lastSeenAt: string }[] }).devices[0]?.lastSeenAt, deviceRegistry.get('one')?.lastSeenAt);

	announcer.stop();
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Address A Connection Came From
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds the HTTP request that carries a WebSocket upgrade, with only the two things the
 * address is ever read from: the socket the request arrived on, and its headers.
 */
const newUpgradeRequest = (remoteAddress: string | undefined, headers: Record<string, string | string[]> = {}) => ({
	headers,
	socket: { remoteAddress },
}) as unknown as Parameters<typeof ClientIpAddress.fromRequest>[0];

Test('the address a connection came from is the address of the socket it arrived on', () => {
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest('203.0.113.7'), false), '203.0.113.7');
});

Test('an x-forwarded-for header is ignored unless a reverse proxy is trusted', () => {
	// Any client can write this header, so believing it without being told a proxy is in front
	// would let a worker name its own address.
	const request = newUpgradeRequest('203.0.113.7', { 'x-forwarded-for': '198.51.100.1' });
	Assert.equal(ClientIpAddress.fromRequest(request, false), '203.0.113.7');
});

Test('a trusted reverse proxy names the address in x-forwarded-for, leftmost entry first', () => {
	// Each proxy appends the address it received the request from, so the leftmost entry is the
	// original client and everything after it is a proxy.
	const request = newUpgradeRequest('172.17.0.1', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' });
	Assert.equal(ClientIpAddress.fromRequest(request, true), '198.51.100.1');
});

Test('a trusted reverse proxy that sends no x-forwarded-for header leaves the socket address in use', () => {
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest('203.0.113.7'), true), '203.0.113.7');
});

Test('an IPv4-mapped IPv6 address is recorded in its plain IPv4 form', () => {
	// A browser connecting over IPv4 to a listener that accepts both produces this form, and the
	// same machine must not be recorded two different ways depending on how it connected.
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest('::ffff:127.0.0.1'), false), '127.0.0.1');
	// A development gateway on the same machine, reached over IPv6, keeps the address it has.
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest('::1'), false), '::1');
});

Test('no address is recorded when none could be observed', () => {
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest(undefined), false), undefined);
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest('   '), false), undefined);
	Assert.equal(ClientIpAddress.fromRequest(newUpgradeRequest(undefined, { 'x-forwarded-for': '' }), true), undefined);
});

Test('a registered worker carries the address the gateway observed when its connection opened', () => {
	const { hub, registerWorker, deviceRegistry } = buildClientMessageHandlerHarness();
	// Set the way accepting a real connection sets it, before anything the device sends.
	hub.ipAddressMap.set('worker-1', '203.0.113.7');
	registerWorker('worker-1', 'worker-one');

	Assert.equal(deviceRegistry.get('worker-1')?.ipAddress, '203.0.113.7');
});

Test('a worker whose address the gateway could not observe carries no address at all', () => {
	const { registerWorker, deviceRegistry } = buildClientMessageHandlerHarness();
	registerWorker('worker-1', 'worker-one');

	Assert.equal(deviceRegistry.get('worker-1')?.ipAddress, undefined);
});

Test('a device cannot name its own address, because the address is never read from what it sends', () => {
	const { hub, drive, authenticate, deviceRegistry } = buildClientMessageHandlerHarness();
	hub.ipAddressMap.set('worker-1', '203.0.113.7');
	authenticate('worker-1');
	drive('worker-1', { type: 'deviceRegister', role: 'worker', name: 'worker-one', ipAddress: '198.51.100.1' } as unknown as ClientMessage);

	Assert.equal(deviceRegistry.get('worker-1')?.ipAddress, '203.0.113.7');
});

Test('the observed address is forgotten when the connection closes', () => {
	const { hub, registerWorker } = buildClientMessageHandlerHarness();
	hub.ipAddressMap.set('worker-1', '203.0.113.7');
	registerWorker('worker-1', 'worker-one');

	hub.forget('worker-1');

	Assert.equal(hub.ipAddressMap.get('worker-1'), undefined);
});

Test('a reverse proxy nobody told the gateway about is reported, so a proxy address is not recorded in silence', () => {
	// Exactly what the deployed gateway did: every worker read as the same address, and nothing
	// on screen said why. See issue #183.
	const request = newUpgradeRequest('10.0.25.1', { 'x-forwarded-for': '88.163.220.204' });
	Assert.equal(ClientIpAddress.isReverseProxyUnnoticed(request, false), true);

	// Nothing to report once the gateway is trusting the proxy, nor when no proxy is in front.
	Assert.equal(ClientIpAddress.isReverseProxyUnnoticed(request, true), false);
	Assert.equal(ClientIpAddress.isReverseProxyUnnoticed(newUpgradeRequest('203.0.113.7'), false), false);
});
