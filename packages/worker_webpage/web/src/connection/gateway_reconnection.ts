import { ReconnectBackoff } from '@webai/protocol/reconnect_backoff';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayReconnection — waits, counts down, and opens the connection again
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How often the seconds left before the next attempt are reported to the page. */
const COUNTDOWN_INTERVAL_MS = 1_000;

/** What this holder tells the page as it waits and as it tries again. */
export type GatewayReconnectionCallbacks = {
	/**
	 * Called while the page is waiting, once when the wait is scheduled and once a second after
	 * that, so the volunteer sees a page that is working rather than a page that looks broken.
	 *
	 * @param secondsRemaining How many whole seconds are left before the next attempt.
	 * @param attemptNumber Which attempt is being waited for, counted from one.
	 */
	onWaiting: (secondsRemaining: number, attemptNumber: number) => void;
	/**
	 * Called when the wait is over and the page should open a connection again.
	 *
	 * @param attemptNumber Which attempt this is, counted from one.
	 */
	onAttempt: (attemptNumber: number) => void;
};

/**
 * Opens the connection to the central gateway again after it was lost, waiting longer each time.
 *
 * A gateway that goes away — a deployment, a container restart, a network interruption — used to
 * leave every worker browser tab disconnected for good, so one deployment emptied the whole
 * cluster of volunteers. This holder is what makes a worker browser tab come back on its own. It
 * owns the wait between attempts, the countdown the page shows while it waits, and nothing else:
 * whether the page should be connecting at all is decided by the page, which starts and stops
 * this holder.
 *
 * The wait itself comes from `ReconnectBackoff` in `@webai/protocol`, shared with the worker in
 * `packages/worker_openai` and the OpenAI-compatible server in `packages/consumer_openai`, so all
 * three lean on one gateway in the same way. See
 * https://github.com/webai-at-home/webai-at-home/issues/158.
 */
export class GatewayReconnection {
	/** How long to wait before each attempt, and the rule that grows that wait. */
	private readonly backoff = new ReconnectBackoff();
	/** The pending timer that makes the next attempt, when the page is waiting. */
	private waitTimer: number | undefined;
	/** The pending timer that reports the seconds left, when the page is waiting. */
	private countdownTimer: number | undefined;
	/** When the pending attempt is due, as a `Date.now()` value, when the page is waiting. */
	private attemptDueAtMs = 0;
	/** Which attempt the pending wait is for, counted from one. */
	private attemptNumber = 0;

	/**
	 * @param callbacks What to tell the page as this holder waits and as it tries again.
	 */
	constructor(private readonly callbacks: GatewayReconnectionCallbacks) {
	}

	/** Whether an attempt is scheduled and being waited for right now. */
	get isWaiting(): boolean {
		return this.waitTimer !== undefined;
	}

	/**
	 * Waits, and then asks the page to open a connection again.
	 *
	 * A wait already scheduled is left alone, so two closes reported for one lost connection do
	 * not turn into two attempts.
	 */
	scheduleAttempt(): void {
		if (this.waitTimer !== undefined) {
			return;
		}
		const delayMs = this.backoff.nextDelayMs();
		this.attemptNumber = this.backoff.attemptCount;
		this.attemptDueAtMs = Date.now() + delayMs;
		this.waitTimer = window.setTimeout((): void => {
			this.waitTimer = undefined;
			this.stopCountdown();
			this.callbacks.onAttempt(this.attemptNumber);
		}, delayMs);
		this.reportSecondsRemaining();
		this.countdownTimer = window.setInterval((): void => {
			this.reportSecondsRemaining();
		}, COUNTDOWN_INTERVAL_MS);
	}

	/**
	 * Makes the pending attempt now instead of waiting out the rest of its wait.
	 *
	 * The device getting its network back is what calls this: the wait was chosen while there was
	 * no network at all, and sitting out the remaining minute of it would leave the volunteer
	 * offering no work for no reason. Nothing happens when no attempt is pending.
	 */
	attemptNow(): void {
		if (this.waitTimer === undefined) {
			return;
		}
		window.clearTimeout(this.waitTimer);
		this.waitTimer = undefined;
		this.stopCountdown();
		this.callbacks.onAttempt(this.attemptNumber);
	}

	/**
	 * Cancels the pending attempt, if there is one, and leaves the wait where it is.
	 *
	 * This is what an attempt that could not be made yet uses, so that the wait grows rather than
	 * starting again from one second.
	 */
	stop(): void {
		if (this.waitTimer !== undefined) {
			window.clearTimeout(this.waitTimer);
		}
		this.waitTimer = undefined;
		this.stopCountdown();
	}

	/**
	 * Cancels the pending attempt and puts the wait back to its first second.
	 *
	 * The page calls this once it holds a connection again, and when the volunteer presses the
	 * connect button, so that neither is followed by the long wait the previous outage grew to.
	 */
	stopAndReset(): void {
		this.stop();
		this.backoff.reset();
		this.attemptNumber = 0;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Tells the page how many whole seconds are left before the pending attempt. */
	private reportSecondsRemaining(): void {
		const secondsRemaining = Math.max(0, Math.ceil((this.attemptDueAtMs - Date.now()) / 1_000));
		this.callbacks.onWaiting(secondsRemaining, this.attemptNumber);
	}

	/** Stops reporting the seconds left. */
	private stopCountdown(): void {
		if (this.countdownTimer !== undefined) {
			window.clearInterval(this.countdownTimer);
		}
		this.countdownTimer = undefined;
	}
}
