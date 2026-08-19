import ChildProcess from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { Command } from 'commander';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExperimentOneConnect — runs experiment one of issue #213 against one destination
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The result of one run of experiment one against one destination.
 */
export type ExperimentOneResult = {
	/** The destination the run was made against: `lmstudio`, `ollama`, or `webai_at_home`. */
	destinationName: string;
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
 * connect the Codex command-line program to one destination and complete one whole turn with a
 * question that needs no tool at all. Every file it writes goes under `data/<destination>/`.
 */
export class ExperimentOneConnect {
	/** The question asked in experiment one. It needs no tool, so only the connection is tested. */
	static readonly question = 'Reply with exactly one word and nothing else: ready';

	/** The folder of this package, holding `destinations/`, `data/`, and `src/`. */
	static readonly packageDirectory = Path.resolve(__dirname, '..');

	/** The folder holding one configuration file per destination, which is committed. */
	static readonly destinationsDirectory = Path.join(ExperimentOneConnect.packageDirectory, 'destinations');

	/**
	 * The folder given to the Codex command-line program as its `CODEX_HOME`. It is generated, it
	 * holds a copy of every destination configuration file, and it is never committed.
	 */
	static readonly codexHomeDirectory = Path.join(ExperimentOneConnect.packageDirectory, 'codex_home');

	/**
	 * Runs experiment one against one destination and writes the recorded run under `data/`.
	 *
	 * @param destinationName The destination to run against: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @returns The result of the run, already written to disk.
	 */
	static run(destinationName: string): ExperimentOneResult {
		const configurationPath = Path.join(ExperimentOneConnect.destinationsDirectory, `${destinationName}.config.toml`);
		if (Fs.existsSync(configurationPath) === false) {
			throw new Error(`no such destination: ${destinationName}, expected ${configurationPath}`);
		}

		ExperimentOneConnect._prepareCodexHome();

		const outputDirectory = Path.join(ExperimentOneConnect.packageDirectory, 'data', destinationName);
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
				'--profile', destinationName,
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
			destinationName: destinationName,
			question: ExperimentOneConnect.question,
			exitCode: codexRun.status ?? 1,
			seconds: Math.round((finishedAt - startedAt) / 1000),
			codexVersion: ExperimentOneConnect._readCodexVersion(),
			lastMessage: ExperimentOneConnect._readTextFile(lastMessagePath),
		};

		const resultText = [
			`destination: ${result.destinationName}`,
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
	 * Parses the command line, runs experiment one against the named destination, and prints the
	 * result. The exit code of this program is the exit code of the Codex command-line program.
	 *
	 * @returns Nothing.
	 */
	static main(): void {
		const command = new Command();
		command
			.name('experiment_one_connect')
			.description('Experiment one of issue #213: connect the Codex command-line program to one destination')
			.argument('<destination>', 'the destination to run against: lmstudio, ollama, or webai_at_home')
			.action((destinationName: string) => {
				console.log(`destination: ${destinationName}`);
				console.log(`question: ${ExperimentOneConnect.question}`);
				console.log('');

				const result = ExperimentOneConnect.run(destinationName);

				console.log(`exit code: ${result.exitCode}`);
				console.log(`seconds: ${result.seconds}`);
				console.log(`codex version: ${result.codexVersion}`);
				console.log('');
				console.log('--- last message ---');
				console.log(result.lastMessage);
				console.log('--- errors recorded, if any ---');
				console.log(ExperimentOneConnect._readRecordedErrors(result.destinationName));

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
	 * Copies every destination configuration file into the generated `codex_home` folder, which is
	 * the folder given to the Codex command-line program as its `CODEX_HOME`. The two folders are
	 * kept apart because the Codex command-line program writes its own sessions, logs, databases,
	 * and downloaded documentation into its `CODEX_HOME`, and none of that belongs next to the
	 * committed destination configuration files.
	 *
	 * @returns Nothing.
	 */
	private static _prepareCodexHome(): void {
		Fs.mkdirSync(ExperimentOneConnect.codexHomeDirectory, {
			recursive: true,
		});
		for (const fileName of Fs.readdirSync(ExperimentOneConnect.destinationsDirectory)) {
			if (fileName.endsWith('.config.toml') === false) {
				continue;
			}
			Fs.copyFileSync(
				Path.join(ExperimentOneConnect.destinationsDirectory, fileName),
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
	 * destination refused the turn.
	 *
	 * @param destinationName The destination whose recorded events are read.
	 * @returns One line per error event, or an empty string when the run recorded none.
	 */
	private static _readRecordedErrors(destinationName: string): string {
		const eventsPath = Path.join(ExperimentOneConnect.packageDirectory, 'data', destinationName, 'experiment_one_events.jsonl');
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
