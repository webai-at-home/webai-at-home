import ChildProcess from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { Command } from 'commander';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExperimentOneConnect — runs experiment one of issue #213 against one target model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The result of one run of experiment one against one target model.
 */
export type ExperimentOneResult = {
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
 * Experiment one of [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213):
 * connect the Codex command-line program to one target model and complete one whole turn with a
 * question that needs no tool at all. Every file it writes goes under `data/<target_model>/`.
 */
export class ExperimentOneConnect {
	/** The question asked in experiment one. It needs no tool, so only the connection is tested. */
	static readonly question = 'Reply with exactly one word and nothing else: ready';

	/** The folder of this package, holding `target_models/`, `data/`, and `src/`. */
	static readonly packageDirectory = Path.resolve(__dirname, '..');

	/** The folder holding one configuration file per target model, which is committed. */
	static readonly targetModelsDirectory = Path.join(ExperimentOneConnect.packageDirectory, 'target_models');

	/**
	 * The folder given to the Codex command-line program as its `CODEX_HOME`. It is generated, it
	 * holds a copy of every target model configuration file, and it is never committed.
	 */
	static readonly codexHomeDirectory = Path.join(ExperimentOneConnect.packageDirectory, 'codex_home');

	/**
	 * Runs experiment one against one target model and writes the recorded run under `data/`.
	 *
	 * @param targetModelName The target model to run against: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @returns The result of the run, already written to disk.
	 */
	static run(targetModelName: string): ExperimentOneResult {
		const configurationPath = Path.join(ExperimentOneConnect.targetModelsDirectory, `${targetModelName}.config.toml`);
		if (Fs.existsSync(configurationPath) === false) {
			throw new Error(`no such target model: ${targetModelName}, expected ${configurationPath}`);
		}

		ExperimentOneConnect._prepareCodexHome();

		const outputDirectory = Path.join(ExperimentOneConnect.packageDirectory, 'data', targetModelName);
		Fs.mkdirSync(outputDirectory, {
			recursive: true,
		});

		const lastMessagePath = Path.join(outputDirectory, 'experiment_one_last_message.txt');
		const eventsPath = Path.join(outputDirectory, 'experiment_one_events.jsonl');
		const standardErrorPath = Path.join(outputDirectory, 'experiment_one_stderr.txt');
		const resultPath = Path.join(outputDirectory, 'experiment_one_result.txt');

		const startedAt = Date.now();
		const codexRun = ChildProcess.spawnSync(
			'codex',
			[
				'exec',
				'--profile', targetModelName,
				'--cd', ExperimentOneConnect.packageDirectory,
				'--sandbox', 'read-only',
				'--skip-git-repo-check',
				'--json',
				'--output-last-message', lastMessagePath,
				ExperimentOneConnect.question,
			],
			{
				env: {
					...process.env,
					CODEX_HOME: ExperimentOneConnect.codexHomeDirectory,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		const finishedAt = Date.now();

		Fs.writeFileSync(eventsPath, codexRun.stdout ?? '');
		Fs.writeFileSync(standardErrorPath, codexRun.stderr ?? '');

		const result: ExperimentOneResult = {
			targetModelName: targetModelName,
			question: ExperimentOneConnect.question,
			exitCode: codexRun.status ?? 1,
			seconds: Math.round((finishedAt - startedAt) / 1000),
			codexVersion: ExperimentOneConnect._readCodexVersion(),
			lastMessage: ExperimentOneConnect._readTextFile(lastMessagePath),
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
	 * Parses the command line, runs experiment one against the named target model, and prints the
	 * result. The exit code of this program is the exit code of the Codex command-line program.
	 *
	 * @returns Nothing.
	 */
	static main(): void {
		const command = new Command();
		command
			.name('experiment_one_connect')
			.description('Experiment one of issue #213: connect the Codex command-line program to one target model')
			.argument('<target_model>', 'the target model to run against: lmstudio, ollama, or webai_at_home')
			.action((targetModelName: string) => {
				console.log(`target model: ${targetModelName}`);
				console.log(`question: ${ExperimentOneConnect.question}`);
				console.log('');

				const result = ExperimentOneConnect.run(targetModelName);

				console.log(`exit code: ${result.exitCode}`);
				console.log(`seconds: ${result.seconds}`);
				console.log(`codex version: ${result.codexVersion}`);
				console.log('');
				console.log('--- last message ---');
				console.log(result.lastMessage);
				console.log('--- errors recorded, if any ---');
				console.log(ExperimentOneConnect._readRecordedErrors(result.targetModelName));

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
	 * Copies every target model configuration file into the generated `codex_home` folder, which is
	 * the folder given to the Codex command-line program as its `CODEX_HOME`. The two folders are
	 * kept apart because the Codex command-line program writes its own sessions, logs, databases,
	 * and downloaded documentation into its `CODEX_HOME`, and none of that belongs next to the
	 * committed target model configuration files.
	 *
	 * @returns Nothing.
	 */
	private static _prepareCodexHome(): void {
		Fs.mkdirSync(ExperimentOneConnect.codexHomeDirectory, {
			recursive: true,
		});
		for (const fileName of Fs.readdirSync(ExperimentOneConnect.targetModelsDirectory)) {
			if (fileName.endsWith('.config.toml') === false) {
				continue;
			}
			Fs.copyFileSync(
				Path.join(ExperimentOneConnect.targetModelsDirectory, fileName),
				Path.join(ExperimentOneConnect.codexHomeDirectory, fileName),
			);
		}
	}

	/**
	 * Reads the version of the installed Codex command-line program.
	 *
	 * @returns The version line it prints, or `unknown` when it cannot be run.
	 */
	private static _readCodexVersion(): string {
		const versionRun = ChildProcess.spawnSync('codex', ['--version'], {
			encoding: 'utf8',
		});
		if (versionRun.status !== 0) {
			return 'unknown';
		}
		return (versionRun.stdout ?? '').trim();
	}

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
		const eventsPath = Path.join(ExperimentOneConnect.packageDirectory, 'data', targetModelName, 'experiment_one_events.jsonl');
		const eventsText = ExperimentOneConnect._readTextFile(eventsPath);
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

ExperimentOneConnect.main();
