import type { AccountSummaryRow } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { SessionRenewal } from '@webai/protocol/session_renewal';
import { ThemeToggle } from '../../_shared/theme_toggle.js';
import { WorkerPageOrigin } from '../../_shared/worker_page_origin.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LedgerPage — the gateway's ledger page: what every account has earned and spent
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The fields this page reads from the messages the central gateway sends it. */
type GatewayMessage = {
	type: string;
	/** One row per account, on `accounting.summaries`. */
	summaries?: AccountSummaryRow[];
	/** When the authenticated session expires, in reply to `deviceAuthenticate`. */
	expiresAt?: string;
	/** The error code, on an error. */
	code?: string;
	/** What the gateway said, on an error. */
	message?: string;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Page Settings
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The bearer token this page presents to the central gateway. It matches the gateway's own
 * `--auth-token` default, the same way the monitor page and the worker browser page do.
 */
const gatewayAuthenticationToken = 'development-token';

/**
 * How often this page asks the gateway what every account holds.
 *
 * Balances are asked for rather than pushed. The gateway announces a device joining or leaving
 * because a reader is watching for exactly that, while a balance changes on every completed stage —
 * three times per generated token on the sharded language-model pipeline — and pushing each one to
 * every open ledger page would be a great deal of traffic to draw a number that a person reads a few
 * times a minute. Asking on a timer costs one small message per interval, whatever the cluster does.
 */
const summaryPollIntervalMs = 3_000;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Ledger Page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Shows what every account on this gateway has earned and spent.
 *
 * It connects as an observer, which is the one connection the gateway answers
 * `accounting.summaries.get` for: every other accounting message is answered for the asking
 * connection's own account and no other. This page is therefore the operator's view, and there is no
 * way for a participant to reach anybody else's balance through it.
 */
export class LedgerPage {
	/** Builds the page and connects it to the central gateway. */
	static start(): void {
		ThemeToggle.setup();
		WorkerPageOrigin.wireLinks(['#worker-link-nav']);
		const statusEl = LedgerPage.element('#status');
		const statusBadgeEl = LedgerPage.element('#status-badge');
		const accountsEl = LedgerPage.element('#accounts');
		const totalEarnedEl = LedgerPage.element('#total-earned');
		const totalSpentEl = LedgerPage.element('#total-spent');
		const accountCountEl = LedgerPage.element('#account-count');

		/**
		 * Draws every account, and the three totals above the table.
		 *
		 * @param summaries One row per account, as the gateway ordered them.
		 */
		const render = (summaries: AccountSummaryRow[]): void => {
			const totalEarned = summaries.reduce((running, row) => running + row.earnedStageCount, 0);
			const totalSpent = summaries.reduce((running, row) => running + row.spentStageCount, 0);
			totalEarnedEl.textContent = String(totalEarned);
			totalSpentEl.textContent = String(totalSpent);
			accountCountEl.textContent = String(summaries.length);
			accountsEl.innerHTML = summaries.length === 0
				? '<p class="text-secondary mb-0">No account has earned or spent anything yet.</p>'
				: summaries.map((row) => LedgerPage.accountMarkup(row)).join('');
		};

		const socketEl: WebSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
		/** Whether this page has already asked to observe on the current connection. */
		let isObserving = false;
		/** The pending timer that authenticates again before the current session expires. */
		let sessionRenewalTimer: number | undefined;
		/** The repeating timer that asks what every account holds. */
		let summaryPollTimer: number | undefined;

		/**
		 * Authenticates again before the current session runs out, so this page keeps working for as
		 * long as it stays open.
		 *
		 * @param expiresAt When the current session expires, as the gateway stated it.
		 */
		const scheduleSessionRenewal = (expiresAt: string | undefined): void => {
			if (sessionRenewalTimer !== undefined) window.clearTimeout(sessionRenewalTimer);
			if (expiresAt === undefined) return;
			sessionRenewalTimer = window.setTimeout((): void => {
				if (socketEl.readyState !== WebSocket.OPEN) return;
				socketEl.send(JSON.stringify(Envelope.fromClient({ type: 'deviceAuthenticate', token: gatewayAuthenticationToken })));
			}, SessionRenewal.renewAfterMs(expiresAt));
		};

		/** Asks the gateway what every account holds, now and every interval after this. */
		const startAskingForSummaries = (): void => {
			const ask = (): void => {
				if (socketEl.readyState !== WebSocket.OPEN) return;
				socketEl.send(JSON.stringify(Envelope.fromClient({ type: 'accounting.summaries.get' })));
			};
			ask();
			summaryPollTimer = window.setInterval(ask, summaryPollIntervalMs);
		};

		socketEl.addEventListener('open', (): void => {
			socketEl.send(JSON.stringify(Envelope.fromClient({ type: 'deviceAuthenticate', token: gatewayAuthenticationToken })));
			statusEl.textContent = 'Authenticating with the central gateway.';
			statusBadgeEl.textContent = 'Authenticating';
			statusBadgeEl.className = 'badge rounded-pill text-bg-warning';
		});

		socketEl.addEventListener('message', (event: MessageEvent): void => {
			const frame = JSON.parse(event.data as string) as { body?: GatewayMessage };
			const message = frame.body;
			if (message === undefined) return;
			if (message.type === 'deviceAuthenticated') {
				statusEl.textContent = 'Connected to the central gateway.';
				statusBadgeEl.textContent = 'Connected';
				statusBadgeEl.className = 'badge rounded-pill text-bg-success';
				scheduleSessionRenewal(message.expiresAt);
				// A renewal is answered with "deviceAuthenticated" too, and must not start observing or
				// asking a second time.
				if (isObserving === false) {
					isObserving = true;
					socketEl.send(JSON.stringify(Envelope.fromClient({ type: 'observe' })));
					startAskingForSummaries();
				}
				return;
			}
			if (message.type === 'accounting.summaries' && message.summaries !== undefined) {
				render(message.summaries);
				return;
			}
			if (message.type === 'error') {
				statusEl.textContent = `The central gateway refused this page: ${message.message ?? 'no reason given'}`;
				statusBadgeEl.textContent = message.code ?? 'Refused';
				statusBadgeEl.className = 'badge rounded-pill text-bg-danger';
			}
		});

		socketEl.addEventListener('close', (): void => {
			if (sessionRenewalTimer !== undefined) window.clearTimeout(sessionRenewalTimer);
			if (summaryPollTimer !== undefined) window.clearInterval(summaryPollTimer);
			statusEl.textContent = 'The connection to the central gateway closed.';
			statusBadgeEl.textContent = 'Disconnected';
			statusBadgeEl.className = 'badge rounded-pill text-bg-danger';
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Drawing
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds one row of the account table.
	 *
	 * @param row One account's summary, joined with what its profile says.
	 * @returns The markup for that row.
	 */
	private static accountMarkup(row: AccountSummaryRow): string {
		const balance = `${row.balance > 0 ? '+' : ''}${String(row.balance)}`;
		const balanceClass = row.balance > 0 ? 'text-success' : row.balance < 0 ? 'text-danger' : 'text-secondary';
		// The shared development account is what work by a participant holding no account of its own is
		// recorded against, so it is named for what it is rather than left looking like a volunteer.
		const name = row.accountId === 'account-shared-development'
			? 'Work by participants with no account of their own'
			: row.displayName === '' ? 'No display name' : row.displayName;
		const registered = row.createdAt === undefined ? 'Never registered a profile' : `Registered ${LedgerPage.escapeHtml(row.createdAt)}`;
		return `<div class="account-item d-flex justify-content-between align-items-start gap-3">
			<div class="flex-grow-1">
				<div class="fw-semibold">${LedgerPage.escapeHtml(name)}</div>
				<div class="account-identifier text-secondary">${LedgerPage.escapeHtml(row.accountId)}</div>
				<div class="small text-secondary">${row.earnedStageCount} stage${row.earnedStageCount === 1 ? '' : 's'} completed · ${row.spentStageCount} run · ${registered}</div>
			</div>
			<div class="account-balance fs-4 ${balanceClass}">${LedgerPage.escapeHtml(balance)}</div>
		</div>`;
	}

	/**
	 * Finds an element this page is built around.
	 *
	 * @param selector The CSS selector for the element.
	 * @returns The matching element.
	 * @throws If the markup no longer has that element.
	 */
	private static element(selector: string): HTMLElement {
		const element = document.querySelector(selector);
		if ((element instanceof HTMLElement) === false) throw new Error(`Element ${selector} was not found`);
		return element;
	}

	/**
	 * Escapes text that came from the gateway, so a display name cannot carry markup into this page.
	 *
	 * @param value The text to escape.
	 * @returns The text, safe to place in markup.
	 */
	private static escapeHtml(value: string): string {
		return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
	}
}

LedgerPage.start();
