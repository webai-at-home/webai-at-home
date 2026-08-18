// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// npm imports
import type OpenAI from 'openai';

// local imports
import { ChatCommand } from '../src/chat/chat_command.js';
import { ChatRenderer } from '../src/chat/chat_renderer.js';
import { ChatSession, type LineSource } from '../src/chat/chat_session.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The chat subcommand: the session loop, its three commands, and what it prints
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

//	The chat Subcommand
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds a line source that reads the given lines and then ends, which is how a session is driven
 * without a terminal.
 *
 * @param lines The lines to read, in order.
 * @returns The line source to hand to a session.
 */
function lineSourceOf(lines: readonly string[]): LineSource {
	let index = 0;
	return {
		next: async () => {
			if (index >= lines.length) {
				return {
					done: true,
				};
			}
			const value = lines[index];
			index += 1;
			return {
				done: false,
				value,
			};
		},
	};
}

/** What one scripted session wrote, and what it was asked to send. */
type SessionTranscript = {
	/** The session that ran, so a test can read the history it ended with. */
	readonly session: ChatSession;
	/** Everything written, concatenated. */
	readonly written: string;
	/** The messages of every turn sent, in the order the turns were sent. */
	readonly sentMessages: OpenAI.ChatCompletionMessageParam[][];
};

/**
 * Runs one whole session over scripted lines, with a sender that answers without an endpoint.
 *
 * @param lines The lines typed into the session, in order.
 * @param systemText The system message to open the session with, `undefined` for none.
 * @param answerOf What the model answers a turn with, read from the turn itself. Throwing from it is
 * how a turn the endpoint would not answer is scripted.
 * @returns What the session wrote and what it sent.
 */
async function runScriptedSession(
	lines: readonly string[],
	systemText: string | undefined,
	answerOf: (turn: string) => string,
): Promise<SessionTranscript> {
	const sentMessages: OpenAI.ChatCompletionMessageParam[][] = [];
	let written = '';
	const session = new ChatSession({
		modelId: 'a-model',
		baseUrl: 'http://localhost:1234/v1',
		systemText,
		isInteractive: true,
		lines: lineSourceOf(lines),
		write: (text: string) => {
			written += text;
		},
		sendTurn: async (messages, writePiece) => {
			sentMessages.push([...messages]);
			const lastMessage = messages[messages.length - 1];
			const answer = answerOf(typeof lastMessage.content === 'string' ? lastMessage.content : '');
			for (const piece of answer) {
				writePiece(piece);
			}
			return {
				answer,
				reportedModelId: 'a-model',
				timeToFirstCharacterMs: 12,
				timeToLastCharacterMs: 34,
				clusterGenerationTimeMs: undefined,
				clusterTimeToFirstPieceMs: undefined,
				usage: undefined,
				finishReason: 'stop',
				toolCalls: [],
			};
		},
	});
	await session.run();
	return {
		session,
		written,
		sentMessages,
	};
}

Test('ChatRenderer.banner says what can be typed only when somebody is typing', () => {
	Assert.match(ChatRenderer.banner('a-model', 'http://localhost:1234/v1', true), /Type a turn/);
	Assert.doesNotMatch(ChatRenderer.banner('a-model', 'http://localhost:1234/v1', false), /Type a turn/);
});

Test('ChatRenderer.banner names the model and the endpoint either way', () => {
	for (const isInteractive of [true, false]) {
		const banner = ChatRenderer.banner('a-model', 'http://localhost:1234/v1', isInteractive);
		Assert.match(banner, /a-model/);
		Assert.match(banner, /localhost:1234/);
	}
});

Test('ChatSession.openingMessages opens with nothing at all when no system message was asked for', () => {
	Assert.deepEqual(ChatSession.openingMessages(undefined), []);
});

Test('ChatSession.openingMessages opens with the system message when one was asked for', () => {
	Assert.deepEqual(ChatSession.openingMessages('Answer in one word.'), [
		{
			role: 'system',
			content: 'Answer in one word.',
		},
	]);
});

