import type Http from 'node:http';
import { ClientEnvelopeSchema, protocolVersion, supportedProtocolVersions } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import type { MessageLogger } from '@webai/protocol/message_logger';
import type { WebSocket } from 'ws';
import type { ChallengeRegistry } from '../accounting/challenge_registry.js';
import type { ClientMessageHandler } from '../task/client_message_handler.js';
import { ClientIpAddress } from './client_ip_address.js';
import type { ConnectionHub } from './connection_hub.js';
import type { DeviceAnnouncer } from '../device/device_announcer.js';
import type { DeviceRegistry } from '../device/device_registry.js';
import type { DiagnosticsRateLimiter } from '../libs/diagnostics_rate_limiter.js';
import type { SessionRegistry } from '../task/session_registry.js';
import type { TaskScheduler } from '../task/task_scheduler.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebsocketRouter — checks every arriving frame before anything acts on it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The largest frame the gateway will read.
 *
 * A language-model hand-off tensor is the largest thing a worker legitimately sends, and this
 * leaves room for one while still refusing a frame that could only be a mistake or an attack.
 */
const maximumInboundMessageBytes = 8_500_000;

/**
 * Takes each new connection, checks every frame that arrives on it, and cleans up after it.
 *
 * Nothing reaches the message handler until the frame has been parsed, matched against the
 * protocol wrapper, and confirmed to speak a protocol version this gateway supports. A
 * connection that closes is forgotten here, and any work it was holding is handed back to the
 * scheduler.
 */
export class WebsocketRouter {
	/**
	 * @param hub The open connections.
	 * @param handler The handler each valid message is passed to.
	 * @param scheduler The scheduler told to recover a disconnected worker's assignments.
	 * @param announcer The announcer of the device's departure.
	 * @param deviceRegistry The registry the departing device is removed from.
	 * @param sessionRegistry The sessions the closed connection's session is removed from.
	 * @param diagnosticsRateLimiter The limiter that forgets the departed device.
	 * @param gatewayMessageLogger The log of this gateway's own message traffic.
	 * @param challengeRegistry The account challenges the closed connection's outstanding one is
	 * removed from.
	 * @param isReverseProxyTrusted Whether this gateway sits behind a reverse proxy whose
	 * `x-forwarded-for` header may be believed when reading the address a connection came from.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly handler: ClientMessageHandler,
		private readonly scheduler: TaskScheduler,
		private readonly announcer: DeviceAnnouncer,
		private readonly deviceRegistry: DeviceRegistry,
		private readonly sessionRegistry: SessionRegistry,
		private readonly diagnosticsRateLimiter: DiagnosticsRateLimiter,
		private readonly gatewayMessageLogger: MessageLogger,
		private readonly challengeRegistry: ChallengeRegistry,
		private readonly isReverseProxyTrusted: boolean = false,
	) { }

	/** Whether the notice about an unnoticed reverse proxy has already been printed. */
	private hasReportedUnnoticedReverseProxy = false;

	/**
	 * Takes on one newly opened connection.
	 *
	 * The address the connection came from is read here and nowhere else, because this is the one
	 * moment the HTTP request that carried the WebSocket upgrade is still available.
	 *
	 * @param socket The connection that just opened.
	 * @param request The HTTP request that carried the WebSocket upgrade.
	 */
	acceptConnection(socket: WebSocket, request: Http.IncomingMessage): void {
		const deviceId = `device-${crypto.randomUUID()}`;
		this.hub.socketMap.set(deviceId, socket);
		const ipAddress = ClientIpAddress.fromRequest(request, this.isReverseProxyTrusted);
		if (ipAddress !== undefined) {
			this.hub.ipAddressMap.set(deviceId, ipAddress);
		}
		// Said once per run rather than once per connection, because it describes how this gateway
		// was started and not anything about the connection that happened to reveal it.
		if (this.hasReportedUnnoticedReverseProxy === false && ClientIpAddress.isReverseProxyUnnoticed(request, this.isReverseProxyTrusted) === true) {
			this.hasReportedUnnoticedReverseProxy = true;
			console.log(
				`Note: a connection arrived carrying an x-forwarded-for header, so a reverse proxy sits in front of this gateway, `
					+ `and every device is being recorded at the address of that proxy (${ipAddress ?? 'none'}) rather than its own. `
					+ 'Start this gateway with --trust-reverse-proxy to record the address each device connected from.',
			);
		}
		socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
			this.readFrame(socket, deviceId, raw);
		});
		socket.on('close', () => {
			this.hub.forget(deviceId);
			this.sessionRegistry.close(deviceId);
			this.challengeRegistry.close(deviceId);
			this.diagnosticsRateLimiter.forget(deviceId);
			// "device.left" already tells subscribers exactly what changed, so the full device
			// list is not sent as well.
			this.announcer.publishDevice(this.deviceRegistry.remove(deviceId));
			this.scheduler.recoverWorkerAssignments(deviceId);
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Frame Checking
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Checks one arriving frame and passes the message inside it on when it is sound.
	 *
	 * @param socket The connection the frame arrived on.
	 * @param deviceId The identifier assigned to that connection.
	 * @param raw The frame as it arrived.
	 */
	private readFrame(socket: WebSocket, deviceId: string, raw: Buffer | ArrayBuffer | Buffer[]): void {
		const rawBuffer = Array.isArray(raw)
			? Buffer.concat(raw)
			: raw instanceof ArrayBuffer
				? Buffer.from(new Uint8Array(raw))
				: raw;
		if (rawBuffer.length > maximumInboundMessageBytes) {
			this.hub.send(socket, { type: 'error', code: 'MESSAGE_TOO_LARGE', message: 'Message exceeds the maximum allowed size' }, this.hub.counterpartFor(deviceId));
			return;
		}
		try {
			const received: unknown = JSON.parse(rawBuffer.toString());
			// A peer built before the wrapper existed sends the message on its own. Say what is
			// now required and which versions are accepted, instead of a bare complaint that
			// the message did not validate.
			if (Envelope.isUnwrappedMessage(received)) {
				this.hub.send(socket, { type: 'error', code: 'UNSUPPORTED', message: `This gateway speaks protocol version ${protocolVersion}, in which every message travels inside a wrapper carrying v, id, ts, and body`, details: { supportedProtocolVersions } }, this.hub.counterpartFor(deviceId));
				return;
			}
			const parsed = ClientEnvelopeSchema.safeParse(received);
			if (parsed.success === false) {
				this.hub.send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message does not match the supported protocol' }, this.hub.counterpartFor(deviceId));
				return;
			}
			const frame = parsed.data;
			// The version is checked on every frame, which means it is checked on "authenticate",
			// the first frame a connection sends. A peer therefore learns straight away whether
			// it can talk to this gateway.
			if (Envelope.supportsVersion(frame.v) === false) {
				this.hub.sendError(socket, frame.id, this.hub.counterpartFor(deviceId), 'UNSUPPORTED', `This gateway does not speak protocol version ${frame.v}`, { retryable: false, details: { supportedProtocolVersions } });
				return;
			}
			const message = frame.body;
			if (message.type !== 'observe') this.gatewayMessageLogger.log('received', this.hub.counterpartFor(deviceId, message), message.type, message, frame.ts, frame);
			this.handler.handle(socket, deviceId, message, frame.id);
		} catch {
			this.hub.send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message is not valid JSON' }, this.hub.counterpartFor(deviceId));
		}
	}
}
