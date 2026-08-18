// node imports
import Fs from 'node:fs';

// local imports
import { OpenaiPackageClient } from '../clients/openai_package_client.js';
import { RawHttpClient } from '../clients/raw_http_client.js';
import type { CompletionMode, CompletionTarget } from '../completion_types.js';
import { exitCodes } from '../exit_codes.js';
import { ModelResolver } from '../model_resolver.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';
import { GenerationControlProbeCache } from './probes/generation_control_probe_cache.js';
import { ToolCallProbeCache } from './probes/tool_call_probe_cache.js';
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
import { MatrixReporter } from './reporter/matrix.js';
import { ReportParameters } from './reporter/report_parameters.js';
import { ReportSummary } from './reporter/report_summary.js';
import { TerminalReporter } from './reporter/terminal.js';
import { Runner, type ConformanceRun, type SkippedModel } from './runner.js';
import type { ConformanceTest, TestContext } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConformanceCommand — runs the conformance tests against one endpoint and writes the report
//
//	Points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports
//	which parts of the protocol that server actually honours, per issue #181.
//
//	Run with:
//	  ./src/cli.ts conformance --model llm_llama3_2_1b_full
//	  ./src/cli.ts conformance --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --profile full
//	  ./src/cli.ts conformance --model llm_llama3_2_1b_full --group streaming --verbose
//	  ./src/cli.ts conformance --model llm_llama3_2_1b_full --format markdown --output report.md
//	  ./src/cli.ts conformance --model llm_llama3_2_1b_full --profile agent --ci
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every profile `conformance` can run. */
export const knownProfiles: ReadonlyMap<string, readonly ConformanceTest[]> = new Map([
	['core', coreProfile],
	['streaming', streamingProfile],
	['tools', toolsProfile],
	['parameters', parametersProfile],
	['structured_output', structuredOutputProfile],
	['sdk', sdkProfile],
	['agent', agentProfile],
	['full', fullProfile],
]);

/** Every report format `conformance` can write. */
export const knownFormats = ['text', 'json', 'markdown', 'junit'] as const;

/**
 * The groups whose verdicts depend on which mode the requests behind them were sent in.
 *
 * These two are the groups backed by a probe cache, and a probe cache is the only thing a mode
 * reaches. Every other test builds its own request with its own fixed shape — `streaming/` always
 * streams, `chat/` never does — so sending it a second time under a second mode would repeat a
 * measurement rather than make a new one.
 */
const probeBackedGroups: readonly string[] = ['parameters', 'tools'];

