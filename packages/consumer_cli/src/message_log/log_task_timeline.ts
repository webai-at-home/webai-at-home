import type { LogEntry } from '@webai/protocol/message_logger';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogTaskTimeline — rebuilds what happened to each task and each stage run from a log
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Everything one log file says about the life of a single task. */
export type TaskRecord = {
	/** The task's own identifier, once the gateway has assigned one. */
	taskId: string;
	/** The identifier the consumer submitted under, when the log shows the submission. */
	taskRequestId: string | undefined;
	/** The task type submitted, for example `task_type_llm_llama3_2_1b_full`. */
	taskType: string | undefined;
	/** The pipeline the gateway chose to run the task through. */
	pipelineId: string | undefined;
	/** The device that submitted the task. */
	consumerDeviceId: string | undefined;
	/** Every worker device that was given a stage of this task, in the order first seen. */
	workerDeviceIds: string[];
	/** Every stage name this task ran, in the order first seen. */
	stageNames: string[];
	/** The moment the consumer's `task.submit` appears, in milliseconds since the epoch. */
	submittedAtMs: number | undefined;
	/** The moment the gateway's `task.accepted` appears. */
	acceptedAtMs: number | undefined;
	/** The moment the first stage of the task was assigned to a worker. */
	firstAssignedAtMs: number | undefined;
	/** The moment a worker first confirmed it had taken a stage of this task. */
	firstStartedAtMs: number | undefined;
	/** The moment the task reached `completed`, `failed`, or `cancelled`. */
	finishedAtMs: number | undefined;
	/** The last state the task was seen in. */
	finalState: string | undefined;
	/** The highest stage attempt number seen, so 1 means the task never had a stage retried. */
	maximumAttempt: number;
	/** How many stage runs this task needed, which is above 1 for a task answered in pieces. */
	stageRunCount: number;
	/** How many log entries mention this task. */
	messageCount: number;
	/** The total size on the wire of every message mentioning this task, in bytes. */
	messageBytes: number;
};

/** One run of one stage on one worker: the gateway assigned it, the worker took it and answered. */
export type StageRunRecord = {
	/** The identifier the gateway gave this particular assignment. */
	stageAssignmentId: string;
	/** The task the stage belongs to. */
	taskId: string | undefined;
	/** The stage that was run, for example `stage_llm_llama3_2_1b_full`. */
	stageName: string | undefined;
	/** The worker device the stage was assigned to. */
	workerDeviceId: string | undefined;
	/** Which attempt this run was, counting the first as 1. */
	attempt: number | undefined;
	/** The moment `stage.assign` appears. */
	assignedAtMs: number | undefined;
	/** The moment the worker's `stage.accepted` appears. */
	acceptedAtMs: number | undefined;
	/** The moment the worker's `stage.result` appears. */
	resultAtMs: number | undefined;
	/** The moment the gateway's `stage.result.accepted` appears. */
	committedAtMs: number | undefined;
};

