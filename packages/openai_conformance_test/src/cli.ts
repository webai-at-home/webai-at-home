#!/usr/bin/env -S npx tsx

// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// npm imports
import { Command } from 'commander';

// local imports
import { SharedOptions, type RawSharedOptions } from '@webai/openai-api-tool/shared_options';
import { OpenaiPackageClient } from './clients/openai_package_client.js';
import { RawHttpClient } from './clients/raw_http_client.js';
import { GenerationControlProbeCache } from './probes/generation_control_probe_cache.js';
import { agentProfile } from './profiles/agent.js';
import { coreProfile } from './profiles/core.js';
import { fullProfile } from './profiles/full.js';
import { parametersProfile } from './profiles/parameters.js';
import { sdkProfile } from './profiles/sdk.js';
import { streamingProfile } from './profiles/streaming.js';
import { structuredOutputProfile } from './profiles/structured_output.js';
import { toolsProfile } from './profiles/tools.js';
import { JsonReporter } from './reporter/json.js';
import { JunitReporter } from './reporter/junit.js';
import { MarkdownReporter } from './reporter/markdown.js';
import { ReportSummary } from './reporter/report_summary.js';
import { TerminalReporter } from './reporter/terminal.js';
import { Runner, type TestRunRecord } from './runner.js';
import { ToolCallProbeCache } from './probes/tool_call_probe_cache.js';
import type { ConformanceTest, TestContext } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the openai_conformance_test command line program
//
//	Points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports
//	which parts of the protocol that server actually honours, per issue #181. Unlike every other
//	command line program in this repository, this one has no subcommand: section 33 of issue #181
//	shapes it as one command with options, and that shape is kept here.
//
//	Run with:
//	  ./src/cli.ts --model llm_llama3_2_1b_full
//	  ./src/cli.ts --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --profile full
//	  ./src/cli.ts --model llm_llama3_2_1b_full --group streaming --verbose
//	  ./src/cli.ts --model llm_llama3_2_1b_full --format markdown --output report.md
//	  ./src/cli.ts --model llm_llama3_2_1b_full --profile agent --ci
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every profile this package can run. */
const knownProfiles: ReadonlyMap<string, readonly ConformanceTest[]> = new Map([
	['core', coreProfile],
	['streaming', streamingProfile],
	['tools', toolsProfile],
	['parameters', parametersProfile],
	['structured_output', structuredOutputProfile],
	['sdk', sdkProfile],
	['agent', agentProfile],
	['full', fullProfile],
]);

/** Every report format this package can write. */
const knownFormats = ['text', 'json', 'markdown', 'junit'] as const;

/** The exit codes of section 29 of issue #181. */
const exitCodes = {
	/** Every required test passed. */
	allPassed: 0,
	/** One or more required tests failed. */
	someFailed: 1,
	/** The tool itself could not run: an unusable command line, or an unwritable output file. */
	runnerError: 2,
} as const;

/** The options `Cli.run` accepts, exactly as commander parses them. */
export type RawCliOptions = RawSharedOptions & {
	/** The model identifier to request. */
	model: string;
	/** Which profile to run. */
	profile: string;
	/** How many times a tool call or generation control probe repeats its prompt, still as text. */
	repeats: string;
	/** Run only the tests of this group, when given. */
	group?: string;
	/** Run only the tests whose identifier is one of these, when given. */
	test?: string[];
	/** Write the report to this file rather than to standard output, when given. */
	output?: string;
	/** Set when `--verbose` was given. */
	verbose?: boolean;
	/** Set when `--ci` was given. */
	ci?: boolean;
};

