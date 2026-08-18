// npm imports
import type { Command } from 'commander';

// local imports
import { completionModes, reportFormats, type CompletionMode, type CompletionTarget } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SharedOptions — the command line options every subcommand accepts, and how they are read
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The options `addEndpointOptions` declares, exactly as commander parses them.
 *
 * All three subcommands accept these, `chat` included, which is why they are named apart from
 * `RawSharedOptions`: `chat` is a terminal session rather than a report, so it accepts no
 * `-f/--format` and no mode flags.
 */
export type RawEndpointOptions = {
	/** The base URL of the OpenAI-compatible API to reach, without `/chat/completions`. */
	base_url: string;
	/** The bearer token sent to the endpoint. */
	api_key: string;
	/** How long one request may take before it is given up on, still as text. */
	timeout_ms: string;
};

/** The options the subcommands that sweep models and write a report accept, exactly as commander parses them. */
export type RawSharedOptions = RawEndpointOptions & {
	/** One model identifier, a comma-separated list, a pattern such as `llm_*`, `all`, or `list`. */
	model: string;
	/** Set when `-s/--streamed` was given. */
	streamed?: boolean;
	/** Set when `--nostream` was given. */
	nostream?: boolean;
	/** The output format, still unchecked against `reportFormats`. */
	format: string;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SharedOptions
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Declares and reads the command line options every subcommand accepts. */
export class SharedOptions {
	/** The base URL used when `-u/--base_url` is not given: the `consumer_openai` server run for development. */
	static readonly defaultBaseUrl = 'http://localhost:8788/v1';

	/**
	 * Adds `-u/--base_url`, `-k/--api_key`, and `--timeout_ms` to one subcommand.
	 *
	 * `-m/--model` is added by each subcommand itself, because the help text for it names the
	 * models that subcommand can reach, which is not the same list for all three.
	 *
	 * @param command The subcommand to add the options to.
	 * @returns The same subcommand, so the call can be chained.
	 */
	static addEndpointOptions(command: Command): Command {
		return command
			.option('-u, --base_url <url>', 'the OpenAI-compatible API to reach, without /chat/completions', process.env.OPENAI_BASE_URL ?? SharedOptions.defaultBaseUrl)
			.option('-k, --api_key <key>', 'the bearer token sent to the endpoint', process.env.OPENAI_API_KEY ?? 'no-key-required')
			.option('--timeout_ms <number>', 'how long one request may take before it is given up on', '600000');
	}

	/**
	 * Adds `-s/--streamed` and `--nostream` to one subcommand.
	 *
	 * The benchmark does not accept either one, because it always asks for the answer in pieces:
	 * that is what lets it measure Time to First Character apart from Time to Last Character.
	 *
	 * @param command The subcommand to add the options to.
	 * @returns The same subcommand, so the call can be chained.
	 */
	static addModeOptions(command: Command): Command {
		return command
			.option('-s, --streamed', 'sweep the streamed mode only')
			.option('--nostream', 'sweep the nostream mode only');
	}

	/**
	 * Adds `-f/--format` to one subcommand.
	 *
	 * @param command The subcommand to add the option to.
	 * @returns The same subcommand, so the call can be chained.
	 */
	static addFormatOption(command: Command): Command {
		return command.option('-f, --format <format>', `output format: ${reportFormats.join(', ')}`, 'text');
	}

	/**
	 * Builds the endpoint every request of one run is sent to.
	 *
	 * @param rawOptions The subcommand's endpoint options, exactly as commander parsed them.
	 * @returns The endpoint to send requests to.
	 * @throws {Error} If `--timeout_ms` is not a positive whole number.
	 */
	static buildTarget(rawOptions: RawEndpointOptions): CompletionTarget {
		return {
			baseUrl: rawOptions.base_url,
			apiKey: rawOptions.api_key,
			timeoutMs: SharedOptions.positiveInteger(rawOptions.timeout_ms, '--timeout_ms'),
		};
	}

	/**
	 * Resolves which modes to sweep from `-s/--streamed` and `--nostream`.
	 *
	 * @param rawOptions The subcommand's options, exactly as commander parsed them.
	 * @returns Both modes when neither flag is given, or when both are; otherwise the one flag given.
	 */
	static resolveModes(rawOptions: RawSharedOptions): readonly CompletionMode[] {
		const streamedOnly = rawOptions.streamed === true && rawOptions.nostream !== true;
		const nostreamOnly = rawOptions.nostream === true && rawOptions.streamed !== true;
		if (streamedOnly === true) {
			return ['streamed'];
		}
		if (nostreamOnly === true) {
			return ['nostream'];
		}
		return completionModes;
	}

	/**
	 * Converts one command line numeric option and reports a useful option name on failure.
	 *
	 * @param value The command line value, still as text.
	 * @param optionName The option name printed when the value is rejected.
	 * @param allowZero Whether zero is an acceptable value.
	 * @returns The converted whole number.
	 * @throws {Error} If the value is not a whole number in range.
	 */
	static positiveInteger(value: string, optionName: string, allowZero = false): number {
		const parsed = Number(value);
		const isValid = Number.isInteger(parsed) && (allowZero === true ? parsed >= 0 : parsed > 0);
		if (isValid === false) {
			const expected = allowZero === true ? 'a non-negative' : 'a positive';
			throw new Error(`${optionName} must be ${expected} integer, got "${value}"`);
		}
		return parsed;
	}

	/**
	 * Prints every model identifier of `universe`, one per line, for `-m/--model list`.
	 *
	 * @param universe The model identifiers to print.
	 * @returns Nothing.
	 */
	static printModelIds(universe: readonly string[]): void {
		for (const modelId of universe) {
			console.log(modelId);
		}
	}
}
