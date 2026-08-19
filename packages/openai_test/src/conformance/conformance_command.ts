// local imports
import { OpenaiPackageClient } from '../clients/openai_package_client.js';
import { RawHttpClient } from '../clients/raw_http_client.js';
import { reportFormats, type StreamSetting, type ThinkingSetting, type CompletionTarget } from '../completion_types.js';
import { EndpointReachability } from '../endpoint_reachability.js';
import { ModelResolver } from '../model_resolver.js';
import { ReportWriter } from '../report_writer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';
import { AnswerLengthCap } from '../probers/answer_length_cap.js';
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
import { MergedRecords } from './reporter/merged_records.js';
import { ReportParameters } from '../report_parameters.js';
import { ReportSummary } from './reporter/report_summary.js';
import { TerminalReporter } from './reporter/terminal.js';
import { Runner, type ConformanceRun, type RunnerProgressListener } from './runner.js';
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

/**
 * The groups whose verdicts depend on which stream setting the requests behind them were sent in.
 *
 * These two are the groups backed by a probe cache, and a probe cache is the only thing a stream setting
 * reaches. Every other test builds its own request with its own fixed shape — `streaming/` always
 * streams, `chat/` never does — so sending it a second time under a second stream setting would repeat a
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
	/** The value `--thinking` was given, still unchecked against `thinkingSettings`. */
	thinking: string;
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
	 * more tests failed.
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
		if ((reportFormats as readonly string[]).includes(rawOptions.format) === false) {
			throw new Error(`-f/--format must be one of ${reportFormats.join(', ')}, got "${rawOptions.format}"`);
		}

		const target = SharedOptions.buildTarget(rawOptions);
		const rawHttpClient = new RawHttpClient(target);
		await EndpointReachability.assertReachable(rawHttpClient, target.baseUrl);
		if (rawOptions.model.trim() === 'list') {
			SharedOptions.printModelIds(await ModelResolver.listModelIds(rawHttpClient));
			return;
		}

		const tests = ConformanceCommand._selectTests(profile, rawOptions);
		const repeats = SharedOptions.positiveInteger(rawOptions.repeats, '--repeats');
		const streamSettings = SharedOptions.resolveStreamSettings(rawOptions);
		const thinkingSetting = SharedOptions.readThinkingSetting(rawOptions.thinking);

		const runs = await ConformanceCommand._runModel(
			tests,
			SharedOptions.readOneModelId(rawOptions.model, 'conformance'),
			streamSettings,
			repeats,
			thinkingSetting,
			target,
			ConformanceCommand._isProgressWanted(rawOptions),
		);

		const report = ConformanceCommand._renderReport(runs, rawOptions, target.baseUrl, args, invokedName);
		ReportWriter.write(report, rawOptions.output);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs the chosen tests against one model, once per stream setting for the tests a stream setting reaches and once
	 * for every other test.
	 *
	 * The stream setting reaches the two probe caches and nothing else, so re-running `chat.basic` under a
	 * second stream setting would send the identical request and record the identical answer under a heading
	 * that says it measured something new. The tests of `probeBackedGroups` are the ones a stream setting
	 * genuinely changes, and they are the only ones a second stream setting runs again.
	 *
	 * @param tests The tests to run, in the order to run and report them.
	 * @param modelId The one model identifier to run them against.
	 * @param streamSettings The stream settings to send the probes in, in order.
	 * @param repeats How many times a test comparing repeated answers sends its prompt.
	 * @param thinkingSetting Whether the probes let the model think before it answers.
	 * @param target The endpoint to send every request to.
	 * @param isProgressWanted Whether each test is printed as it starts and as it finishes.
	 * @returns One run for the tests no stream setting reaches, when there are any, followed by one run per
	 * stream setting for the tests a stream setting does reach. A single stream setting collapses both into one run, so a
	 * single-setting invocation produces exactly one run.
	 */
	private static async _runModel(
		tests: readonly ConformanceTest[],
		modelId: string,
		streamSettings: readonly StreamSetting[],
		repeats: number,
		thinkingSetting: ThinkingSetting,
		target: CompletionTarget,
		isProgressWanted: boolean,
	): Promise<ConformanceRun[]> {
		const buildContext = (streamSetting: StreamSetting): TestContext => {
			const openaiPackageClient = new OpenaiPackageClient(target);
			// One cap for both probers of one stream setting, so the question of whether this
			// endpoint answers a budgeted request is asked once per run rather than once per prober.
			const answerLengthCap = new AnswerLengthCap({
				client: openaiPackageClient.client,
				modelId,
				streamSetting,
				thinkingSetting,
			});
			return {
				rawHttpClient: new RawHttpClient(target),
				openaiPackageClient,
				modelId,
				repeats,
				toolCallProbeCache: new ToolCallProbeCache(openaiPackageClient.client, modelId, repeats, streamSetting, thinkingSetting, answerLengthCap),
				generationControlProbeCache: new GenerationControlProbeCache(openaiPackageClient.client, modelId, repeats, streamSetting, thinkingSetting, answerLengthCap),
			};
		};

		const listenerFor = (streamSetting: StreamSetting | undefined): RunnerProgressListener | undefined => {
			if (isProgressWanted === false) {
				return undefined;
			}
			const prefix = ConformanceCommand._progressPrefix(streamSetting, streamSettings.length > 1);
			return ConformanceCommand._buildProgressListener(prefix);
		};

		const firstSetting = streamSettings[0] ?? 'off';
		if (streamSettings.length === 1) {
			return [
				{
					modelId,
					streamSetting: firstSetting,
					records: await Runner.run(tests, buildContext(firstSetting), listenerFor(firstSetting)),
				},
			];
		}

		const modeReached = tests.filter((test) => probeBackedGroups.includes(test.group) === true);
		const streamingUnreached = tests.filter((test) => probeBackedGroups.includes(test.group) === false);
		const runs: ConformanceRun[] = [];
		if (streamingUnreached.length > 0) {
			runs.push({
				modelId,
				streamSetting: undefined,
				records: await Runner.run(streamingUnreached, buildContext(firstSetting), listenerFor(undefined)),
			});
		}
		for (const streamSetting of modeReached.length > 0 ? streamSettings : []) {
			runs.push({
				modelId,
				streamSetting,
				records: await Runner.run(modeReached, buildContext(streamSetting), listenerFor(streamSetting)),
			});
		}
		return runs;
	}

	/**
	 * Reports whether the run is to print each test as it starts and as it finishes.
	 *
	 * `--ci` prints nothing, since a continuous integration log reads the report rather than a run
	 * as it happens.
	 *
	 * @param rawOptions The subcommand's options.
	 * @returns `true` when the lines are to be printed.
	 */
	private static _isProgressWanted(rawOptions: RawConformanceOptions): boolean {
		return rawOptions.verbose === true && rawOptions.ci !== true;
	}

	/**
	 * Builds what every progress line of one run is written behind, so a run measured with streaming
	 * both on and off says which stream setting reached a verdict rather than printing the same test
	 * identifier twice over.
	 *
	 * @param streamSetting The stream setting this run's probes are sent in, `undefined` for the tests no stream setting reaches.
	 * @param isSeveralRuns Whether more than one run is expected. A single run needs no prefix at
	 * all, because there is nothing to tell its lines apart from.
	 * @returns The prefix, empty when there is nothing to distinguish.
	 */
	private static _progressPrefix(streamSetting: StreamSetting | undefined, isSeveralRuns: boolean): string {
		if (isSeveralRuns === false || streamSetting === undefined) {
			return '';
		}
		return `${streamSetting} `;
	}

	/**
	 * Builds the listener that prints each test as it starts and as it finishes, so a run against a
	 * slow endpoint says what it is doing rather than sitting silent for minutes.
	 *
	 * The lines go to standard error, so that a report written to standard output stays exactly the
	 * report and nothing else. Each test writes its own line in two halves: the name when the test
	 * starts, and the verdict with the duration when it finishes.
	 *
	 * @param prefix What to write in front of every line, empty when nothing distinguishes this run.
	 * @returns The listener to hand `Runner.run`.
	 */
	private static _buildProgressListener(prefix: string): RunnerProgressListener {
		return {
			onTestStarted: (test) => {
				process.stderr.write(`${prefix}${test.id.padEnd(28)} ${test.name} ... `);
			},
			onTestFinished: (record) => {
				process.stderr.write(`${record.result.verdict} (${record.durationMs} ms)\n`);
			},
		};
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
	 * The one model measured is reported as one document however many runs it took: the summary,
	 * what was run, and one table per group carrying the detail of everything that did not pass.
	 * One model measured with streaming both on and off produces three runs and is still one
	 * report, with `MergedRecords` folding the runs back into one list of records.
	 *
	 * @param runs Every run this invocation produced.
	 * @param rawOptions The subcommand's options.
	 * @param endpoint The endpoint that was tested.
	 * @param args The command line arguments as they were typed.
	 * @param invokedName The name this program was invoked under.
	 * @returns The report, ready to write.
	 */
	private static _renderReport(
		runs: readonly ConformanceRun[],
		rawOptions: RawConformanceOptions,
		endpoint: string,
		args: readonly string[],
		invokedName: string,
	): string {
		const commandLine = ReportParameters.commandLine(args, invokedName);
		const records = MergedRecords.of(runs);
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
					parameters: ReportParameters.ofConformanceOptions(rawOptions),
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

}
