///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	exit_codes — the one place this program decides what each exit code means
//
//	Named here rather than in `cli.ts` so that a subcommand can set one without importing the
//	command line program that called it.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What this program returns to the shell, kept from section 29 of
 * [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181) and applied to all three
 * subcommands.
 *
 * `benchmark` reports numbers rather than verdicts and `chat` has no verdicts at all, so only
 * `conformance` ever returns `someFailed`.
 */
export const exitCodes = {
	/** Nothing failed. */
	allPassed: 0,
	/** One or more tests failed. */
	someFailed: 1,
	/** The run itself could not start: an unusable command line, an unreachable endpoint, or an unwritable output file. */
	runnerError: 2,
} as const;
