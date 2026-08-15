import { StagePayloadFactory, type ClientMessage, type Device } from '@webai/protocol';
import { TaskProjection } from '@webai/protocol/task_projection';
import type { WebSocket } from 'ws';
import { AccountMessageHandler } from '../accounting/account_message_handler.js';
import { AccountingQueryHandler } from '../accounting/accounting_query_handler.js';
import type { AccountingRecorder } from '../accounting/accounting_recorder.js';
import { AccountingSummaryHandler } from '../accounting/accounting_summary_handler.js';
import type { ConnectionHub } from '../connection/connection_hub.js';
import type { DeviceAnnouncer } from '../device/device_announcer.js';
import type { DeviceRegistry } from '../device/device_registry.js';
import type { PipelineRegistry } from './pipeline_registry.js';
import type { Session, SessionRegistry } from './session_registry.js';
import type { StagePolicyResolver } from './stage_policy_resolver.js';
import type { TaskScheduler } from './task_scheduler.js';
import { TaskStore } from './task_store.js';
import { WorkerPlacement } from '../device/worker_placement.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClientMessageHandler — acts on each validated message a connected client sends
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Carries out one client message at a time.
 *
 * The messages fall into four groups, and they are tried in this order because the order is
 * part of the rules: the messages a connection may send before it has registered, then the
 * ones that read task state, then the ones that change it, then the stage messages a worker
 * sends about the assignment it holds. Everything after the first group requires a registered
 * device.
 */
export class ClientMessageHandler {
	/**
	 * @param hub The open connections, and the only place a message is written to one.
	 * @param deviceRegistry The registry of connected devices.
	 * @param taskStore The store holding every task.
	 * @param pipelineRegistry The authority on which pipelines and stage names exist.
	 * @param sessionRegistry The authenticated sessions.
	 * @param stagePolicyResolver The source of each stage's own settings.
	 * @param scheduler The scheduler that places stages and reports task progress.
	 * @param announcer The announcer of device changes.
	 * @param authToken The bearer token a connection must present.
	 * @param maximumTasksPerPrincipal How many tasks one principal may have in flight.
	 * @param accountMessageHandler The handler of the account messages, which are answered
	 * asynchronously because verifying a signature is asynchronous.
	 * @param accountingRecorder The recorder of the credit a completed stage earns and costs.
	 * @param accountingQueryHandler The answerer of what an account is, what it holds, and what it did.
	 * @param accountingSummaryHandler The answerer of what every account holds, for an observer.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly deviceRegistry: DeviceRegistry,
		private readonly taskStore: TaskStore,
		private readonly pipelineRegistry: PipelineRegistry,
		private readonly sessionRegistry: SessionRegistry,
		private readonly stagePolicyResolver: StagePolicyResolver,
		private readonly scheduler: TaskScheduler,
		private readonly announcer: DeviceAnnouncer,
		private readonly authToken: string,
		private readonly maximumTasksPerPrincipal: number,
		private readonly accountMessageHandler: AccountMessageHandler,
		private readonly accountingRecorder: AccountingRecorder,
		private readonly accountingQueryHandler: AccountingQueryHandler,
		private readonly accountingSummaryHandler: AccountingSummaryHandler,
	) { }

	/**
	 * Handles one validated client message for a connected device.
	 *
	 * @param socket The WebSocket that sent the message.
	 * @param deviceId The identifier assigned to the WebSocket connection.
	 * @param message The client message to process.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 */
	handle(socket: WebSocket, deviceId: string, message: ClientMessage, inReplyToMessageId: string): void {
		// The session expiry the gateway advertises is checked here, on every message, rather than
		// only at the moment a connection authenticates. An expired session is refused until the
		// client authenticates again on the same connection; the connection is never closed for it.
		const currentSession = this.sessionRegistry.active(deviceId);
		if (message.type !== 'deviceAuthenticate' && currentSession === undefined) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHENTICATION_REQUIRED', 'Authenticate before using the protocol', { retryable: true });
			return;
		}
		if (this.handleBeforeRegistration(socket, deviceId, message, inReplyToMessageId, currentSession)) return;

