// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// local imports
import { ServerCommand } from './commands/server_command.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the consumer_openai command line program: server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The subcommand names this program dispatches to. */
const subcommandNames = ['server'] as const;

/**
 * The command line program of `@webai/consumer-openai`: `server` serves the OpenAI-compatible
 * completion interface in front of the cluster. The latency benchmark against another
 * OpenAI-compatible endpoint lives outside this package altogether, as the `benchmark`
 * subcommand of `@webai/openai-api-tool`, since it measures any server that speaks the
 * OpenAI-compatible API rather than this one in particular.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @param programName The name to print in every usage line and every error message. Defaults
	 * to `consumer_openai`, which is what this program is called when it is run on its own. The
	 * `webai-at-home` program passes its own name instead, so a person who typed
	 * `webai-at-home consumer_openai` is told about the command they actually ran. See issue #171.
	 * @param serverCommandName The name to print for the `server` subcommand in particular.
	 * Defaults to this program's name followed by `server`, which is what a person typed to reach
	 * it. `webai-at-home serve` reaches the same subcommand by a different name and passes that
	 * name here, so its usage line reads `webai-at-home serve` rather than `webai-at-home server`,
	 * a command nobody can type.
	 * @returns Nothing, once the chosen subcommand has finished.
	 */
	static async run(
		args: string[] = process.argv.slice(2),
		programName = 'consumer_openai',
		serverCommandName = `${programName} server`,
	): Promise<void> {
		const [subcommand, ...rest] = args;
		if (subcommand === 'server') {
			await ServerCommand.run(rest, serverCommandName);
			return;
		}
		if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
			Cli._printUsage(programName);
			process.exitCode = subcommand === undefined ? 1 : 0;
			return;
		}
		console.error(`Unknown command: ${subcommand}\n`);
		Cli._printUsage(programName);
		process.exitCode = 1;
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `npx`, and the `bin` symlink `npm install` creates for it, invoke this file through a
	 * symlink under `node_modules/.bin`, so `process.argv[1]` is the symlink path while
	 * `import.meta.url` is Node's already-resolved real path. Comparing both sides after
	 * resolving symlinks handles that invocation the same as running this file directly.
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

	/**
	 * Prints the one subcommand this program accepts, and where to find its own options.
	 *
	 * @param programName The name to print in the usage line, so it names the command the person
	 * actually typed.
	 */
	private static _printUsage(programName: string): void {
		console.log(`Usage: ${programName} <command> [options]`);
		console.log();
		console.log('Commands:');
		console.log(`  ${subcommandNames[0]}      serve the OpenAI-compatible completion interface in front of the webai-at-home cluster`);
		console.log();
		console.log(`Run "${programName} <command> --help" for the command's own options.`);
		console.log('The latency benchmark is the benchmark subcommand of the openai_api_tool command line program.');
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
