import { type Tensor } from '@huggingface/transformers';
export declare function applyMask(logits: Tensor, mask: Uint32Array, vocabSize: number): void;
