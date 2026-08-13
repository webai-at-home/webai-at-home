///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StagingBufferRing — a fixed set of mapped WebGPU buffers, recycled rather than reallocated
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The ring of staging buffers milestone 4 of https://github.com/webai-at-home/webai-at-home/issues/169 asks for.
 *
 * Two measurements decided its shape.
 *
 * Milestone 2 compared moving 64 megabytes with `queue.writeBuffer` against mapping a buffer, filling it, and moving it
 * with `copyBufferToBuffer`. The first cost 32.50 milliseconds and hid 1 per cent of itself inside a compute pass. The
 * second cost 1.00 millisecond of queue work and hid 90 per cent. Almost everything `writeBuffer` charges is a copy on
 * the calling thread, before the queue ever sees the bytes, and no queue can hide that. So the expert bytes are read
 * from disk straight into a mapped buffer, and never pass through `writeBuffer`.
 *
 * Milestone 4 then says never to allocate a buffer for each step, because allocation churn would dominate every number
 * measured. So a fixed count is created once and recycled forever. The ring size is what bounds how many expert loads
 * can be in flight at once.
 */

/** One staging buffer handed out by the ring, mapped and ready to be filled. */
export type StagingBuffer = {
	/** Where in the ring this buffer sits, which is how it is given back. */
	index: number;
	/** The buffer itself, to be used as the source of a `copyBufferToBuffer`. */
	buffer: GPUBuffer;
	/** The mapped bytes, to be written into directly. Valid only until `unmap()` is called. */
	mapped: ArrayBuffer;
};

/** A fixed set of mapped WebGPU buffers, handed out in turn and mapped again after each use. */
export class StagingBufferRing {
	/** The device the buffers belong to. */
	private readonly _device: GPUDevice;
	/** How many bytes each buffer holds, which is one whole expert block. */
	private readonly _bufferByteLength: number;
	/** The buffers, in ring order. */
	private readonly _buffers: GPUBuffer[] = [];
	/**
	 * For each buffer, the promise that resolves when it is mapped again, or undefined when it is already mapped.
	 * A buffer is handed out only after its promise has resolved, which is what makes the ring wait instead of
	 * allocating.
	 */
	private readonly _remapping: (Promise<void> | undefined)[] = [];
	/** Which buffer is handed out next. */
	private _nextIndex = 0;
	/**
	 * How long callers spent waiting for a buffer to finish being mapped again, in milliseconds.
	 *
	 * The count of waits is not worth recording. After the first lap of the ring, every single `acquire` waits on a
	 * promise, because a buffer that has just been used is always being mapped again. What decides whether the ring is
	 * large enough is how long those waits take: near zero means the mapping finished long before the buffer came round
	 * again, and a large number means the ring is being lapped faster than the queue can release it.
	 */
	private _waitedMilliseconds = 0;

	/**
	 * Creates the ring and maps every buffer in it.
	 *
	 * @param device The WebGPU device the buffers belong to.
	 * @param bufferByteLength How many bytes each buffer holds.
	 * @param bufferCount How many buffers the ring holds.
	 */
	constructor(device: GPUDevice, bufferByteLength: number, bufferCount: number) {
		this._device = device;
		this._bufferByteLength = bufferByteLength;
		for (let index = 0; index < bufferCount; index++) {
			this._buffers.push(this._device.createBuffer({
				size: this._bufferByteLength,
				usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
				mappedAtCreation: true,
			}));
			this._remapping.push(undefined);
		}
	}

	/** How many bytes the whole ring holds. */
	get byteLength(): number {
		return this._buffers.length * this._bufferByteLength;
	}

	/** How many buffers the ring holds. */
	get bufferCount(): number {
		return this._buffers.length;
	}

	/** How long callers spent waiting for a buffer to be mapped again, in milliseconds. */
	get waitedMilliseconds(): number {
		return this._waitedMilliseconds;
	}

	/**
	 * Takes the next buffer in the ring, waiting if it has not finished being mapped again.
	 *
	 * @returns The buffer, mapped and ready to be written into.
	 */
	async acquire(): Promise<StagingBuffer> {
		const index = this._nextIndex;
		this._nextIndex = (this._nextIndex + 1) % this._buffers.length;

		const pending = this._remapping[index];
		if (pending !== undefined) {
			const waitStartedAt = performance.now();
			await pending;
			this._waitedMilliseconds += performance.now() - waitStartedAt;
			this._remapping[index] = undefined;
		}

		const buffer = this._buffers[index];
		return {
			index: index,
			buffer: buffer,
			mapped: buffer.getMappedRange(),
		};
	}

	/**
	 * Unmaps a buffer so its bytes can be copied on the queue. Call this after filling it and before encoding the copy.
	 *
	 * @param staging The buffer to unmap.
	 * @returns Nothing.
	 */
	unmap(staging: StagingBuffer): void {
		staging.buffer.unmap();
	}

	/**
	 * Starts mapping a buffer again so it can be handed out later. This is not awaited here on purpose: the caller
	 * carries on, and the wait, if there is one at all, happens in `acquire()` a full lap of the ring later.
	 *
	 * @param staging The buffer to map again.
	 * @returns Nothing.
	 */
	recycle(staging: StagingBuffer): void {
		this._remapping[staging.index] = staging.buffer.mapAsync(GPUMapMode.WRITE);
	}

	/**
	 * Forgets how long the ring has waited, so a second run does not report the first run's waiting as its own.
	 *
	 * @returns Nothing.
	 */
	resetCounters(): void {
		this._waitedMilliseconds = 0;
	}

	/**
	 * Destroys every buffer in the ring.
	 *
	 * @returns Nothing.
	 */
	destroy(): void {
		for (const buffer of this._buffers) {
			buffer.destroy();
		}
		this._buffers.length = 0;
		this._remapping.length = 0;
	}
}
