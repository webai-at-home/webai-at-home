import type { WebSocket, WebSocketServer } from 'ws';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebsocketHeartbeat — pings every open connection so an idle one is not silently dropped
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Pings every open WebSocket connection on an interval, and closes any connection that has not
 * answered for longer than it is allowed to stay silent.
 *
 * A reverse proxy placed in front of the gateway commonly closes a WebSocket connection that
 * carries no traffic for as little as sixty seconds. A worker with no assignment, a consumer
 * waiting on a task, and a dashboard page that is only watching all send nothing on their own,
 * so without this the connection would eventually be closed out from under them. Sending a ping
 * keeps traffic flowing on every connection regardless of how short a reverse proxy's own idle
 * timeout is set, and a connection that stops answering is recognized as dead and closed instead
 * of being left open and unusable.
 *
 * How often a connection is pinged and how long it may stay silent are two separate settings,
 * because they answer two separate questions: how short a reverse proxy's own idle timeout may
 * be, and how quickly a worker that is gone without having said so should be noticed. A single
 * number used to do both jobs, so neither could be changed without changing the other
 * (see https://github.com/webai-at-home/webai-at-home/issues/176).
 */
export class WebsocketHeartbeat {
	/** When each open connection last answered, in milliseconds since the epoch. */
	private readonly lastAnswerAtBySocket = new WeakMap<WebSocket, number>();
	/** The repeating timer that sends the next round of pings. */
	private readonly timer: NodeJS.Timeout;

	/**
	 * @param websocketServer The server whose open connections are pinged.
	 * @param intervalMs How often every open connection is pinged.
	 * @param timeoutMs How long a connection may go without answering before it is terminated.
	 * Measured from the last answer, so it is only ever reached by a connection that answered
	 * nothing in the meantime.
	 * @param onPong Called with the connection that answered a ping, so that answering a ping
	 * counts as a sign of life for the device on the other end of that connection. Leave it out
	 * when nothing outside this class needs to know.
	 */
	constructor(
		private readonly websocketServer: WebSocketServer,
		intervalMs: number,
		private readonly timeoutMs: number,
		private readonly onPong?: (socket: WebSocket) => void,
	) {
		websocketServer.on('connection', (socket: WebSocket) => {
			// A connection that has only just opened has answered nothing yet, so the moment it
			// opened is what it is given credit for. Without this the first sweep would find no
			// answer at all and terminate a connection that is perfectly healthy.
			this.lastAnswerAtBySocket.set(socket, Date.now());
			socket.on('pong', () => {
				this.lastAnswerAtBySocket.set(socket, Date.now());
				this.onPong?.(socket);
			});
		});
		this.timer = setInterval(() => this.pingEveryConnection(), intervalMs);
	}

	/** Stops sending pings, so nothing keeps the process running after shutdown. */
	stop(): void {
		clearInterval(this.timer);
	}

	/** Closes every connection that has been silent for too long, then pings what remains. */
	private pingEveryConnection(): void {
		const now = Date.now();
		for (const socket of this.websocketServer.clients) {
			// A connection this heartbeat never saw open is treated as having just answered, so
			// that it is pinged rather than terminated on the sweep that first meets it.
			const lastAnswerAt = this.lastAnswerAtBySocket.get(socket) ?? now;
			this.lastAnswerAtBySocket.set(socket, lastAnswerAt);
			if (now - lastAnswerAt > this.timeoutMs) {
				socket.terminate();
				continue;
			}
			socket.ping();
		}
	}
}
