// local imports
import type { ReportParameter } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportParameters — what a run was given, written into a report without its bearer token
//
//	A markdown report is written to be pasted into a GitHub issue or committed beside the code, so
//	everything this file produces is written on the assumption that it will be published. That is
//	the whole reason the redaction lives here rather than in the reporter: the reporter formats
//	what it is handed, and what it is handed must already be safe to publish.
//
//	It sits beside the subcommands rather than inside one of them because `conformance` and
//	`benchmark` both write a report naming what they were given, and one bearer token redaction
//	written twice is one redaction that will eventually be fixed in only one of the two places.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `conformance` command line options a report names, as this file reads them.
 *
 * Declared here rather than imported from `./conformance/conformance_command.ts` so that this file
 * never depends on the subcommand that happens to call it. `RawConformanceOptions` satisfies this
 * shape already.
 */
export type ConformanceParameterSource = {
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

/**
 * The `benchmark` command line options a report names, as this file reads them.
 *
 * Declared here for the same reason as `ConformanceParameterSource`, and satisfied already by
 * `RawBenchmarkOptions`.
 */
export type BenchmarkParameterSource = {
	/** The model identifier requested. */
	readonly model: string;
	/** The one prompt sent to the endpoint. */
	readonly prompt: string;
	/** How many measured requests each model was sent, still as text. */
	readonly runs: string;
	/** How many unreported warm-up requests each model was sent, still as text. */
	readonly warmup_runs: string;
	/** The base URL of the endpoint reached. */
	readonly base_url: string;
	/** The bearer token sent to the endpoint, never written into a report as it stands. */
	readonly api_key: string;
	/** How long one request could take before it was given up on, still as text. */
	readonly timeout_ms: string;
	/** The output format. */
	readonly format: string;
	/** The file the report was written to, when `-o/--output` was given. */
	readonly output?: string | undefined;
	/** Set when `--verbose` was given. */
	readonly verbose?: boolean | undefined;
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
	 * Lists every command line parameter one `conformance` run was given, including the ones
	 * commander filled in from a default.
	 *
	 * The defaults are listed rather than left out on purpose: a reader comparing two reports needs
	 * to know that one ran three repeats and the other one, whether or not either of them typed
	 * `--repeats`. An option that was never given and has no default is left out entirely, because
	 * naming it would say it was set to nothing rather than that it was never set.
	 *
	 * @param source The `conformance` options, exactly as commander parsed them.
	 * @returns The parameters, in the order the help text declares them, with the bearer token
	 * replaced whenever a real one was given.
	 */
	static ofConformanceOptions(source: ConformanceParameterSource): readonly ReportParameter[] {
		return ReportParameters._present([
			{ name: '--model', value: source.model },
			{ name: '--profile', value: source.profile },
			{ name: '--group', value: source.group },
			{ name: '--test', value: source.test === undefined ? undefined : source.test.join(' ') },
			{ name: '--repeats', value: source.repeats },
			{ name: '--output', value: source.output },
			{ name: '--verbose', value: source.verbose === true ? 'true' : undefined },
			{ name: '--ci', value: source.ci === true ? 'true' : undefined },
			{ name: '--base_url', value: source.base_url },
			{ name: '--api_key', value: ReportParameters._shownApiKey(source.api_key) },
			{ name: '--timeout_ms', value: source.timeout_ms },
			{ name: '--format', value: source.format },
		]);
	}

	/**
	 * Lists every command line parameter one `benchmark` run was given, on the same terms as
	 * `ofConformanceOptions`: the defaults are named, an option never given is left out, and the
	 * bearer token is replaced.
	 *
	 * The prompt is among them because two benchmark reports measured with two different prompts
	 * are not comparable, and the prompt is the one setting a reader cannot guess from the numbers.
	 *
	 * @param source The `benchmark` options, exactly as commander parsed them.
	 * @returns The parameters, in the order the help text declares them.
	 */
	static ofBenchmarkOptions(source: BenchmarkParameterSource): readonly ReportParameter[] {
		return ReportParameters._present([
			{ name: '--model', value: source.model },
			{ name: '--prompt', value: source.prompt },
			{ name: '--runs', value: source.runs },
			{ name: '--warmup_runs', value: source.warmup_runs },
			{ name: '--output', value: source.output },
			{ name: '--verbose', value: source.verbose === true ? 'true' : undefined },
			{ name: '--base_url', value: source.base_url },
			{ name: '--api_key', value: ReportParameters._shownApiKey(source.api_key) },
			{ name: '--timeout_ms', value: source.timeout_ms },
			{ name: '--format', value: source.format },
		]);
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

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Keeps the candidates that carry a value, so that an option never given is absent from the
	 * report rather than named with an empty value.
	 *
	 * @param candidates Every parameter the subcommand could name, in help text order.
	 * @returns The ones that were actually set.
	 */
	private static _present(candidates: readonly { name: string; value: string | undefined }[]): readonly ReportParameter[] {
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
	 * Decides what a report shows in place of the bearer token that was sent.
	 *
	 * @param apiKey The bearer token the run was given.
	 * @returns The placeholder as it stands when no key was given, and the redaction otherwise.
	 */
	private static _shownApiKey(apiKey: string): string {
		return apiKey === placeholderApiKey ? placeholderApiKey : redactedApiKey;
	}
}
