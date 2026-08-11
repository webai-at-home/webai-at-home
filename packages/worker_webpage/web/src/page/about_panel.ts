import { Modal } from 'bootstrap';
import { PageElements } from './page_elements.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AboutPanel — the panel naming which build of the worker webpage this browser tab is running
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Fills in and opens the About panel of the worker webpage.
 *
 * The panel names the version number of `@webai/worker-webpage` and the git commit this build was
 * made from, both baked into the bundle by the `define` option in `vite.config.ts` rather than
 * written into the markup by hand, and links to the `/health` route of the central gateway this
 * page is connected to, whose JSON body carries the gateway's own commit. It is a panel that opens
 * over the worker webpage rather than a page of its own, so a volunteer whose browser tab is
 * running a stage never leaves that tab. See
 * [issue #159](https://github.com/webai-at-home/webai-at-home/issues/159).
 */
export class AboutPanel {
	/**
	 * Fills the panel in and wires the navigation bar button that opens it.
	 *
	 * @param gatewayHealthUrl The full address of the `/health` route of the central gateway this page
	 * is connected to.
	 * @throws If the markup no longer has the panel, the button that opens it, or the elements the
	 * panel is filled into.
	 */
	static setup(gatewayHealthUrl: string): void {
		PageElements.getElement('#about-version').textContent = __PACKAGE_VERSION__;
		PageElements.getElement('#about-commit-sha').textContent = __COMMIT_SHA__;
		PageElements.getAnchor('#about-health-link').href = gatewayHealthUrl;

		const panel = new Modal(PageElements.getElement('#about-panel'));
		PageElements.getButton('#about-open').addEventListener('click', (): void => {
			panel.show();
		});
	}
}
