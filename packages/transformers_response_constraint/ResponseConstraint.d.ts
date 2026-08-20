import { StoppingCriteria } from '@huggingface/transformers';
import { type JSONSchema, type TokenConstraint, type TokenizerSource } from './engine';
export type ResponseFormat = {
    type: 'json_object';
} | {
    type: 'json_schema';
    json_schema: JSONSchema;
} | {
    type: 'regex';
    regex: string;
};
type GenerationState = {
    completed: boolean;
    constraint: TokenConstraint;
    mask?: Uint32Array;
};
export declare class ResponseConstraint {
    /**
     * Precomputes the tokenizer-derived data structures used by every
     * constraint. The first constraint per tokenizer otherwise pays this cost
     * (hundreds of milliseconds for large vocabularies) inside
     * `fromResponseFormat`; call this once after loading the model to pay it
     * early instead.
     */
    static warmup(tokenizer: TokenizerSource): void;
    static fromResponseFormat(tokenizer: TokenizerSource, responseFormat: ResponseFormat): {
        logits_processor: any;
        stopping_criteria: ConstraintStoppingCriteria;
    };
}
declare class ConstraintStoppingCriteria extends StoppingCriteria {
    private readonly state;
    constructor(state: GenerationState);
    _call(inputIds: ArrayLike<unknown>[]): boolean[];
}
export {};