Test('ChatSession.run sends the whole history with every turn after the first', async () => {
	const transcript = await runScriptedSession(
		['What is the capital of France?', 'And of Spain?'],
		'Answer in one word.',
		() => 'Paris',
	);
	Assert.equal(transcript.sentMessages.length, 2);
	Assert.deepEqual(
		transcript.sentMessages[0].map((message) => message.role),
		['system', 'user'],
	);
	Assert.deepEqual(
		transcript.sentMessages[1].map((message) => message.role),
		['system', 'user', 'assistant', 'user'],
	);
	Assert.equal(transcript.session.currentMessages().length, 5);
});

Test('ChatSession.run writes the answer and the dimmed timings under it', async () => {
	const transcript = await runScriptedSession(['What is the capital of France?'], undefined, () => 'Paris');
	Assert.match(transcript.written, /Paris/);
	Assert.match(transcript.written, /Time to First Character 12 ms/);
	Assert.match(transcript.written, /Time to Last Character 34 ms/);
	Assert.match(transcript.written, /5 characters/);
});

Test('ChatSession.run leaves the session on /quit, and reads nothing after it', async () => {
	const transcript = await runScriptedSession(['/quit', 'this turn is never read'], undefined, () => 'Paris');
	Assert.equal(transcript.sentMessages.length, 0);
});

Test('ChatSession.run clears the history on /reset, and keeps the system message', async () => {
	const transcript = await runScriptedSession(
		['What is the capital of France?', '/reset', 'And of Spain?'],
		'Answer in one word.',
		() => 'Paris',
	);
	Assert.deepEqual(
		transcript.sentMessages[1].map((message) => message.role),
		['system', 'user'],
	);
	Assert.match(transcript.written, /The history is cleared/);
});

Test('ChatSession.run prints every message the next turn would carry on /history', async () => {
	const transcript = await runScriptedSession(['What is the capital of France?', '/history'], undefined, () => 'Paris');
	Assert.match(transcript.written, /2 messages will be sent with the next turn/);
	Assert.match(transcript.written, /user: What is the capital of France\?/);
	Assert.match(transcript.written, /assistant: Paris/);
});

Test('ChatSession.run sends a line that only starts with a slash as a turn', async () => {
	const transcript = await runScriptedSession(['/resetting is not /reset'], undefined, () => 'Paris');
	Assert.equal(transcript.sentMessages.length, 1);
});

Test('ChatSession.run reports a turn the endpoint would not answer, and carries on with the history it had', async () => {
	const transcript = await runScriptedSession(
		['What is the capital of France?', 'And of Spain?'],
		undefined,
		(turn: string) => {
			if (turn === 'What is the capital of France?') {
				throw new Error('the endpoint refused this one');
			}
			return 'Madrid';
		},
	);
	Assert.match(transcript.written, /That turn was not answered: the endpoint refused this one/);
	Assert.deepEqual(
		transcript.sentMessages[1].map((message) => message.role),
		['user'],
	);
	Assert.deepEqual(
		transcript.session.currentMessages().map((message) => message.role),
		['user', 'assistant'],
	);
});

Test('ChatSession.run skips a line with nothing on it', async () => {
	const transcript = await runScriptedSession(['', '   ', 'What is the capital of France?'], undefined, () => 'Paris');
	Assert.equal(transcript.sentMessages.length, 1);
});

Test('ChatCommand refuses a model spelling that names more than one model', async () => {
	await Assert.rejects(
		async () =>
			await ChatCommand.run({
				model: 'all',
				prompt: 'What is the capital of France?',
				base_url: 'http://localhost:1234/v1',
				api_key: 'no-key-required',
				timeout_ms: '600000',
			}),
		/one model identifier/,
	);
});

Test('ChatCommand refuses a run that named no model at all', async () => {
	await Assert.rejects(
		async () =>
			await ChatCommand.run({
				base_url: 'http://localhost:1234/v1',
				api_key: 'no-key-required',
				timeout_ms: '600000',
			}),
		/no model was named/,
	);
});

Test('ChatCommand reads the one turn of -p/--prompt and then ends the input', async () => {
	const lines = ChatCommand.oneLineSource('What is the capital of France?');
	Assert.deepEqual(await lines.next(), {
		done: false,
		value: 'What is the capital of France?',
	});
	Assert.deepEqual(await lines.next(), {
		done: true,
	});
});

///////////////////////////////////////////////////////////////////////////////
