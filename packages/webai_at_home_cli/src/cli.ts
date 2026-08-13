#!/usr/bin/env node
// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// local imports
import { Cli as GatewayCli } from '@webai/gateway/dist/cli.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the webai-at-home command line program: gateway (milestone 0 throwaway)
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The subcommand names this throwaway program dispatches to. */
const subcommandNames = ['gateway'] as const;

/**
 * The command line program of `webai-at-home`, milestone 0.
 *
 * This is the de-risk gate for issue #170: it wires only the gateway, so publishing this package
 * and installing it in a folder outside this repository can prove that `npm pack` carries
 * `@webai/gateway` and `@webai/protocol` into the tarball whole, and that the gateway can still
 * resolve `onnxruntime-web` and serve its built browser pages once installed that way. The other
 * command line programs, and the fall-through to `consumer_cli`, are wired in milestone 2.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @returns Nothing, once the chosen subcommand has finished.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const [subcommand] = args;
		if (subcommand === 'gateway') {
			// Milestone 1 gives the gateway's own `Cli.run` an arguments parameter and stops it
			// from starting a Vite development server outside production. Until then, this
			// throwaway forces production mode so the gateway serves its already-built
			// `web/dist` assets, the only files this tarball carries.
			process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';
			await GatewayCli.run();
			return;
		}
		if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
			Cli._printUsage();
			process.exitCode = subcommand === undefined ? 1 : 0;
			return;
		}
		console.error(`Unknown command: ${subcommand}\n`);
		Cli._printUsage();
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

	/** Prints the one subcommand this throwaway program accepts. */
	private static _printUsage(): void {
		console.log('Usage: webai-at-home <command> [options]');
		console.log();
		console.log('Commands:');
		console.log(`  ${subcommandNames[0]}      start the central gateway`);
		console.log();
		console.log('This is the milestone 0 throwaway for issue #170: only "gateway" is wired so far.');
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
