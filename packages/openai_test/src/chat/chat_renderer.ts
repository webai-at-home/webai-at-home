// npm imports
import Chalk from 'chalk';
import type OpenAI from 'openai';

// local imports
import type { CompletionResult } from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatRenderer — every line the chat session puts on the screen except the answer itself
//
//	The answer is written piece by piece as it arrives, so it is the one thing this file does not
//	build: it belongs to whoever is holding the stream. Everything else — the opening lines, the
//	prompt in front of a turn, the dimmed timings under an answer, what `/history` prints — is built
//	here and returned as a string, so a test can read what would have been shown.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Builds the lines of a chat session. */
export class ChatRenderer {
	/** What is typed to leave the session. */
	static readonly quitCommand = '/quit';

	/** What is typed to clear the history. */
	static readonly resetCommand = '/reset';

	/** What is typed to print the history. */
	static readonly historyCommand = '/history';

	/**
	 * Renders the opening lines, which name what is being talked to and, in a session somebody is
	 * typing into, what can be typed at it.
	 *
	 * @param modelId The one model identifier turns are sent to.
	 * @param baseUrl The endpoint the model is served by.
	 * @param isInteractive Whether turns are being typed. A `-p/--prompt` run is told nothing about
	 * the three commands, because it ends before a second line could be typed.
	 * @returns The lines to print before the first turn is read.
	 */
	static banner(modelId: string, baseUrl: string, isInteractive: boolean): string {
		const heading = Chalk.bold(`${modelId} on ${baseUrl}`);
		if (isInteractive === false) {
			return heading;
		}
		const commands = [ChatRenderer.resetCommand, ChatRenderer.historyCommand, ChatRenderer.quitCommand].join(', ');
		return [
			heading,
			Chalk.dim(`Type a turn and press return. ${commands} — and nothing else — are read as commands.`),
		].join('\n');
	}

	/**
	 * Renders the prompt printed in front of a turn somebody is about to type.
	 *
	 * @returns The prompt, without a newline after it.
	 */
	static turnPrompt(): string {
		return Chalk.cyan.bold('you> ');
	}

	/**
	 * Renders the one dimmed line printed under an answer.
	 *
	 * @param result What the request produced.
	 * @returns The line to print.
	 */
	static timings(result: CompletionResult): string {
		const timeToFirstCharacter = `Time to First Character ${Math.round(result.timeToFirstCharacterMs)} ms`;
		const timeToLastCharacter = `Time to Last Character ${Math.round(result.timeToLastCharacterMs)} ms`;
		return Chalk.dim(`${timeToFirstCharacter}, ${timeToLastCharacter}, ${result.answer.length} characters`);
	}

	/**
	 * Renders what `/history` prints: every message of the session so far, in the order it will be
	 * sent, each one named by its role.
	 *
	 * The whole point of printing the history is to show what the next request will carry, so a
	 * message is shown whole rather than shortened, and the system message is shown as well.
	 *
	 * @param messages The messages of the session so far.
	 * @returns The lines to print.
	 */
	static history(messages: readonly OpenAI.ChatCompletionMessageParam[]): string {
		if (messages.length === 0) {
			return Chalk.dim('The history is empty. The next turn will be the first message sent.');
		}
		const lines = messages.map((message) => {
			const role = Chalk.bold(`${message.role}:`);
			return `${role} ${ChatRenderer._messageText(message)}`;
		});
		return [Chalk.dim(`${messages.length} message${messages.length === 1 ? '' : 's'} will be sent with the next turn:`), ...lines].join('\n');
	}

	/**
	 * Renders the line printed when `/reset` has cleared the history.
	 *
	 * @param remainingCount How many messages the session kept, which is the system message alone or
	 * nothing at all.
	 * @returns The line to print.
	 */
	static resetNotice(remainingCount: number): string {
		if (remainingCount === 0) {
			return Chalk.dim('The history is cleared. The next turn will be the first message sent.');
		}
		return Chalk.dim('The history is cleared. The system message stays, since it opens the session.');
	}

	/**
	 * Renders the line printed when a turn could not be answered.
	 *
	 * A failed turn ends the turn, never the session: the endpoint may answer the next one, and a
	 * session that stopped on the first refusal would throw away the history somebody typed.
	 *
	 * @param reason Why the turn could not be answered.
	 * @returns The line to print.
	 */
	static turnFailed(reason: string): string {
		return Chalk.red(`That turn was not answered: ${reason}`);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one message's text, which the OpenAI message shape allows to be a string or a list of
	 * content parts.
	 *
	 * @param message The message to read.
	 * @returns The message's text, with a list of parts joined into one string.
	 */
	private static _messageText(message: OpenAI.ChatCompletionMessageParam): string {
		const content: unknown = message.content;
		if (typeof content === 'string') {
			return content;
		}
		if (Array.isArray(content) === true) {
			return (content as { text?: string }[]).map((part) => part.text ?? '').join('');
		}
		return '';
	}
}
