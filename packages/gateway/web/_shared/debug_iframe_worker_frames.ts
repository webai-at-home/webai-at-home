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
 *
 * `data-enabled-stages` may name several stages, separated by spaces or by commas. Each one becomes
 * its own `enabledStages` query parameter, because that is the shape
 * `WorkerStageOffer.requestedStageNamesFromUrl` reads: it collects every occurrence of the
 * parameter and never splits one occurrence apart. A frame that names no stage at all is
 * unrestricted and offers every stage whose computation the worker page implements.
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
			const enabledStagesStr: string | undefined = frame.dataset.enabledStages;
			for (const stageName of DebugIframeWorkerFrames._splitStageNames(enabledStagesStr)) {
				frameParameters.append('enabledStages', stageName);
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

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the stage names out of one `data-enabled-stages` attribute value.
	 *
	 * @param enabledStagesStr The attribute value, with its stage names separated by spaces or by
	 * commas, or absent when the frame names no stage at all.
	 * @returns One entry per stage name, in the order written, and nothing at all when the
	 * attribute is absent or holds only separators.
	 */
	private static _splitStageNames(enabledStagesStr: string | undefined): string[] {
		if (enabledStagesStr === undefined) {
			return [];
		}
		return enabledStagesStr.split(/[\s,]+/).filter((stageName) => stageName !== '');
	}
}

// Every debug page includes this file as its only script, and none of them has a page script of
// its own to call this from, so it runs itself. A module script is deferred until the document
// has been parsed, so the frames it looks for are already there.
DebugIframeWorkerFrames.setup();
