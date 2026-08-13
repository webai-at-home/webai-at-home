import Assert from 'node:assert/strict';
import ChildProcess from 'node:child_process';
import Test from 'node:test';
import { Cli } from '../src/cli.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the webai-at-home command line program
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What running this program to completion, out of process, produced. */
type CompletionResult = {
	/** The exit code the process finished with, or `null` if it was killed by a signal. */
	code: number | null;
	/** Everything the process wrote to standard output. */
	stdout: string;
};

/**
 * Runs this program with the given arguments in its own process, to completion, and reports what
 * it printed and exited with.
 *
 * Every one of the four command line programs this program dispatches to answers `--help` by
 * calling `process.exit` itself, through commander's own default handling, which none of them
 * overrides. Calling `Cli.run` in this test process directly, the way every other test in this
 * repository calls the code it tests, would therefore end this test process itself partway
 * through the very first `--help` a test asked for, silently dropping every test after it. Running
 * out of process is what real usage already does — a real `npx webai-at-home gateway --help` is
 * its own process too — so this is not a workaround so much as testing the real thing.
 *
 * @param args The command line arguments to run this program with.
 * @returns The exit code and standard output this program produced.
 */
const runCli = (args: string[]): Promise<CompletionResult> => new Promise((resolve, reject) => {
	const childProcess = ChildProcess.spawn('npx', ['tsx', 'src/cli.ts', ...args], {
		cwd: new URL('..', import.meta.url).pathname,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	childProcess.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
	childProcess.once('error', reject);
	childProcess.once('exit', (code) => resolve({ code, stdout }));
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('is not its own main module when imported by a test, rather than run directly', () => {
	Assert.equal(Cli.isMainModule(), false);
});

Test('routes "gateway" to the gateway\'s own command line program, which prints its own real options', async () => {
	const { code, stdout } = await runCli(['gateway', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /--port/);
	Assert.match(stdout, /--lease-ms/);
});

Test('routes "consumer_openai" to that program\'s own command line program, which prints its own real usage', async () => {
	const { code, stdout } = await runCli(['consumer_openai', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /consumer_openai <command> \[options\]/);
	Assert.match(stdout, /server/);
});

Test('routes "worker_openai" to that program\'s own command line program, which prints its own real options', async () => {
	const { code, stdout } = await runCli(['worker_openai', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /--openai-base-url/);
	Assert.match(stdout, /--model/);
});

Test('routes anything else to consumer_cli, including a subcommand this program has never heard of', async () => {
	const { code, stdout } = await runCli(['account_key', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /Usage: consumer_cli account_key \[options\]/);
});

Test('routes a global option written ahead of a consumer_cli subcommand to consumer_cli as well, rather than failing to match any subcommand of its own', async () => {
	const { code, stdout } = await runCli(['--url', 'ws://localhost:1', 'account_key', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /Usage: consumer_cli account_key \[options\]/);
});

Test('prints its own top-level help, listing all four programs, when given no arguments', async () => {
	const { code, stdout } = await runCli([]);
	Assert.equal(code, 1);
	Assert.match(stdout, /gateway/);
	Assert.match(stdout, /consumer_openai/);
	Assert.match(stdout, /worker_openai/);
	Assert.match(stdout, /consumer_cli commands/);
});
