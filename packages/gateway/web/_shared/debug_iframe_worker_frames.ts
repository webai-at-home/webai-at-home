import { defaultWorkerPort, WorkerPageOrigin } from './worker_page_origin.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DebugIframeWorkerFrames — points every worker inline frame at the address the debug page itself was opened from
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Fills in the address of every worker inline frame on a debug page, from the address that debug
 * page was itself opened from, using [`WorkerPageOrigin`](./worker_page_origin.js).
 *
 * Each frame states only which worker it is and which stages that worker is restricted to, as the
 * `data-worker-name` and `data-enabled-stages` attributes, and this class builds the rest.
 */
export class DebugIframeWorkerFrames {
	/** Points every worker inline frame on this page at the server this page came from. */
	static setup(): void {
		const pageParameters = new URLSearchParams(location.search);
		const workerPort: string = pageParameters.get('workerPort') ?? defaultWorkerPort;
		const workerPageOrigin = WorkerPageOrigin.compute(workerPort);

		const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-worker-name]');
		for (const frame of frames) {
			const frameParameters = new URLSearchParams();
			frameParameters.set('gatewayUrl', location.origin);
			frameParameters.set('workerName', frame.dataset.workerName ?? '');
			const enabledStages: string | undefined = frame.dataset.enabledStages;
			if (enabledStages !== undefined && enabledStages !== '') {
				frameParameters.set('enabledStages', enabledStages);
			}
			// The token the debug page was opened with is handed on, so a gateway started with a
			// token other than its development default still accepts the worker pages in these
			// frames without each frame's address being written out by hand.
			const authToken: string | null = pageParameters.get('authToken');
			if (authToken !== null && authToken !== '') {
				frameParameters.set('authToken', authToken);
			}
			frame.src = `${workerPageOrigin}/?${frameParameters.toString()}`;
		}
	}
}

// Every debug page includes this file as its only script, and none of them has a page script of
// its own to call this from, so it runs itself. A module script is deferred until the document
// has been parsed, so the frames it looks for are already there.
DebugIframeWorkerFrames.setup();
