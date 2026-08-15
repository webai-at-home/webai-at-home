///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayHealthReader — reads the central gateway's `/health` route
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads what the central gateway publishes about itself on its `/health` route.
 *
 * The git commit a gateway was built from is published there and nowhere else: no message of the
 * protocol carries it, so a program that wants to know which build it is talking to reads this
 * route. The route is served by the same server, on the same port, as the WebSocket endpoint every
 * other part of this package connects to, so the address is derived from the WebSocket address
 * rather than configured a second time.
 */
export class GatewayHealthReader {
	/**
	 * Reads the git commit the central gateway was built from.
	 *
	 * A gateway that cannot be reached, answers something else, or was built without being told its
	 * commit is not an error here: knowing which build is running is worth printing when it is
	 * available and worth nothing at all when it is not, and `status` has a worker cluster to report
	 * either way.
	 *
	 * @param gatewayUrl The central gateway's WebSocket address, as `status` was given it.
	 * @param timeoutMs How long to wait for the route to answer before giving up.
	 * @returns The commit, or `undefined` when the gateway did not name one.
	 */
	static async readCommitSha(gatewayUrl: string, timeoutMs: number): Promise<string | undefined> {
		const healthUrl = GatewayHealthReader._healthUrl(gatewayUrl);
		if (healthUrl === undefined) {
			return undefined;
		}
		try {
			const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
			if (response.ok === false) {
				return undefined;
			}
			const health = await response.json() as { commitSha?: unknown };
			if (typeof health.commitSha !== 'string' || health.commitSha === '') {
				return undefined;
			}
			return health.commitSha;
		} catch {
			return undefined;
		}
	}

	/**
	 * Turns the central gateway's WebSocket address into the address of its `/health` route.
	 *
	 * @param gatewayUrl The central gateway's WebSocket address.
	 * @returns The address of the `/health` route, or `undefined` when the given address cannot be
	 * read as a URL.
	 */
	private static _healthUrl(gatewayUrl: string): string | undefined {
		try {
			const url = new URL(gatewayUrl);
			url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
			url.pathname = '/health';
			url.search = '';
			url.hash = '';
			return url.toString();
		} catch {
			return undefined;
		}
	}
}
