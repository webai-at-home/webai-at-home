// local imports
import type { ReportParameter } from './markdown.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportParameters — what a run was given, written into a report without its bearer token
//
//	A markdown report is written to be pasted into a GitHub issue or committed beside the code, so
//	everything this file produces is written on the assumption that it will be published. That is
//	the whole reason the redaction lives here rather than in the reporter: the reporter formats
//	what it is handed, and what it is handed must already be safe to publish.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The command line options a report names, as this file reads them.
 *
 * Declared here rather than imported from `../conformance_command.ts` so that a reporter never
 * depends on the subcommand that happens to call it. `RawConformanceOptions` satisfies this shape
 * already.
 */
export type ReportParameterSource = {
	/** The model identifier requested. */
	readonly model: string;
	/** Which profile was run. */
	readonly profile: string;
	/** How many times a tool call or generation control probe repeated its prompt, still as text. */
	readonly repeats: string;
	/** The base URL of the endpoint reached. */
	readonly base_url: string;
	/** The bearer token sent to the endpoint, never written into a report as it stands. */
	readonly api_key: string;
	/** How long one request could take before it was given up on, still as text. */
	readonly timeout_ms: string;
	/** The output format. */
	readonly format: string;
	/** The one group run, when `-g/--group` was given. */
	readonly group?: string | undefined;
	/** The test identifiers run, when `-t/--test` was given. */
	readonly test?: readonly string[] | undefined;
	/** The file the report was written to, when `-o/--output` was given. */
	readonly output?: string | undefined;
	/** Set when `--verbose` was given. */
	readonly verbose?: boolean | undefined;
	/** Set when `--ci` was given. */
	readonly ci?: boolean | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportParameters
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What is written into a report in place of a bearer token.
 *
 * `-k/--api_key` carries a real key whenever the endpoint is a paid one, so it is replaced in the
 * parameter list and in the command line both, rather than being left out of one and printed in
 * the other.
 */
export const redactedApiKey = '<redacted>';

/** The value `-k/--api_key` carries when no key was given at all, which is not a secret and is shown as it stands. */
export const placeholderApiKey = 'no-key-required';

/** Turns what a run was given into the parameters a report names. */
export class ReportParameters {
	/**
	 * Lists every command line parameter one run was given, including the ones commander filled in
	 * from a default.
	 *
	 * The defaults are listed rather than left out on purpose: a reader comparing two reports needs
	 * to know that one ran three repeats and the other one, whether or not either of them typed
	 * `--repeats`. An option that was never given and has no default is left out entirely, because
	 * naming it would say it was set to nothing rather than that it was never set.
	 *
	 * @param source The command line options, exactly as commander parsed them.
	 * @returns The parameters, in the order the help text declares them, with the bearer token
	 * replaced whenever a real one was given.
	 */
	static of(source: ReportParameterSource): readonly ReportParameter[] {
		const apiKey = source.api_key === placeholderApiKey ? placeholderApiKey : redactedApiKey;
		const candidates: readonly { name: string; value: string | undefined }[] = [
			{ name: '--model', value: source.model },
			{ name: '--profile', value: source.profile },
			{ name: '--group', value: source.group },
			{ name: '--test', value: source.test === undefined ? undefined : source.test.join(' ') },
			{ name: '--repeats', value: source.repeats },
			{ name: '--output', value: source.output },
			{ name: '--verbose', value: source.verbose === true ? 'true' : undefined },
			{ name: '--ci', value: source.ci === true ? 'true' : undefined },
			{ name: '--base_url', value: source.base_url },
			{ name: '--api_key', value: apiKey },
			{ name: '--timeout_ms', value: source.timeout_ms },
			{ name: '--format', value: source.format },
		];
		const parameters: ReportParameter[] = [];
		for (const candidate of candidates) {
			if (candidate.value !== undefined) {
				parameters.push({
					name: candidate.name,
					value: candidate.value,
				});
			}
		}
		return parameters;
	}

	/**
	 * Rebuilds the command line that produced one run, as a line a reader can run again.
	 *
	 * The bearer token is replaced wherever it appears, in both the spellings commander accepts:
	 * `-k sk-...` as two arguments, and `--api_key=sk-...` as one. A key that reached the run
	 * through the `OPENAI_API_KEY` environment variable never appears on this line at all, which is
	 * one more reason the line is built from what was typed rather than from the resolved options.
	 *
	 * @param args The command line arguments as they were typed, without the program name.
	 * @param invokedName The name this program was invoked under.
	 * @returns The command line, ready to put in a fenced block.
	 */
	static commandLine(args: readonly string[], invokedName: string): string {
		const parts: string[] = [invokedName];
		let isRedactingNext = false;
		for (const argument of args) {
			if (isRedactingNext === true) {
				parts.push(redactedApiKey);
				isRedactingNext = false;
				continue;
			}
			if (argument === '-k' || argument === '--api_key') {
				parts.push(argument);
				isRedactingNext = true;
				continue;
			}
			if (argument.startsWith('--api_key=') === true || argument.startsWith('-k=') === true) {
				parts.push(`${argument.split('=')[0] ?? argument}=${redactedApiKey}`);
				continue;
			}
			parts.push(argument);
		}
		return parts.join(' ');
	}
}
