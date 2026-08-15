import type Http from 'node:http';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClientIpAddress — reads the address a connection was opened from
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads the address a connection was opened from, out of the HTTP request that carried the
 * WebSocket upgrade.
 *
 * A WebSocket connection begins as an ordinary HTTP request, so the address of the connection is
 * the address of the socket that request arrived on. Nothing a device sends can change that
 * address, which is what makes it worth recording: a worker cannot choose the address the gateway
 * stores for it.
 *
 * The `x-forwarded-for` header is the one exception, and it is read only when this gateway has
 * been told a reverse proxy sits in front of it. Any client can write that header, so a gateway
 * that read it unconditionally would let a worker name its own address.
 */
export class ClientIpAddress {
	/**
	 * Reads the address one connection was opened from.
	 *
	 * @param request The HTTP request that carried the WebSocket upgrade.
	 * @param isReverseProxyTrusted Whether this gateway sits behind a reverse proxy whose
	 * `x-forwarded-for` header may be believed.
	 * @returns The address, or `undefined` when no address could be observed.
	 */
	static fromRequest(request: Http.IncomingMessage, isReverseProxyTrusted: boolean): string | undefined {
		if (isReverseProxyTrusted === true) {
			const forwardedAddress = ClientIpAddress._leftmostForwardedFor(request.headers['x-forwarded-for']);
			if (forwardedAddress !== undefined) {
				return forwardedAddress;
			}
		}
		return ClientIpAddress._normalize(request.socket.remoteAddress);
	}

	/**
	 * Reports whether this gateway is recording the address of a reverse proxy rather than the
	 * address of the device that connected.
	 *
	 * A proxy sets `x-forwarded-for`, so a gateway that is not trusting one while that header keeps
	 * arriving is behind a proxy nobody told it about. Every device then reads as the same address,
	 * and until this was said out loud nothing on screen explained why. See issue #183.
	 *
	 * @param request The HTTP request that carried the WebSocket upgrade.
	 * @param isReverseProxyTrusted Whether this gateway was told a reverse proxy sits in front.
	 * @returns `true` when the operator should be told to start the gateway with
	 * `--trust-reverse-proxy`.
	 */
	static isReverseProxyUnnoticed(request: Http.IncomingMessage, isReverseProxyTrusted: boolean): boolean {
		if (isReverseProxyTrusted === true) {
			return false;
		}
		return ClientIpAddress._leftmostForwardedFor(request.headers['x-forwarded-for']) !== undefined;
	}

	/**
	 * Reads the leftmost address out of an `x-forwarded-for` header.
	 *
	 * Each proxy the request passed through appends the address it received the request from, so
	 * the leftmost entry is the original client and every entry after it is a proxy.
	 *
	 * @param headerValue The header as Node.js presents it, which is an array when the header
	 * appeared more than once.
	 * @returns The leftmost address, or `undefined` when the header held no address.
	 */
	private static _leftmostForwardedFor(headerValue: string | string[] | undefined): string | undefined {
		if (headerValue === undefined) {
			return undefined;
		}
		const firstLine = Array.isArray(headerValue) ? headerValue[0] : headerValue;
		if (firstLine === undefined) {
			return undefined;
		}
		return ClientIpAddress._normalize(firstLine.split(',')[0]);
	}

	/**
	 * Puts one address into the single form this gateway stores.
	 *
	 * An address such as `::ffff:127.0.0.1` is the IPv4-mapped IPv6 form of `127.0.0.1`, which a
	 * browser produces by connecting over IPv4 to a listener that accepts both. It is written in
	 * its plain IPv4 form, so one machine is not recorded two different ways depending on how the
	 * connection happened to be made.
	 *
	 * @param address The address as it was read, when there was one.
	 * @returns The address to store, or `undefined` when there was nothing to store.
	 */
	private static _normalize(address: string | undefined): string | undefined {
		if (address === undefined) {
			return undefined;
		}
		const trimmed = address.trim();
		if (trimmed === '') {
			return undefined;
		}
		const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
		if (mappedIpv4 !== null && mappedIpv4[1] !== undefined) {
			return mappedIpv4[1];
		}
		return trimmed;
	}
}
