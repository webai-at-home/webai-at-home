// node imports
import Readline from 'node:readline';

// local imports
import { CompletionSender } from '../clients/completion_sender.js';
import { SharedOptions, type RawEndpointOptions } from '../shared_options.js';
import { ChatSession, type LineSource } from './chat_session.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatCommand — sends turns to one model and streams each answer back to the terminal
//
//	This subcommand answers "what does this endpoint actually answer", which is a different
//	question from the one `conformance` answers and from the one `benchmark` answers. Nothing it
//	prints is a verdict and nothing it prints is a measurement to compare runs by: it shows what
//	came back, and the timings under each answer are there for the person reading them.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `chat` subcommand's options, exactly as commander parses them. */
export type RawChatOptions = RawEndpointOptions & {
	/**
	 * Exactly one model identifier. `undefined` when neither `-m/--model` nor `OPENAI_MODEL` named
	 * one.
	 */
	model?: string;
	/** The system message sent as the first message of the session, when one was asked for. */
	system?: string;
	/** The one turn to send before leaving, when `-p/--prompt` was given. */
	prompt?: string;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatCommand
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Sends turns to one model and streams each answer back to the terminal. */
export class ChatCommand {
	/**
	 * Runs the `chat` subcommand: either the one turn `-p/--prompt` named, or the session somebody
	 * types turns into.
	 *
	 * @param rawOptions The subcommand's options, exactly as commander parsed them.
	 * @returns Nothing, once the session has ended or the one turn has been written out.
	 * @throws {Error} If no model was named, or if `-m/--model` named more than one model. A turn the
	 * endpoint would not answer is reported inside the session and never throws, since a session that
	 * ended on the first refusal would throw away the history somebody typed.
	 */
	static async run(rawOptions: RawChatOptions): Promise<void> {
		const modelId = ChatCommand._readSingleModelId(rawOptions.model);
		const target = SharedOptions.buildTarget(rawOptions);
		const client = CompletionSender.createClient(target);
		const sendTurn = ChatSession.streamedTurnSender(client, modelId);
		const write = (text: string): void => {
			process.stdout.write(text);
		};

		if (rawOptions.prompt !== undefined) {
			const session = new ChatSession({
				modelId,
				baseUrl: target.baseUrl,
				systemText: rawOptions.system,
				isInteractive: false,
				lines: ChatCommand.oneLineSource(rawOptions.prompt),
				write,
				sendTurn,
			});
			await session.run();
			return;
		}

		const readlineInterface = Readline.createInterface({
			input: process.stdin,
			terminal: process.stdin.isTTY === true,
		});
		try {
			const session = new ChatSession({
				modelId,
				baseUrl: target.baseUrl,
				systemText: rawOptions.system,
				isInteractive: true,
				lines: readlineInterface[Symbol.asyncIterator](),
				write,
				sendTurn,
			});
			await session.run();
		} finally {
			readlineInterface.close();
		}
	}

	/**
	 * Builds the line source of a `-p/--prompt` run: one turn, and then the end of the input.
	 *
	 * The one-turn run and the session are the same loop, fed differently, so that the two can never
	 * disagree about what is printed under an answer or about what is sent with a turn.
	 *
	 * @param promptText The one turn to send.
	 * @returns The line source to hand to a session.
	 */
	static oneLineSource(promptText: string): LineSource {
		let isRead = false;
		return {
			next: async (): Promise<{ done?: boolean; value?: string }> => {
				if (isRead === true) {
					return {
						done: true,
					};
				}
				isRead = true;
				return {
					done: false,
					value: promptText,
				};
			},
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the one model identifier `-m/--model` named.
	 *
	 * `conformance` and `benchmark` answer `list` by printing the identifiers the endpoint serves.
	 * `chat` has nowhere to print such a listing to, since it opens a session rather than writing a
	 * report, so `list` is refused here alongside the spellings that name several models.
	 *
	 * @param rawModel The `-m/--model` value, exactly as commander parsed it, `undefined` when
	 * neither the option nor `OPENAI_MODEL` named one.
	 * @returns The one model identifier to send to.
	 * @throws {Error} If no model was named, or if the value names more than one model.
	 */
	private static _readSingleModelId(rawModel: string | undefined): string {
		if (rawModel === undefined) {
			throw new Error('no model was named — give -m/--model one model identifier, or set OPENAI_MODEL');
		}
		if (rawModel.trim() === 'list') {
			throw new Error('chat sends turns to one model, so -m/--model takes one model identifier, got "list"');
		}
		return SharedOptions.readOneModelId(rawModel, 'chat');
	}
}