/** The `conformance` subcommand's options, exactly as commander parses them. */
export type RawConformanceOptions = RawSharedOptions & {
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

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConformanceCommand
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Runs the conformance tests against one endpoint and writes the report. */
export class ConformanceCommand {
	/**
	 * Validates `rawOptions`, runs the chosen tests, writes the report, and sets the exit code.
	 *
	 * @param rawOptions The subcommand's options, exactly as commander parsed them.
	 * @param args The command line arguments as they were typed, reproduced in a markdown report so
	 * a reader can run the same measurement again.
	 * @param invokedName The name this program was invoked under, used to write that same line, so a
	 * person who typed `webai-at-home openai_test` is not shown a name they never typed.
	 * @returns Nothing, once the report has been written. Sets `process.exitCode` to `1` when one or
	 * more tests failed. Every model the sweep leaves out is named on standard error as it is left
	 * out, because only the verdict matrix has a section for it, and a sweep that ends up measuring
	 * one model writes the single-model report instead.
	 * @throws {Error} If the command line is unusable: a missing `-m/--model`, an unknown
	 * `--profile` or `-f/--format`, or a `-g/--group` or `-t/--test` matching no test at all.
	 */
	static async run(rawOptions: RawConformanceOptions, args: readonly string[], invokedName: string): Promise<void> {
		if (rawOptions.model === undefined || rawOptions.model.trim() === '') {
			throw new Error('-m/--model is required, or set the OPENAI_MODEL environment variable');
		}
		const profile = knownProfiles.get(rawOptions.profile);
		if (profile === undefined) {
			throw new Error(`--profile must be one of ${[...knownProfiles.keys()].join(', ')}, got "${rawOptions.profile}"`);
		}
		if (knownFormats.includes(rawOptions.format as (typeof knownFormats)[number]) === false) {
			throw new Error(`-f/--format must be one of ${knownFormats.join(', ')}, got "${rawOptions.format}"`);
		}

		const target = SharedOptions.buildTarget(rawOptions);
		const rawHttpClient = new RawHttpClient(target);
		if (rawOptions.model.trim() === 'list') {
			SharedOptions.printModelIds(await ModelResolver.listModelIds(rawHttpClient));
			return;
		}

		const tests = ConformanceCommand._selectTests(profile, rawOptions);
		const repeats = SharedOptions.positiveInteger(rawOptions.repeats, '--repeats');
		const modes = SharedOptions.resolveModes(rawOptions);
		const selection = await ModelResolver.resolve(rawOptions.model, rawHttpClient);

		const runs: ConformanceRun[] = [];
		const skippedModels: SkippedModel[] = [];
		for (const modelId of selection.modelIds) {
			if (selection.isFromEndpointListing === true) {
				const reason = await ModelResolver.probeUsable(new OpenaiPackageClient(target).client, modelId);
				if (reason !== undefined) {
					skippedModels.push({
						modelId,
						reason,
					});
					console.error(`Model left out: "${modelId}" (${reason})`);
					continue;
				}
			}
			runs.push(...(await ConformanceCommand._runOneModel(tests, modelId, modes, repeats, target)));
		}
		if (runs.length === 0) {
			throw new Error(`no model was measured. ${ConformanceCommand._describeSkipped(skippedModels)}`);
		}

		const report = ConformanceCommand._renderReport(runs, skippedModels, rawOptions, target.baseUrl, args, invokedName);
		ConformanceCommand._writeReport(report, rawOptions.output);
		ConformanceCommand._setExitCode(runs);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs the chosen tests against one model, once per mode for the tests a mode reaches and once
	 * for every other test.
	 *
	 * The mode reaches the two probe caches and nothing else, so re-running `chat.basic` under a
	 * second mode would send the identical request and record the identical answer under a heading
	 * that says it measured something new. The tests of `probeBackedGroups` are the ones a mode
	 * genuinely changes, and they are the only ones a second mode runs again.
	 *
	 * @param tests The tests to run, in the order to run and report them.
	 * @param modelId The model identifier to run them against.
	 * @param modes The modes to send the probes in, in order.
	 * @param repeats How many times a test comparing repeated answers sends its prompt.
	 * @param target The endpoint to send every request to.
	 * @returns One run for the tests no mode reaches, when there are any, followed by one run per
	 * mode for the tests a mode does reach. A single mode collapses both into one run, so a
	 * single-model, single-mode invocation produces exactly one run and exactly today's report.
	 */
	private static async _runOneModel(
		tests: readonly ConformanceTest[],
		modelId: string,
		modes: readonly CompletionMode[],
		repeats: number,
		target: CompletionTarget,
	): Promise<ConformanceRun[]> {
		const buildContext = (mode: CompletionMode): TestContext => {
			const openaiPackageClient = new OpenaiPackageClient(target);
			return {
				rawHttpClient: new RawHttpClient(target),
				openaiPackageClient,
				modelId,
				repeats,
				toolCallProbeCache: new ToolCallProbeCache(openaiPackageClient.client, modelId, repeats, mode),
				generationControlProbeCache: new GenerationControlProbeCache(openaiPackageClient.client, modelId, repeats, mode),
			};
		};

		const firstMode = modes[0] ?? 'nostream';
		if (modes.length === 1) {
			return [
				{
					modelId,
					mode: firstMode,
					records: await Runner.run(tests, buildContext(firstMode)),
				},
			];
		}

		const modeReached = tests.filter((test) => probeBackedGroups.includes(test.group) === true);
		const modeUnreached = tests.filter((test) => probeBackedGroups.includes(test.group) === false);
		const runs: ConformanceRun[] = [];
		if (modeUnreached.length > 0) {
			runs.push({
				modelId,
				mode: undefined,
				records: await Runner.run(modeUnreached, buildContext(firstMode)),
			});
		}
		for (const mode of modeReached.length > 0 ? modes : []) {
			runs.push({
				modelId,
				mode,
				records: await Runner.run(modeReached, buildContext(mode)),
			});
		}
		return runs;
	}

	/**
	 * Says which models were left out, and why, for a run that ended up measuring none of them.
	 *
	 * @param skippedModels The models that were left out.
	 * @returns One sentence naming each of them.
	 */
	private static _describeSkipped(skippedModels: readonly SkippedModel[]): string {
		if (skippedModels.length === 0) {
			return '-m/--model matched no model at all.';
		}
		const named = skippedModels.map((skipped) => `"${skipped.modelId}" (${skipped.reason})`).join('; ');
		return `Every model matched failed to answer one chat completion under its own name: ${named}`;
	}

	/**
	 * Narrows a profile down to what `-g/--group` and `-t/--test` asked for.
	 *
	 * @param profile The profile chosen by `--profile`.
	 * @param rawOptions The subcommand's options.
	 * @returns The tests to run, in the profile's own order.
	 * @throws {Error} If the narrowing leaves no test at all, which is a mistake on the command
	 * line rather than a result worth reporting.
	 */
	private static _selectTests(profile: readonly ConformanceTest[], rawOptions: RawConformanceOptions): readonly ConformanceTest[] {
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
	 * The generation date, the parameter list, and the command line go to the markdown format only.
	 * That format is the one written to a file and read again days later, where a report that does
	 * not say when it was measured or what it was measured with says very little; the other three
	 * are read by a program or by the person who just typed the command.
	 *
	 * A run that produced one set of records is reported exactly as it always was. More than one set
	 * is a sweep, and a sweep is a different document: the matrix, where a reader compares models by
	 * reading across a row, which a stack of separate reports never lets them do.
	 *
	 * @param runs Every run this invocation produced.
	 * @param skippedModels The models the sweep left out before measuring them.
	 * @param rawOptions The subcommand's options.
	 * @param endpoint The endpoint that was tested.
	 * @param args The command line arguments as they were typed.
	 * @param invokedName The name this program was invoked under.
	 * @returns The report, ready to write.
	 */
	private static _renderReport(
		runs: readonly ConformanceRun[],
		skippedModels: readonly SkippedModel[],
		rawOptions: RawConformanceOptions,
		endpoint: string,
		args: readonly string[],
		invokedName: string,
	): string {
		const commandLine = ReportParameters.commandLine(args, invokedName);
		if (runs.length > 1) {
			const matrixOptions = {
				endpoint,
				skippedModels,
				generatedAt: new Date(),
				commandLine,
			};
			switch (rawOptions.format) {
				case 'json':
					return JsonReporter.renderRuns(runs, endpoint, skippedModels);
				case 'markdown':
					return MatrixReporter.renderMarkdown(runs, matrixOptions);
				case 'junit':
					return JunitReporter.renderRuns(runs, endpoint);
				default:
					return MatrixReporter.renderText(runs, matrixOptions);
			}
		}

		const records = runs[0]?.records ?? [];
		const options = {
			endpoint,
			modelId: runs[0]?.modelId ?? rawOptions.model,
		};
		switch (rawOptions.format) {
			case 'json':
				return JsonReporter.render(records, options);
			case 'markdown':
				return MarkdownReporter.render(records, {
					...options,
					generatedAt: new Date(),
					parameters: ReportParameters.of(rawOptions),
					commandLine,
				});
			case 'junit':
				return JunitReporter.render(records, options);
			default:
				return TerminalReporter.render(records, {
					...options,
					verbose: rawOptions.verbose === true,
				});
		}
	}

	/**
	 * Writes the report to `-o/--output` when one was named, and to standard output otherwise.
	 *
	 * @param report The rendered report.
	 * @param outputPath The file to write to, `undefined` to print instead.
	 * @returns Nothing.
	 * @throws {Error} If the file cannot be written, which stops the run rather than being a test
	 * result.
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
			throw new Error(`-o/--output could not be written: ${message}`);
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
	 * A sweep fails when any one of its runs failed. A model that measured badly is not excused by
	 * another model that measured well.
	 *
	 * @param runs Every run this invocation produced.
	 * @returns Nothing.
	 */
	private static _setExitCode(runs: readonly ConformanceRun[]): void {
		const failedCount = runs.reduce((total, run) => total + ReportSummary.of(run.records).failedCount, 0);
		if (failedCount > 0) {
			process.exitCode = exitCodes.someFailed;
		}
	}
}
