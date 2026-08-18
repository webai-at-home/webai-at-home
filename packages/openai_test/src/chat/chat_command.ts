// npm imports
import Chalk from 'chalk';
import type OpenAI from 'openai';

// local imports
import { CompletionSender } from '../clients/completion_sender.js';
import type { CompletionResult } from '../completion_types.js';
import { SharedOptions, type RawEndpointOptions } from '../shared_options.js';

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
	 * Exactly one model identifier. A sweep makes no sense in a session someone is typing into.
	 * `undefined` when neither `-m/--model` nor `OPENAI_MODEL` named one.
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
	 * Sends the one turn `-p/--prompt` named and streams the answer.
	 *
	 * The session someone types into is not built yet. Until it is, a run without `-p/--prompt`
	 * says so and stops, rather than starting a session that cannot read a second turn.
	 *
	 * @param rawOptions The subcommand's options, exactly as commander parsed them.
	 * @returns Nothing, once the answer has been written out.
	 * @throws {Error} If no `-p/--prompt` was given, if `-m/--model` named more than one model, or
	 * if the request did not produce an answer.
	 */
	static async run(rawOptions: RawChatOptions): Promise<void> {
		const modelId = ChatCommand._readSingleModelId(rawOptions.model);
		if (rawOptions.prompt === undefined) {
			throw new Error(
				'the session to type turns into is not built yet — send one turn with -p/--prompt for now. See Milestone 6 of https://github.com/webai-at-home/webai-at-home/issues/208',
			);
		}

		const target = SharedOptions.buildTarget(rawOptions);
		const client = CompletionSender.createClient(target);
		const messages = ChatCommand.buildMessages(rawOptions.system, rawOptions.prompt);

		console.log(Chalk.bold(`${modelId} on ${target.baseUrl}`));
		// The answer is written out as it arrives, so a request that fails after its first piece has
		// already put text on the screen. The line is closed either way, so that what the endpoint
		// wrote and what went wrong with it never end up on the same line.
		let writtenCharacterCount = 0;
		try {
			const result = await CompletionSender.send({
				client,
				modelId,
				messages,
				mode: 'streamed',
				writePiece: (piece: string) => {
					writtenCharacterCount += piece.length;
					process.stdout.write(piece);
				},
			});
			process.stdout.write('\n');
			console.log(ChatCommand.renderTimings(result));
		} catch (error: unknown) {
			if (writtenCharacterCount > 0) {
				process.stdout.write('\n');
			}
			throw error;
		}
	}

	/**
	 * Builds the messages of a session that has had one turn typed into it.
	 *
	 * @param systemText The system message to open the session with, `undefined` when none was asked
	 * for.
	 * @param promptText The turn to send.
	 * @returns The messages to send, in the order they are sent.
	 */
	static buildMessages(systemText: string | undefined, promptText: string): OpenAI.ChatCompletionMessageParam[] {
		const messages: OpenAI.ChatCompletionMessageParam[] = [];
		if (systemText !== undefined) {
			messages.push({
				role: 'system',
				content: systemText,
			});
		}
		messages.push({
			role: 'user',
			content: promptText,
		});
		return messages;
	}

	/**
	 * Renders the one dimmed line printed under an answer.
	 *
	 * @param result What the request produced.
	 * @returns The line to print.
	 */
	static renderTimings(result: CompletionResult): string {
		const timeToFirstCharacter = `Time to First Character ${Math.round(result.timeToFirstCharacterMs)} ms`;
		const timeToLastCharacter = `Time to Last Character ${Math.round(result.timeToLastCharacterMs)} ms`;
		return Chalk.dim(`${timeToFirstCharacter}, ${timeToLastCharacter}, ${result.answer.length} characters`);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the one model identifier `-m/--model` named.
	 *
	 * `conformance` and `benchmark` sweep every model an endpoint serves. `chat` does not, because
	 * a session someone types turns into has one model behind it, so the sweep spellings this
	 * package accepts elsewhere are refused here by name rather than silently sending to the first
	 * of them.
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
		const isSweep = rawModel === 'all' || rawModel === 'list' || rawModel.includes(',') || rawModel.includes('*');
		if (isSweep === true) {
			throw new Error(`chat sends turns to one model, so -m/--model takes one model identifier, got "${rawModel}"`);
		}
		return rawModel;
	}
}
