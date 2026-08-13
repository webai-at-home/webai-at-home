import type { SelectionKind } from './residency_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExpertSelection — the synthetic sequences of expert choices that drive the measurement loop
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Milestone 4 of https://github.com/webai-at-home/webai-at-home/issues/169 measures the residency layer, not the model.
 * The residency layer needs to be told which experts each token wants, and the real answer to that comes from the
 * router of Qwen3-30B-A3B reading a real prompt, which needs the graph milestone 5 builds.
 *
 * Rather than invent one number and present it as the answer, this offers two sequences that bracket the real one:
 *
 * - `uniform` picks the selected experts uniformly at random from all 128 of a layer. This is the worst case any cache
 *   can meet. No policy helps against it, and a hit rate measured under it is a floor.
 * - `skewed` picks them with a long-tailed weighting, so a minority of experts of each layer take most of the traffic.
 *   Routed mixtures of experts are generally observed to behave this way, but the exponent here is chosen, not
 *   measured, so this is a shape rather than a prediction.
 *
 * **Neither is Qwen3-30B-A3B.** Any hit rate this page reports must be quoted with the sequence that produced it, and
 * no number from here should be carried into the deliverable of issue #168 without the real router replacing this.
 */

/** How strongly the skewed sequence favours the experts it favours. Chosen for shape, not measured. */
const SKEW_EXPONENT = 1.2;

/** Produces deterministic sequences of expert choices for the measurement loop. */
export class ExpertSelection {
	/** The layer count of the model being simulated. */
	private readonly _layerCount: number;
	/** How many experts each layer holds. */
	private readonly _expertsForEachLayer: number;
	/** How many experts each layer selects for each token. */
	private readonly _selectedForEachLayer: number;
	/** Which sequence this is. */
	private readonly _kind: SelectionKind;
	/**
	 * For the skewed sequence, the cumulative weights of one layer's experts, computed once. The same table serves
	 * every layer, with each layer's own permutation applied, so that no two layers favour the same expert numbers.
	 */
	private readonly _cumulativeWeights: number[] = [];
	/** For the skewed sequence, each layer's permutation of expert numbers. */
	private readonly _layerPermutations: number[][] = [];
	/** The state of the deterministic generator, so two runs of the same settings choose the same experts. */
	private _randomState: number;

	/**
	 * Builds a sequence.
	 *
	 * @param kind Which sequence to produce.
	 * @param layerCount How many layers the model has.
	 * @param expertsForEachLayer How many experts one layer holds.
	 * @param selectedForEachLayer How many experts one layer selects for each token.
	 * @param seed The seed, so a run can be repeated exactly.
	 */
	constructor(
		kind: SelectionKind,
		layerCount: number,
		expertsForEachLayer: number,
		selectedForEachLayer: number,
		seed: number,
	) {
		this._kind = kind;
		this._layerCount = layerCount;
		this._expertsForEachLayer = expertsForEachLayer;
		this._selectedForEachLayer = selectedForEachLayer;
		this._randomState = seed;

		if (this._kind === 'skewed') {
			let runningTotal = 0;
			for (let rank = 0; rank < this._expertsForEachLayer; rank++) {
				runningTotal += 1 / Math.pow(rank + 1, SKEW_EXPONENT);
				this._cumulativeWeights.push(runningTotal);
			}
			for (let layerIndex = 0; layerIndex < this._layerCount; layerIndex++) {
				this._layerPermutations.push(this._shuffledExpertNumbers());
			}
		}
	}

	/**
	 * Chooses the experts one layer wants for one token.
	 *
	 * @param layerIndex Which layer is choosing.
	 * @returns The chosen expert numbers within that layer, with no repeats.
	 */
	select(layerIndex: number): number[] {
		const chosen = new Set<number>();
		let attempts = 0;
		while (chosen.size < this._selectedForEachLayer) {
			chosen.add(this._chooseOne(layerIndex));
			attempts++;
			if (attempts > this._selectedForEachLayer * 64) {
				throw new Error('the selection could not find enough distinct experts, which means the weighting is wrong');
			}
		}
		return Array.from(chosen);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Chooses one expert of one layer, according to the sequence this is.
	 *
	 * @param layerIndex Which layer is choosing.
	 * @returns The chosen expert number within that layer.
	 */
	private _chooseOne(layerIndex: number): number {
		if (this._kind === 'uniform') {
			return Math.floor(this._nextRandom() * this._expertsForEachLayer);
		}
		const target = this._nextRandom() * this._cumulativeWeights[this._cumulativeWeights.length - 1];
		let rank = 0;
		while (rank < this._cumulativeWeights.length - 1 && this._cumulativeWeights[rank] < target) {
			rank++;
		}
		return this._layerPermutations[layerIndex][rank];
	}

	/**
	 * Produces one layer's permutation of expert numbers, so the favoured experts differ from layer to layer.
	 *
	 * @returns The expert numbers of one layer, shuffled.
	 */
	private _shuffledExpertNumbers(): number[] {
		const numbers: number[] = [];
		for (let index = 0; index < this._expertsForEachLayer; index++) {
			numbers.push(index);
		}
		for (let index = numbers.length - 1; index > 0; index--) {
			const other = Math.floor(this._nextRandom() * (index + 1));
			const held = numbers[index];
			numbers[index] = numbers[other];
			numbers[other] = held;
		}
		return numbers;
	}

	/**
	 * The deterministic generator. A seeded generator rather than `Math.random` so that the uniform run and the skewed
	 * run can be compared without the comparison moving between runs.
	 *
	 * @returns The next value, from 0 up to but not including 1.
	 */
	private _nextRandom(): number {
		this._randomState = (this._randomState + 0x6d2b79f5) | 0;
		let value = this._randomState;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	}
}
