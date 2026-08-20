import type { TokenizerSource } from './types';
export type TokenizerData = {
    tokens: Uint8Array[];
    eosTokenId: number;
    specialTokenIds: Set<number>;
};
export declare function extractTokenizer(tokenizer: TokenizerSource): TokenizerData;
