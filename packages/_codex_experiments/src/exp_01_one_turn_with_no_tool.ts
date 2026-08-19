import Fs from 'node:fs';
import Path from 'node:path';
import { Command } from 'commander';
import { CodexRun } from './codex_run.js';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Exp01OneTurnWithNoTool — the first experiment of issue #213, run against one target model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The result of one run of `exp_01_one_turn_with_no_tool` against one target model.
 */
export type Exp01OneTurnWithNoToolResult = {
	/** The target model the run was made against: `lmstudio`, `ollama`, or `webai_at_home`. */
	targetModelName: string;
	/** The question given to the Codex command-line program, which needs no tool at all. */
	question: string;
	/** The exit code of the Codex command-line program, where zero means the turn completed. */
	exitCode: number;
	/** How long the run took, in seconds. */
	seconds: number;
	/** The version of the Codex command-line program that made the run. */
	codexVersion: string;
	/** The last message written by the Codex command-line program, empty when the turn failed. */
	lastMessage: string;
};

/**
 * `exp_01_one_turn_with_no_tool`, the first experiment of
 * [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213): connect the Codex
 * command-line program to one target model and complete one whole turn with a question that needs
 * no tool at all. Every file it writes goes under `data/<target_model>/`.
 */
export class Exp01OneTurnWithNoTool {
	/** The question asked by this experiment. It needs no tool, so only the connection is tested. */
	static readonly question = 'Reply with exactly one word and nothing else: ready';

	/** The name of this experiment, which names every file it writes. */
	static readonly experimentName = 'exp_01_one_turn_with_no_tool';

	/**
	 * Runs this experiment against one target model and writes the recorded run under `data/`.
	 *
	 * @param targetModelName The target model to run against: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @returns The result of the run, already written to disk.
	 */
	static run(targetModelName: string): Exp01OneTurnWithNoToolResult {
		if (CodexRun.targetModelExists(targetModelName) === false) {
			throw new Error(`no such target model: ${targetModelName}, expected ${CodexRun.targetModelFilePath(targetModelName)}`);
		}

		const outputDirectory = Path.join(CodexRun.packageDirectory, 'data', targetModelName);
		Fs.mkdirSync(outputDirectory, {
			recursive: true,
		});

		const lastMessagePath = Path.join(outputDirectory, `${Exp01OneTurnWithNoTool.experimentName}_last_message.txt`);
		const eventsPath = Path.join(outputDirectory, `${Exp01OneTurnWithNoTool.experimentName}_events.jsonl`);
		const standardErrorPath = Path.join(outputDirectory, `${Exp01OneTurnWithNoTool.experimentName}_stderr.txt`);
		const resultPath = Path.join(outputDirectory, `${Exp01OneTurnWithNoTool.experimentName}_result.txt`);

		const codexRunResult = CodexRun.execute([
			'--profile', targetModelName,
			'--cd', CodexRun.packageDirectory,
			'--sandbox', 'read-only',
			'--skip-git-repo-check',
			'--json',
			'--output-last-message', lastMessagePath,
			Exp01OneTurnWithNoTool.question,
		]);

		Fs.writeFileSync(eventsPath, codexRunResult.eventsText);
		Fs.writeFileSync(standardErrorPath, codexRunResult.standardErrorText);

		const result: Exp01OneTurnWithNoToolResult = {
			targetModelName: targetModelName,
			question: Exp01OneTurnWithNoTool.question,
			exitCode: codexRunResult.exitCode,
			seconds: codexRunResult.seconds,
			codexVersion: CodexRun.readVersion(),
			lastMessage: Exp01OneTurnWithNoTool._readTextFile(lastMessagePath),
		};

		const resultText = [
			`target model: ${result.targetModelName}`,
			`question: ${result.question}`,
			`exit code: ${result.exitCode}`,
			`seconds: ${result.seconds}`,
			`codex version: ${result.codexVersion}`,
			'',
		].join('\n');
		Fs.writeFileSync(resultPath, resultText);

		return result;
	}

	/**
	 * Parses the command line, runs this experiment against the named target model, and prints the
	 * result. The exit code of this program is the exit code of the Codex command-line program.
	 *
	 * @returns Nothing.
	 */
	static main(): void {
		const command = new Command();
		command
			.name(Exp01OneTurnWithNoTool.experimentName)
			.description('The first experiment of issue #213: one whole turn with a question that needs no tool')
			.argument('<target_model>', 'the target model to run against: lmstudio, ollama, or webai_at_home')
			.action((targetModelName: string) => {
				console.log(`target model: ${targetModelName}`);
				console.log(`question: ${Exp01OneTurnWithNoTool.question}`);
				console.log('');

				const result = Exp01OneTurnWithNoTool.run(targetModelName);

				console.log(`exit code: ${result.exitCode}`);
				console.log(`seconds: ${result.seconds}`);
				console.log(`codex version: ${result.codexVersion}`);
				console.log('');
				console.log('--- last message ---');
				console.log(result.lastMessage);
				console.log('--- errors recorded, if any ---');
				console.log(Exp01OneTurnWithNoTool._readRecordedErrors(result.targetModelName));

				process.exitCode = result.exitCode;
			});
		command.parse(process.argv);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads a text file written by the run, tolerating a file the run never created.
	 *
	 * @param filePath The file to read.
	 * @returns The contents of the file, trimmed, or an empty string when the file is missing.
	 */
	private static _readTextFile(filePath: string): string {
		if (Fs.existsSync(filePath) === false) {
			return '';
		}
		return Fs.readFileSync(filePath, 'utf8').trim();
	}

	/**
	 * Collects the `error` events out of the recorded events of a run, which is what says why a
	 * target model refused the turn.
	 *
	 * @param targetModelName The target model whose recorded events are read.
	 * @returns One line per error event, or an empty string when the run recorded none.
	 */
	private static _readRecordedErrors(targetModelName: string): string {
		const eventsPath = Path.join(
			CodexRun.packageDirectory,
			'data',
			targetModelName,
			`${Exp01OneTurnWithNoTool.experimentName}_events.jsonl`,
		);
		const eventsText = Exp01OneTurnWithNoTool._readTextFile(eventsPath);
		if (eventsText === '') {
			return '';
		}

		const errorLines: string[] = [];
		for (const eventLine of eventsText.split('\n')) {
			if (eventLine.includes('"error"') === false && eventLine.includes('turn.failed') === false) {
				continue;
			}
			errorLines.push(eventLine);
		}
		return errorLines.join('\n');
	}
}

Exp01OneTurnWithNoTool.main();
