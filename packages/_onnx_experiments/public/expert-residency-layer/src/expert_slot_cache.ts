import type { BlockPart } from './residency_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExpertSlotCache — the graphics memory the residency layer holds, and the policy deciding what is in it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The expert cache of milestone 4 of https://github.com/webai-at-home/webai-at-home/issues/169.
 *
 * Every buffer it will ever need is created once, before any step runs, and an expert becoming resident means its
 * bytes are copied into buffers that already exist. Nothing is allocated or destroyed while steps are running.
 *
 * The cache is a set of slots rather than one large buffer with offsets into it, and that is not a style choice.
 * Milestone 0 measured that ONNX Runtime Web binds a *whole* WebGPU buffer to a graph input through
 * `Tensor.fromGpuBuffer()`, and cannot be given a range inside a larger buffer. So each of the nine parts of an
 * expert — the quantized weights, the scales, and the zero points of `gate_proj`, `up_proj`, and `down_proj` — needs
 * a buffer of its own that begins exactly where that part begins.
 *
 * The size of the cache is given to it, never discovered. Milestone 2 tried to find the graphics memory ceiling by
 * allocating until the device refused, and on a machine with 16 gigabytes of memory it took 64 gigabytes and wrote
 * every byte of them without a single refusal, paging to disk instead. A cache that sized itself by probing would
 * find a limit that does not exist and then run at swap speed without ever being told why.
 */

/** One expert's place in the cache: nine buffers that together hold one expert block. */
export type ExpertSlot = {
	/** Where in the cache this slot sits. */
	index: number;
	/** The nine buffers, in the order the block stores its parts. */
	buffers: GPUBuffer[];
};

/** How a lookup went. */
export type LookupOutcome = {
	/** The slot the expert is in. */
	slot: ExpertSlot;
	/** Whether the expert was already there, which is what a cache hit means. */
	wasResident: boolean;
	/** Which expert was thrown out to make room, or undefined when nothing was. */
	evictedExpertIndex: number | undefined;
};

/** A fixed set of expert slots in graphics memory, with a pinned set and least-recently-used eviction. */
export class ExpertSlotCache {
	/** The nine parts one expert block is made of. */
	private readonly _parts: BlockPart[];
	/** Every slot, allocated once at construction. */
	private readonly _slots: ExpertSlot[] = [];
	/** Which expert each slot currently holds, or undefined when the slot is empty. */
	private readonly _slotExpert: (number | undefined)[] = [];
	/** When each slot was last used, as a counter rather than a clock, which is all least-recently-used needs. */
	private readonly _slotStamp: number[] = [];
	/** Where each resident expert is. */
	private readonly _expertSlot = new Map<number, number>();
	/** The experts that may never be evicted. */
	private readonly _pinned = new Set<number>();
	/** How many bytes one expert occupies across its nine buffers. */
	private readonly _expertByteLength: number;
	/** The counter behind the least-recently-used order. */
	private _stamp = 0;

	/**
	 * Creates every slot and every buffer in it.
	 *
	 * @param device The WebGPU device the buffers belong to.
	 * @param parts The nine parts one expert block is made of, from the published manifest.
	 * @param slotCount How many experts the cache may hold at once.
	 */
	constructor(device: GPUDevice, parts: BlockPart[], slotCount: number) {
		this._parts = parts;
		this._expertByteLength = parts.reduce((total, part) => total + part.byteLength, 0);
		for (let index = 0; index < slotCount; index++) {
			const buffers: GPUBuffer[] = [];
			for (const part of this._parts) {
				buffers.push(device.createBuffer({
					size: part.byteLength,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}));
			}
			this._slots.push({
				index: index,
				buffers: buffers,
			});
			this._slotExpert.push(undefined);
			this._slotStamp.push(0);
		}
	}

	/** How many experts the cache can hold at once. */
	get slotCount(): number {
		return this._slots.length;
	}

	/** How many bytes of graphics memory the cache holds. */
	get byteLength(): number {
		return this._slots.length * this._expertByteLength;
	}

	/** How many experts are pinned. */
	get pinnedCount(): number {
		return this._pinned.size;
	}

	/**
	 * Declares an expert pinned, so eviction never chooses it.
	 *
	 * @param expertIndex The expert to pin.
	 * @returns Nothing.
	 */
	pin(expertIndex: number): void {
		this._pinned.add(expertIndex);
	}

	/**
	 * Finds where an expert already is, without claiming a slot for it.
	 *
	 * @param expertIndex The expert to look for.
	 * @returns Its slot, or undefined when it is not resident.
	 */
	find(expertIndex: number): ExpertSlot | undefined {
		const slotIndex = this._expertSlot.get(expertIndex);
		if (slotIndex === undefined) {
			return undefined;
		}
		this._stamp++;
		this._slotStamp[slotIndex] = this._stamp;
		return this._slots[slotIndex];
	}

	/**
	 * Finds an expert, or takes a slot for it, evicting the least recently used unpinned expert if the cache is full.
	 *
	 * The caller is responsible for filling the slot's buffers when `wasResident` is false. The cache does not read
	 * anything itself, because a cache that also did input and output could not be reasoned about separately from it.
	 *
	 * @param expertIndex The expert wanted.
	 * @returns Where the expert is, whether it was already there, and what was evicted to make room.
	 */
	acquire(expertIndex: number): LookupOutcome {
		const resident = this.find(expertIndex);
		if (resident !== undefined) {
			return {
				slot: resident,
				wasResident: true,
				evictedExpertIndex: undefined,
			};
		}

		let chosenIndex = this._slotExpert.indexOf(undefined);
		let evictedExpertIndex: number | undefined;
		if (chosenIndex === -1) {
			chosenIndex = this._leastRecentlyUsedUnpinned();
			evictedExpertIndex = this._slotExpert[chosenIndex];
			if (evictedExpertIndex !== undefined) {
				this._expertSlot.delete(evictedExpertIndex);
			}
		}

		this._slotExpert[chosenIndex] = expertIndex;
		this._expertSlot.set(expertIndex, chosenIndex);
		this._stamp++;
		this._slotStamp[chosenIndex] = this._stamp;
		return {
			slot: this._slots[chosenIndex],
			wasResident: false,
			evictedExpertIndex: evictedExpertIndex,
		};
	}

	/**
	 * Destroys every buffer the cache holds.
	 *
	 * @returns Nothing.
	 */
	destroy(): void {
		for (const slot of this._slots) {
			for (const buffer of slot.buffers) {
				buffer.destroy();
			}
		}
		this._slots.length = 0;
		this._slotExpert.length = 0;
		this._slotStamp.length = 0;
		this._expertSlot.clear();
		this._pinned.clear();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Finds the slot to evict: the one used longest ago that does not hold a pinned expert.
	 *
	 * @returns The slot index to take.
	 */
	private _leastRecentlyUsedUnpinned(): number {
		let chosenIndex = -1;
		let oldestStamp = Number.POSITIVE_INFINITY;
		for (let index = 0; index < this._slots.length; index++) {
			const expertIndex = this._slotExpert[index];
			if (expertIndex !== undefined && this._pinned.has(expertIndex) === true) {
				continue;
			}
			if (this._slotStamp[index] < oldestStamp) {
				oldestStamp = this._slotStamp[index];
				chosenIndex = index;
			}
		}
		if (chosenIndex === -1) {
			throw new Error(
				`every one of the ${this._slots.length} slots holds a pinned expert, so nothing can be read in. ` +
					'Pin fewer experts than the cache can hold.',
			);
		}
		return chosenIndex;
	}
}
