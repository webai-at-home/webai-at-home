///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerPageOrigin — the address the worker webpage is reachable at, from wherever the calling page was opened
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The port the built worker browser page is served on, matching the `WORKER_PORT` default in
 * `packages/docker_server`. A caller reading a `?workerPort=` query parameter uses that port
 * instead.
 */
export const defaultWorkerPort = '8789';

/**
 * Works out the origin the worker webpage is reachable at, from the address the calling page was
 * itself opened from.
 *
 * The origin cannot be written into the HTML, because the worker webpage and the central gateway
 * are only reachable at `localhost` when the whole cluster runs on the reader's own machine. A
 * page opened from a deployed server, at `http://135.125.8.186:8787` for one, has to point at that
 * same server instead, or the reader's own browser looks for a worker webpage on the reader's own
 * machine and finds none. A page opened from `https://webai-gateway.dash-menu.com` is a further
 * exception: there, the worker webpage is not the same host on a different port, but a different
 * host entirely, `https://webai-worker.dash-menu.com`, on the default HTTPS port.
 */
export class WorkerPageOrigin {
	/**
	 * @param workerPort The port the worker webpage is served on, when it is reachable at the
	 * calling page's own hostname rather than at `webai-gateway.dash-menu.com`'s dedicated worker
	 * host.
	 * @returns The origin the worker webpage is reachable at.
	 */
	static compute(workerPort: string): string {
		return location.hostname === 'webai-gateway.dash-menu.com'
			? 'https://webai-worker.dash-menu.com'
			: `${location.protocol}//${location.hostname}:${workerPort}`;
	}

	/**
	 * Points every given link at the worker webpage, connected back to the gateway the calling page
	 * was itself opened from.
	 *
	 * The `?gatewayUrl=` query parameter is left out when the calling page's own origin is already
	 * the gateway the worker webpage picks by itself, so the link stays short and readable.
	 *
	 * @param selectors The CSS selector for each anchor element to point at the worker webpage.
	 * @throws If the markup does not have an anchor element for every one of the given selectors.
	 */
	static wireLinks(selectors: string[]): void {
		const workerPageOrigin = WorkerPageOrigin.compute(defaultWorkerPort);
		const defaultGatewayUrl = WorkerPageOrigin._defaultGatewayUrlOf(workerPageOrigin);
		const isDefaultGateway = new URL(location.origin).toString() === new URL(defaultGatewayUrl).toString();
		const workerPageUrl = isDefaultGateway
			? `${workerPageOrigin}/`
			: `${workerPageOrigin}/?${new URLSearchParams({ gatewayUrl: location.origin }).toString()}`;
		for (const selector of selectors) {
			const element = document.querySelector(selector);
			if ((element instanceof HTMLAnchorElement) === false) throw new Error(`Element ${selector} was not found`);
			element.href = workerPageUrl;
		}
	}

	/**
	 * The central gateway the worker webpage connects to when no `?gatewayUrl=` query parameter is
	 * given, mirroring `GatewayConfig` in `packages/worker_webpage`: the local gateway when the
	 * worker webpage itself runs on `localhost`, otherwise the deployed gateway.
	 *
	 * @param workerPageOrigin The origin the worker webpage is served from.
	 * @returns The gateway URL the worker webpage defaults to at that origin.
	 */
	static _defaultGatewayUrlOf(workerPageOrigin: string): string {
		return new URL(workerPageOrigin).hostname === 'localhost'
			? 'http://localhost:8787'
			: 'https://webai-gateway.dash-menu.com';
	}
}
