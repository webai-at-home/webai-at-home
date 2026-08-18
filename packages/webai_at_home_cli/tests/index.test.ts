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
	/** Everything the process wrote to standard error, which is where commander reports an unknown command. */
	stderr: string;
};

/**
 * Runs this program with the given arguments in its own process, to completion, and reports what
 * it printed and exited with.
 *
 * Every command line program this program dispatches to answers `--help` by
 * calling `process.exit` itself, through commander's own default handling, which none of them
 * overrides. Calling `Cli.run` in this test process directly, the way every other test in this
 * repository calls the code it tests, would therefore end this test process itself partway
 * through the very first `--help` a test asked for, silently dropping every test after it. Running
 * out of process is what real usage already does — a real `npx webai-at-home gateway --help` is
 * its own process too — so this is not a workaround so much as testing the real thing.
 *
 * @param args The command line arguments to run this program with.
 * @returns The exit code, the standard output, and the standard error this program produced.
 */
const runCli = (args: string[]): Promise<CompletionResult> => new Promise((resolve, reject) => {
	const childProcess = ChildProcess.spawn('npx', ['tsx', 'src/cli.ts', ...args], {
		cwd: new URL('..', import.meta.url).pathname,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	childProcess.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
	childProcess.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
	childProcess.once('error', reject);
	childProcess.once('exit', (code) => resolve({ code, stdout, stderr }));
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
	Assert.match(stdout, /Usage: webai-at-home consumer_openai <command> \[options\]/);
	Assert.match(stdout, /server/);
});

Test('routes "worker_openai" to that program\'s own command line program, which prints its own real options', async () => {
	const { code, stdout } = await runCli(['worker_openai', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /--openai-base-url/);
	Assert.match(stdout, /--openai-model/);
});

Test('routes "consumer_cli" to that program\'s own command line program, which prints its own real commands', async () => {
	const { code, stdout } = await runCli(['consumer_cli', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /Usage: webai-at-home consumer_cli \[options\] \[command\]/);
	Assert.match(stdout, /submit/);
	Assert.match(stdout, /account_balance/);
});

Test('runs a consumer_cli command written behind the "consumer_cli" word, and prints that command\'s own real options', async () => {
	const { code, stdout } = await runCli(['consumer_cli', 'account_key', '--help']);
	Assert.equal(code, 0);
	Assert.match(stdout, /Usage: webai-at-home consumer_cli account_key \[options\]/);
	Assert.match(stdout, /--config_dir/);
});

// A consumer_cli command written without the "consumer_cli" word ahead of it used to run anyway,
// which is what made consumer_cli the one wrapped program with no name of its own at this level.
// It is now an unknown command like any other. The `--help` case is tested as well as the bare one
// because commander answers `--help` before it matches a first word against a subcommand at all:
// with its own automatic help handling left on, this printed this program's own help and exited 0,
// saying nothing about `account_key` not being a command here.
Test('refuses a consumer_cli command written without the "consumer_cli" word ahead of it, rather than running it anyway', async () => {
	for (const args of [['account_key', '--help'], ['account_key'], ['submit', '--help'], ['submit', '--task_type', 'dev_formula', '5']] as const) {
		const { code, stdout, stderr } = await runCli([...args]);
		Assert.equal(code, 1);
		Assert.match(stderr, new RegExp(`unknown command '${args[0]}'`));
		Assert.equal(stdout, '');
	}
});

Test('refuses a global option belonging to consumer_cli when it is written ahead of the "consumer_cli" word, where it no longer belongs', async () => {
	const { code, stderr } = await runCli(['--gateway-url', 'ws://localhost:1', 'account_key', '--help']);
	Assert.equal(code, 1);
	Assert.match(stderr, /unknown option '--gateway-url'/);
});

Test('prints its own top-level help, listing every wrapped program one line each, when given no arguments', async () => {
	const { code, stdout } = await runCli([]);
	Assert.equal(code, 1);
	Assert.match(stdout, /gateway \[gatewayArgs\.\.\.\]/);
	Assert.match(stdout, /consumer_openai \[consumerOpenaiArgs\.\.\.\]/);
	Assert.match(stdout, /worker_openai \[workerOpenaiArgs\.\.\.\]/);
	Assert.match(stdout, /consumer_cli \[consumerCliArgs\.\.\.\]/);
	// consumer_cli gets the one line every other wrapped program gets, and no more: its own nine
	// commands are listed by `webai-at-home consumer_cli --help`, the way every other wrapped
	// program's own commands are, and never expanded into this program's own help.
	Assert.doesNotMatch(stdout, /account_balance/);
	Assert.doesNotMatch(stdout, /log_statistics/);
});

Test('names itself, rather than the program it dispatched to, in the usage line of every one of them', async () => {
	for (const [args, expected] of [
		[['gateway', '--help'], /Usage: webai-at-home gateway \[options\]/],
		[['consumer_openai', 'server', '--help'], /Usage: webai-at-home consumer_openai server \[options\]/],
		[['worker_openai', '--help'], /Usage: webai-at-home worker_openai \[options\]/],
		[['consumer_cli', 'submit', '--help'], /Usage: webai-at-home consumer_cli submit \[options\] <input>/],
	] as const) {
		const { stdout } = await runCli([...args]);
		Assert.match(stdout, expected);
	}
});

Test('prints the version this package was published with, which is the version npx fetched', async () => {
	const { code, stdout } = await runCli(['--version']);
	Assert.equal(code, 0);
	Assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
	Assert.equal(stdout.trim(), Cli.readVersion());
});

Test('lists every command consumer_cli declares behind the "consumer_cli" word, straight from consumer_cli itself', async () => {
	const { stdout } = await runCli(['consumer_cli', '--help']);
	// Every command consumer_cli declares has to appear, `log_statistics` included: it was renamed
	// from `log_stats`, and a hand-written list is exactly what would have been left saying the old
	// name. This program keeps no list of its own to drift now — consumer_cli prints its own.
	for (const name of [
		'submit', 'status', 'capacity', 'log_statistics',
		'account_key', 'account_register', 'account_information', 'account_balance', 'account_history',
	]) {
		Assert.match(stdout, new RegExp(`\\n  ${name}[\\s|]`));
	}
});
