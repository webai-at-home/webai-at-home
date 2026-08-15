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
import { GenerationControlProbeCache } from './generation_control_probe_cache.js';
import { coreProfile } from './profiles/core.js';
import { parametersProfile } from './profiles/parameters.js';
import { sdkProfile } from './profiles/sdk.js';
import { streamingProfile } from './profiles/streaming.js';
import { structuredOutputProfile } from './profiles/structured_output.js';
import { toolsProfile } from './profiles/tools.js';
import { TerminalReporter } from './reporter/terminal.js';
import { Runner } from './runner.js';
import { ToolCallProbeCache } from './tool_call_probe_cache.js';
import type { ConformanceTest, TestContext } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the openai_conformance_test command line program
//
//	Points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports
//	which parts of the protocol that server actually honours, per issue #181. Unlike every other
//	command line program in this repository, this one has no subcommand: section 33 of issue #181
//	shapes it as one command with options, `openai-conformance-test [options]`, and that shape is
//	kept here.
//
//	Run with:
//	  ./src/cli.ts --model llm_llama3_2_1b_full
//	  ./src/cli.ts --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
//	or, from the workspace:
//	  npm run core --workspace @webai/openai-conformance-test -- --model llm_llama3_2_1b_full
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every profile this package can run today. `packages/openai_conformance_test/CONTEXT.md` names which milestone adds the next one. */
const knownProfiles: ReadonlyMap<string, readonly ConformanceTest[]> = new Map([
	['core', coreProfile],
	['streaming', streamingProfile],
	['tools', toolsProfile],
	['parameters', parametersProfile],
	['structured_output', structuredOutputProfile],
	['sdk', sdkProfile],
]);

/** The options `Cli.run` accepts, exactly as commander parses them. */
export type RawCliOptions = RawSharedOptions & {
	/** The model identifier to request. */
	model: string;
	/** Which profile to run. */
	profile: string;
	/** How many times a tool call or generation control probe repeats its prompt, still as text. */
	repeats: string;
};

/** The `openai_conformance_test` command line program. */
export class Cli {
	/**
	 * Parses the command line, runs the named profile against the named endpoint, and prints the
	 * report.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the arguments
	 * this process was started with.
	 * @returns Nothing, once the report has been printed. Sets `process.exitCode` to `1` when the
	 * command line itself was unusable, such as a missing `-m/--model` or an unknown `-p/--profile`,
	 * reported in words rather than as a stack trace.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Command();
		program
			.name('openai_conformance_test')
			.description('Points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol it actually honours.')
			.option('-m, --model <name>', 'the model identifier to request', process.env.OPENAI_MODEL);
		program.addOption(program.createOption('-p, --profile <name>', `which group of tests to run: ${[...knownProfiles.keys()].join(', ')}`).default('core'));
		program.option('-r, --repeats <number>', 'how many times a tool call or generation control probe repeats its prompt', '3');
		SharedOptions.addEndpointOptions(program);
		SharedOptions.addFormatOption(program);

		program.action(async (rawOptions: RawCliOptions) => {
			await Cli._runProfile(rawOptions);
		});

		try {
			await program.parseAsync(args, { from: 'user' });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 1;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Validates `rawOptions`, runs the named profile, and prints the report.
	 *
	 * @param rawOptions The command line options, exactly as commander parsed them.
	 * @returns Nothing, once the report has been printed.
	 * @throws {Error} If `-m/--model` is missing, `-p/--profile` names a profile that does not
	 * exist yet, or `-f/--format` names a format this milestone has not written a reporter for.
	 */
	private static async _runProfile(rawOptions: RawCliOptions): Promise<void> {
		if (rawOptions.model === undefined || rawOptions.model.trim() === '') {
			throw new Error('-m/--model is required, or set the OPENAI_MODEL environment variable');
		}
		const profile = knownProfiles.get(rawOptions.profile);
		if (profile === undefined) {
			throw new Error(`-p/--profile must be one of ${[...knownProfiles.keys()].join(', ')}, got "${rawOptions.profile}"`);
		}
		if (rawOptions.format !== 'text') {
			throw new Error(`-f/--format "${rawOptions.format}" is not written yet; only "text" is`);
		}

		const target = SharedOptions.buildTarget(rawOptions);
		const openaiPackageClient = new OpenaiPackageClient(target);
		const context: TestContext = {
			rawHttpClient: new RawHttpClient(target),
			openaiPackageClient,
			modelId: rawOptions.model,
			toolCallProbeCache: new ToolCallProbeCache(openaiPackageClient.client, rawOptions.model, SharedOptions.positiveInteger(rawOptions.repeats, '--repeats')),
			generationControlProbeCache: new GenerationControlProbeCache(openaiPackageClient.client, rawOptions.model, SharedOptions.positiveInteger(rawOptions.repeats, '--repeats')),
		};

		const records = await Runner.run(profile, context);
		console.log(TerminalReporter.render(records, { endpoint: target.baseUrl, modelId: rawOptions.model }));
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
