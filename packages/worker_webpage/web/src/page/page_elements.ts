///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PageElements — finds the elements a page needs, and says plainly when one is missing
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Looks up the elements a page is built around.
 *
 * Each lookup insists on the kind of element the page expects, so a page whose markup has
 * drifted away from its script fails immediately with the selector that no longer matches,
 * rather than much later with a message about a missing property.
 */
export class PageElements {
	/**
	 * Finds a required HTML element.
	 *
	 * @param selector CSS selector for the required element.
	 * @returns The matching HTML element.
	 * @throws If the selector does not match an HTML element.
	 */
	static getElement(selector: string): HTMLElement {
		const element: Element | null = document.querySelector(selector);
		if ((element instanceof HTMLElement) === false) {
			throw new Error(`Element ${selector} was not found`);
		}
		return element;
	}

	/**
	 * Finds a required HTML input element.
	 *
	 * @param selector CSS selector for the required input element.
	 * @returns The matching HTML input element.
	 * @throws If the selector does not match an HTML input element.
	 */
	static getInput(selector: string): HTMLInputElement {
		const element: Element | null = document.querySelector(selector);
		if ((element instanceof HTMLInputElement) === false) {
			throw new Error(`Input ${selector} was not found`);
		}
		return element;
	}

	/**
	 * Finds a required HTML button element.
	 *
	 * @param selector CSS selector for the required button element.
	 * @returns The matching HTML button element.
	 * @throws If the selector does not match an HTML button element.
	 */
	static getButton(selector: string): HTMLButtonElement {
		const element: Element | null = document.querySelector(selector);
		if ((element instanceof HTMLButtonElement) === false) {
			throw new Error(`Button ${selector} was not found`);
		}
		return element;
	}

	/**
	 * Finds a required HTML anchor element.
	 *
	 * @param selector CSS selector for the required anchor element.
	 * @returns The matching HTML anchor element.
	 * @throws If the selector does not match an HTML anchor element.
	 */
	static getAnchor(selector: string): HTMLAnchorElement {
		const element: Element | null = document.querySelector(selector);
		if ((element instanceof HTMLAnchorElement) === false) {
			throw new Error(`Anchor ${selector} was not found`);
		}
		return element;
	}
}
