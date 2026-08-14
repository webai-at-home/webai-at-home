import Path from 'node:path';
import WebSocket from 'ws';
import { MessageLogger } from '@webai/protocol/message_logger';
import { ConsumerClient, type TaskSocket } from '../gateway_connection/consumer_client.js';
import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { TaskInputFactory, type TaskTypeName } from '../libs/task_input_factory.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SubmitCommand — submits one task to the central gateway and prints what comes back
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli submit` needs to submit one task and report on it. */
export type SubmitCommandOptions = {
	url: string;
	authToken: string;
	type: TaskTypeName;
	name: string;
	stream: boolean;
	input: string | undefined;
	/**
	 * Where this participant's account key pair is kept.
	 *
	 * A submission from a machine with no key pair there carries no account, and the stages its task
	 * runs are recorded against the shared development account.
	 */
	keyFilePath: string;
	/** The directory this command writes its message log into. */
	logsDirectory: string;
};

/**
 * Submits one task to the central gateway, prints every answer as formatted JSON, and closes
 * the connection once the task has either completed or failed.
 */
export class SubmitCommand {
	/**
	 * @param options The task to submit and the connection to submit it over.
	 * @returns Once the connection has been closed, after the task completed or failed.
	 */
	static async run(options: SubmitCommandOptions): Promise<void> {
		// Nothing is asked for when the option is absent, so a submission without it carries no
		// generation settings at all rather than a settings field stating the default.
		const generationSettings = options.stream === true ? { isStreaming: true } : undefined;
		const taskInput = TaskInputFactory.createTaskInput(options.type, options.input, generationSettings);

		// Read before the connection opens, so a key file this program cannot read stops the submission
		// with that as the reason, rather than half-way through the history with the gateway.
		const accountKeyPair = await AccountKeyFile.readIfPresent(options.keyFilePath);

		// Written under `~/.webai-at-home/` unless `--log-dir` says otherwise — not into this
		// package's own folder, which is a cache directory `npx` may clear (issue #170), and no
		// longer into whichever directory this command was run from (issue #171).
		const logsDirectory = options.logsDirectory;
		const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const messageLogger = new MessageLogger(Path.join(logsDirectory, `consumer-cli-${runTimestamp}.log_entry.jsonl`));

		return new Promise<void>((resolve) => {
			// The connection of the `ws` package names its event handlers with its own event
			// types, so it is read here through the smaller shape this client actually uses.
			const socket = new WebSocket(options.url) as unknown as TaskSocket;
			const client = new ConsumerClient(socket, {
				onMessage: (direction, message) => messageLogger.log(direction, { role: 'gateway' }, message.type, message),
				onRegistered: () => client.submit(taskInput),
				onTaskAccepted: (task) => console.log(JSON.stringify(task, null, 2)),
				onTaskUpdated: (update) => {
					console.log(JSON.stringify(update, null, 2));
					if (update.state === 'completed' || update.state === 'failed') client.close();
				},
				onError: (error) => {
					console.error(error.message);
					client.close();
				},
				onConnectionChange: (isConnected) => {
					if (isConnected === false) resolve();
				},
				onAccountSettled: (accountId) => {
					console.error(accountId === undefined
						? `Submitting with no account of its own, so the stages this task runs are recorded against the shared development account. Run "consumer_cli account_key" and "consumer_cli account_register" to have them recorded against you.`
						: `Submitting as ${accountId}.`);
				},
				onAccountNote: (note) => console.error(note),
			}, options.name, options.authToken, accountKeyPair);
		});
	}
}
