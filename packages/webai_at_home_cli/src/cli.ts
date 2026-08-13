#!/usr/bin/env node
// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// npm imports
import * as Commander from 'commander';

// local imports
import { Cli as GatewayCli } from '@webai/gateway/dist/cli.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the webai-at-home command line program: gateway (milestone 0 throwaway)
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

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
	 * Every subcommand keeps its own options, exactly as `@webai/gateway`, `@webai/consumer-openai`,
	 * `@webai/worker-openai` and `@webai/consumer-cli` already declare them, so this program only
	 * has to recognise which one was named and hand the rest of the command line to it unchanged.
	 * `allowUnknownOption` and `passThroughOptions` keep this program's own parser from rejecting
	 * or reinterpreting options it does not itself declare, such as the gateway's `--port`.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @returns Nothing, once the chosen subcommand has finished.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Commander.Command('webai-at-home')
			.description(
				'Run one part of the WebAI@Home cluster. This is the milestone 0 throwaway for issue'
					+ ' #170: only "gateway" is wired so far.',
			)
			.enablePositionalOptions();

		program
			.command('gateway')
			.description('start the central gateway')
			.allowUnknownOption()
			.passThroughOptions()
			.argument('[gatewayArgs...]', "the gateway's own options")
			.action(async (gatewayArgs: string[]): Promise<void> => {
				await GatewayCli.run(gatewayArgs);
			});

		await program.parseAsync([process.argv[0] ?? '', process.argv[1] ?? '', ...args]);
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
}

if (Cli.isMainModule()) {
	await Cli.run();
}
