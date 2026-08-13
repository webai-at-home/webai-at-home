import { AccountIdentity, type ClientMessage, type GatewayMessage, type ProtocolError, type ProtocolErrorCode } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import WebSocket from 'ws';
import type { TaskSocket } from '../gateway_connection/consumer_client.js';
import { CliError, type CliExitCode } from '../libs/cli_errors.js';
import { AccountKeyFile, type LoadedAccountKey } from '@webai/protocol/account_key_file';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountClient — one connection that authenticates an account and asks it questions
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What opening one account connection to the central gateway needs. */
export type AccountClientOptions = {
	/** The central gateway's WebSocket address. */
	url: string;
	/** The bearer token every connection presents before anything else. */
	authToken: string;
	/** How long to wait for the gateway to answer anything, in milliseconds. */
	timeoutMs: number;
	/** Where this participant's key pair is kept. */
	keyFilePath: string;
	/**
	 * How to build the connection. Left out, a real `ws` connection to `url` is opened.
	 *
	 * It is here so a test can drive this client with a connection of its own, the way the tests of
	 * `ConsumerClient` and `ObserverClient` already do, rather than needing a gateway to talk to.
	 */
	socketFactory?: (url: string) => TaskSocket;
};

/**
 * Speaks the account side of the gateway protocol over one short-lived connection.
 *
 * Every accounting command does the same three things before it can ask its own question: open a
 * connection, present the shared token, and prove which account is on the connection by signing the
 * challenge the gateway hands back. That sequence lives here once, so no command repeats it, and no
 * command has to remember that reading a balance is refused until the account is authenticated.
 *
 * The connection is deliberately not kept: a command asks one question and ends.
 */
export class AccountClient {
	/** The answers still being waited for, by the frame identifier each will answer. */
	private readonly pendingAnswers = new Map<string, { resolve: (message: GatewayMessage) => void; reject: (error: CliError) => void }>();
	/** The connection, once it is open. */
	private socket: TaskSocket | undefined;
	/** The key pair read from the file, once it has been read. */
	private accountKey: LoadedAccountKey | undefined;

	/**
	 * @param options Where to connect, what to present, and where the key pair is kept.
	 */
	constructor(private readonly options: AccountClientOptions) { }

