import { departureContentType, type Departure } from '@webai/protocol';
import { GatewayConfig } from './gateway_config';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayDeparture — tells the central gateway this browser page is going away
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Tells the central gateway that this browser page is going away, in the one way a browser
 * promises to deliver after the page itself is gone.
 *
 * Closing the WebSocket connection from the `pagehide` handler is not enough on its own. That
 * close frame is queued at the moment the browser is destroying the tab, so the browser never
 * promises to write it to the network, and a reverse proxy in front of the central gateway can
 * hold its own upstream connection open after the browser side is gone. When the close frame
 * never arrives, the only thing that notices is the central gateway's heartbeat, up to two of
 * its intervals later. `navigator.sendBeacon` is the one request a browser does promise to
 * deliver after the page is gone. See
 * https://github.com/webai-at-home/webai-at-home/issues/176.
 */
export class GatewayDeparture {
	/** The device identifier the central gateway issued, once this page has registered. */
	private static deviceId: string | undefined;

	/**
	 * Remembers which device is going to depart, so a departure can name it later.
	 *
	 * @param deviceId The device identifier the central gateway issued this page when it registered.
	 */
	static start(deviceId: string): void {
		GatewayDeparture.deviceId = deviceId;
	}

	/** Forgets the device identifier, so a page with no registration announces no departure. */
	static stop(): void {
		GatewayDeparture.deviceId = undefined;
	}

	/**
	 * Announces that this browser page is going away, if it ever registered.
	 *
	 * @returns Whether the browser accepted the departure for delivery. A page that never
	 * registered, and a browser that refused the request, both return `false`.
	 */
	static announce(): boolean {
		const deviceId = GatewayDeparture.deviceId;
		if (deviceId === undefined) {
			return false;
		}
		const departure: Departure = {
			deviceId,
			// The token travels in the body because `navigator.sendBeacon` cannot set a header.
			authToken: GatewayConfig.authToken,
		};
		// Sent as plain text, not as JSON. A JSON content type is one a browser refuses to send
		// across origins until it has asked the other side for permission, and a beacon sent from
		// a page that is being destroyed cannot wait for that answer, so the departure would never
		// leave at all.
		const wasAccepted = navigator.sendBeacon(
			GatewayConfig.assetUrl('/departure'),
			new Blob([JSON.stringify(departure)], {
				type: departureContentType,
			}),
		);
		GatewayDeparture.deviceId = undefined;
		return wasAccepted;
	}
}
