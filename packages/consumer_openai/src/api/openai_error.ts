///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiError — a failure, with the HTTP status and the response body it is answered with
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The kinds of failure the OpenAI completion interface names in an error body. */
export type OpenaiErrorKind = 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'api_error';

/**
 * The error body an OpenAI client reads.
 *
 * The field names are spelled the way the OpenAI completion interface spells them on the
 * connection, and `param` and `code` are always present, holding `null` when they say nothing,
 * because that is how a client expects to find them.
 */
export type OpenaiErrorBody = {
	error: {
		message: string;
		type: OpenaiErrorKind;
		param: string | null;
		code: string | null;
	};
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Openai Error
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A failure this server answers a request with, carrying the HTTP status and the error body
 * together.
 *
 * Every failure is built by one of the named methods below rather than by writing a status
 * and a body at the place the failure is noticed, so that the whole list of ways a request can
 * fail can be read in one file, and so that the official `openai` package raises the error it
 * would raise against OpenAI itself: a 400 becomes a bad request, a 401 an authentication
 * failure, a 429 a rate limit, and a 500 or above a connection or server error.
 */
export class OpenaiError extends Error {
	/**
	 * @param status The HTTP status to answer with.
	 * @param kind Which kind of failure this is, as named in the error body.
	 * @param message What went wrong, in words, for whoever sent the request.
	 * @param param The request field at fault, when one field is at fault.
	 * @param code A short stable name for this failure, when one is useful.
	 */
	private constructor(
		readonly status: number,
		readonly kind: OpenaiErrorKind,
		message: string,
		readonly param: string | null = null,
		readonly code: string | null = null,
	) {
		super(message);
		this.name = 'OpenaiError';
	}

	/** The response body to answer this failure with. */
	get body(): OpenaiErrorBody {
		return {
			error: {
				message: this.message,
				type: this.kind,
				param: this.param,
				code: this.code,
			},
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Failures In The Request
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The request body is not one this server can read: it is not valid JSON, a required field
	 * is missing, or a field holds the wrong kind of value.
	 *
	 * @param message What is wrong with the body.
	 * @param param The field at fault, when one field is at fault.
	 * @returns The failure to answer with, as HTTP 400.
	 */
	static invalidRequest(message: string, param: string | null = null): OpenaiError {
		return new OpenaiError(400, 'invalid_request_error', message, param);
	}

	/**
	 * The request names a model this server does not offer.
	 *
	 * @param modelId The model identifier the request asked for.
	 * @param offeredModelIds The model identifiers this server does offer.
	 * @returns The failure to answer with, as HTTP 404.
	 */
	static unknownModel(modelId: string, offeredModelIds: readonly string[]): OpenaiError {
		return new OpenaiError(
			404,
			'invalid_request_error',
			`This server does not offer a model named ${modelId}. The models it offers are ` +
				`${offeredModelIds.join(', ')}, which can also be read from GET /v1/models.`,
			'model',
			'model_not_found',
		);
	}

	/**
	 * The value submitted for the chosen model is not one that model accepts, such as text
	 * that is not a number for the development formula model.
	 *
	 * @param message What is wrong with the value, as the task input check stated it.
	 * @returns The failure to answer with, as HTTP 400.
	 */
	static unusableMessages(message: string): OpenaiError {
		return new OpenaiError(400, 'invalid_request_error', message, 'messages');
	}

	/**
	 * The request asks for a generation control the model it named cannot honour, at a value that
	 * is not this interface's own default for that control.
	 *
	 * Refusing is the middle of the three possible answers, and the one this server gives. Ignoring
	 * the control returns an answer generated some other way and reports nothing, which is a wrong
	 * answer with no error; answering and reporting which controls were honoured needs the client
	 * to read a field it was never written to read. A request that asks for this interface's own
	 * default is never refused, because a client that always sends `temperature: 1` is asking for
	 * nothing unusual. See milestone 4 of
	 * [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
	 *
	 * @param field The request field at fault, spelled the way this interface spells it, such as
	 * `top_p`.
	 * @param modelId The model the request asked for.
	 * @param honouredFields The fields that model does honour, spelled the same way, so the sender
	 * learns what it may ask for instead of only what it may not.
	 * @returns The failure to answer with, as HTTP 400.
	 */
	static unhonourableGenerationControl(field: string, modelId: string, honouredFields: readonly string[]): OpenaiError {
		return new OpenaiError(
			400,
			'invalid_request_error',
			`The model ${modelId} cannot honour ${field}, and this server refuses a request it would have to ` +
				'ignore rather than answering it as though nothing had been asked for. The generation controls ' +
				`${modelId} honours are ${honouredFields.length === 0 ? 'none' : honouredFields.join(', ')}. Send the ` +
				`request again without ${field}, or send it to a model that honours it.`,
			field,
			'unhonourable_generation_control',
		);
	}

	/**
	 * This server was started with a required key, and the request presented no key or a key
	 * that does not match.
	 *
	 * The two cases are answered with one message on purpose, so that the answer does not
	 * report whether a presented key was close to the right one.
	 *
	 * @returns The failure to answer with, as HTTP 401.
	 */
	static authenticationFailed(): OpenaiError {
		return new OpenaiError(
			401,
			'authentication_error',
			'This server was started with a required key, and the request did not present a matching one. Send ' +
				'it in an Authorization header, as "Bearer" followed by the key.',
			null,
			'invalid_api_key',
		);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Failures In The Cluster
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * More requests are already waiting for a cluster task than this server will hold at once.
	 *
	 * @param limit How many requests it will hold at once.
	 * @returns The failure to answer with, as HTTP 429.
	 */
	static tooManyTasksInFlight(limit: number): OpenaiError {
		return new OpenaiError(
			429,
			'rate_limit_error',
			`This server is already waiting on ${limit} cluster tasks, which is as many as it holds at once. ` +
				'Send the request again once one of them has finished.',
			null,
			'too_many_tasks_in_flight',
		);
	}

	/**
	 * The central gateway refused the submission because this server has reached the number of
	 * tasks one submitter may have in flight.
	 *
	 * @param message The gateway's own words.
	 * @returns The failure to answer with, as HTTP 429.
	 */
	static gatewayRateLimited(message: string): OpenaiError {
		return new OpenaiError(429, 'rate_limit_error', message, null, 'gateway_rate_limited');
	}

	/**
	 * This server holds no registered connection to the central gateway, or the connection was
	 * lost while the request was waiting for its task.
	 *
	 * A task already under way cannot be picked up again after the connection returns, because
	 * the gateway issues a new device identifier to the new connection and the task belongs to
	 * the device that has gone.
	 *
	 * @param message What the state of the connection is.
	 * @returns The failure to answer with, as HTTP 503.
	 */
	static gatewayUnavailable(message: string): OpenaiError {
		return new OpenaiError(503, 'api_error', message, null, 'gateway_unavailable');
	}

	/**
	 * No worker browser tab offered the first stage of the task within the time the gateway
	 * allows a submitted task to wait, so nobody in the cluster can run this model right now.
	 *
	 * @param modelId The model the request asked for.
	 * @returns The failure to answer with, as HTTP 503.
	 */
	static noVolunteerAvailable(modelId: string): OpenaiError {
		return new OpenaiError(
			503,
			'api_error',
			`No volunteer browser is currently offering the work the model ${modelId} needs, so the task ` +
				`waited until the central gateway's submission deadline and was then given up. Open a worker ` +
				`browser tab that offers that model's stages and send the request again.`,
			null,
			'no_volunteer_available',
		);
	}

	/**
	 * The cluster ran the task and the task failed.
	 *
	 * @param message The reason the gateway recorded on the task.
	 * @returns The failure to answer with, as HTTP 502.
	 */
	static taskFailed(message: string): OpenaiError {
		return new OpenaiError(
			502,
			'api_error',
			`The cluster could not finish this task: ${message}`,
			null,
			'task_failed',
		);
	}

	/**
	 * The task did not finish within the time this server waits, and has been cancelled.
	 *
	 * @param requestTimeoutMs How long this server waited, in milliseconds.
	 * @returns The failure to answer with, as HTTP 504.
	 */
	static requestTimedOut(requestTimeoutMs: number): OpenaiError {
		return new OpenaiError(
			504,
			'api_error',
			`The cluster did not finish this task within ${requestTimeoutMs} milliseconds, so it was cancelled. ` +
				`Start this server with a longer --request-timeout-ms to wait longer.`,
			null,
			'request_timed_out',
		);
	}

	/**
	 * Something failed that this server did not expect and has no better name for.
	 *
	 * @returns The failure to answer with, as HTTP 500.
	 */
	static unexpected(): OpenaiError {
		return new OpenaiError(
			500,
			'api_error',
			'This server failed in a way it does not account for. The reason was written to its own output.',
			null,
			'internal_error',
		);
	}

	/**
	 * The task finished but carried no text to answer with, which means a stage returned a
	 * value of a shape this server does not know how to read.
	 *
	 * @param taskTypeName The task type that produced it.
	 * @returns The failure to answer with, as HTTP 502.
	 */
	static answerUnreadable(taskTypeName: string): OpenaiError {
		return new OpenaiError(
			502,
			'api_error',
			`The cluster finished this ${taskTypeName} task but its result carried no text to answer with.`,
			null,
			'answer_unreadable',
		);
	}
}
