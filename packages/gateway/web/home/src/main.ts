import { Modal } from 'bootstrap';
import { ThemeToggle } from '../../_shared/theme_toggle.js';
import { WorkerPageOrigin } from '../../_shared/worker_page_origin.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HomePage — the gateway's landing page, and the About panel it opens
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Applies the reader's theme and wires the About panel of the gateway home page.
 *
 * The panel names the version number of `@webai/gateway`, baked into the bundle by the `define`
 * option in `vite.config.ts` rather than written into the markup by hand, and the git commit this
 * build was made from, read from the JSON body of the gateway's own `/health` route so the panel
 * names the commit of the server that is actually running rather than the commit the browser
 * bundle was built from. The panel also links to that same `/health` route.
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
		void HomePage.showCommitSha();

		const panel = new Modal(HomePage.element('#about-panel'));
		HomePage.element('#about-open').addEventListener('click', (): void => {
			panel.show();
		});

		WorkerPageOrigin.wireLinks(['#worker-link-nav', '#worker-link-card']);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the git commit this build was made from off the gateway's own `/health` route and writes
	 * it into the About panel.
	 *
	 * @returns Nothing, once the commit has been written into the About panel.
	 */
	private static async showCommitSha(): Promise<void> {
		const element = HomePage.element('#about-commit-sha');
		try {
			const response = await fetch('/health');
			const health = await response.json() as { commitSha?: string; };
			element.textContent = health.commitSha ?? 'unknown';
		} catch {
			element.textContent = 'unknown';
		}
	}

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
}

HomePage.start();
