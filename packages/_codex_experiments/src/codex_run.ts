import ChildProcess from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CodexRun — the one way every experiment of this package runs the Codex command-line program
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one run of the Codex command-line program produced.
 */
export type CodexRunResult = {
	/** The exit code of the Codex command-line program, where zero means the turn completed. */
	exitCode: number;
	/** Everything the Codex command-line program wrote to its standard output, one event per line. */
	eventsText: string;
	/** Everything the Codex command-line program wrote to its standard error. */
	standardErrorText: string;
	/** How long the run took, in seconds. */
	seconds: number;
};

/**
 * Runs the Codex command-line program the way every experiment of this package runs it: against a
 * generated `CODEX_HOME` holding a copy of every committed target model file, and never against the
 * `CODEX_HOME` of the person running the experiment.
 */
export class CodexRun {
	/** The folder of this package, holding `target_models/`, `tasks/`, `data/`, and `src/`. */
	static readonly packageDirectory = Path.resolve(__dirname, '..');

	/** The folder holding one committed file per target model, which is the source of truth. */
	static readonly targetModelsDirectory = Path.join(CodexRun.packageDirectory, 'target_models');

	/**
	 * The folder given to the Codex command-line program as its `CODEX_HOME`. It is generated, it
	 * holds a copy of every target model file, and it is never committed.
	 */
	static readonly codexHomeDirectory = Path.join(CodexRun.packageDirectory, 'codex_home');

	/** The ending of every committed target model file name, before which the target model is named. */
	static readonly targetModelFileSuffix = '.target_model.toml';

	/**
	 * Says whether a target model of that name is committed under `target_models/`.
	 *
	 * @param targetModelName The target model to look for: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @returns True when the file exists, false otherwise.
	 */
	static targetModelExists(targetModelName: string): boolean {
		return Fs.existsSync(CodexRun.targetModelFilePath(targetModelName));
	}

	/**
	 * The path of the committed file describing one target model.
	 *
	 * @param targetModelName The target model to name: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @returns The path of the file, whether or not it exists.
	 */
	static targetModelFilePath(targetModelName: string): string {
		return Path.join(CodexRun.targetModelsDirectory, `${targetModelName}${CodexRun.targetModelFileSuffix}`);
	}

	/**
	 * Copies every `<target model>.target_model.toml` file into the generated `codex_home` folder as
	 * `<target model>.config.toml`, which is the name the Codex command-line program reads when it is
	 * given `--profile <target model>`. The two folders are kept apart because the Codex command-line
	 * program writes its own sessions, logs, databases, and downloaded documentation into its
	 * `CODEX_HOME`, and none of that belongs next to the committed files.
	 *
	 * @returns Nothing.
	 */
	static prepareCodexHome(): void {
		Fs.mkdirSync(CodexRun.codexHomeDirectory, {
			recursive: true,
		});
		for (const fileName of Fs.readdirSync(CodexRun.targetModelsDirectory)) {
			if (fileName.endsWith(CodexRun.targetModelFileSuffix) === false) {
				continue;
			}
			const targetModelName = fileName.slice(0, fileName.length - CodexRun.targetModelFileSuffix.length);
			Fs.copyFileSync(
				Path.join(CodexRun.targetModelsDirectory, fileName),
				Path.join(CodexRun.codexHomeDirectory, `${targetModelName}.config.toml`),
			);
		}
	}

	/**
	 * Runs `codex exec` once against the generated `CODEX_HOME`, with the given arguments.
	 *
	 * @param commandArguments The arguments given to `codex exec`, the prompt last.
	 * @returns What the run produced, already timed.
	 */
	static execute(commandArguments: string[]): CodexRunResult {
		CodexRun.prepareCodexHome();

		const startedAt = Date.now();
		const codexRun = ChildProcess.spawnSync('codex', ['exec', ...commandArguments], {
			env: {
				...process.env,
				CODEX_HOME: CodexRun.codexHomeDirectory,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		const finishedAt = Date.now();

		return {
			exitCode: codexRun.status ?? 1,
			eventsText: codexRun.stdout ?? '',
			standardErrorText: codexRun.stderr ?? '',
			seconds: Math.round((finishedAt - startedAt) / 1000),
		};
	}

	/**
	 * Reads the version of the installed Codex command-line program.
	 *
	 * @returns The version line it prints, or `unknown` when it cannot be run.
	 */
	static readVersion(): string {
		const versionRun = ChildProcess.spawnSync('codex', ['--version'], {
			encoding: 'utf8',
		});
		if (versionRun.status !== 0) {
			return 'unknown';
		}
		return (versionRun.stdout ?? '').trim();
	}
}
