import { AccountAuthentication, type AccountKeyPair, type ClientMessage, type GatewayEnvelope, type GatewayMessage, type LlmStagePayload, type StagePayload } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { SessionRenewal } from '@webai/protocol/session_renewal';
import { LeaseHeartbeat } from './lease_heartbeat.js';
import { WorkerStageOffer } from './worker_stage_offer.js';
import { StageCatalog } from '../stages/stage_catalog.js';
import { LocalServerGeneration } from '../stages/local_server_generation.js';
import type { OpenaiApiClient } from './openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayWorkerClient — holds this worker's connection to the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The part of a WebSocket connection this client uses.
 *
 * Only these members are named, so that the same client works with the connection of the `ws`
 * package and with any other connection that offers the same few members.
 */
export type WorkerSocket = {
	readonly readyState: number;
	readonly OPEN: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string | Buffer }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
};

/** The functions this client calls as the conversation with the central gateway proceeds. */
export type GatewayWorkerClientCallbacks = {
	/** Called with every message this worker sends and receives. */
	onMessage?: (direction: 'sent' | 'received', message: ClientMessage | GatewayMessage) => void;
	/** Called with the device identifier the gateway issued, once registration has succeeded. */
	onRegistered?: (deviceId: string, stageNames: string[]) => void;
	/** Called with something worth telling the person running this worker, in plain words. */
	onNotice?: (text: string) => void;
	/** Called when something went wrong, in plain words. */
	onFailure?: (text: string) => void;
	/**
	 * Called once the account is proved, or once it is clear it will not be.
	 *
	 * The account identifier is absent when this worker holds no key pair, or when the gateway would
	 * not give it one: in both cases the stages it completes earn credits for nobody.
	 */
	onAccountSettled?: (accountId: string | undefined) => void;
	/** Called with anything about the account worth telling the person running this worker. */
	onAccountNote?: (note: string) => void;
	/** Called when the connection opens and when it closes. */
	onConnectionChange?: (isConnected: boolean) => void;
};

