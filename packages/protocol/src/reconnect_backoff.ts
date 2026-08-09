///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReconnectBackoff — decides how long a client waits before connecting again
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How long the first attempt waits, in milliseconds. */
const firstDelayMs = 1_000;

/** What each wait is multiplied by after an attempt that did not produce a usable connection. */
const growthFactor = 2;

/** The longest wait between two attempts, in milliseconds. */
const maximumDelayMs = 60_000;

/**
 * The largest random extra, as a fraction of the wait it is added to.
 *
 * Every worker browser tab that was connected to one gateway loses its connection at the same
 * instant when that gateway restarts. Without this, all of them would come back at the same
 * instant too, and the gateway would meet the whole cluster at once.
 */
const randomExtraFraction = 0.3;

/**
 * Decides how long a client waits before opening a connection to the central gateway again.
 *
 * The wait starts at one second, is doubled after each attempt that did not produce a usable
 * connection, and stops growing at one minute, so a gateway that is down for a long time is not
 * asked once a second. A random extra of up to 30 per cent is added to each wait. There is no
 * limit on the number of attempts: a worker browser tab is meant to be left open for hours, and
 * the gateway is expected to come back.
 *
 * Every client that connects again uses this one rule — the worker browser page, the worker in
 * `packages/worker_openai`, and the OpenAI-compatible server in `packages/consumer_openai` —
 * so how long to wait is decided in a single place rather than separately in each program, the
 * same way `SessionRenewal` decides when to authenticate again. See
 * https://github.com/webai-at-home/webai-at-home/issues/158.
 */
export class ReconnectBackoff {
	/** How many waits have been handed out since the last reset. */
	private attemptCountSoFar = 0;

	/**
	 * @param randomFraction Where the random extra comes from, as a number from 0 up to but not
	 * including 1. A test passes its own so that the wait it checks is exact; every other caller
	 * leaves this unset.
	 */
	constructor(private readonly randomFraction: () => number = Math.random) {
	}

	/** How many waits have been handed out since the last reset, counting from zero. */
	get attemptCount(): number {
		return this.attemptCountSoFar;
	}

	/**
	 * Hands out the wait before the next attempt, and moves the rule on to the wait after it.
	 *
	 * @returns How many milliseconds to wait before opening a connection again.
	 */
	nextDelayMs(): number {
		const growthMultiplier = growthFactor ** this.attemptCountSoFar;
		const delayMs = Math.min(firstDelayMs * growthMultiplier, maximumDelayMs);
		this.attemptCountSoFar += 1;
		return Math.round(delayMs * (1 + this.randomFraction() * randomExtraFraction));
	}

	/**
	 * Puts the rule back to its first wait.
	 *
	 * A client calls this once it holds a usable connection again, so that the next connection it
	 * loses is retried after one second rather than after the wait the previous outage grew to.
	 */
	reset(): void {
		this.attemptCountSoFar = 0;
	}
}
