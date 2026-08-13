import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { AccountOutputFormatter, type AccountOutputFormat } from '../account/account_output_format.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountKeyCommand — generates this machine's account key pair
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli account_key` needs to know. */
export type AccountKeyCommandOptions = {
	/** Where to keep the key pair. */
	keyFilePath: string;
	/** Whether to overwrite a key pair that is already there. */
	isForced: boolean;
	/** How to write the answer out. */
	format: AccountOutputFormat;
};

/**
 * Generates the key pair that is this participant's account, and prints the account identifier it
 * produces.
 *
 * It talks to nothing: an account identifier is a digest of its own public key, so it exists as soon
 * as the key pair does, and the gateway learns about it later through `account_register`.
 */
export class AccountKeyCommand {
	/**
	 * Runs the command.
	 *
	 * @param options Where to keep the key pair, whether to overwrite one, and how to print.
	 * @returns Nothing.
	 * @throws {Error} If a key pair is already there and `--force` was not given.
	 */
	static async run(options: AccountKeyCommandOptions): Promise<void> {
		const stored = await AccountKeyFile.create(options.keyFilePath, options.isForced);
		console.log(AccountOutputFormatter.format([
			['account identifier', stored.accountId],
			['signature algorithm', stored.signatureAlgorithmName],
			['public key', stored.publicKeySpkiBase64],
			['kept in', options.keyFilePath],
			['generated at', stored.createdAt],
		], {
			accountId: stored.accountId,
			signatureAlgorithmName: stored.signatureAlgorithmName,
			publicKeySpkiBase64: stored.publicKeySpkiBase64,
			keyFilePath: options.keyFilePath,
			createdAt: stored.createdAt,
		}, options.format));
		if (options.format === 'text') {
			console.log('');
			console.log('This file is the account. Anyone holding it can spend what the account has earned, and losing it loses the account.');
			console.log('Register it with the central gateway using: consumer_cli account_register');
		}
	}
}
