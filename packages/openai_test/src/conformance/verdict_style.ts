// npm imports
import { chalkStderr } from 'chalk';

// local imports
import type { Verdict } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VerdictStyle — the one place a verdict's word and color are decided
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * How a verdict is written for a person to read: the word that names it, and the color that
 * carries it.
 *
 * Both the report of `reporter/terminal.ts` and the live progress lines of
 * `conformance_command.ts` read this class, so that one run never names the same outcome two ways
 * and never colors it two ways.
 *
 * The color is applied through chalk's `chalkStderr` export rather than the default one. The
 * default export decides whether to color from whether standard output is a terminal, while the
 * progress lines are written to standard error: a run writing its report to standard output and
 * its progress to a terminal would lose the color, and a run whose progress is piped would keep
 * it. Both callers use `chalkStderr` rather than one each, so the report and the progress lines
 * of one run always agree about whether this run has color at all.
 */
export class VerdictStyle {
	/**
	 * The word that names one verdict, one per verdict so `SKIP` and `WARN` are never mistaken for
	 * `FAIL` at a glance.
	 *
	 * @param verdict The verdict to name.
	 * @returns The word.
	 */
	public static statusWord(verdict: Verdict): string {
		switch (verdict) {
			case 'PASS':
				return 'OK';
			case 'FAIL':
				return 'Failed';
			case 'SKIP':
				return 'Skipped';
			case 'WARN':
				return 'Warn';
		}
	}

	/**
	 * Colors one piece of text by its verdict: green for `PASS`, red for `FAIL`, cyan for `SKIP`,
	 * yellow for `WARN`. Cyan keeps `SKIP` visibly distinct from a dimmed, uncolored line. Chalk
	 * turns coloring off automatically once output is piped or redirected.
	 *
	 * @param verdict The verdict to color by.
	 * @param text The text to color.
	 * @returns The colored text.
	 */
	public static color(verdict: Verdict, text: string): string {
		switch (verdict) {
			case 'PASS':
				return chalkStderr.green(text);
			case 'FAIL':
				return chalkStderr.red(text);
			case 'SKIP':
				return chalkStderr.cyan(text);
			case 'WARN':
				return chalkStderr.yellow(text);
		}
	}
}
