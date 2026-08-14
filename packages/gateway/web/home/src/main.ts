import { Modal } from 'bootstrap';
import { ThemeToggle } from '../../_shared/theme_toggle.js';
import { defaultWorkerPort, WorkerPageOrigin } from '../../_shared/worker_page_origin.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HomePage — the gateway's landing page, and the About panel it opens
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Applies the reader's theme and wires the About panel of the gateway home page.
 *
 * The panel names the version number of `@webai/gateway`, baked into the bundle by the `define`
 * option in `vite.config.ts` rather than written into the markup by hand, and links to the
 * gateway's own `/health` route, whose JSON body carries the git commit this build was made from.
 * It is a panel that opens over the home page rather than a page of its own, the same way the
 * worker webpage shows its own build. See
 * [issue #159](https://github.com/webai-at-home/webai-at-home/issues/159).
 */
export class HomePage {
	/**
	 * Starts the page.
	 *
	 * @throws If the markup no longer has the About panel, the button that opens it, or the element
	 * the version number is written into.
	 */
	static start(): void {
		ThemeToggle.setup();
		HomePage.element('#about-version').textContent = __PACKAGE_VERSION__;

		const panel = new Modal(HomePage.element('#about-panel'));
		HomePage.element('#about-open').addEventListener('click', (): void => {
			panel.show();
		});

		HomePage.wireWorkerLinks();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Finds one element this page is built around.
	 *
	 * @param selector CSS selector for the required element.
	 * @returns The matching HTML element.
	 * @throws If the markup no longer has that element.
	 */
	private static element(selector: string): HTMLElement {
		const element = document.querySelector(selector);
		if ((element instanceof HTMLElement) === false) throw new Error(`Element ${selector} was not found`);
		return element;
	}

	/**
	 * Points the navigation bar's and the card's Worker links at the worker webpage, connected back
	 * to this gateway.
	 *
	 * The address cannot be written into the markup, because the worker webpage is only reachable
	 * at `localhost` when the whole cluster runs on the reader's own machine; see
	 * [`WorkerPageOrigin`](../../_shared/worker_page_origin.js) for the deployed exception.
	 *
	 * @throws If the markup no longer has either Worker link.
	 */
	private static wireWorkerLinks(): void {
		const workerPageOrigin = WorkerPageOrigin.compute(defaultWorkerPort);
		const workerPageUrl = `${workerPageOrigin}/?${new URLSearchParams({ gatewayUrl: location.origin }).toString()}`;

		for (const linkId of ['#worker-link-nav', '#worker-link-card']) {
			(HomePage.element(linkId) as HTMLAnchorElement).href = workerPageUrl;
		}
	}
}

HomePage.start();