/** What one log file says about every task and every stage run in it. */
export type TaskTimeline = {
	/** One record per task, in the order the tasks were first seen. */
	tasks: TaskRecord[];
	/** One record per stage run, in the order the runs were first seen. */
	stageRuns: StageRunRecord[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Log Task Timeline
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Rebuilds, from the messages one log file recorded, what happened to each task and to each
 * individual run of a stage on a worker.
 *
 * The message types are read for what they say rather than for which way they travelled, so
 * the same code measures a gateway log, which sees both the consumer and the worker side of
 * every task, and a consumer log, which sees only its own submissions and the updates sent
 * back to it. Whatever a log does not contain simply stays `undefined`, and the statistics
 * built on top leave those tasks out of the affected measurement instead of guessing.
 */
export class LogTaskTimeline {
	/**
	 * Walks every entry once and groups what it says by task and by stage run.
	 *
	 * @param entries Every log entry of one file, oldest first.
	 * @returns One record per task and one per stage run.
	 */
	static build(entries: LogEntry[]): TaskTimeline {
		const tasks = new Map<string, TaskRecord>();
		const stageRuns = new Map<string, StageRunRecord>();
		const taskIdByRequestId = new Map<string, string>();

		// `task.submit` names only the request identifier, and `task.accepted` is what ties that
		// request to the task identifier every later message uses. Collecting those pairs first
		// means a submission can be attributed to its task on the single walk below.
		for (const entry of entries) {
			const payload = LogTaskTimeline._asRecord(entry.messagePayload);
			const taskRequestId = LogTaskTimeline._findTaskRequestId(payload);
			const taskId = LogTaskTimeline._findTaskId(payload);
			if (taskRequestId !== undefined && taskId !== undefined) {
				taskIdByRequestId.set(taskRequestId, taskId);
			}
		}

		for (const entry of entries) {
			const payload = LogTaskTimeline._asRecord(entry.messagePayload);
			const timestampMs = Date.parse(entry.timestamp);
			const taskRequestId = LogTaskTimeline._findTaskRequestId(payload);
			const taskId = LogTaskTimeline._findTaskId(payload)
				?? (taskRequestId === undefined ? undefined : taskIdByRequestId.get(taskRequestId));
			if (taskId !== undefined) {
				LogTaskTimeline._recordTask(tasks, taskId, taskRequestId, entry, payload, timestampMs);
			}
			LogTaskTimeline._recordStageRun(stageRuns, taskId, entry, payload, timestampMs);
		}

		for (const task of tasks.values()) {
			task.stageRunCount = [...stageRuns.values()].filter((stageRun) => stageRun.taskId === task.taskId).length;
		}

		return {
			tasks: [...tasks.values()],
			stageRuns: [...stageRuns.values()],
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Recording
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Folds one log entry into the record of the task it mentions.
	 *
	 * @param tasks Every task record built so far, keyed by task identifier.
	 * @param taskId The task the entry mentions.
	 * @param taskRequestId The request identifier the entry names, when it names one.
	 * @param entry The log entry being folded in.
	 * @param payload The entry's message body, when it is an object.
	 * @param timestampMs The entry's moment, in milliseconds since the epoch.
	 */
	private static _recordTask(
		tasks: Map<string, TaskRecord>,
		taskId: string,
		taskRequestId: string | undefined,
		entry: LogEntry,
		payload: Record<string, unknown> | undefined,
		timestampMs: number,
	): void {
		const task: TaskRecord = tasks.get(taskId) ?? LogTaskTimeline._emptyTask(taskId);
		tasks.set(taskId, task);

		task.messageCount += 1;
		task.messageBytes += entry.messageBytes ?? entry.messagePayloadBytes ?? 0;
		task.taskRequestId = task.taskRequestId ?? taskRequestId;

		const nested = LogTaskTimeline._asRecord(payload?.['task']) ?? LogTaskTimeline._asRecord(payload?.['update']);
		const taskInput = LogTaskTimeline._asRecord(nested?.['input']) ?? LogTaskTimeline._asRecord(payload?.['input']);
		task.taskType = task.taskType ?? LogTaskTimeline._readString(taskInput?.['taskType']);
		task.pipelineId = task.pipelineId ?? LogTaskTimeline._readString(nested?.['pipelineId']);
		task.consumerDeviceId = task.consumerDeviceId ?? LogTaskTimeline._readString(nested?.['consumerDeviceId']);

		const stageAssignment = LogTaskTimeline._asRecord(nested?.['stageAssignment']);
		const workerDeviceId = LogTaskTimeline._readString(stageAssignment?.['workerDeviceId'])
			?? (entry.messageType.startsWith('stage.') ? entry.counterpart.deviceId : undefined);
		if (workerDeviceId !== undefined && task.workerDeviceIds.includes(workerDeviceId) === false) {
			task.workerDeviceIds.push(workerDeviceId);
		}

		const stageName = LogTaskTimeline._readString(payload?.['stage'])
			?? LogTaskTimeline._readString(nested?.['currentStage'])
			?? LogTaskTimeline._readString(stageAssignment?.['stage']);
		if (stageName !== undefined && task.stageNames.includes(stageName) === false) {
			task.stageNames.push(stageName);
		}

		const attempt = LogTaskTimeline._readNumber(payload?.['attempt'])
			?? LogTaskTimeline._readNumber(nested?.['currentStageAttempts'])
			?? LogTaskTimeline._readNumber(stageAssignment?.['attempt']);
		if (attempt !== undefined && attempt > task.maximumAttempt) {
			task.maximumAttempt = attempt;
		}

		const state = LogTaskTimeline._readString(nested?.['state']);
		if (state !== undefined) {
			task.finalState = state;
			if (state === 'completed' || state === 'failed' || state === 'cancelled') {
				task.finishedAtMs = task.finishedAtMs ?? timestampMs;
			}
		}

		if (entry.messageType === 'task.submit') {
			task.submittedAtMs = task.submittedAtMs ?? timestampMs;
		}
		if (entry.messageType === 'task.accepted') {
			task.acceptedAtMs = task.acceptedAtMs ?? timestampMs;
		}
		if (entry.messageType === 'stage.assign') {
			task.firstAssignedAtMs = task.firstAssignedAtMs ?? timestampMs;
		}
		if (entry.messageType === 'stage.accepted') {
			task.firstStartedAtMs = task.firstStartedAtMs ?? timestampMs;
		}
	}

	/**
	 * Folds one log entry into the record of the stage run it mentions.
	 *
	 * @param stageRuns Every stage run record built so far, keyed by stage assignment identifier.
	 * @param taskId The task the entry mentions, when it mentions one.
	 * @param entry The log entry being folded in.
	 * @param payload The entry's message body, when it is an object.
	 * @param timestampMs The entry's moment, in milliseconds since the epoch.
	 */
	private static _recordStageRun(
		stageRuns: Map<string, StageRunRecord>,
		taskId: string | undefined,
		entry: LogEntry,
		payload: Record<string, unknown> | undefined,
		timestampMs: number,
	): void {
		const stageAssignmentId = LogTaskTimeline._readString(payload?.['stageAssignmentId']);
		if (stageAssignmentId === undefined) {
			return;
		}

		const stageRun: StageRunRecord = stageRuns.get(stageAssignmentId) ?? {
			stageAssignmentId,
			taskId: undefined,
			stageName: undefined,
			workerDeviceId: undefined,
			attempt: undefined,
			assignedAtMs: undefined,
			acceptedAtMs: undefined,
			resultAtMs: undefined,
			committedAtMs: undefined,
		};
		stageRuns.set(stageAssignmentId, stageRun);

		stageRun.taskId = stageRun.taskId ?? taskId;
		stageRun.stageName = stageRun.stageName ?? LogTaskTimeline._readString(payload?.['stage']);
		stageRun.attempt = stageRun.attempt ?? LogTaskTimeline._readNumber(payload?.['attempt']);
		if (entry.counterpart.role === 'worker' && entry.counterpart.deviceId !== undefined) {
			stageRun.workerDeviceId = stageRun.workerDeviceId ?? entry.counterpart.deviceId;
		}

		if (entry.messageType === 'stage.assign') {
			stageRun.assignedAtMs = stageRun.assignedAtMs ?? timestampMs;
		}
		if (entry.messageType === 'stage.accepted') {
			stageRun.acceptedAtMs = stageRun.acceptedAtMs ?? timestampMs;
		}
		if (entry.messageType === 'stage.result') {
			stageRun.resultAtMs = stageRun.resultAtMs ?? timestampMs;
		}
		if (entry.messageType === 'stage.result.accepted') {
			stageRun.committedAtMs = stageRun.committedAtMs ?? timestampMs;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading Message Bodies
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the record of a task no entry has been folded into yet.
	 *
	 * @param taskId The task's own identifier.
	 * @returns A task record with nothing measured yet.
	 */
	private static _emptyTask(taskId: string): TaskRecord {
		return {
			taskId,
			taskRequestId: undefined,
			taskType: undefined,
			pipelineId: undefined,
			consumerDeviceId: undefined,
			workerDeviceIds: [],
			stageNames: [],
			submittedAtMs: undefined,
			acceptedAtMs: undefined,
			firstAssignedAtMs: undefined,
			firstStartedAtMs: undefined,
			finishedAtMs: undefined,
			finalState: undefined,
			maximumAttempt: 0,
			stageRunCount: 0,
			messageCount: 0,
			messageBytes: 0,
		};
	}

	/**
	 * Finds the task identifier a message body names, wherever the protocol puts it.
	 *
	 * @param payload The message body, when it is an object.
	 * @returns The task identifier, or `undefined` when the body names none.
	 */
	private static _findTaskId(payload: Record<string, unknown> | undefined): string | undefined {
		return LogTaskTimeline._readString(payload?.['taskId'])
			?? LogTaskTimeline._readString(LogTaskTimeline._asRecord(payload?.['task'])?.['taskId'])
			?? LogTaskTimeline._readString(LogTaskTimeline._asRecord(payload?.['update'])?.['taskId']);
	}

	/**
	 * Finds the request identifier a message body names, wherever the protocol puts it.
	 *
	 * @param payload The message body, when it is an object.
	 * @returns The request identifier, or `undefined` when the body names none.
	 */
	private static _findTaskRequestId(payload: Record<string, unknown> | undefined): string | undefined {
		return LogTaskTimeline._readString(payload?.['taskRequestId'])
			?? LogTaskTimeline._readString(LogTaskTimeline._asRecord(payload?.['task'])?.['taskRequestId']);
	}

	/**
	 * Reads a value as an object of named properties.
	 *
	 * @param value The value to read, which a log file may have recorded as anything at all.
	 * @returns The value as a record, or `undefined` when it is not a plain object.
	 */
	private static _asRecord(value: unknown): Record<string, unknown> | undefined {
		if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
			return undefined;
		}
		return value as Record<string, unknown>;
	}

	/**
	 * Reads a value as a string.
	 *
	 * @param value The value to read.
	 * @returns The string, or `undefined` when the value is not a string.
	 */
	private static _readString(value: unknown): string | undefined {
		return typeof value === 'string' ? value : undefined;
	}

	/**
	 * Reads a value as a finite number.
	 *
	 * @param value The value to read.
	 * @returns The number, or `undefined` when the value is not a finite number.
	 */
	private static _readNumber(value: unknown): number | undefined {
		return typeof value === 'number' && Number.isFinite(value) === true ? value : undefined;
	}
}
