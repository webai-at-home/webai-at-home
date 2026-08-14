import type { WebSocket, WebSocketServer } from 'ws';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebsocketHeartbeat — pings every open connection so an idle one is not silently dropped
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Pings every open WebSocket connection on an interval, and closes any connection that did not
 * answer the previous ping.
 *
 * A reverse proxy placed in front of the gateway commonly closes a WebSocket connection that
 * carries no traffic for as little as sixty seconds. A worker with no assignment, a consumer
 * waiting on a task, and a dashboard page that is only watching all send nothing on their own,
 * so without this the connection would eventually be closed out from under them. Sending a ping
 * keeps traffic flowing on every connection regardless of how short a reverse proxy's own idle
 * timeout is set, and a connection that stops answering is recognized as dead and closed instead
 * of being left open and unusable.
 */
export class WebsocketHeartbeat {
	/** Whether each open connection answered the previous ping. */
	private readonly isAliveBySocket = new WeakMap<WebSocket, boolean>();
	/** The repeating timer that sends the next round of pings. */
	private readonly timer: NodeJS.Timeout;

	/**
	 * @param websocketServer The server whose open connections are pinged.
	 * @param intervalMs How often every open connection is pinged.
	 * @param onPong Called with the connection that answered a ping, so that answering a ping
	 * counts as a sign of life for the device on the other end of that connection. Leave it out
	 * when nothing outside this class needs to know.
	 */
	constructor(
		private readonly websocketServer: WebSocketServer,
		intervalMs: number,
		private readonly onPong?: (socket: WebSocket) => void,
	) {
		websocketServer.on('connection', (socket: WebSocket) => {
			this.isAliveBySocket.set(socket, true);
			socket.on('pong', () => {
				this.isAliveBySocket.set(socket, true);
				this.onPong?.(socket);
			});
		});
		this.timer = setInterval(() => this.pingEveryConnection(), intervalMs);
	}

	/** Stops sending pings, so nothing keeps the process running after shutdown. */
	stop(): void {
		clearInterval(this.timer);
	}

	/** Closes every connection that did not answer the previous ping, then pings what remains. */
	private pingEveryConnection(): void {
		for (const socket of this.websocketServer.clients) {
			if (this.isAliveBySocket.get(socket) === false) {
				socket.terminate();
				continue;
			}
			this.isAliveBySocket.set(socket, false);
			socket.ping();
		}
	}
}
