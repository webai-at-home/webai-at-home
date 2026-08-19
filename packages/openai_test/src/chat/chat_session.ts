// npm imports
import type OpenAI from 'openai';

// local imports
import { CompletionSender } from '../clients/completion_sender.js';
import type { CompletionResult } from '../completion_types.js';
import { ChatRenderer } from './chat_renderer.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatSession — the loop that reads a turn, sends the history, and streams the answer back
//
//	Turns are read through a line iterator rather than through `readline/promises`'s `question`,
//	because `question` reads the first line of a piped standard input and then never settles, which
//	makes a session impossible to drive from a script or a test. The line iterator reads every line
//	and ends by itself when the input ends. Proved with raw output in Milestone 6 of
//	https://github.com/webai-at-home/webai-at-home/issues/208.
//
//	Everything the session reaches the outside world through — where turns come from, where text
//	goes, how a turn is sent — is handed to it, so the session itself needs neither a terminal nor
//	an endpoint to run.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Where the session's turns are read from, one line per turn. */
export type LineSource = {
	/**
	 * Reads the next line.
	 *
	 * @returns The next line, or `done` when there are no more lines to read.
	 */
	next(): Promise<{ done?: boolean; value?: string }>;
};

/** How the session sends one turn and receives the answer. */
export type ChatTurnSender = (
	messages: readonly OpenAI.ChatCompletionMessageParam[],
	writePiece: (piece: string) => void,
) => Promise<CompletionResult>;

/** What one session needs to run. */
export type ChatSessionOptions = {
	/** The one model identifier turns are sent to, named in the opening lines. */
	readonly modelId: string;
	/** The endpoint the model is served by, named in the opening lines. */
	readonly baseUrl: string;
	/** The system message opening the session, `undefined` when none was asked for. */
	readonly systemText: string | undefined;
	/**
	 * Whether turns are being typed, rather than fed from `-p/--prompt` or from a script. A run that
	 * nobody is typing into is shown no prompt in front of a turn it cannot type and is told nothing
	 * about the three commands it will never reach.
	 */
	readonly isInteractive: boolean;
	/** Where the turns are read from. */
	readonly lines: LineSource;
	/** Where every line and every answer piece is written. */
	readonly write: (text: string) => void;
	/** How one turn is sent. */
	readonly sendTurn: ChatTurnSender;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatSession
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Reads turns, sends the accumulated history, and streams each answer back. */
export class ChatSession {
	/** What one session needs to run, exactly as it was handed over. */
	private readonly options: ChatSessionOptions;

	/** The messages the next turn will be sent with, in the order they are sent. */
	private messages: OpenAI.ChatCompletionMessageParam[];

	/**
	 * Builds a session that has not read a turn yet.
	 *
	 * @param options What the session needs to run.
	 */
	constructor(options: ChatSessionOptions) {
		this.options = options;
		this.messages = ChatSession.openingMessages(options.systemText);
	}

	/**
	 * Builds the messages a session opens with, which is the system message alone when one was asked
	 * for and nothing at all otherwise.
	 *
	 * @param systemText The system message to open the session with, `undefined` when none was asked
	 * for.
	 * @returns The opening messages.
	 */
	static openingMessages(systemText: string | undefined): OpenAI.ChatCompletionMessageParam[] {
		if (systemText === undefined) {
			return [];
		}
		return [
			{
				role: 'system',
				content: systemText,
			},
		];
	}

	/**
	 * Builds the turn sender that reaches a real endpoint, streaming every request so the answer can
	 * be shown as it is written rather than after it is finished.
	 *
	 * @param client The client every turn of the session is sent over, built once so the session does
	 * not open a new connection per turn.
	 * @param modelId The one model identifier every turn is sent to.
	 * @returns The turn sender to hand to a session.
	 */
	static streamedTurnSender(client: OpenAI, modelId: string): ChatTurnSender {
		return async (messages: readonly OpenAI.ChatCompletionMessageParam[], writePiece: (piece: string) => void): Promise<CompletionResult> => {
			return await CompletionSender.send({
				client,
				modelId,
				messages: [...messages],
				streamSetting: 'on',
				writePiece,
			});
		};
	}

	/**
	 * Runs the session until `/quit` is typed or the turns run out.
	 *
	 * @returns Nothing, once the session has ended.
	 */
	async run(): Promise<void> {
		this.options.write(`${ChatRenderer.banner(this.options.modelId, this.options.baseUrl, this.options.isInteractive)}\n`);
		for (;;) {
			if (this.options.isInteractive === true) {
				this.options.write(ChatRenderer.turnPrompt());
			}
			const line = await this.options.lines.next();
			if (line.done === true || line.value === undefined) {
				if (this.options.isInteractive === true) {
					this.options.write('\n');
				}
				return;
			}
			const turn = line.value.trim();
			if (turn === '') {
				continue;
			}
			const command = this.readCommand(turn);
			if (command === 'quit') {
				return;
			}
			if (command === 'turn') {
				await this.sendOneTurn(turn);
			}
		}
	}

	/**
	 * Acts on one line that has already been read and trimmed, when that line is one of the three
	 * commands, and says which of the three kinds of line it was.
	 *
	 * The three commands are matched whole. A line that merely starts with a slash is a turn, since a
	 * model may well be asked about a command it has no idea about.
	 *
	 * @param turn The line to act on.
	 * @returns `quit` when the session is to end, `handled` when the line was a command that has
	 * been acted on, and `turn` when the line is to be sent to the model.
	 */
	readCommand(turn: string): 'quit' | 'handled' | 'turn' {
		if (turn === ChatRenderer.quitCommand) {
			return 'quit';
		}
		if (turn === ChatRenderer.historyCommand) {
			this.options.write(`${ChatRenderer.history(this.messages)}\n`);
			return 'handled';
		}
		if (turn === ChatRenderer.resetCommand) {
			this.messages = ChatSession.openingMessages(this.options.systemText);
			this.options.write(`${ChatRenderer.resetNotice(this.messages.length)}\n`);
			return 'handled';
		}
		return 'turn';
	}

	/**
	 * Sends one turn with the whole history in front of it, writes the answer as it arrives, and
	 * keeps the answer in the history.
	 *
	 * A turn that was not answered leaves the history as it was, so that the next turn is not sent
	 * with a question nobody answered hanging in front of it.
	 *
	 * @param turn The turn to send.
	 * @returns Nothing, once the answer has been written out or the failure reported.
	 */
	async sendOneTurn(turn: string): Promise<void> {
		this.messages.push({
			role: 'user',
			content: turn,
		});
		let writtenCharacterCount = 0;
		try {
			const result = await this.options.sendTurn(this.messages, (piece: string) => {
				writtenCharacterCount += piece.length;
				this.options.write(piece);
			});
			this.options.write('\n');
			this.options.write(`${ChatRenderer.timings(result)}\n`);
			this.messages.push({
				role: 'assistant',
				content: result.answer,
			});
		} catch (error: unknown) {
			if (writtenCharacterCount > 0) {
				this.options.write('\n');
			}
			this.messages.pop();
			this.options.write(`${ChatRenderer.turnFailed(CompletionSender.describeFailure(error))}\n`);
		}
	}

	/**
	 * Reports the messages the next turn would be sent with, for a test that needs to read what the
	 * session is holding.
	 *
	 * @returns The messages, in the order they are sent.
	 */
	currentMessages(): readonly OpenAI.ChatCompletionMessageParam[] {
		return this.messages;
	}
}
