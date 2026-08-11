import { Modal, Toast } from 'bootstrap';
import { PageElements } from './page_elements.js';
import { PageMarkup } from './page_markup.js';
import { StageCatalog } from '../stages/stage_catalog.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StagesConfigPanel — the settings panel a volunteer uses to choose which stages this browser offers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Where the chosen stage names are kept in the browser's local storage. */
const enabledStageNamesStorageKey = 'webai-enabled-stages';

/**
 * Fills in and opens the settings panel that lets a volunteer choose which of this worker
 * webpage's stages get offered to the central gateway.
 *
 * Every stage `StageCatalog` names is shown with a checkbox and a short description, and is
 * enabled by default. The choice is kept in local storage, so it survives a page reload, and it
 * takes effect the next time this browser connects and registers, the same way the page URL's
 * `enabledStages` query parameter already does. It is a panel that opens over the worker webpage
 * rather than a page of its own, following the pattern set by `AboutPanel`.
 */
export class StagesConfigPanel {
	/**
	 * Fills the panel in with one checkbox per catalog stage, and wires the navigation bar button
	 * that opens it, the Enable all and Clear all buttons, and each checkbox to local storage.
	 *
	 * @throws If the markup no longer has the panel, the button that opens it, or the elements the
	 * panel is filled into.
	 */
	static setup(): void {
		const listEl: HTMLElement = PageElements.getElement('#stages-config-list');
		const enabledStageNames: Set<string> = StagesConfigPanel.readEnabledStageNames();
		listEl.innerHTML = StageCatalog.entries.map((entry): string => `
			<div class="form-check mb-3">
				<input class="form-check-input" type="checkbox" id="stages-config-${PageMarkup.escapeHtml(entry.name)}" value="${PageMarkup.escapeHtml(entry.name)}" ${enabledStageNames.has(entry.name) ? 'checked' : ''}>
				<label class="form-check-label" for="stages-config-${PageMarkup.escapeHtml(entry.name)}">
					<span class="d-block fw-semibold">${PageMarkup.escapeHtml(entry.name)}</span>
					<span class="d-block text-secondary small">${PageMarkup.escapeHtml(entry.description)}</span>
				</label>
			</div>
		`).join('');

		const checkboxEls = (): HTMLInputElement[] =>
			[...listEl.querySelectorAll('input[type="checkbox"]')].filter(
				(element): element is HTMLInputElement => element instanceof HTMLInputElement,
			);
		const saveFromCheckboxes = (): void => {
			StagesConfigPanel.writeEnabledStageNames(checkboxEls().filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value));
		};
		listEl.addEventListener('change', saveFromCheckboxes);

		PageElements.getButton('#stages-config-enable-all').addEventListener('click', (): void => {
			for (const checkbox of checkboxEls()) {
				checkbox.checked = true;
			}
			saveFromCheckboxes();
		});
		PageElements.getButton('#stages-config-clear-all').addEventListener('click', (): void => {
			for (const checkbox of checkboxEls()) {
				checkbox.checked = false;
			}
			saveFromCheckboxes();
		});

		const reloadToast = new Toast(PageElements.getElement('#stages-config-reload-toast'));
		const panelEl: HTMLElement = PageElements.getElement('#stages-config-panel');
		const panel = new Modal(panelEl);
		panelEl.addEventListener('hidden.bs.modal', (): void => {
			reloadToast.show();
		});
		PageElements.getButton('#stages-config-open').addEventListener('click', (): void => {
			panel.show();
		});
	}

	/**
	 * Reads which stages this browser currently offers, from local storage.
	 *
	 * @returns The enabled stage names. Every stage `StageCatalog` names, when nothing has been
	 * stored yet, when storage cannot be read, or when the stored value is not a list of strings.
	 */
	static getEnabledStageNames(): string[] {
		return [...StagesConfigPanel.readEnabledStageNames()];
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Reads the stage names stored in local storage, defaulting to every catalog stage. */
	private static readEnabledStageNames(): Set<string> {
		try {
			const storedValue: string | null = window.localStorage.getItem(enabledStageNamesStorageKey);
			if (storedValue === null) {
				return new Set(StageCatalog.entries.map((entry) => entry.name));
			}
			const storedNames: unknown = JSON.parse(storedValue);
			if (Array.isArray(storedNames) === false || storedNames.some((name) => typeof name !== 'string')) {
				return new Set(StageCatalog.entries.map((entry) => entry.name));
			}
			return new Set(storedNames as string[]);
		} catch {
			return new Set(StageCatalog.entries.map((entry) => entry.name));
		}
	}

	/**
	 * Writes the chosen stage names to local storage.
	 *
	 * @param stageNames The stage names to enable.
	 */
	private static writeEnabledStageNames(stageNames: string[]): void {
		try {
			window.localStorage.setItem(enabledStageNamesStorageKey, JSON.stringify(stageNames));
		} catch {
			// The chosen stages still apply to this page for the rest of the session when storage is unavailable.
		}
	}
}