/** The `openai_conformance_test` command line program. */
export class Cli {
	/**
	 * Parses the command line, runs the chosen tests against the named endpoint, and writes the
	 * report.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the arguments
	 * this process was started with.
	 * @param invokedName The name this program was invoked under, printed in its usage line, so a
	 * person who typed `webai-at-home openai_conformance_test` is not shown a name they never
	 * typed. Defaults to this program's own name.
	 * @returns Nothing, once the report has been written. Sets `process.exitCode` per section 29 of
	 * issue #181: `0` when every test passed, `1` when one or more failed, and `2` when the tool
	 * itself could not run.
	 */
	static async run(args: string[] = process.argv.slice(2), invokedName = 'openai_conformance_test'): Promise<void> {
		const program = new Command();
		program
			.name(invokedName)
			.description('Points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol it actually honours.')
			.option('-m, --model <name>', 'the model identifier to request', process.env.OPENAI_MODEL);
		program.addOption(program.createOption('-p, --profile <name>', `which group of tests to run: ${[...knownProfiles.keys()].join(', ')}`).default('core'));
		program.option('-g, --group <name>', 'run only the tests of one group, such as streaming');
		program.option('-t, --test <id...>', 'run only the tests with these identifiers, such as chat.basic');
		program.option('-r, --repeats <number>', 'how many times a tool call or generation control probe repeats its prompt', '3');
		program.option('-o, --output <file>', 'write the report to this file rather than to standard output');
		program.option('--verbose', 'print the detail of every test, including the ones that passed');
		program.option('--ci', 'exit 1 when any test failed, for a continuous integration run');
		SharedOptions.addEndpointOptions(program);
		program.option('-f, --format <format>', `output format: ${knownFormats.join(', ')}`, 'text');

		program.action(async (rawOptions: RawCliOptions) => {
			await Cli._runProfile(rawOptions);
		});

		try {
			await program.parseAsync(args, { from: 'user' });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = exitCodes.runnerError;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Validates `rawOptions`, runs the chosen tests, writes the report, and sets the exit code.
	 *
	 * @param rawOptions The command line options, exactly as commander parsed them.
	 * @returns Nothing, once the report has been written.
	 * @throws {Error} If the command line is unusable: a missing `-m/--model`, an unknown
	 * `-p/--profile` or `-f/--format`, or a `-g/--group` or `-t/--test` matching no test at all.
	 */
	private static async _runProfile(rawOptions: RawCliOptions): Promise<void> {
		if (rawOptions.model === undefined || rawOptions.model.trim() === '') {
			throw new Error('-m/--model is required, or set the OPENAI_MODEL environment variable');
		}
		const profile = knownProfiles.get(rawOptions.profile);
		if (profile === undefined) {
			throw new Error(`-p/--profile must be one of ${[...knownProfiles.keys()].join(', ')}, got "${rawOptions.profile}"`);
		}
		if (knownFormats.includes(rawOptions.format as (typeof knownFormats)[number]) === false) {
			throw new Error(`-f/--format must be one of ${knownFormats.join(', ')}, got "${rawOptions.format}"`);
		}
		const tests = Cli._selectTests(profile, rawOptions);

		const target = SharedOptions.buildTarget(rawOptions);
		const openaiPackageClient = new OpenaiPackageClient(target);
		const repeats = SharedOptions.positiveInteger(rawOptions.repeats, '--repeats');
		const context: TestContext = {
			rawHttpClient: new RawHttpClient(target),
			openaiPackageClient,
			modelId: rawOptions.model,
			toolCallProbeCache: new ToolCallProbeCache(openaiPackageClient.client, rawOptions.model, repeats),
			generationControlProbeCache: new GenerationControlProbeCache(openaiPackageClient.client, rawOptions.model, repeats),
		};

		const records = await Runner.run(tests, context);
		Cli._writeReport(Cli._renderReport(records, rawOptions, target.baseUrl), rawOptions.output);
		Cli._setExitCode(records);
	}

	/**
	 * Narrows a profile down to what `-g/--group` and `-t/--test` asked for.
	 *
	 * @param profile The profile chosen by `-p/--profile`.
	 * @param rawOptions The command line options.
	 * @returns The tests to run, in the profile's own order.
	 * @throws {Error} If the narrowing leaves no test at all, which is a mistake on the command
	 * line rather than a result worth reporting.
	 */
	private static _selectTests(profile: readonly ConformanceTest[], rawOptions: RawCliOptions): readonly ConformanceTest[] {
		let tests = profile;
		if (rawOptions.group !== undefined) {
			tests = tests.filter((test) => test.group === rawOptions.group);
			if (tests.length === 0) {
				const groups = [...new Set(profile.map((test) => test.group))].join(', ');
				throw new Error(`-g/--group "${rawOptions.group}" matches no test in the "${rawOptions.profile}" profile, whose groups are ${groups}`);
			}
		}
		if (rawOptions.test !== undefined && rawOptions.test.length > 0) {
			const wanted = rawOptions.test;
			tests = tests.filter((test) => wanted.includes(test.id));
			if (tests.length === 0) {
				throw new Error(`-t/--test ${wanted.join(', ')} matches no test in the "${rawOptions.profile}" profile`);
			}
		}
		return tests;
	}

	/**
	 * Renders the report in the requested format.
	 *
	 * @param records Every test's outcome.
	 * @param rawOptions The command line options.
	 * @param endpoint The endpoint that was tested.
	 * @returns The report, ready to write.
	 */
	private static _renderReport(records: readonly TestRunRecord[], rawOptions: RawCliOptions, endpoint: string): string {
		const options = { endpoint, modelId: rawOptions.model };
		switch (rawOptions.format) {
			case 'json':
				return JsonReporter.render(records, options);
			case 'markdown':
				return MarkdownReporter.render(records, options);
			case 'junit':
				return JunitReporter.render(records, options);
			default:
				return TerminalReporter.render(records, { ...options, verbose: rawOptions.verbose === true });
		}
	}

	/**
	 * Writes the report to `--output` when one was named, and to standard output otherwise.
	 *
	 * @param report The rendered report.
	 * @param outputPath The file to write to, `undefined` to print instead.
	 * @returns Nothing.
	 * @throws {Error} If the file cannot be written, which is a runner error rather than a test result.
	 */
	private static _writeReport(report: string, outputPath: string | undefined): void {
		if (outputPath === undefined) {
			console.log(report);
			return;
		}
		try {
			Fs.writeFileSync(outputPath, `${report}\n`, 'utf8');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`--output could not be written: ${message}`);
		}
		console.log(`Report written to ${outputPath}`);
	}

	/**
	 * Sets the exit code of section 29 of issue #181.
	 *
	 * A failure sets `1` whether or not `--ci` was given, because a failing conformance run is a
	 * failing run in any context, and a continuous integration file that wants to depend on that
	 * writes `--ci` to say so rather than to change the behaviour. A `WARN` never sets it, and
	 * neither does a `SKIP`: both are answers about the endpoint rather than faults.
	 *
	 * @param records Every test's outcome.
	 * @returns Nothing.
	 */
	private static _setExitCode(records: readonly TestRunRecord[]): void {
		if (ReportSummary.of(records).failedCount > 0) {
			process.exitCode = exitCodes.someFailed;
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
