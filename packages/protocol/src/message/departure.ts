import { z } from 'zod';
import { Identifier } from '../identifier.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Departure — what a worker browser page sends as its tab is being closed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The content type a departure is sent with, and the only one the gateway accepts for one.
 *
 * A departure is sent with `navigator.sendBeacon`, which is the one request a browser promises
 * to deliver after the page that started it is gone. A beacon cannot answer a browser's request
 * for permission to send a cross-origin request, so it must be a request the browser sends
 * without asking, and that rules out a JSON content type. Plain text is what is left.
 * See https://github.com/webai-at-home/webai-at-home/issues/176.
 */
export const departureContentType = 'text/plain;charset=UTF-8';

/**
 * A worker browser page saying that it is going away, as posted to the gateway's departure
 * endpoint while the tab is being closed.
 *
 * The bearer token travels in the body rather than in an `authorization` header, because
 * `navigator.sendBeacon` cannot set a header. What the gateway does with it is exactly what it
 * does with the header on a diagnostics report: the token must match, and the named device must
 * already hold an authenticated connection.
 */
export const DepartureSchema = z.object({
	/** The device identifier the gateway issued this worker when it registered. */
	deviceId: Identifier,
	/** The bearer token this worker authenticated its connection with. */
	authToken: z.string().min(1).max(500),
}).strict();
/** A worker browser page saying that it is going away. */
export type Departure = z.infer<typeof DepartureSchema>;
