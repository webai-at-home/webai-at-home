#!/usr/bin/env -S npx tsx

// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// npm imports
import { Command } from 'commander';

// local imports
import { taskTypeNames, taskTypeNamesAcceptingHistory } from '@webai/consumer-cli';
import { BenchmarkCommand, type RawBenchmarkOptions } from './commands/benchmark_command.js';
import { CompletionCommand, type RawCompletionOptions } from './commands/completion_command.js';
import { GenerationControlsCommand, type RawGenerationControlsOptions } from './commands/generation_controls_command.js';
import { HistoryCommand, type RawHistoryOptions } from './commands/history_command.js';
import { ToolCallsCommand, type RawToolCallsOptions } from './commands/tool_calls_command.js';
import { UsageCommand, type RawUsageOptions } from './commands/usage_command.js';
import { SharedOptions } from './shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the openai_api_tool command line program and its six subcommands
//
//	Run with:
//	  ./src/cli.ts completion --streamed --model llm_qwen3_0_6b_sharded
//	  ./src/cli.ts history --model llm_llama3_2_1b_full
//	  ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
//	  ./src/cli.ts usage --model all
//	  ./src/cli.ts generation_controls --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --nostream
//	  ./src/cli.ts tool_calls --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --nostream
//	or, from the workspace:
//	  npm run completion --workspace @webai/openai-api-tool -- --model all
//
//	`-m/--model` accepts one model identifier, a comma-separated list of identifiers, a pattern
//	such as `llm_*`, `all`, or `list` to print the model identifiers and send nothing. Neither
//	`-s/--streamed` nor `--nostream` given sweeps both modes, which is what makes a bare
//	subcommand the whole sweep across every model and every mode it applies to.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `openai_api_tool` command line program. */
export class Cli {
	/**
	 * Parses the command line and dispatches to `completion`, `history`, `benchmark`, `usage`,
	 * `generation_controls`, or `tool_calls`.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the arguments
	 * this process was started with.
	 * @returns Nothing, once the subcommand has finished. Sets `process.exitCode` to `1` when the
	 * command line itself was unusable, such as an `-m/--model` pattern matching nothing, reported
	 * in words rather than as a stack trace.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Command();
		program.name('openai_api_tool').description('Exercises and measures a server that speaks the OpenAI-compatible API.');

		const completion = program
			.command('completion')
			.description('Sends one chat completion request per model and per mode, and reports which ones answered.')
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the model identifiers',
				'all',
			)
			.option('-p, --prompt <text>', "the prompt to send instead of each model's own default prompt");
		SharedOptions.addModeOptions(completion);
		SharedOptions.addFormatOption(completion);
		SharedOptions.addEndpointOptions(completion);
		completion.action(async (rawOptions: RawCompletionOptions) => {
			await CompletionCommand.run(rawOptions);
		});

		const history = program
			.command('history')
			.description(
				"Sends a two-turn history to a model that accepts one, and checks that the second turn's answer recalls what the first turn said.",
			)
			.option(
				'-m, --model <name>',
				`model identifier, a comma-separated list of identifiers, a pattern, all, or list to print the model identifiers — only ${taskTypeNamesAcceptingHistory.join(' and ')} accept a whole history`,
				'all',
			)
			.option('-r, --repeats <number>', 'how many times the two turns are sent before the model is reported not to have recalled them', '5');
		SharedOptions.addModeOptions(history);
		SharedOptions.addFormatOption(history);
		SharedOptions.addEndpointOptions(history);
		history.action(async (rawOptions: RawHistoryOptions) => {
			await HistoryCommand.run(rawOptions);
		});

		const benchmark = program
			.command('benchmark')
			.description("Measures one OpenAI-compatible endpoint's streamed chat completion latency, one model at a time.")
			.option(
				'-m, --model <name>',
				`model identifier, a comma-separated list of identifiers, a pattern, all, or list — a name outside ${taskTypeNames.join(', ')} is sent to the endpoint unchanged, so another server's own model names work`,
				'all',
			)
			.option('-p, --prompt <text>', 'the one prompt sent to the endpoint', BenchmarkCommand.defaultPrompt)
			.option('-r, --runs <number>', 'measured requests per model', '10')
			.option('-w, --warmup_runs <number>', 'unreported warm-up requests per model', '1');
		SharedOptions.addFormatOption(benchmark);
		SharedOptions.addEndpointOptions(benchmark);
		benchmark.action(async (rawOptions: RawBenchmarkOptions) => {
			await BenchmarkCommand.run(rawOptions);
		});

		const usage = program
			.command('usage')
			.description("Sends one chat completion request per model and per mode, and reports each answer's usage and finish_reason.")
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the model identifiers',
				'all',
			)
			.option('-p, --prompt <text>', "the prompt to send instead of each model's own default prompt");
		SharedOptions.addModeOptions(usage);
		SharedOptions.addFormatOption(usage);
		SharedOptions.addEndpointOptions(usage);
		usage.action(async (rawOptions: RawUsageOptions) => {
			await UsageCommand.run(rawOptions);
		});

		const generationControls = program
			.command('generation_controls')
			.description('Probes each of temperature, top_p, max_completion_tokens, stop, and seed, and reports whether the model really honours it.')
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the model identifiers',
				'all',
			)
			.option('-r, --repeats <number>', 'how many times a probe that compares repeated answers sends its prompt', '5');
		SharedOptions.addModeOptions(generationControls);
		SharedOptions.addFormatOption(generationControls);
		SharedOptions.addEndpointOptions(generationControls);
		generationControls.action(async (rawOptions: RawGenerationControlsOptions) => {
			await GenerationControlsCommand.run(rawOptions);
		});

		const toolCalls = program
			.command('tool_calls')
			.description('Probes each of the six tool call abilities, and reports which ones the model behind the endpoint really has.')
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the model identifiers',
				'all',
			)
			.option('-r, --repeats <number>', 'how many times a probe that needs a tool call sends its prompt before giving up on getting one', '5');
		SharedOptions.addModeOptions(toolCalls);
		SharedOptions.addFormatOption(toolCalls);
		SharedOptions.addEndpointOptions(toolCalls);
		toolCalls.action(async (rawOptions: RawToolCallsOptions) => {
			await ToolCallsCommand.run(rawOptions);
		});

		try {
			await program.parseAsync(args, { from: 'user' });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 1;
		}
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `tsx` invokes this file through `process.argv[1]`, while `import.meta.url` is Node's
	 * already-resolved real path. Comparing both sides after resolving symlinks means a test that
	 * imports this module for its exports never triggers command line parsing.
	 *
	 * @returns `true` when this process was started to run this file.
	 */
	static isMainModule(): boolean {
		if (process.argv[1] === undefined) {
			return false;
		}
		try {
			return Url.fileURLToPath(import.meta.url) === Fs.realpathSync(process.argv[1]);
		} catch {
			return false;
		}
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
