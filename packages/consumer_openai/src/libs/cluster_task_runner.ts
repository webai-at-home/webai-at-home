// node imports
import Crypto from 'node:crypto';

// npm imports
import WebSocket from 'ws';
import { ConsumerClient, type TaskSocket } from '@webai/consumer-cli';
import type { MessageLogger } from '@webai/protocol/message_logger';
import { ReconnectBackoff } from '@webai/protocol/reconnect_backoff';
import type { AccountKeyPair, ProtocolError, StagePayload, TaskInput, TaskSnapshot, TaskState, ToolCall, TaskUpdate } from '@webai/protocol';

// local imports
import { OpenaiError } from '../api/openai_error.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClusterTaskRunner — runs one cluster task per request over one gateway connection
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one submitted task produced: the generated text, and whatever the worker that produced
 * it reported alongside that text, per milestone 2 of
 * [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
 */
export type TaskAnswer = {
	/** The generated text. */
	text: string;
	/** How many tokens the prompt was counted as, `undefined` when the worker did not report it. */
	promptTokenCount: number | undefined;
	/** How many tokens the whole answer was counted as, `undefined` when the worker did not report it. */
	completionTokenCount: number | undefined;
	/**
	 * The worker's own word for why generation stopped, `undefined` when the worker did not
	 * report it. Not an OpenAI value — translating this into `finish_reason` is a job for whoever
	 * calls this runner and speaks the OpenAI Chat Completions interface.
	 */
	stopReason: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | 'stop_sequence' | undefined;
	/**
	 * The tools the model asked to have called, `undefined` when it answered in words, which is
	 * every task whose history declared no tool.
	 *
	 * Carried without an identifier and with every argument value as text, exactly as the worker
	 * reported it. Supplying the identifier this cluster cannot generate, and the types this
	 * cluster cannot know, is a job for whoever calls this runner and speaks the OpenAI Chat
	 * Completions interface.
	 */
	toolCalls: ToolCall[] | undefined;
};

/** How this runner reaches the central gateway and how long it is willing to wait. */
export type ClusterTaskRunnerOptions = {
	/** The WebSocket address of the central gateway. */
	gatewayUrl: string;
	/** The bearer token the central gateway requires. */
	authToken: string;
	/** The consumer name this runner registers under. */
	name: string;
	/**
	 * This server's own account key pair, when it has one.
	 *
	 * One deployment of this server is one account, and it is this server's account rather than the
	 * account of whichever program called its OpenAI-compatible endpoint: this server is what the
	 * gateway sees. Left out, the stages its tasks run are recorded against the shared development
	 * account.
	 */
	accountKeyPair?: AccountKeyPair | undefined;
	/** How long one task may run before it is cancelled and the request is given up on. */
	requestTimeoutMs: number;
	/** How long a request waits for a registered connection before it is refused. */
	connectionWaitMs: number;
	/** How many tasks this runner will have in flight at once. */
	maximumTasksInFlight: number;
	/** Where to record the message traffic of this runner's connection, when it is recorded. */
	messageLogger?: MessageLogger | undefined;
};

/** One request waiting for the cluster task it submitted. */
type PendingTask = {
	/** The identifier the submission was sent under, which `task.accepted` echoes back. */
	taskRequestId: string;
	/** The task identifier, once the central gateway has accepted the submission. */
	taskId: string | undefined;
	/** What was submitted, which says how the task's result is read. */
	taskInput: TaskInput;
	/** The model the request asked for, named in a failure so the caller recognises it. */
	modelId: string;
	resolve: (answer: TaskAnswer) => void;
	reject: (failure: OpenaiError) => void;
	/** The timer that gives up on this task once this server has waited long enough. */
	timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	/** Whether this request has already been answered, so it is not answered twice. */
	isSettled: boolean;
	/**
	 * Told the identifier this request was submitted under, and again once a task identifier is
	 * assigned, so a caller can record both for auditing.
	 */
	onCorrelationIds: ((ids: { taskRequestId: string; taskId?: string }) => void) | undefined;
	/**
	 * Told each piece of the answer as the cluster reports it, for a request that asked to be
	 * answered as the answer is written. Absent for a request that asked for the whole answer,
	 * and never called for one, because such a task reports no pieces at all.
	 */
	onPiece: ((piece: string) => void) | undefined;
};

/** One request waiting for the connection to the central gateway to be registered. */
type RegistrationWaiter = {
	resolve: () => void;
	reject: (failure: OpenaiError) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
};


///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cluster Task Runner
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Holds one consumer connection to the central gateway and turns each submitted task into one
 * promise that either carries the generated text or a failure to answer the request with.
 *
 * One connection serves every request, rather than one connection per request, because the
 * gateway counts a connection as a device and a consumer only needs one. Requests are told
 * apart by the identifier each submission is sent under: `task.accepted` echoes that
 * identifier back with the task identifier, and every later task revision carries the task
 * identifier, so the two maps below join a revision back to the request waiting for it. The
 * submitting consumer receives every revision of its own task without asking, so no task is
 * observed explicitly.
 *
 * When the connection closes, every request still waiting is given up on rather than being
 * carried over to the next connection. A task already under way cannot be picked up again,
 * because the gateway gives the new connection a new device identifier and the task belongs to
 * the device that has gone.
 */
export class ClusterTaskRunner {
	private client: ConsumerClient | undefined;
	private isRegistered = false;
	private isClosed = false;
	/**
	 * How long to wait before each attempt, and the rule that grows that wait.
	 *
	 * The rule is the one every long-lived client of this repository shares, so this server, a
	 * worker browser tab, and the worker in `packages/worker_openai` all lean on one gateway in
	 * the same way. See [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158).
	 */
	private readonly reconnectBackoff = new ReconnectBackoff();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pendingByTaskRequestId = new Map<string, PendingTask>();
	private readonly pendingByTaskId = new Map<string, PendingTask>();
	private readonly registrationWaiters = new Set<RegistrationWaiter>();

	/**
	 * @param options How to reach the central gateway and how long to wait.
	 * @param openSocket How to open one connection. The default opens a `ws` connection, read
	 * through the smaller shape the consumer client actually uses. A test passes its own.
	 */
	constructor(
		private readonly options: ClusterTaskRunnerOptions,
		private readonly openSocket: (gatewayUrl: string) => TaskSocket = (gatewayUrl) =>
			new WebSocket(gatewayUrl) as unknown as TaskSocket,
	) {
		this._connect();
	}

	/** Whether this runner currently holds a registered connection to the central gateway. */
	get isGatewayConnected(): boolean {
		return this.isRegistered;
	}

	/** How many requests are waiting for a cluster task to finish. */
	get tasksInFlight(): number {
		return this.pendingByTaskRequestId.size;
	}

	/**
	 * Submits one task and waits for the text it generates.
	 *
	 * @param taskInput The task type and the value to submit.
	 * @param modelId The model the request asked for, named in a failure so the caller
	 * recognises which model could not be served.
	 * @param abortSignal Reports that whoever sent the request has gone, so the task is
	 * cancelled instead of being run for nobody.
	 * @param onCorrelationIds Told the identifier this request is submitted under as soon as it
	 * is generated, and again once the central gateway assigns a task identifier to it, so a
	 * caller can record both for auditing without this runner exposing its internal maps.
	 * @param onPiece Told each piece of the answer as the cluster reports it. It is called only
	 * for a task submitted asking to be answered as its answer is written, because only such a
	 * task is reported in pieces. Joining the pieces gives the same text this returns.
	 * @returns The generated text, and whatever usage the worker that produced it reported.
	 * @throws OpenaiError when the task fails, is refused, or does not finish in time.
	 */
	async run(
		taskInput: TaskInput,
		modelId: string,
		abortSignal?: AbortSignal,
		onCorrelationIds?: (ids: { taskRequestId: string; taskId?: string }) => void,
		onPiece?: (piece: string) => void,
	): Promise<TaskAnswer> {
		if (this.pendingByTaskRequestId.size >= this.options.maximumTasksInFlight) {
			throw OpenaiError.tooManyTasksInFlight(this.options.maximumTasksInFlight);
		}
		const client = await this._registeredClient();
		const taskRequestId = Crypto.randomUUID();
		onCorrelationIds?.({ taskRequestId });
		return await new Promise<TaskAnswer>((resolve, reject) => {
			const pending: PendingTask = {
				taskRequestId,
				taskId: undefined,
				taskInput,
				modelId,
				resolve,
				reject,
				timeoutTimer: undefined,
				isSettled: false,
				onCorrelationIds,
				onPiece,
			};
			pending.timeoutTimer = setTimeout(() => {
				this._giveUp(
					pending,
					OpenaiError.requestTimedOut(this.options.requestTimeoutMs),
					'this server waited as long as it was willing to',
				);
			}, this.options.requestTimeoutMs);
			pending.timeoutTimer.unref();
			this.pendingByTaskRequestId.set(taskRequestId, pending);
			abortSignal?.addEventListener(
				'abort',
				() => {
					this._giveUp(
						pending,
						OpenaiError.taskFailed('whoever sent the request went away'),
						'whoever sent the request went away',
					);
				},
				{
					once: true,
				},
			);
			try {
				client.submit(taskInput, taskRequestId);
			} catch {
				this._settleWithFailure(
					pending,
					OpenaiError.gatewayUnavailable(
						'The connection to the central gateway closed before this request could be submitted.',
					),
				);
			}
		});
	}

	/** Gives up on every request still waiting and closes the connection for good. */
	close(): void {
		this.isClosed = true;
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
		}
		this.reconnectTimer = undefined;
		const failure = OpenaiError.gatewayUnavailable('This server is shutting down.');
		this._failEveryPendingTask(failure);
		this._rejectRegistrationWaiters(failure);
		this.client?.close();
		this.client = undefined;
		this.isRegistered = false;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Gateway Connection
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Opens one connection to the central gateway and speaks the consumer side of it. */
	private _connect(): void {
		if (this.isClosed) {
			return;
		}
		let socket: TaskSocket;
		try {
			socket = this.openSocket(this.options.gatewayUrl);
		} catch (error: unknown) {
			console.error(
				`The connection to the central gateway at ${this.options.gatewayUrl} could not be opened: ` +
					`${String(error)}`,
			);
			this._scheduleReconnect();
			return;
		}
		this.client = new ConsumerClient(
			socket,
			{
				onMessage: (direction, message) =>
					this.options.messageLogger?.log(
						direction,
						{
							role: 'gateway',
						},
						message.type,
						message,
					),
				onRegistered: () => this._onRegistered(),
				onAccountSettled: (accountId) => {
					console.log(accountId === undefined
						? 'Connected to the central gateway with no account of its own, so the stages this server\'s tasks run are recorded against the shared development account.'
						: `Connected to the central gateway as ${accountId}.`);
				},
				onAccountNote: (note) => console.error(note),
				onTaskAccepted: (task) => this._onTaskAccepted(task),
				onTaskUpdated: (update) => this._onTaskUpdated(update),
				onError: (error) => this._onGatewayError(error),
				onConnectionChange: (isConnected) => {
					if (isConnected === false) {
						this._onConnectionLost();
					}
				},
			},
			this.options.name,
			this.options.authToken,
			this.options.accountKeyPair,
		);
	}

	/** Notes that the connection is usable, and lets every waiting request proceed. */
	private _onRegistered(): void {
		this.isRegistered = true;
		this.reconnectBackoff.reset();
		for (const waiter of [...this.registrationWaiters]) {
			this.registrationWaiters.delete(waiter);
			if (waiter.timer !== undefined) {
				clearTimeout(waiter.timer);
			}
			waiter.resolve();
		}
	}

	/** Gives up on every request still waiting, then opens the connection again. */
	private _onConnectionLost(): void {
		this.isRegistered = false;
		this._failEveryPendingTask(
			OpenaiError.gatewayUnavailable(
				'The connection to the central gateway was lost while this request was waiting for its task. A ' +
					'task already under way cannot be picked up again by the next connection, because the ' +
					'central gateway gives that connection a new device identifier and the task belongs to the ' +
					'device that has gone.',
			),
		);
		this._scheduleReconnect();
	}

	/** Waits before opening the connection again, waiting longer after each failed attempt. */
	private _scheduleReconnect(): void {
		if (this.isClosed) {
			return;
		}
		if (this.reconnectTimer !== undefined) {
			return;
		}
		const delayMs = this.reconnectBackoff.nextDelayMs();
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this._connect();
		}, delayMs);
		this.reconnectTimer.unref();
	}

	/**
	 * Waits for a registered connection, for as long as `connectionWaitMs` allows.
	 *
	 * A request that arrives during a short reconnection waits and then proceeds, and a request
	 * that arrives while the central gateway is not running is refused within that bound rather
	 * than being held until its own timeout runs out.
	 *
	 * @returns The registered consumer client to submit through.
	 * @throws OpenaiError when no registered connection appears in time.
	 */
	private async _registeredClient(): Promise<ConsumerClient> {
		const client = this.client;
		if (this.isRegistered === true && client !== undefined) {
			return client;
		}
		if (this.isClosed === true) {
			throw OpenaiError.gatewayUnavailable('This server is shutting down.');
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: RegistrationWaiter = {
				resolve,
				reject,
				timer: undefined,
			};
			waiter.timer = setTimeout(() => {
				this.registrationWaiters.delete(waiter);
				reject(
					OpenaiError.gatewayUnavailable(
						`This server is not connected to the central gateway at ${this.options.gatewayUrl}. ` +
							'Start the gateway, or start this server with a --gateway-url that points at it.',
					),
				);
			}, this.options.connectionWaitMs);
			waiter.timer.unref();
			this.registrationWaiters.add(waiter);
		});
		const registeredClient = this.client;
		if (registeredClient === undefined) {
			throw OpenaiError.gatewayUnavailable('The connection to the central gateway closed as this request was submitted.');
		}
		return registeredClient;
	}

	/**
	 * Refuses every request waiting for a registered connection.
	 *
	 * @param failure The failure to refuse them with.
	 */
	private _rejectRegistrationWaiters(failure: OpenaiError): void {
		for (const waiter of [...this.registrationWaiters]) {
			this.registrationWaiters.delete(waiter);
			if (waiter.timer !== undefined) {
				clearTimeout(waiter.timer);
			}
			waiter.reject(failure);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Task Progress
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Joins an accepted task to the request that submitted it, so later revisions of that task
	 * can be matched to the same request.
	 *
	 * @param task The accepted task, which carries back the identifier the submission was sent
	 * under.
	 */
	private _onTaskAccepted(task: TaskSnapshot): void {
		const pending = this.pendingByTaskRequestId.get(task.taskRequestId);
		if (pending === undefined) {
			return;
		}
		pending.taskId = task.taskId;
		this.pendingByTaskId.set(task.taskId, pending);
		pending.onCorrelationIds?.({
			taskRequestId: pending.taskRequestId,
			taskId: task.taskId,
		});
		this._settleFromTaskState(pending, task.state, task.result, task.error);
	}

	/**
	 * Answers a request once its task has reached a state that ends it.
	 *
	 * @param update The task revision the central gateway sent.
	 */
	private _onTaskUpdated(update: TaskUpdate): void {
		const pending = this.pendingByTaskId.get(update.taskId);
		if (pending === undefined) {
			return;
		}
		// A revision carries text only for a task that asked to be answered as its answer is
		// written, and only for the revision that produced that text, so each piece is passed on
		// exactly once and a task that asked for the whole answer passes on nothing.
		if (update.newText !== undefined && pending.isSettled === false) {
			pending.onPiece?.(update.newText);
		}
		this._settleFromTaskState(pending, update.state, update.result, update.error);
	}

	/**
	 * Answers a request from the state its task has reached, and leaves the request waiting
	 * while the task is still queued, assigned, or running.
	 *
	 * @param pending The request waiting for this task.
	 * @param state The state the task has reached.
	 * @param result The task result, present once the task has completed.
	 * @param error The reason the task failed, present once it has failed.
	 */
	private _settleFromTaskState(
		pending: PendingTask,
		state: TaskState,
		result: StagePayload | undefined,
		error: string | undefined,
	): void {
		if (state === 'completed') {
			const answer = ClusterTaskRunner._taskAnswerOf(pending.taskInput, result);
			if (answer === undefined) {
				this._settleWithFailure(pending, OpenaiError.answerUnreadable(pending.taskInput.taskType));
				return;
			}
			this._settleWithAnswer(pending, answer);
			return;
		}
		if (state === 'failed') {
			// The gateway records this one reason as a fixed name rather than a sentence: it is
			// what a task carries when no worker browser tab offered its first stage before the
			// gateway's submission deadline, which is the everyday case of nobody being connected.
			const reason = error ?? 'the central gateway gave no reason';
			if (reason === 'SUBMISSION_DEADLINE_EXPIRED') {
				this._settleWithFailure(pending, OpenaiError.noVolunteerAvailable(pending.modelId));
				return;
			}
			this._settleWithFailure(pending, OpenaiError.taskFailed(reason));
			return;
		}
		if (state === 'cancelled') {
			this._settleWithFailure(pending, OpenaiError.taskFailed('the task was cancelled'));
		}
	}

	/**
	 * Answers the request an error names, or reports the error when it names none.
	 *
	 * @param error The error the central gateway sent, or one the consumer client noticed itself.
	 */
	private _onGatewayError(error: ProtocolError): void {
		const pendingByRequest = error.taskRequestId === undefined ? undefined : this.pendingByTaskRequestId.get(error.taskRequestId);
		const pending = pendingByRequest ?? (error.taskId === undefined ? undefined : this.pendingByTaskId.get(error.taskId));
		if (pending === undefined) {
			console.error(`The central gateway reported ${error.code}: ${error.message}`);
			return;
		}
		if (error.code === 'RATE_LIMITED') {
			this._settleWithFailure(pending, OpenaiError.gatewayRateLimited(error.message));
			return;
		}
		// The gateway names the stages nobody runs in the error's details. Passing its own sentence
		// on instead would say "one or more stages this task requires", which names neither the
		// model the caller asked for nor the stages that are missing.
		if (error.code === 'CAPACITY_EXHAUSTED') {
			const missingStageNames = ClusterTaskRunner._missingStageNamesOf(error);
			this._settleWithFailure(pending, OpenaiError.modelHasNoConnectedWorker(pending.modelId, missingStageNames));
			return;
		}
		this._settleWithFailure(pending, OpenaiError.taskFailed(`${error.code}: ${error.message}`));
	}

	/**
	 * Reads the stages nobody runs out of a `CAPACITY_EXHAUSTED` error's details.
	 *
	 * The details are typed as an open record of unknown values, so the field is checked rather
	 * than trusted: an older gateway that sends no details, or sends something other than a list
	 * of names, leaves the caller with an empty list to word its message around instead of a
	 * broken one.
	 *
	 * @param error The error the central gateway sent.
	 * @returns The stage names, or an empty list when the error carries none.
	 */
	private static _missingStageNamesOf(error: ProtocolError): string[] {
		const missingStageNames = error.details?.['missingStageNames'];
		if (Array.isArray(missingStageNames) === false) {
			return [];
		}
		return missingStageNames.filter((stageName): stageName is string => typeof stageName === 'string');
	}

	/**
	 * Reads the generated text and its usage out of a task result.
	 *
	 * @param taskInput What was submitted, which says which shape the result has.
	 * @param result The task result.
	 * @returns The answer to resolve the request with, or `undefined` when the result carries no
	 * text to answer with. A development formula task never carries usage, since it runs no
	 * language model.
	 */
	private static _taskAnswerOf(taskInput: TaskInput, result: StagePayload | undefined): TaskAnswer | undefined {
		if (result === undefined) {
			return undefined;
		}
		// A development formula task carries a plain number, so its answer is that number
		// written out. Either language-model task carries the generated text.
		if (taskInput.taskType === 'task_type_dev_formula') {
			return typeof result === 'number'
				? { text: String(result), promptTokenCount: undefined, completionTokenCount: undefined, stopReason: undefined, toolCalls: undefined }
				: undefined;
		}
		if (typeof result === 'number') {
			return undefined;
		}
		if (result.text === undefined) {
			return undefined;
		}
		return {
			text: result.text,
			promptTokenCount: result.promptTokenCount,
			completionTokenCount: result.completionTokenCount,
			stopReason: result.stopReason,
			toolCalls: result.toolCalls,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Answering One Request
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Cancels the task of a request this server is no longer waiting for, and then refuses the
	 * request, so the cluster stops running stages for work nobody reads.
	 *
	 * @param pending The request being given up on.
	 * @param failure The failure to refuse it with.
	 * @param cancelReason Why the task is being cancelled, recorded by the gateway on the task.
	 */
	private _giveUp(pending: PendingTask, failure: OpenaiError, cancelReason: string): void {
		if (pending.isSettled === true) {
			return;
		}
		if (pending.taskId !== undefined) {
			this.client?.cancel(pending.taskId, cancelReason);
		}
		this._settleWithFailure(pending, failure);
	}

	/**
	 * Answers one request with what its task generated.
	 *
	 * @param pending The request being answered.
	 * @param answer The generated text and its usage.
	 */
	private _settleWithAnswer(pending: PendingTask, answer: TaskAnswer): void {
		if (this._forget(pending) === false) {
			return;
		}
		pending.resolve(answer);
	}

	/**
	 * Refuses one request.
	 *
	 * @param pending The request being refused.
	 * @param failure The failure to refuse it with.
	 */
	private _settleWithFailure(pending: PendingTask, failure: OpenaiError): void {
		if (this._forget(pending) === false) {
			return;
		}
		pending.reject(failure);
	}

	/**
	 * Refuses every request waiting for a task.
	 *
	 * @param failure The failure to refuse them with.
	 */
	private _failEveryPendingTask(failure: OpenaiError): void {
		for (const pending of [...this.pendingByTaskRequestId.values()]) {
			this._settleWithFailure(pending, failure);
		}
	}

	/**
	 * Stops tracking one request and cancels its timer.
	 *
	 * @param pending The request to stop tracking.
	 * @returns `true` when this call is the one that ends the request, and `false` when the
	 * request had already been answered, so it is not answered a second time.
	 */
	private _forget(pending: PendingTask): boolean {
		if (pending.isSettled === true) {
			return false;
		}
		pending.isSettled = true;
		if (pending.timeoutTimer !== undefined) {
			clearTimeout(pending.timeoutTimer);
		}
		pending.timeoutTimer = undefined;
		this.pendingByTaskRequestId.delete(pending.taskRequestId);
		if (pending.taskId !== undefined) {
			this.pendingByTaskId.delete(pending.taskId);
		}
		return true;
	}
}