		if (this.deviceRegistry.get(deviceId) === undefined) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'NOT_REGISTERED', 'Register before sending this message');
			return;
		}
		const activeDevice = this.deviceRegistry.get(deviceId);
		if (activeDevice !== undefined) this.deviceRegistry.add({ ...activeDevice, lastSeenAt: new Date().toISOString() });

		if (this.handleTaskReads(socket, deviceId, message, inReplyToMessageId)) return;
		if (this.handleTaskChanges(socket, deviceId, message, inReplyToMessageId, currentSession)) return;
		if (this.handleStageMessages(socket, deviceId, message, inReplyToMessageId)) return;

		if (message.type === 'signal') {
			const target = this.hub.socketMap.get(message.to);
			if (target !== undefined) {
				this.hub.send(target, { type: 'signal', from: deviceId, data: message.data }, this.hub.counterpartFor(message.to));
			}
			return;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Before Registration
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages a connection may send before it has registered.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @param currentSession The connection's active session, when it has one.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleBeforeRegistration(socket: WebSocket, deviceId: string, message: ClientMessage, inReplyToMessageId: string, currentSession: Session | undefined): boolean {
		// An account message is answered before registration, because a worker browser page proves
		// which account it is before it registers as a worker. Answering it takes verifying a
		// signature, which is asynchronous, so the answer is sent when it is ready rather than within
		// this call; nothing else a connection may send depends on that answer having arrived.
		// The accounting reads are answered here and now, unlike the three account messages below them:
		// reading a balance or a history takes no cryptography, so nothing about it is asynchronous.
		if (AccountingQueryHandler.isAccountingQuery(message)) {
			this.accountingQueryHandler.handle(socket, deviceId, message, inReplyToMessageId);
			return true;
		}
		if (AccountingSummaryHandler.isAccountingSummaryMessage(message)) {
			this.accountingSummaryHandler.handle(socket, deviceId, inReplyToMessageId);
			return true;
		}
		if (AccountMessageHandler.isAccountIdentityMessage(message)) {
			void this.accountMessageHandler.handle(socket, deviceId, message, inReplyToMessageId).catch((error: unknown) => {
				console.error(error);
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'UNSUPPORTED', 'The account message could not be answered', { retryable: false });
			});
			return true;
		}
		if (message.type === 'observe') {
			this.hub.observerDeviceIds.add(deviceId);
			// An observer connection exists to watch the cluster, so observing implies a
			// device membership subscription and no separate "devices.subscribe" is needed.
			this.hub.deviceSubscriberIds.add(deviceId);
			this.sendDeviceList(socket, deviceId, inReplyToMessageId);
			return true;
		}
		if (message.type === 'devices.subscribe') {
			this.hub.deviceSubscriberIds.add(deviceId);
			this.sendDeviceList(socket, deviceId, inReplyToMessageId);
			return true;
		}
		if (message.type === 'devices.unsubscribe') {
			this.hub.deviceSubscriberIds.delete(deviceId);
			return true;
		}
		if (message.type === 'deviceAuthenticate') {
			if (message.token !== this.authToken) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHENTICATION_REQUIRED', 'Credentials were rejected', { retryable: false });
				return true;
			}
			// Authenticating again on a connection that already has a session simply replaces it,
			// which is how a client renews before or after its session runs out.
			const session = this.sessionRegistry.open(deviceId, message.token);
			this.hub.send(socket, { type: 'deviceAuthenticated', authIdentity: session.authIdentity, expiresAt: new Date(session.expiresAt).toISOString() }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return true;
		}
		// Answered before registration on purpose: a worker asks which pipelines the gateway has
		// loaded so it can decide which stages to advertise, and that decision has to be made
		// before it registers. A pipeline specification carries no task data.
		if (message.type === 'pipelines.get') {
			this.hub.send(socket, { type: 'pipelines', pipelines: this.pipelineRegistry.list().filter((specification) => specification.retired !== true) }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return true;
		}
		if (message.type === 'deviceRegister') {
			this.register(socket, deviceId, message, inReplyToMessageId, currentSession);
			return true;
		}
		return false;
	}

	/**
	 * Registers a connection as a worker or a consumer.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The `deviceRegister` message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @param currentSession The connection's active session.
	 */
	private register(socket: WebSocket, deviceId: string, message: Extract<ClientMessage, { type: 'deviceRegister' }>, inReplyToMessageId: string, currentSession: Session | undefined): void {
		// The pipeline registry is the authority on which stage names exist. The shared
		// protocol package only checks the shape of a stage name, so a worker advertising a
		// stage no loaded pipeline defines is told so here, rather than registering
		// successfully and then silently never receiving work.
		const undefinedStageNames = (message.stageNames ?? []).filter((stageName) => this.pipelineRegistry.definesStage(stageName) === false);
		if (message.role === 'worker' && undefinedStageNames.length > 0) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'VALIDATION', 'No loaded pipeline defines these stages', { retryable: false, details: { undefinedStageNames, definedStageNames: this.pipelineRegistry.stageNames() } });
			return;
		}
		// A worker is identified by the deviceId this connection was given when it opened, never
		// by the name it registers under. The name is a display label, and two connected workers
		// are allowed to carry the same one: three worker browser tabs of one debug page and the
		// three of a second copy of that same page register six workers under three names, and
		// all six have to stay connected (see
		// https://github.com/webai-at-home/webai-at-home/issues/135). A device leaves the registry
		// only when its own connection closes.
		const ipAddress = this.hub.ipAddressMap.get(deviceId);
		const device: Device = {
			deviceId,
			name: message.name,
			deviceRole: message.role,
			// A worker that names no stages is taken to run every stage the loaded pipelines
			// define, rather than a list of stage names written into the gateway.
			stageNames: message.role === 'worker'
				? (message.stageNames ?? this.pipelineRegistry.stageNames())
				: [],
			connectedAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
			// Observed by the gateway when this connection opened, never sent by the device, so a
			// device cannot choose the address recorded for it. See issue #183.
			...(ipAddress === undefined ? {} : { ipAddress }),
			authIdentity: currentSession?.authIdentity ?? '',
			...(message.role === 'worker' ? { workerState: message.ready === false ? 'draining' as const : 'ready' as const, ready: message.ready ?? true, maxConcurrentAssignments: message.maxConcurrentAssignments ?? 1, activeAssignments: 0 } : {}),
		};
		const change = this.deviceRegistry.add(device);
		this.hub.send(socket, { type: 'deviceRegistered', deviceId }, this.hub.counterpartFor(deviceId, message), inReplyToMessageId);
		this.announcer.publishDevice(change);
		this.scheduler.scheduleQueuedTasks();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading Tasks And Devices
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages that read task state or the device list.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleTaskReads(socket: WebSocket, deviceId: string, message: ClientMessage, inReplyToMessageId: string): boolean {
		if (message.type === 'task.observe' || message.type === 'task.unobserve' || message.type === 'task.resync') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) { this.sendTaskNotFound(socket, deviceId, inReplyToMessageId, message.taskId); return true; }
			if (message.type === 'task.observe') {
				const requester = this.deviceRegistry.get(deviceId);
				if (requester?.deviceRole !== 'consumer' || (task.consumerDeviceId !== deviceId && this.hub.taskObserverDeviceIds.get(task.taskId)?.has(deviceId) !== true)) {
					this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'Task observation requires an owner grant', { taskId: task.taskId });
					return true;
				}
				const observers = this.hub.taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
				observers.add(deviceId);
				this.hub.taskObserverDeviceIds.set(task.taskId, observers);
			}
			if (message.type === 'task.resync' && this.scheduler.mayReadTask(deviceId, task.taskId) === false) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'This connection is not allowed to read the task', { taskId: task.taskId });
				return true;
			}
			if (message.type === 'task.unobserve') this.hub.taskObserverDeviceIds.get(task.taskId)?.delete(deviceId);
			if (message.type !== 'task.unobserve') this.hub.send(socket, { type: 'task.snapshot', task: TaskProjection.snapshot(task) }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return true;
		}
		if (message.type === 'task.history') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) { this.sendTaskNotFound(socket, deviceId, inReplyToMessageId, message.taskId); return true; }
			if (this.scheduler.mayReadTask(deviceId, task.taskId) === false) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'This connection is not allowed to read the task', { taskId: task.taskId });
				return true;
			}
			this.hub.send(socket, { type: 'task.history', taskId: task.taskId, events: task.events }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return true;
		}
		if (message.type === 'task.observer.grant' || message.type === 'task.observer.revoke') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) { this.sendTaskNotFound(socket, deviceId, inReplyToMessageId, message.taskId); return true; }
			if (task.consumerDeviceId !== deviceId) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'Only the task owner may manage observers', { taskId: task.taskId });
				return true;
			}
			const observer = this.deviceRegistry.get(message.consumerDeviceId);
			if (observer === undefined || observer.deviceRole !== 'consumer') {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'VALIDATION', 'An observer must be a connected consumer', { taskId: task.taskId });
				return true;
			}
			const observers = this.hub.taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
			if (message.type === 'task.observer.grant') observers.add(message.consumerDeviceId);
			else observers.delete(message.consumerDeviceId);
			this.hub.taskObserverDeviceIds.set(task.taskId, observers);
			return true;
		}
		if (message.type === 'devices.resync') {
			this.sendDeviceList(socket, deviceId, inReplyToMessageId);
			return true;
		}
		return false;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Changing Tasks And Worker State
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages that submit, read, cancel a task, or change worker state.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @param currentSession The connection's active session, when it has one.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleTaskChanges(socket: WebSocket, deviceId: string, message: ClientMessage, inReplyToMessageId: string, currentSession: Session | undefined): boolean {
		if (message.type === 'task.submit') {
			const device = this.deviceRegistry.get(deviceId);
			if (device?.deviceRole !== 'consumer') {
				this.hub.send(socket, { type: 'error', code: 'CONSUMER_REQUIRED', message: 'Only consumer browser tabs may submit tasks', taskRequestId: message.taskRequestId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			const existingTask = this.taskStore.findByTaskRequest(deviceId, message.taskRequestId);
			if (existingTask !== undefined) {
				if (JSON.stringify(existingTask.input) !== JSON.stringify(message.input)) {
					this.hub.send(socket, { type: 'error', code: 'TASK_REQUEST_ID_CONFLICT', message: 'taskRequestId was already used with different task contents', taskRequestId: message.taskRequestId, taskId: existingTask.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
					return true;
				}
				this.hub.send(socket, { type: 'task.accepted', taskRequestId: message.taskRequestId, task: TaskProjection.snapshot(existingTask) }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			// Read from the live session rather than from whatever identity was recorded when this
			// connection registered, so the limit always applies to whoever is authenticated now.
			const authIdentity = currentSession?.authIdentity ?? '';
			const activeTaskCount = this.taskStore.list().filter((candidate) => candidate.consumerAuthIdentity === authIdentity && ['completed', 'failed', 'cancelled'].includes(candidate.state) === false).length;
			if (activeTaskCount >= this.maximumTasksPerPrincipal) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'RATE_LIMITED', 'The principal has reached its active-task limit', { taskRequestId: message.taskRequestId, retryable: true, details: { limit: this.maximumTasksPerPrincipal } });
				return true;
			}
			// Every task now runs a pipeline, including the formula and language-model ones. The
			// stage sequence is data the task carries rather than a sequence built into the
			// gateway, so a task whose pipeline is missing cannot be advanced at all.
			const pipeline = this.pipelineRegistry.select(message.input, message.pipelineId, message.pipelineVersion);
			if (pipeline === undefined) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'NO_COMPATIBLE_WORKER', 'No active compatible pipeline specification exists', { taskRequestId: message.taskRequestId, retryable: false });
				return true;
			}
			// A stage nobody is connected to offer at all will never be run, however long a queued
			// task waits for the submission deadline. That is different from a stage every connected
			// worker is currently too busy to accept, which the wait exists for. Telling the two
			// apart here rejects the first case at once, rather than waiting out the deadline for
			// something no connected device could ever have done.
			const missingStageNames = pipeline.stages.map((stage) => stage.name).filter((stageName) => this.deviceRegistry.hasWorkerForStage(stageName) === false);
			if (missingStageNames.length > 0) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'CAPACITY_EXHAUSTED', 'One or more stages this task requires have no connected worker', { taskRequestId: message.taskRequestId, retryable: true, details: { missingStageNames } });
				return true;
			}
			// The account is read from the live session and recorded on the task, because the consumer of
			// a batch task is expected to be gone by the time its stages complete.
			const task = this.taskStore.create(message.input, deviceId, message.taskRequestId, { authIdentity, accountId: currentSession?.accountId }, {
				pipelineId: pipeline.pipelineId,
				pipelineVersion: pipeline.version,
				pipelineStages: pipeline.stages.map((stage) => stage.name),
				...(pipeline.repeatsUntilDone === true ? { pipelineRepeatsUntilDone: true } : {}),
			});
			this.hub.send(socket, { type: 'task.accepted', taskRequestId: message.taskRequestId, task: TaskProjection.snapshot(task) }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			const stage = TaskStore.nextStage(task);
			if (stage !== undefined) this.scheduler.assign(task.taskId, StagePayloadFactory.initial(message.input), stage);
			return true;
		}

		if (message.type === 'task.get') {
			const task = this.taskStore.get(message.taskId);
			if (task !== undefined && this.scheduler.mayReadTask(deviceId, task.taskId)) {
				this.hub.send(socket, { type: 'task.snapshot', task: TaskProjection.snapshot(task) }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			} else if (task !== undefined) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'This connection is not allowed to read the task', { taskId: message.taskId });
			} else {
				this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			}
			return true;
		}

		if (message.type === 'worker.state') {
			const device = this.deviceRegistry.get(deviceId);
			if (device === undefined || device.deviceRole !== 'worker') {
				this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may change worker state' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			this.announcer.publishDevice(this.deviceRegistry.add({ ...device, workerState: message.state, ready: message.state === 'ready', ...(message.maxConcurrentAssignments === undefined ? {} : { maxConcurrentAssignments: message.maxConcurrentAssignments }), lastSeenAt: new Date().toISOString() }));
			if (message.state === 'ready') this.scheduler.scheduleQueuedTasks();
			return true;
		}

		if (message.type === 'task.cancel') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) {
				this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			if (task.consumerDeviceId !== deviceId) {
				this.hub.send(socket, { type: 'error', code: 'TASK_OWNER_MISMATCH', message: 'Only the task owner may cancel this task', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			const stageAssignment = task.stageAssignment;
			const cancelled = this.taskStore.cancel(task.taskId, message.reason);
			if (stageAssignment !== undefined) {
				this.announcer.releaseWorkerAssignment(stageAssignment.workerDeviceId);
				const workerSocket = this.hub.socketMap.get(stageAssignment.workerDeviceId);
				if (workerSocket !== undefined) this.hub.send(workerSocket, { type: 'stage.cancel', taskId: task.taskId, stageAssignmentId: stageAssignment.stageAssignmentId, attempt: stageAssignment.attempt, reason: message.reason }, this.hub.counterpartFor(stageAssignment.workerDeviceId));
			}
			this.scheduler.broadcastTask(cancelled.taskId);
			return true;
		}
		return false;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Stage Messages From Workers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages a worker sends about the assignment it holds.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleStageMessages(socket: WebSocket, deviceId: string, message: ClientMessage, inReplyToMessageId: string): boolean {
		// A worker that is still working on its stage extends the lease rather than losing the
		// assignment mid-computation. Without this, a stage that takes longer than the lease is
		// reassigned while it is still running, its eventual result is refused as stale, and the
		// work is thrown away.
		if (message.type === 'stage.heartbeat') {
			const device = this.deviceRegistry.get(deviceId);
			const task = this.taskStore.get(message.taskId);
			const stageAssignment = task?.stageAssignment;
			if (device === undefined || device.deviceRole !== 'worker') {
				this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may extend an assignment lease' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			// The gateway refuses to extend a lease for an assignment that is no longer current,
			// and says so with the same message it uses to withdraw an assignment, so the worker
			// stops work and drops any state it holds rather than finishing work nobody wants.
			if (task === undefined || stageAssignment === undefined || stageAssignment.stageAssignmentId !== message.stageAssignmentId || stageAssignment.attempt !== message.attempt || stageAssignment.workerDeviceId !== deviceId) {
				this.hub.send(socket, { type: 'stage.cancel', taskId: message.taskId, stageAssignmentId: message.stageAssignmentId, attempt: message.attempt, reason: 'assignment_superseded' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			const leaseUntil = this.taskStore.renewLease(task.taskId, this.stagePolicyResolver.resolve(task, stageAssignment.stage).leaseMs);
			if (leaseUntil === undefined) return true;
			this.hub.send(socket, { type: 'stage.lease.extended', taskId: task.taskId, stageAssignmentId: stageAssignment.stageAssignmentId, attempt: stageAssignment.attempt, leaseUntil }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return true;
		}

		if (message.type === 'stage.accepted' || message.type === 'stage.relinquish') {
			const device = this.deviceRegistry.get(deviceId);
			const task = this.taskStore.get(message.taskId);
			const stageAssignment = task?.stageAssignment;
			if (device === undefined || device.deviceRole !== 'worker') {
				this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may update assignments' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			if (task === undefined || stageAssignment === undefined || stageAssignment.stageAssignmentId !== message.stageAssignmentId || stageAssignment.attempt !== message.attempt || stageAssignment.workerDeviceId !== deviceId) {
				this.hub.send(socket, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return true;
			}
			if (message.type === 'stage.accepted') {
				this.taskStore.acceptAssignment(task.taskId);
				this.scheduler.broadcastTask(task.taskId);
			} else {
				this.scheduler.assign(task.taskId, stageAssignment.value, stageAssignment.stage, { excluded: [deviceId], retryReason: 'worker_relinquished' });
			}
			return true;
		}

		if (message.type === 'stage.result') {
			this.acceptStageResult(socket, deviceId, message, inReplyToMessageId);
			return true;
		}

		if (message.type === 'stage.failed') {
			this.acceptStageFailure(socket, deviceId, message, inReplyToMessageId);
			return true;
		}
		return false;
	}

	/**
	 * Records one completed stage, then either assigns the next stage or completes the task.
	 *
	 * @param socket The connection that sent the result.
	 * @param deviceId The worker that ran the stage.
	 * @param message The `stage.result` message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 */
	private acceptStageResult(socket: WebSocket, deviceId: string, message: Extract<ClientMessage, { type: 'stage.result' }>, inReplyToMessageId: string): void {
		const device = this.deviceRegistry.get(deviceId);
		if (device === undefined || device.deviceRole !== 'worker') {
			this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may return stage results' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		const task = this.taskStore.get(message.taskId);
		if (task === undefined) {
			this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		const stageAssignment = task.stageAssignment;
		if (stageAssignment === undefined || stageAssignment.stageAssignmentId !== message.stageAssignmentId || stageAssignment.attempt !== message.attempt) {
			if (task.acknowledgedStageAssignmentIds?.includes(message.stageAssignmentId) === true) {
				this.hub.send(socket, { type: 'stage.result.accepted', taskId: task.taskId, stageAssignmentId: message.stageAssignmentId, attempt: message.attempt, taskRevision: task.taskRevision, status: task.state === 'completed' ? 'completed' : 'assigned' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
				return;
			}
			this.hub.send(socket, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (stageAssignment.workerDeviceId !== deviceId) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_OWNER_MISMATCH', message: 'Only the assigned worker may return this stage result', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (stageAssignment.stage !== message.stage) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_STAGE_MISMATCH', message: 'The stage result does not match the current assignment', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (task.state !== 'running') {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_NOT_ACCEPTED', message: 'A stage assignment must be accepted before returning a result', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		const updated = this.taskStore.addStage(task.taskId, { name: message.stage, value: message.value }, message.stageAssignmentId);
		// The one place a stage is known to have completed, so the one place the accounting rules are
		// applied: the worker earns a credit and the consumer spends one. The duration is measured from
		// the moment the worker accepted the assignment, and is recorded for information only — it
		// changes no balance, because every completed stage is worth the same credit.
		this.accountingRecorder.recordCompletedStage({
			task: updated,
			stageName: message.stage,
			stageAssignmentId: message.stageAssignmentId,
			workerDeviceId: deviceId,
			...(stageAssignment.acceptedAt === undefined ? {} : { stageDurationMs: Math.max(0, Date.now() - new Date(stageAssignment.acceptedAt).getTime()) }),
		});
		// A piece of an answer belongs to the revision that produced it and to no other, so it is
		// sent from here. Every revision that follows this one — the assignment of the next stage,
		// and the completion of the task — has already dropped it, and would otherwise be the
		// first thing broadcast after the piece existed. Only a task that asked for its answer in
		// pieces ever has one, so no other task is broadcast any more often than before.
		if (updated.newText !== undefined) this.scheduler.broadcastTask(updated.taskId);
		this.announcer.releaseWorkerAssignment(deviceId);
		const upcoming = TaskStore.nextStage(updated);
		if (upcoming === undefined) {
			const completed = this.taskStore.update(updated.taskId, { state: 'completed', result: message.value });
			this.scheduler.broadcastTask(updated.taskId);
			this.hub.send(socket, { type: 'stage.result.accepted', taskId: completed.taskId, stageAssignmentId: message.stageAssignmentId, attempt: message.attempt, taskRevision: completed.taskRevision, status: 'completed' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		// A stage that keeps state in the memory of the device running it must be placed back
		// on the device holding that state: a language-model shard needs the key-value cache
		// and hand-off tensors that device holds, and a built-in language-model stage needs
		// the generation it is holding open. Which device that is comes from the task's own
		// record of which device ran each stage, falling back to the device that just
		// finished. A stage that keeps no such state is instead preferably moved to a
		// different device, to demonstrate several workers cooperating on one task. Each
		// stage states which of the two it is, so no task type is named here.
		const policy = this.stagePolicyResolver.resolve(updated, upcoming);
		this.scheduler.assign(updated.taskId, message.value, upcoming, {
			excluded: policy.prefersSameWorkerOnRetry ? [] : [deviceId],
			preferredWorkerDeviceId: WorkerPlacement.preferredWorkerDeviceId(updated, upcoming, policy, deviceId),
			// The assignment this result completes was released just above, so the preferred
			// worker's assignment counter is already correct and nothing may be discounted
			// from it. Discounting one here would let that worker hold one assignment more
			// than its own maxConcurrentAssignments allows.
			isPreviousAssignmentReleased: true,
		});
		const assigned = this.taskStore.get(updated.taskId);
		if (assigned === undefined) return;
		this.hub.send(socket, { type: 'stage.result.accepted', taskId: assigned.taskId, stageAssignmentId: message.stageAssignmentId, attempt: message.attempt, taskRevision: assigned.taskRevision, status: 'assigned' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
	}

	/**
	 * Records that one stage failed, which fails the whole task.
	 *
	 * @param socket The connection that reported the failure.
	 * @param deviceId The worker that ran the stage.
	 * @param message The `stage.failed` message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 */
	private acceptStageFailure(socket: WebSocket, deviceId: string, message: Extract<ClientMessage, { type: 'stage.failed' }>, inReplyToMessageId: string): void {
		const device = this.deviceRegistry.get(deviceId);
		if (device === undefined || device.deviceRole !== 'worker') {
			this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may fail a stage' }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		const task = this.taskStore.get(message.taskId);
		if (task === undefined) {
			this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		const stageAssignment = task.stageAssignment;
		if (stageAssignment === undefined || stageAssignment.stageAssignmentId !== message.stageAssignmentId || stageAssignment.attempt !== message.attempt) {
			this.hub.send(socket, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (stageAssignment.workerDeviceId !== deviceId) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_OWNER_MISMATCH', message: 'Only the assigned worker may fail this stage', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (stageAssignment.stage !== message.stage) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_STAGE_MISMATCH', message: 'The stage failure does not match the current assignment', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (task.state !== 'running') {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_NOT_ACCEPTED', message: 'A stage assignment must be accepted before failing', taskId: message.taskId }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		this.taskStore.update(message.taskId, { state: 'failed', error: message.error, stageAssignment: undefined });
		this.announcer.releaseWorkerAssignment(deviceId);
		this.scheduler.broadcastTask(message.taskId);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Shared Replies
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends the full device list with the current membership revision.
	 *
	 * @param socket The connection to answer.
	 * @param deviceId The connection's device identifier.
	 * @param inReplyToMessageId The identifier of the frame being answered.
	 */
	private sendDeviceList(socket: WebSocket, deviceId: string, inReplyToMessageId: string): void {
		this.hub.send(socket, { type: 'devices', devices: this.announcer.connectedDevices(), deviceListRevision: this.deviceRegistry.currentDeviceListRevision() }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
	}

	/**
	 * Says that a task the client named does not exist.
	 *
	 * @param socket The connection to answer.
	 * @param deviceId The connection's device identifier.
	 * @param inReplyToMessageId The identifier of the frame being answered.
	 * @param taskId The task the client named.
	 */
	private sendTaskNotFound(socket: WebSocket, deviceId: string, inReplyToMessageId: string, taskId: string): void {
		this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'TASK_NOT_FOUND', 'Task was not found', { taskId });
	}
}
