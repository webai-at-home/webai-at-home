import { AccountIdentityFile } from '@webai/protocol/account_identity_file';
import { AccountClient, type AccountClientOptions } from '../account/account_client.js';
import { AccountOutputFormatter, type AccountOutputFormat } from '../account/account_output_format.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountRegisterCommand — tells the central gateway about this machine's public key
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli account_register` needs to connect and where to read the profile from. */
export type AccountRegisterCommandOptions = AccountClientOptions & {
	/** Where the account profile is kept, as `default.identity.json` in the configuration directory. */
	identityFilePath: string;
	/** How to write the answer out. */
	format: AccountOutputFormat;
};

/**
 * Registers this machine's public key with the central gateway.
 *
 * The display name and the email address are read from `default.identity.json` in the configuration
 * directory rather than given on the command line, so they are stated once in a file and not retyped
 * on every run. A configuration directory with no such file registers with both of them empty, which
 * is the same anonymous profile a worker browser tab registers with.
 *
 * Registering a public key the gateway already knows changes nothing and reports the profile it
 * already holds, so running this twice is harmless. Editing a profile after the fact is not part of
 * Version 1: registration does not prove that the sender holds the private key, so it must not be
 * able to rewrite the email address or display name of an account somebody else owns.
 */
export class AccountRegisterCommand {
	/**
	 * Runs the command.
	 *
	 * @param options Where to connect, where to read the profile from, and how to print.
	 * @returns Nothing.
	 * @throws {CliError} If the connection, the token, or the registration is refused.
	 */
	static async run(options: AccountRegisterCommandOptions): Promise<void> {
		// Read before the connection opens, so an identity file this program cannot read stops the
		// command with that as the reason, rather than half-way through the conversation with the gateway.
		const identity = AccountIdentityFile.read(options.identityFilePath);
		const client = new AccountClient(options);
		try {
			await client.connect();
			const registered = await client.registerAccount(identity.emailAddress, identity.displayName);
			console.log(AccountOutputFormatter.format([
				['account identifier', registered.account.accountId],
				['was created now', registered.isNewAccount ? 'yes' : 'no, this gateway already held it'],
				['display name', registered.account.displayName === '' ? '(none)' : registered.account.displayName],
				['email address', registered.account.emailAddress === '' ? '(none)' : registered.account.emailAddress],
				['registered at', registered.account.createdAt],
			], {
				account: registered.account,
				isNewAccount: registered.isNewAccount,
			}, options.format));
		} finally {
			client.close();
		}
	}
}