/** What this client needs to register and to run the stages it is assigned. */
export type GatewayWorkerClientOptions = {
	/** The worker name to register under, which the gateway shows in its device list. */
	name: string;
	/** The bearer token the gateway requires. */
	authenticationToken: string;
	/** The stages the command line restricts this worker to. Empty means every stage it can run. */
	requestedStageNames: readonly string[];
	/** The client for the local server that holds the model. */
	openaiApiClient: OpenaiApiClient;
	/** The model this worker was told to serve, such as `llama-3.2-1b-instruct`. */
	modelId: string;
	/**
	 * This worker's own account key pair, when it has one.
	 *
	 * Left out, the stages this worker completes are recorded against the shared development account
	 * rather than earning credits for anybody.
	 */
	accountKeyPair?: AccountKeyPair | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gateway Worker Client
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Speaks the worker side of the gateway protocol over one connection.
 *
 * The sequence is the one the worker browser page runs in
 * `packages/worker_webpage/web/src/main.ts`, carried out by a Node.js process instead: the
 * client authenticates as soon as the connection opens, asks which pipelines the gateway has
 * loaded, checks that the local server holds the model, registers with the stages it can run,
 * and then runs each stage the gateway assigns to it. It authenticates again before the session
 * the gateway granted runs out, and it extends the lease of the assignment it is working on, so
 * neither expires underneath it.
 *
 * Nothing about diagnostics reporting is needed here. That path exists because a worker browser
 * page cannot write files; this worker writes its own output.
 */
export class GatewayWorkerClient {
	/** Whether this worker has completed registration on this connection. */
	private isRegistered = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: ReturnType<typeof setTimeout> | undefined;
	/** The stages this worker advertised, once the gateway's pipelines have been read. */
	private offeredStageNames: string[] = [];
	/** The assignments whose stage runs are under way right now. */
	private readonly runningStageAssignmentIds = new Set<string>();
	/**
	 * The assignments the gateway cancelled while their stage run was still under way.
	 *
	 * A cancelled run ends by throwing, because releasing the answer it was reading is what stops
	 * it waiting, and without this that throw would be reported as `stage.failed` for an
	 * assignment the gateway has already taken back. The gateway refuses such a result with
	 * `STALE_ASSIGNMENT`, so nothing breaks, but this worker's own log would announce a failure
	 * every time a task was cancelled normally.
	 */
	private readonly cancelledStageAssignmentIds = new Set<string>();
	/** The account conversation of the current connection, when this worker holds a key pair. */
	private accountAuthentication: AccountAuthentication | undefined;

	/**
	 * @param socket The already-built connection to the central gateway.
	 * @param options What this worker registers as, and what it runs its stages against.
	 * @param callbacks The functions to call as the conversation proceeds.
	 */
	constructor(
		private readonly socket: WorkerSocket,
		private readonly options: GatewayWorkerClientOptions,
		private readonly callbacks: GatewayWorkerClientCallbacks = {},
	) {
		socket.onopen = (): void => {
			this.callbacks.onConnectionChange?.(true);
			this.send({
				type: 'deviceAuthenticate',
				token: this.options.authenticationToken,
			});
		};
		socket.onmessage = (event): void => {
			this.handleMessage(typeof event.data === 'string' ? event.data : event.data.toString());
		};
		socket.onerror = (): void => {
			this.callbacks.onFailure?.('The connection to the central gateway failed');
		};
		socket.onclose = (): void => {
			this.isRegistered = false;
			// The account belongs to the connection that proved it, so the next connection proves it again.
			this.accountAuthentication = undefined;
			// An answer being read one piece at a time stays open between runs, and only a run
			// assigned over this connection can carry it on. With the connection gone, no run
			// can arrive, so every open request to the local server is stopped now rather than
			// left running for as long as this process stays alive.
			StageCatalog.clearEveryGeneration();
			LeaseHeartbeat.stop();
			this.clearSessionRenewal();
			this.callbacks.onConnectionChange?.(false);
		};
	}

	/** Cancels any pending session renewal and closes the connection. */
	close(): void {
		LeaseHeartbeat.stop();
		this.clearSessionRenewal();
		this.socket.close();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Sending And Receiving
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the account conversation for this connection.
	 *
	 * @param accountKeyPair This worker's key pair.
	 * @returns The conversation, not yet started.
	 */
	private buildAccountAuthentication(accountKeyPair: AccountKeyPair): AccountAuthentication {
		return new AccountAuthentication(accountKeyPair, (message: ClientMessage): void => {
			this.send(message);
		}, {
			onSettled: (accountId: string | undefined): void => {
				this.callbacks.onAccountSettled?.(accountId);
				if (this.isRegistered === false) {
					this.send({
						type: 'pipelines.get',
					});
				}
			},
			onNote: (note: string): void => {
				this.callbacks.onAccountNote?.(note);
			},
		});
	}

	/**
	 * Sends one message inside the wrapper every frame travels in.
	 *
	 * @param message The message to send.
	 */
	private send(message: ClientMessage): void {
		if (this.socket.readyState !== this.socket.OPEN) {
			return;
		}
		const frame = Envelope.fromClient(message);
		this.callbacks.onMessage?.('sent', message);
		this.socket.send(JSON.stringify(frame));
	}

	/**
	 * Reads one frame the central gateway sent and acts on it.
	 *
	 * @param rawStr The frame as the text it arrived in.
	 */
	private handleMessage(rawStr: string): void {
		let frame: GatewayEnvelope;
		try {
			frame = JSON.parse(rawStr) as GatewayEnvelope;
		} catch {
			this.callbacks.onFailure?.('The central gateway sent invalid data');
			return;
		}
		const message: GatewayMessage | undefined = frame.body;
		if (message === undefined) {
			this.callbacks.onFailure?.('The central gateway sent a frame with no message in it');
			return;
		}
		this.callbacks.onMessage?.('received', message);
		if (message.type === 'deviceAuthenticated') {
			// This worker holds its connection open for as long as it runs, which is longer than
			// one session lasts, and the gateway refuses messages once a session has expired.
			// A renewal is answered with "deviceAuthenticated" too, so asking for the pipelines
			// again each time would restart the whole registration sequence.
			this.scheduleSessionRenewal(message.expiresAt);
			if (this.isRegistered || this.accountAuthentication !== undefined) {
				return;
			}
			// Proving which account this worker is comes before asking for the pipelines, and therefore
			// before registering, so no stage can complete before the gateway knows whose account earned
			// it. A worker with no key pair asks straight away and earns for nobody.
			if (this.options.accountKeyPair === undefined) {
				// Reported just as an account that was proved is, so whoever is running this worker is
				// always told which of the two happened.
				this.callbacks.onAccountSettled?.(undefined);
				this.send({
					type: 'pipelines.get',
				});
				return;
			}
			this.accountAuthentication = this.buildAccountAuthentication(this.options.accountKeyPair);
			this.accountAuthentication.begin();
			return;
		}
		if (this.accountAuthentication?.handleMessage(message) === true) {
			return;
		}
		if (message.type === 'pipelines') {
			void this.registerOfferedStages(message.pipelines);
			return;
		}
		if (message.type === 'deviceRegistered') {
			this.isRegistered = true;
			this.callbacks.onRegistered?.(message.deviceId, this.offeredStageNames);
			return;
		}
		if (message.type === 'stage.cancel') {
			LeaseHeartbeat.stop(message.stageAssignmentId);
			// One worker process can hold two runs of the same task at once, when a lease expires
			// and the gateway assigns the stage again to the same worker; only the assignment named
			// here is being cancelled, which is what stops this from ending an answer the
			// replacement run is still reading.
			StageCatalog.clearGeneration(message.taskId, message.stageAssignmentId);
			// Only a run that is actually under way needs remembering: it is about to end by
			// throwing, and it must not report that as a stage failure. A cancellation that
			// arrives between two runs has nothing to suppress, so nothing is recorded and the
			// set cannot grow without bound.
			if (this.runningStageAssignmentIds.has(message.stageAssignmentId)) {
				this.cancelledStageAssignmentIds.add(message.stageAssignmentId);
			}
			return;
		}
		// The gateway answers each lease heartbeat with a later expiry. Nothing has to be done
		// with it: the assignment is still this worker's, which is the whole point.
		if (message.type === 'stage.lease.extended') {
			return;
		}
		if (message.type === 'stage.assign') {
			void this.runAssignedStage(message);
			return;
		}
		if (message.type === 'error') {
			// A result this worker sent can reach the gateway just after the assignment it belongs
			// to stopped being current — the task was cancelled, or the lease ran out and the
			// stage was assigned again — and the gateway then refuses it. That is the gateway
			// declining work it no longer wants, not this worker malfunctioning, and the race is
			// not one the worker can avoid: it had already sent the result before it was told.
			if (message.code === 'STALE_ASSIGNMENT') {
				this.callbacks.onNotice?.('The gateway had already moved the assignment on, so the result this worker sent was not wanted');
				return;
			}
			this.callbacks.onFailure?.(`${message.code}: ${message.message}`);
			return;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Registering
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Decides which stages this worker can offer and registers with them.
	 *
	 * A stage that needs the local server to hold the model is dropped when the server cannot be
	 * reached or does not offer that model, so this worker never advertises work it would fail.
	 *
	 * @param pipelines The pipeline specifications the gateway returned.
	 */
	private async registerOfferedStages(pipelines: { stages: { name: string; computation: string }[] }[]): Promise<void> {
		const offered = WorkerStageOffer.offeredStages(pipelines, this.options.requestedStageNames);
		let stageNames = offered.stageNames;
		if (offered.localModelStageNames.length > 0) {
			const readiness = await LocalServerGeneration.readiness(this.options.openaiApiClient, this.options.modelId);
			if (readiness.status === 'ready') {
				this.callbacks.onNotice?.(`The local server offers ${this.options.modelId}`);
			} else {
				stageNames = stageNames.filter((stageName) => offered.localModelStageNames.includes(stageName) === false);
				this.callbacks.onFailure?.(readiness.message);
			}
		}
		if (stageNames.length === 0) {
			this.callbacks.onFailure?.('This worker can run none of the stages the loaded pipelines define, so it is not registering');
			this.socket.close(1000, 'No stage to run');
			return;
		}
		this.offeredStageNames = stageNames;
		this.send({
			type: 'deviceRegister',
			role: 'worker',
			name: this.options.name,
			stageNames,
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Running One Stage
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one assigned stage and reports its result, or its failure, to the gateway.
	 *
	 * @param message The `stage.assign` message the gateway sent.
	 */
	private async runAssignedStage(message: Extract<GatewayMessage, { type: 'stage.assign' }>): Promise<void> {
		const { taskId, stageAssignmentId, attempt, stage } = message;
		this.runningStageAssignmentIds.add(stageAssignmentId);
		this.send({
			type: 'stage.accepted',
			taskId,
			stageAssignmentId,
			attempt,
		});
		LeaseHeartbeat.start((heartbeat) => this.send(heartbeat), {
			taskId,
			stageAssignmentId,
			attempt,
			leaseUntil: message.leaseUntil,
		});
		try {
			const value = await this.runComputation(message);
			LeaseHeartbeat.stop(stageAssignmentId);
			if (this.reportsNothingFor(stageAssignmentId)) {
				return;
			}
			this.send({
				type: 'stage.result',
				taskId,
				stageAssignmentId,
				attempt,
				stage,
				value,
			});
		} catch (error: unknown) {
			LeaseHeartbeat.stop(stageAssignmentId);
			// A failed stage abandons the task, so drop whatever this worker was keeping for it:
			// an answer the local server is still producing. Left alone when no such answer exists.
			StageCatalog.clearGeneration(taskId, stageAssignmentId);
			if (this.reportsNothingFor(stageAssignmentId)) {
				return;
			}
			this.send({
				type: 'stage.failed',
				taskId,
				stageAssignmentId,
				attempt,
				stage,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.runningStageAssignmentIds.delete(stageAssignmentId);
			this.cancelledStageAssignmentIds.delete(stageAssignmentId);
		}
	}

	/**
	 * Reports whether a finished run should stay silent, because its assignment was cancelled
	 * while it was still under way.
	 *
	 * @param stageAssignmentId The stage assignment the run was carrying out.
	 * @returns `true` when the gateway has already taken the assignment back, so neither a result
	 * nor a failure should be sent for it.
	 */
	private reportsNothingFor(stageAssignmentId: string): boolean {
		if (this.cancelledStageAssignmentIds.has(stageAssignmentId) === false) {
			return false;
		}
		this.callbacks.onNotice?.('The assignment was cancelled while it was running, so its outcome is not being reported');
		return true;
	}

	/**
	 * Runs the assigned stage with whichever helper implements its computation.
	 *
	 * The assignment says which computation to run, so this worker never has to recognise the
	 * stage name.
	 *
	 * @param message The `stage.assign` message the gateway sent.
	 * @returns The stage result, once the computation has produced it.
	 * @throws If no helper here implements the computation, or if the computation fails.
	 */
	private async runComputation(message: Extract<GatewayMessage, { type: 'stage.assign' }>): Promise<StagePayload> {
		const stageHelper = StageCatalog.stageHelperFor(message.computation);
		if (stageHelper === undefined) {
			throw new Error(`This worker implements no computation named ${message.computation}`);
		}
		return await stageHelper.compute(
			message.taskId,
			message.stageAssignmentId,
			message.value as LlmStagePayload,
			message.generationSettings,
			this.options.openaiApiClient,
			this.options.modelId,
		);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Session Renewal
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Authenticates again before the current session runs out.
	 *
	 * @param expiresAt When the current session expires, as the gateway stated it.
	 */
	private scheduleSessionRenewal(expiresAt: string): void {
		this.clearSessionRenewal();
		this.sessionRenewalTimer = setTimeout((): void => {
			this.send({
				type: 'deviceAuthenticate',
				token: this.options.authenticationToken,
			});
		}, SessionRenewal.renewAfterMs(expiresAt));
		// The open WebSocket connection is what keeps this process alive, not this timer: a
		// worker with a connection open always has more to wait for than its own renewal, and a
		// program driving this client in a test has neither and must be free to exit.
		this.sessionRenewalTimer.unref?.();
	}

	/** Cancels the pending renewal, if there is one. */
	private clearSessionRenewal(): void {
		if (this.sessionRenewalTimer === undefined) {
			return;
		}
		clearTimeout(this.sessionRenewalTimer);
		this.sessionRenewalTimer = undefined;
	}
}