	/**
	 * Opens the connection and presents the shared token.
	 *
	 * @returns Nothing.
	 * @throws {CliError} If the connection fails, the token is refused, or the gateway does not answer
	 * in time.
	 */
	async connect(): Promise<void> {
		const socket = this.options.socketFactory?.(this.options.url) ?? (new WebSocket(this.options.url) as unknown as TaskSocket);
		this.socket = socket;
		socket.onmessage = (event): void => this.readFrame(typeof event.data === 'string' ? event.data : event.data.toString());
		socket.onclose = (): void => this.failEveryPendingAnswer(new CliError('The connection to the central gateway closed', 1));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new CliError(`Timed out after ${String(this.options.timeoutMs)}ms waiting for the central gateway to accept the connection`, 3)), this.options.timeoutMs);
			timer.unref?.();
			socket.onopen = (): void => {
				clearTimeout(timer);
				resolve();
			};
			socket.onerror = (): void => {
				clearTimeout(timer);
				reject(new CliError(`The central gateway at ${this.options.url} could not be reached`, 1));
			};
		});
		await this.request({ type: 'deviceAuthenticate', token: this.options.authToken });
	}

	/**
	 * Proves which account is on this connection, by signing the challenge the gateway hands back.
	 *
	 * @returns The account identifier the connection now authenticates as.
	 * @throws {CliError} If the gateway refuses the account or the signature.
	 * @throws {Error} If there is no key pair on this machine to sign with.
	 */
	async authenticateAccount(): Promise<string> {
		const accountKey = await this.readAccountKey();
		const challenge = await this.request({ type: 'account.challenge.request' });
		if (challenge.type !== 'account.challenge') {
			throw new CliError(`The central gateway answered a challenge request with ${challenge.type}`, 4);
		}
		const signatureBase64 = await AccountIdentity.signChallenge(accountKey.stored.signatureAlgorithmName, accountKey.privateKey, challenge.challenge);
		await this.request({ type: 'account.authenticate', accountId: accountKey.stored.accountId, signatureBase64 });
		return accountKey.stored.accountId;
	}

	/**
	 * Registers this machine's public key as an account, or reports the account it already has.
	 *
	 * @param emailAddress The email address for the profile. May be empty.
	 * @param displayName The display name for the profile. May be empty.
	 * @returns The gateway's answer.
	 * @throws {CliError} If the gateway refuses the registration.
	 */
	async registerAccount(emailAddress: string, displayName: string): Promise<Extract<GatewayMessage, { type: 'account.registered' }>> {
		const accountKey = await this.readAccountKey();
		const answer = await this.request({
			type: 'account.register',
			signatureAlgorithmName: accountKey.stored.signatureAlgorithmName,
			publicKeySpkiBase64: accountKey.stored.publicKeySpkiBase64,
			emailAddress,
			displayName,
		});
		if (answer.type !== 'account.registered') {
			throw new CliError(`The central gateway answered a registration with ${answer.type}`, 4);
		}
		return answer;
	}

	/**
	 * Sends one message and waits for the answer to that exact frame.
	 *
	 * @param message The message to send.
	 * @returns The gateway message that answered it.
	 * @throws {CliError} If the gateway answers with an error, or does not answer in time.
	 */
	async request(message: ClientMessage): Promise<GatewayMessage> {
		const socket = this.socket;
		if (socket === undefined) {
			throw new CliError('The account connection was used before it was opened', 4);
		}
		const frame = Envelope.fromClient(message);
		return await new Promise<GatewayMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingAnswers.delete(frame.id);
				reject(new CliError(`Timed out after ${String(this.options.timeoutMs)}ms waiting for the central gateway to answer ${message.type}`, 3));
			}, this.options.timeoutMs);
			timer.unref?.();
			this.pendingAnswers.set(frame.id, {
				resolve: (answer): void => {
					clearTimeout(timer);
					resolve(answer);
				},
				reject: (error): void => {
					clearTimeout(timer);
					reject(error);
				},
			});
			socket.send(JSON.stringify(frame));
		});
	}

	/** Closes the connection, whatever state it is in. */
	close(): void {
		this.socket?.close();
	}

	/**
	 * Reads this machine's key pair, once, however many times a command asks for it.
	 *
	 * @returns The key pair.
	 */
	private async readAccountKey(): Promise<LoadedAccountKey> {
		this.accountKey ??= await AccountKeyFile.read(this.options.keyFilePath);
		return this.accountKey;
	}

	/**
	 * Matches one arriving frame to the request it answers.
	 *
	 * An error the gateway sends is what rejects the request that drew it, so a command reports what
	 * the gateway actually said rather than a timeout.
	 *
	 * @param raw The frame as it arrived.
	 */
	private readFrame(raw: string): void {
		let body: GatewayMessage;
		let inReplyToMessageId: string | undefined;
		try {
			const frame = JSON.parse(raw) as { body: GatewayMessage; inReplyToMessageId?: string };
			body = frame.body;
			inReplyToMessageId = frame.inReplyToMessageId;
		} catch {
			this.failEveryPendingAnswer(new CliError('The central gateway sent a frame this program could not read', 4));
			return;
		}
		// A message the gateway pushed on its own initiative answers nothing this command asked, so it
		// is ignored rather than mistaken for an answer.
		if (inReplyToMessageId === undefined) {
			return;
		}
		const pending = this.pendingAnswers.get(inReplyToMessageId);
		if (pending === undefined) {
			return;
		}
		this.pendingAnswers.delete(inReplyToMessageId);
		if (body.type === 'error') {
			pending.reject(new CliError(AccountClient.explain(body), AccountClient.exitCodeForError(body.code)));
			return;
		}
		pending.resolve(body);
	}

	/**
	 * Fails every request still waiting, when the connection can no longer answer any of them.
	 *
	 * @param error What to fail them with.
	 */
	private failEveryPendingAnswer(error: CliError): void {
		for (const pending of this.pendingAnswers.values()) {
			pending.reject(error);
		}
		this.pendingAnswers.clear();
	}

	/**
	 * Turns one gateway error into the sentence a user reads.
	 *
	 * @param error The error the gateway sent.
	 * @returns What to print, with advice for the codes where advice is what the user needs.
	 */
	private static explain(error: ProtocolError): string {
		if (error.code === 'ACCOUNT_NOT_FOUND') {
			return `${error.message}. Run "consumer_cli account_register" first.`;
		}
		if (error.code === 'ACCOUNT_REQUIRED') {
			return `${error.message}.`;
		}
		return `${error.code}: ${error.message}`;
	}

	/**
	 * Maps a protocol error code to the exit code a command ends with.
	 *
	 * It follows `GatewaySession`, which `status` and `capacity` already use, so every command of this
	 * program fails with the same code for the same reason.
	 *
	 * @param code The error code the gateway reported.
	 * @returns The exit code to end with.
	 */
	private static exitCodeForError(code: ProtocolErrorCode): CliExitCode {
		if (code === 'INVALID_MESSAGE') return 4;
		if (code === 'AUTHORISATION' || code === 'AUTHENTICATION_REQUIRED' || code === 'ACCOUNT_REQUIRED' || code === 'ACCOUNT_SIGNATURE_REJECTED') return 2;
		return 1;
	}
}
