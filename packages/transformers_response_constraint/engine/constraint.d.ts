import type { JSONSchema, TokenizerSource } from './types';
type ResponseFormat = {
    type: 'json_object';
} | {
    type: 'json_schema';
    json_schema: JSONSchema;
} | {
    type: 'regex';
    regex: string;
};
export type TokenConstraint = {
    vocabSize: number;
    fillMask(target: Uint32Array): boolean;
    commit(tokenId: number): boolean;
};
/**
 * Builds and caches the tokenizer-derived data structures (token tries, string
 * masks) ahead of time. This is the expensive part of creating the first
 * constraint for a tokenizer (hundreds of milliseconds for a 256k vocabulary),
 * so calling this right after loading a model moves that cost off the first
 * generation. Subsequent calls with the same tokenizer are free.
 */
export declare function prepareTokenizer(tokenizerSource: TokenizerSource): void;
export declare function createTokenConstraint(tokenizerSource: TokenizerSource, responseFormat: ResponseFormat): TokenConstraint;
export {};
