import Path from 'node:path';
import type { WebSocket } from 'ws';
import type { ClientMessage, GatewayMessage } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { MessageLogger, type LogCounterpart } from '@webai/protocol/message_logger';
import type { DeviceRegistry } from '../device/device_registry.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConnectionHub — holds every open connection and sends gateway messages over them
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The error codes a gateway error message may carry. */
type ErrorCode = Extract<GatewayMessage, { type: 'error' }>['code'];

/** What an error message may say beyond its code and text. */
type ErrorOptions = {
	taskId?: string;
	taskRequestId?: string;
	details?: Record<string, unknown>;
	retryable?: boolean;
};

/**
 * Holds the open connections and is the only place a gateway message is written to one.
 *
 * Every message sent from here is logged as it goes out, so the gateway's own log is a
 * complete record of what it said and to whom. Which connections asked for device membership,
 * which are observers, and which are watching a particular task are also kept here, because
 * they all describe the connections themselves rather than the work being scheduled.
 */
export class ConnectionHub {
	/** The open connection for each connected device. */
	readonly socketMap = new Map<string, WebSocket>();
	/** The connections that connected as observers of the whole cluster. */
	readonly observerDeviceIds = new Set<string>();
	/**
	 * The connections that asked for device membership.
	 *
	 * Device membership is opt-in. A connection receives `devices`, `device.joined`,
	 * `device.updated`, `device.activity`, and `device.left` only after asking for them with
	 * `devices.subscribe`, or by connecting as an observer. Workers and consumers never ask,
	 * so a cluster with no dashboard attached exchanges no device membership messages at all.
	 */
	readonly deviceSubscriberIds = new Set<string>();
	/** The connections watching each task, by task identifier. */
	readonly taskObserverDeviceIds = new Map<string, Set<string>>();

	/** One log file per connected worker, relayed to the gateway since a page cannot write files. */
	private readonly workerMessageLoggers = new Map<string, MessageLogger>();

	/**
	 * @param deviceRegistry The registry the role of a connection is read from.
	 * @param gatewayMessageLogger The log of this gateway's own message traffic.
	 * @param logsDirectory Where a connected worker's relayed log file is written.
	 */
	constructor(
		private readonly deviceRegistry: DeviceRegistry,
		private readonly gatewayMessageLogger: MessageLogger,
		private readonly logsDirectory: string,
	) { }

	/**
	 * Finds which device a connection belongs to.
	 *
	 * @param socket The connection to look up.
	 * @returns The device identifier registered for that connection, or `undefined` when the
	 * connection has not registered a device identifier yet.
	 */
	deviceIdForSocket(socket: WebSocket): string | undefined {
		for (const [deviceId, registeredSocket] of this.socketMap) {
			if (registeredSocket === socket) return deviceId;
		}
		return undefined;
	}

	/**
	 * Sends a gateway message when a WebSocket is still open, and logs it as sent.
	 *
	 * @param socket The WebSocket that should receive the message.
	 * @param message The gateway message to serialize and send.
	 * @param counterpart Who the message is being sent to.
	 * @param inReplyToMessageId The identifier of the client request this message answers. Leave
	 * it out for a message the gateway pushes on its own initiative; that absence is what tells a
	 * client the message is a push rather than an answer.
	 */
	send(socket: WebSocket, message: GatewayMessage, counterpart: LogCounterpart, inReplyToMessageId?: string): void {
		const frame = Envelope.fromGateway(message, inReplyToMessageId);
		if ([...this.observerDeviceIds].some((deviceId): boolean => this.socketMap.get(deviceId) === socket) === false) {
			this.gatewayMessageLogger.log('sent', counterpart, message.type, message, frame.ts, frame);
		}
		if (socket.readyState === socket.OPEN) {
			socket.send(JSON.stringify(frame));
		}
	}

	/**
	 * Sends a stable, machine-readable error.
	 *
	 * An error is always an answer to something, so it echoes the identifier of the request that
	 * caused it whenever that request is known.
	 *
	 * @param socket The connection to answer.
	 * @param inReplyToMessageId The identifier of the request that caused the error, when it is
	 * known.
	 * @param counterpart Who the error is being sent to.
	 * @param code The stable error code.
	 * @param message The description to send with it.
	 * @param options What the error may say beyond its code and text.
	 */
	sendError(socket: WebSocket, inReplyToMessageId: string | undefined, counterpart: LogCounterpart, code: ErrorCode, message: string, options: ErrorOptions = {}): void {
		this.send(socket, {
			type: 'error',
			code,
			message,
			retryable: options.retryable ?? false,
			...(options.taskId === undefined ? {} : { taskId: options.taskId }),
			...(options.taskRequestId === undefined ? {} : { taskRequestId: options.taskRequestId }),
			...(options.details === undefined ? {} : { details: options.details }),
		}, counterpart, inReplyToMessageId);
	}

	/**
	 * Sends a gateway message to the connections that asked for device membership.
	 *
	 * @param message The gateway message to send.
	 */
	sendToDeviceSubscribers(message: GatewayMessage): void {
		for (const deviceId of this.deviceSubscriberIds) {
			const socket = this.socketMap.get(deviceId);
			if (socket !== undefined) this.send(socket, message, this.counterpartFor(deviceId));
		}
	}

	/**
	 * Resolves the role and device identifier to log for a connected device, from this
	 * gateway's own point of view.
	 *
	 * @param deviceId The device identifier assigned to the WebSocket connection.
	 * @param registerMessage The client's own `deviceRegister` message, when this is being
	 * resolved for that message itself, before the device has been added to the registry.
	 * @returns The counterpart to record in a log entry.
	 */
	counterpartFor(deviceId: string, registerMessage?: ClientMessage): LogCounterpart {
		if (registerMessage?.type === 'deviceRegister') return { role: registerMessage.role, deviceId };
		if (this.observerDeviceIds.has(deviceId)) return { role: 'observer', deviceId };
		const device = this.deviceRegistry.get(deviceId);
		return { role: device?.deviceRole ?? 'unknown', deviceId };
	}

	/**
	 * Returns the log file for a connected worker's relayed message log, creating it on
	 * first use.
	 *
	 * @param deviceId The worker device identifier.
	 * @returns The message logger that appends to that worker's own log file.
	 */
	workerMessageLogger(deviceId: string): MessageLogger {
		let logger = this.workerMessageLoggers.get(deviceId);
		if (logger === undefined) {
			logger = new MessageLogger(Path.join(this.logsDirectory, `worker-${deviceId}.log_entry.jsonl`));
			this.workerMessageLoggers.set(deviceId, logger);
		}
		return logger;
	}

	/**
	 * Forgets everything held for a connection that has closed.
	 *
	 * @param deviceId The device whose connection closed.
	 */
	forget(deviceId: string): void {
		this.socketMap.delete(deviceId);
		this.observerDeviceIds.delete(deviceId);
		this.deviceSubscriberIds.delete(deviceId);
		for (const observers of this.taskObserverDeviceIds.values()) observers.delete(deviceId);
	}
}
