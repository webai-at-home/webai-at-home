import WebSocket from 'ws';
import { ReconnectBackoff } from '@webai/protocol/reconnect_backoff';
import { GatewayWorkerClient, type GatewayWorkerClientCallbacks, type GatewayWorkerClientOptions, type WorkerSocket } from './gateway_worker_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayConnectionSupervisor — keeps this worker connected to the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What this supervisor needs beyond what one connection needs. */
export type GatewayConnectionSupervisorOptions = {
	/** The central gateway WebSocket URL every connection is opened to. */
	gatewayUrl: string;
	/**
	 * Whether a connection that closes is opened again after a wait.
	 *
	 * `false` makes this supervisor stop after the first connection closes, which is what this
	 * worker did before it learned to connect again, and what `--no-automatic-reconnection` asks
	 * for.
	 */
	isAutomaticReconnectionEnabled: boolean;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gateway Connection Supervisor
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Keeps this worker connected to the central gateway, opening a connection again after each one
 * that closes.
 *
 * A gateway that goes away — a deployment, a container restart, a network interruption — used to
 * end this worker process, so the volunteer had to start it by hand. This supervisor is what
 * makes the worker come back on its own, waiting longer after each attempt that did not produce a
 * usable connection, up to one minute, with no limit on the number of attempts. See
 * https://github.com/webai-at-home/webai-at-home/issues/158.
 *
 * `GatewayWorkerClient` speaks the worker side of the protocol over exactly one connection, and
 * everything it resets when a connection closes depends on that. So each attempt builds a new
 * socket and a new client rather than reusing either, and this supervisor holds the only state
 * that outlives one connection: how long to wait, and whether the worker is meant to be
 * connected at all.
 */
export class GatewayConnectionSupervisor {
	/** How long to wait before each attempt, and the rule that grows that wait. */
	private readonly backoff = new ReconnectBackoff();
	/** Whether `stop` has been called, after which no further connection is opened. */
	private isStopped = false;
	/** The connection this supervisor currently holds, when one is open. */
	private client: GatewayWorkerClient | undefined;
	/** Cancels the pending wait, while this supervisor is waiting to open the next connection. */
	private cancelWait: (() => void) | undefined;

	/**
	 * @param supervisorOptions The gateway address, and whether to connect again at all.
	 * @param clientOptions What each connection registers as, and what it runs its stages against.
	 * @param callbacks The functions each connection calls as its conversation proceeds.
	 * @param openSocket How to open one connection. The default opens a `ws` connection, read
	 * through the smaller shape the worker client actually uses. A test passes its own.
	 * @param waitBeforeAttempt How to wait between two attempts, returning how to cancel that wait.
	 * The default waits on a timer. A test passes its own so that it runs at once.
	 */
	constructor(
		private readonly supervisorOptions: GatewayConnectionSupervisorOptions,
		private readonly clientOptions: GatewayWorkerClientOptions,
		private readonly callbacks: GatewayWorkerClientCallbacks = {},
		private readonly openSocket: (gatewayUrl: string) => WorkerSocket = (gatewayUrl) =>
			new WebSocket(gatewayUrl) as unknown as WorkerSocket,
		private readonly waitBeforeAttempt: (delayMs: number, makeAttempt: () => void) => () => void = (delayMs, makeAttempt) => {
			// The open connection is what keeps this process alive once there is one. While there
			// is none, this timer is the only thing left to wait for, so it is deliberately not
			// unreferenced: the process must stay alive through the wait rather than exiting
			// during it.
			const timer = setTimeout(makeAttempt, delayMs);
			return (): void => {
				clearTimeout(timer);
			};
		},
	) {
	}

	/** Opens the first connection, and every connection after it. */
	start(): void {
		this.connect();
	}

	/**
	 * Stops for good: closes the connection this supervisor holds, and opens no further one.
	 *
	 * This is what Ctrl-C reaches. It is deliberately the only way out, because a worker that is
	 * meant to be left running for hours must not decide on its own that the gateway is not coming
	 * back.
	 */
	stop(): void {
		this.isStopped = true;
		this.cancelWait?.();
		this.cancelWait = undefined;
		this.client?.close();
		this.client = undefined;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Opens one connection to the central gateway and speaks the worker side of it. */
	private connect(): void {
		if (this.isStopped) {
			return;
		}
		let socket: WorkerSocket;
		try {
			socket = this.openSocket(this.supervisorOptions.gatewayUrl);
		} catch (error: unknown) {
			// A gateway address that cannot even be opened — no process listening, a name that does
			// not resolve — throws here rather than reporting a close. Without this the first
			// refused attempt would end the process, which is exactly what this supervisor exists
			// to prevent.
			this.callbacks.onFailure?.(`The connection to the central gateway at ${this.supervisorOptions.gatewayUrl} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleAttempt();
			return;
		}
		this.client = new GatewayWorkerClient(socket, this.clientOptions, {
			...this.callbacks,
			onRegistered: (deviceId: string, stageNames: string[]): void => {
				// Registration is the first moment the connection is known to be usable, rather
				// than merely open, so it is the moment the wait goes back to one second.
				this.backoff.reset();
				this.callbacks.onRegistered?.(deviceId, stageNames);
			},
			onConnectionChange: (isConnected: boolean): void => {
				this.callbacks.onConnectionChange?.(isConnected);
				if (isConnected) {
					return;
				}
				this.client = undefined;
				this.scheduleAttempt();
			},
		});
	}

	/** Waits, and then opens the next connection. */
	private scheduleAttempt(): void {
		if (this.isStopped || this.supervisorOptions.isAutomaticReconnectionEnabled === false) {
			return;
		}
		if (this.cancelWait !== undefined) {
			return;
		}
		const delayMs = this.backoff.nextDelayMs();
		this.callbacks.onNotice?.(`Opening a connection to the central gateway again in ${String(Math.round(delayMs / 1_000))} second(s), attempt ${String(this.backoff.attemptCount)}`);
		this.cancelWait = this.waitBeforeAttempt(delayMs, (): void => {
			this.cancelWait = undefined;
			this.connect();
		});
	}
}
