import type { ConstraintState, JSONSchema } from './types';
type Schema = boolean | Record<string, unknown>;
type JsonNode = {
    kind: 'null';
    value: null;
} | {
    kind: 'boolean';
    value: boolean;
} | {
    kind: 'number';
    value: number;
    raw: string;
} | {
    kind: 'string';
    value: string;
} | {
    kind: 'array';
    value: unknown[];
    items: JsonNode[];
} | {
    kind: 'object';
    value: Record<string, unknown>;
    entries: Array<{
        key: string;
        node: JsonNode;
    }>;
};
type Guidance = {
    itemSeparator: string;
    keySeparator: string;
    itemBytes: Uint8Array;
    keyBytes: Uint8Array;
    whitespaceFlexible: boolean;
};
type Mode = 'value' | 'array-value' | 'object-key' | 'colon' | 'item-separator' | 'after-value' | 'string' | 'key-string' | 'escape' | 'key-escape' | 'unicode' | 'key-unicode' | 'number' | 'literal' | 'done' | 'dead';
type ObjectFrame = {
    kind: 'object';
    schema: Schema;
    seen: ReadonlySet<string>;
    entries: ReadonlyArray<{
        key: string;
        node: JsonNode;
    }>;
    key?: string;
    childSchema?: Schema;
};
type ArrayFrame = {
    kind: 'array';
    schema: Schema;
    length: number;
    items: readonly JsonNode[];
};
type Frame = ObjectFrame | ArrayFrame;
type JsonState = {
    mode: Mode;
    schema: Schema;
    stack: readonly Frame[];
    bytes?: readonly number[];
    stringLength?: number;
    stringPending?: number;
    text?: string;
    literal?: string;
    literalValue?: null | boolean;
    index?: number;
    highSurrogate?: number;
    guidance: Guidance;
};
export declare function compileJsonSchema(schema: JSONSchema, stringKeyClamp?: number): ConstraintState<JsonState>;
export {};
