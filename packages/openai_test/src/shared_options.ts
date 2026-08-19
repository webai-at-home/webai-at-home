// npm imports
import type { Command } from 'commander';

// local imports
import { streamSettings, reportFormats, type StreamSetting, type CompletionTarget } from './completion_types.js';

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
 * `-f/--format` and no stream setting flags.
 */
export type RawEndpointOptions = {
	/** The base URL of the OpenAI-compatible API to reach, without `/chat/completions`. */
	base_url: string;
	/** The bearer token sent to the endpoint. */
	api_key: string;
	/** How long one request may take before it is given up on, still as text. */
	timeout_ms: string;
};

/** The options the two subcommands that write a report accept, exactly as commander parses them. */
export type RawSharedOptions = RawEndpointOptions & {
	/** The one model identifier to work with, or `list` to print the identifiers the endpoint serves. */
	model: string;
	/** The value `--stream` was given, still unchecked against `streamSettings`. */
	stream?: string;
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
	 * Adds `--stream` to one subcommand.
	 *
	 * The benchmark does not accept it, because it always asks for the answer in pieces: that is
	 * what lets it measure Time to First Character apart from Time to Last Character.
	 *
	 * @param command The subcommand to add the option to.
	 * @returns The same subcommand, so the call can be chained.
	 */
	static addStreamOption(command: Command): Command {
		return command.option(
			'--stream <on|off>',
			'measure with streaming on only, or with streaming off only; both when this option is left out',
		);
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
	 * Resolves which stream settings to measure from `--stream`.
	 *
	 * @param rawOptions The subcommand's options, exactly as commander parsed them.
	 * @returns The one setting `--stream` names, or both settings when the option was left out.
	 * @throws {Error} If `--stream` was given anything other than `on` or `off`.
	 */
	static resolveStreamSettings(rawOptions: RawSharedOptions): readonly StreamSetting[] {
		if (rawOptions.stream === undefined) {
			return streamSettings;
		}
		const wanted = rawOptions.stream.trim().toLowerCase();
		if ((streamSettings as readonly string[]).includes(wanted) === false) {
			throw new Error(`--stream must be one of ${streamSettings.join(', ')}, got "${rawOptions.stream}"`);
		}
		return [wanted as StreamSetting];
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
	 * Reads the one model identifier `-m/--model` named.
	 *
	 * Every subcommand of this package works with one model, so the spellings that name several —
	 * `all`, a comma-separated list, and a pattern carrying `*` — are refused here by name. Sending
	 * one of them on as if it were a model identifier would reach the endpoint as a model nobody
	 * serves, and the error a reader would then be shown says nothing about what went wrong.
	 *
	 * @param rawModel The `-m/--model` value, exactly as commander parsed it.
	 * @param subcommandName The subcommand refusing it, named in the error so a reader knows which
	 * one of the three is speaking.
	 * @returns The one model identifier, with the surrounding spaces taken off.
	 * @throws {Error} If the value named no model at all, or if it names more than one.
	 */
	static readOneModelId(rawModel: string, subcommandName: string): string {
		const modelId = rawModel.trim();
		if (modelId === '') {
			throw new Error('-m/--model named no model at all');
		}
		if (modelId === 'all' || modelId.includes(',') === true || modelId.includes('*') === true) {
			throw new Error(`${subcommandName} works with one model, so -m/--model takes one model identifier, got "${rawModel}"`);
		}
		return modelId;
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
