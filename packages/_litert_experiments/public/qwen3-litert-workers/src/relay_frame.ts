///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RelayFrame — the wire format the workers and the conductor speak
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What every frame carries in front of its payload.
 */
export type FrameHeader = {
	/** The name of the connection this frame is for. The relay reads only this. */
	to: string;
	/** The name of the connection that sent it. */
	from: string;
	/**
	 * What the frame is.
	 *
	 * `hello` exists because the relay forwards and never queues: a `ready` sent while the conductor is not
	 * connected is dropped, and the conductor would wait for a worker that had already announced itself. The
	 * conductor says `hello` when it connects, and every worker answers `ready` again.
	 */
	type: 'hello' | 'ready' | 'reset' | 'reset-done' | 'hidden' | 'token' | 'collect' | 'records';
	/** The token position being decoded, on the frames that carry one. */
	position?: number;
	/** Whatever else the type needs. */
	[key: string]: unknown;
};

/**
 * One frame, taken apart.
 */
export type DecodedFrame = {
	/** The header. */
	header: FrameHeader;
	/** The 32-bit floating point payload, empty when the frame carries none. */
	payload: Float32Array;
};

/**
 * Encodes and decodes the frames that cross the relay.
 *
 * A frame is one binary WebSocket message: four bytes of header length, then the header as UTF-8 JSON, then
 * the payload as raw 32-bit floating point. The payload is never turned into text, because a hidden state
 * written as JSON is about six times its own size and would make every byte measurement in this experiment a
 * measurement of JSON instead.
 */
export class RelayFrame {
	/**
	 * Builds one frame.
	 *
	 * @param header The header.
	 * @param payload The values to carry, if any.
	 * @returns The bytes to send.
	 */
	static encode(header: FrameHeader, payload?: Float32Array): ArrayBuffer {
		const headerBytes = new TextEncoder().encode(JSON.stringify(header));
		const payloadBytes = payload === undefined ? 0 : payload.byteLength;
		const frame = new ArrayBuffer(4 + headerBytes.byteLength + payloadBytes);
		const view = new DataView(frame);
		view.setUint32(0, headerBytes.byteLength, true);
		new Uint8Array(frame, 4, headerBytes.byteLength).set(headerBytes);
		if (payload !== undefined) {
			new Uint8Array(frame, 4 + headerBytes.byteLength).set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
		}
		return frame;
	}

	/**
	 * Takes one frame apart.
	 *
	 * @param frame The bytes that arrived.
	 * @returns The header and the payload.
	 */
	static decode(frame: ArrayBuffer): DecodedFrame {
		const view = new DataView(frame);
		const headerLength = view.getUint32(0, true);
		const header = JSON.parse(
			new TextDecoder().decode(new Uint8Array(frame, 4, headerLength)),
		) as FrameHeader;
		// The payload is copied rather than viewed, because a view onto the received buffer would keep the
		// whole frame alive and would not be aligned for Float32Array in the general case.
		const payloadBytes = frame.byteLength - 4 - headerLength;
		const payload = new Float32Array(payloadBytes / Float32Array.BYTES_PER_ELEMENT);
		new Uint8Array(payload.buffer).set(new Uint8Array(frame, 4 + headerLength, payloadBytes));
		return {
			header,
			payload,
		};
	}
}
