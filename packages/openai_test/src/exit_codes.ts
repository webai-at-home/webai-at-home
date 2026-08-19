///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	exit_codes — the one place this program decides what each exit code means
//
//	Named here rather than in `cli.ts` so that a subcommand can set one without importing the
//	command line program that called it.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What this program returns to the shell.
 *
 * A run that finished returns `runFinished`, whatever the verdicts in its report were. A failed test,
 * a `WARN`, a `SKIP`, and a model `benchmark` could not measure are all findings the report states,
 * and a finding is not a reason to return a failing code: the shell that called this program, and
 * npm above it, print an error block for a non-zero code, which reads as the program having broken
 * when it has just measured something and said so.
 *
 * `runnerError` is what is left, and it means the report was never written. Read the verdicts in
 * the report to find out what the endpoint did.
 */
export const exitCodes = {
	/** The run finished and wrote its report, whatever the report says. */
	runFinished: 0,
	/** The run itself could not start: an unusable command line, an unreachable endpoint, or an unwritable output file. */
	runnerError: 2,
} as const;
