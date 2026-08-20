// src/ResponseConstraint.ts
import { LogitsProcessor, LogitsProcessorList, StoppingCriteria } from "@huggingface/transformers";

// src/engine/json.ts
var DEFAULT_GUIDANCE = {
  itemSeparator: ",",
  keySeparator: ":",
  itemBytes: Uint8Array.of(44),
  keyBytes: Uint8Array.of(58),
  whitespaceFlexible: true
};
var DEAD = { mode: "dead", schema: false, stack: [], guidance: DEFAULT_GUIDANCE };
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var schemaIds = /* @__PURE__ */ new WeakMap();
var propertyKeyBytes = /* @__PURE__ */ new WeakMap();
var finiteStringCache = /* @__PURE__ */ new WeakMap();
var nextSchemaId = 0;
var SIMPLE_ESCAPES = {
  34: '"',
  47: "/",
  92: "\\",
  98: "\b",
  102: "\f",
  110: "\n",
  114: "\r",
  116: "	"
};
function compileJsonSchema(schema, stringKeyClamp = Infinity) {
  registerSchemaContext(schema, schema);
  checkSchema(schema, "$");
  checkReferences(schema);
  const guidance = guidanceFrom(schema);
  return {
    initial: { mode: "value", schema, stack: [], guidance },
    transition,
    viable: (state) => state !== DEAD,
    accepting: isAccepting,
    stringCapacity,
    maskKey: (state) => stateMaskKey(state, stringKeyClamp)
  };
}
function stringCapacity(state) {
  if (state.mode !== "string" || state.highSurrogate !== void 0 || finiteStringValues(state.schema) !== null)
    return void 0;
  if ((state.stringPending ?? 0) !== 0) return void 0;
  const maximum = directStringMaxLength(state.schema);
  if (maximum === void 0) return Infinity;
  return maximum - (state.stringLength ?? 0);
}
function stateMaskKey(state, stringKeyClamp) {
  if (state === DEAD) return void 0;
  const frames = state.stack.map((frame) => {
    if (frame.kind === "object") {
      const entries = [...frame.entries].sort((left, right) => left.key.localeCompare(right.key)).map((entry) => `${JSON.stringify(entry.key)}:${nodeKey(entry.node)}`).join(",");
      return `o${schemaId(frame.schema)}[${entries}]${frame.key === void 0 ? "" : `:${JSON.stringify(frame.key)}:${schemaId(frame.childSchema)}`}`;
    }
    return `a${schemaId(frame.schema)}[${frame.items.map(nodeKey).join(",")}]`;
  });
  const key = [
    state.mode,
    schemaId(state.schema),
    state.bytes === void 0 ? "" : stringLengthKey(state, stringKeyClamp) ?? bytesKey(state.bytes),
    state.text ?? "",
    state.literal ?? "",
    state.index ?? "",
    state.highSurrogate ?? "",
    ...frames
  ].join("|");
  return key.length <= 2048 ? key : void 0;
}
var CONTENT_DEPENDENT_STRING_KEYWORDS = ["pattern", "format", "const", "enum", "$ref", "allOf", "anyOf", "oneOf", "not", "if"];
var CONTENT_DEPENDENT_FRAME_KEYWORDS = [
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "uniqueItems",
  "contains",
  "dependentSchemas",
  "dependencies"
];
var contentIndependentStrings = /* @__PURE__ */ new WeakMap();
var contentNeutralFrames = /* @__PURE__ */ new WeakMap();
function isContentIndependent(schema, keywords, cache) {
  if (schema === true) return true;
  if (schema === false) return false;
  let result = cache.get(schema);
  if (result === void 0) {
    result = keywords.every((keyword) => schema[keyword] === void 0);
    cache.set(schema, result);
  }
  return result;
}
function stringLengthKey(state, clamp) {
  if (state.mode !== "string" || state.highSurrogate !== void 0) return void 0;
  if (!isContentIndependent(state.schema, CONTENT_DEPENDENT_STRING_KEYWORDS, contentIndependentStrings)) {
    return void 0;
  }
  for (const frame of state.stack) {
    if (!isContentIndependent(frame.schema, CONTENT_DEPENDENT_FRAME_KEYWORDS, contentNeutralFrames)) {
      return void 0;
    }
  }
  if ((state.stringPending ?? 0) !== 0) return void 0;
  const length = state.stringLength ?? 0;
  const maximum = directStringMaxLength(state.schema);
  const remaining = Math.min(maximum === void 0 ? Infinity : maximum - length, clamp);
  const minimum = state.schema !== true && state.schema !== false && typeof state.schema.minLength === "number" ? state.schema.minLength : 0;
  return `#${remaining === Infinity ? "inf" : remaining}:${length >= minimum ? "" : length}`;
}
function nodeKey(node) {
  if (node.kind === "number") return `n${node.raw}`;
  if (node.kind === "string") return `s${JSON.stringify(node.value)}`;
  if (node.kind === "boolean") return node.value ? "t" : "f";
  if (node.kind === "null") return "z";
  if (node.kind === "array") return `[${node.items.map(nodeKey).join(",")}]`;
  return `{${[...node.entries].sort((left, right) => left.key.localeCompare(right.key)).map((entry) => `${JSON.stringify(entry.key)}:${nodeKey(entry.node)}`).join(",")}}`;
}
function bytesKey(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
function schemaId(schema) {
  if (schema === true) return "t";
  if (schema === false) return "f";
  let id = schemaIds.get(schema);
  if (id === void 0) {
    id = nextSchemaId++;
    schemaIds.set(schema, id);
  }
  return id;
}
function transition(state, byte) {
  if (state === DEAD) return DEAD;
  if (state.guidance.whitespaceFlexible && isWhitespace(byte) && allowsWhitespace(state.mode) && !separatorExpects(state, byte))
    return state;
  switch (state.mode) {
    case "value":
    case "array-value":
      if (state.mode === "array-value" && byte === 93) return closeArray(state);
      if (state.mode === "array-value" && exceedsMaxItems(state.stack.at(-1))) return DEAD;
      return startValue(state, byte);
    case "object-key":
      if (byte === 125) return closeObject(state);
      return byte === 34 ? { ...state, mode: "key-string", bytes: [], stringLength: 0, stringPending: 0 } : DEAD;
    case "colon":
      return separatorByte(state, byte, state.guidance.keyBytes, "value");
    case "item-separator":
      return separatorByte(
        state,
        byte,
        state.guidance.itemBytes,
        state.stack.at(-1)?.kind === "object" ? "object-key" : "array-value"
      );
    case "after-value":
      return afterValue(state, byte);
    case "string":
    case "key-string":
      return stringByte(state, byte);
    case "escape":
    case "key-escape":
      return escapeByte(state, byte);
    case "unicode":
    case "key-unicode":
      return unicodeByte(state, byte);
    case "number":
      return numberByte(state, byte);
    case "literal":
      return literalByte(state, byte);
    case "done":
    case "dead":
      return DEAD;
  }
}
function startValue(state, byte) {
  const kind = byteKind(byte);
  if (kind === void 0) return DEAD;
  const schema = selectSchema(state.schema, kind);
  if (schema === null) return DEAD;
  if (byte === 34) return { ...state, mode: "string", schema, bytes: [], stringLength: 0, stringPending: 0 };
  if (byte === 123) {
    return {
      mode: "object-key",
      schema,
      stack: [...state.stack, { kind: "object", schema, seen: /* @__PURE__ */ new Set(), entries: [] }],
      guidance: state.guidance
    };
  }
  if (byte === 91) {
    return {
      mode: "array-value",
      schema: itemSchema(schema, 0),
      stack: [
        ...state.stack,
        {
          kind: "array",
          schema,
          length: 0,
          items: []
        }
      ],
      guidance: state.guidance
    };
  }
  if (byte === 116) return { ...state, mode: "literal", schema, literal: "true", literalValue: true, index: 1 };
  if (byte === 102) return { ...state, mode: "literal", schema, literal: "false", literalValue: false, index: 1 };
  if (byte === 110) return { ...state, mode: "literal", schema, literal: "null", literalValue: null, index: 1 };
  const text = String.fromCharCode(byte);
  if (!integerPrefixViable(schema, text)) return DEAD;
  return { ...state, mode: "number", schema, text };
}
function isAccepting(state) {
  if (state.mode === "done") return true;
  return state.mode === "number" && state.stack.length === 0 && numberComplete(state.text) && validateNode(state.schema, { kind: "number", value: Number(state.text), raw: state.text });
}
function stringByte(state, byte) {
  const isKey = state.mode === "key-string";
  if (state.highSurrogate !== void 0 && byte !== 92) return DEAD;
  if (byte === 34) {
    const value = decodeString(state.bytes ?? []);
    if (value === null) return DEAD;
    if (isKey) return completeKey(state, value);
    return completeValue(state, { kind: "string", value });
  }
  if (byte === 92) {
    if (isKey ? !keyEscapeAllowed(state) : !stringEscapeAllowed(state)) return DEAD;
    return { ...state, mode: isKey ? "key-escape" : "escape" };
  }
  if (byte < 32) return DEAD;
  let length = state.stringLength ?? 0;
  let pending = state.stringPending ?? 0;
  if ((byte & 192) === 128) {
    pending = pending > 0 ? pending - 1 : -1;
  } else {
    pending = pending === 0 ? utf8Continuations(byte) : -1;
    length++;
  }
  const bytes = [...state.bytes ?? [], byte];
  if (isKey && !keyPrefixAllowed(state, bytes)) return DEAD;
  if (!isKey && !stringContentAllowed(state.schema, bytes, length)) return DEAD;
  return { ...state, bytes, stringLength: length, stringPending: pending };
}
function utf8Continuations(lead) {
  if (lead < 128) return 0;
  if (lead < 194) return -1;
  if (lead < 224) return 1;
  if (lead < 240) return 2;
  if (lead < 245) return 3;
  return -1;
}
function escapeByte(state, byte) {
  const isKey = state.mode === "key-escape";
  if (state.highSurrogate !== void 0 && byte !== 117) return DEAD;
  if (byte === 117) {
    return { ...state, mode: isKey ? "key-unicode" : "unicode", text: "" };
  }
  const escaped = SIMPLE_ESCAPES[byte];
  if (escaped === void 0) return DEAD;
  const bytes = [...state.bytes ?? [], ...encoder.encode(escaped)];
  const length = (state.stringLength ?? 0) + 1;
  const pending = (state.stringPending ?? 0) === 0 ? 0 : -1;
  if (isKey && !keyPrefixAllowed(state, bytes)) return DEAD;
  if (!isKey && !stringContentAllowed(state.schema, bytes, length)) return DEAD;
  return { ...state, mode: isKey ? "key-string" : "string", bytes, stringLength: length, stringPending: pending };
}
function unicodeByte(state, byte) {
  if (!isHex(byte)) return DEAD;
  const text = `${state.text ?? ""}${String.fromCharCode(byte)}`;
  if (text.length < 4) {
    if (state.mode === "key-unicode" && !unicodeKeyPrefixAllowed(state, text)) return DEAD;
    return { ...state, text };
  }
  const codeUnit = Number.parseInt(text, 16);
  const isKey = state.mode === "key-unicode";
  const mode = isKey ? "key-string" : "string";
  if (codeUnit >= 55296 && codeUnit <= 56319) {
    if (state.highSurrogate !== void 0) return DEAD;
    return { ...state, mode, text: void 0, highSurrogate: codeUnit };
  }
  let value;
  if (codeUnit >= 56320 && codeUnit <= 57343) {
    if (state.highSurrogate === void 0) return DEAD;
    const codePoint = 65536 + (state.highSurrogate - 55296 << 10) + (codeUnit - 56320);
    value = String.fromCodePoint(codePoint);
  } else {
    if (state.highSurrogate !== void 0) return DEAD;
    value = String.fromCharCode(codeUnit);
  }
  const bytes = [...state.bytes ?? [], ...encoder.encode(value)];
  const length = (state.stringLength ?? 0) + 1;
  const pending = (state.stringPending ?? 0) === 0 ? 0 : -1;
  if (isKey && !keyPrefixAllowed(state, bytes)) return DEAD;
  if (!isKey && !stringContentAllowed(state.schema, bytes, length)) return DEAD;
  return {
    ...state,
    mode,
    bytes,
    text: void 0,
    highSurrogate: void 0,
    stringLength: length,
    stringPending: pending
  };
}
function completeKey(state, key) {
  const frame = topObject(state);
  if (frame.seen.has(key)) return DEAD;
  const childSchema = propertySchema(frame.schema, key, frame.entries);
  if (childSchema === null) return DEAD;
  return {
    ...state,
    mode: "colon",
    bytes: void 0,
    index: 0,
    stack: replaceTop(state.stack, { ...frame, key, childSchema })
  };
}
function literalByte(state, byte) {
  const index = state.index ?? 0;
  const literal2 = state.literal;
  if (byte !== literal2.charCodeAt(index)) return DEAD;
  if (index + 1 < literal2.length) return { ...state, index: index + 1 };
  const node = state.literalValue === null ? { kind: "null", value: null } : { kind: "boolean", value: state.literalValue };
  return completeValue(state, node);
}
function numberByte(state, byte) {
  if (isNumberByte(byte)) {
    const text = `${state.text}${String.fromCharCode(byte)}`;
    if (numberPrefixValid(text) && integerPrefixViable(state.schema, text)) return { ...state, text };
  }
  const value = finishNumber(state);
  return value === DEAD ? DEAD : transition(value, byte);
}
var SCALE_DIGIT_LIMIT = 3;
var integerRestrictions = /* @__PURE__ */ new WeakMap();
function integerPrefixViable(schema, text) {
  const restriction = integerRestriction(schema);
  if (restriction === null) return true;
  const { lo, hi } = restriction;
  if (text === "-") return lo <= Math.min(hi, 0);
  const match = /^(-?)(0|[1-9]\d*)(\.0{0,3})?(?:[eE]\+?(\d{0,3}))?$/.exec(text);
  if (match === null) return false;
  if (match[3] === "." && match[4] !== void 0) return false;
  const negative = match[1] === "-";
  if (match[3] === void 0 && match[4] === void 0) {
    return integerDigitsReachable(lo, hi, negative, match[2]);
  }
  return integerScaleReachable(lo, hi, negative, match[2], match[4] ?? "");
}
function integerRestriction(schema) {
  if (schema === true || schema === false) return null;
  let restriction = integerRestrictions.get(schema);
  if (restriction === void 0) {
    restriction = computeIntegerRestriction(schema);
    integerRestrictions.set(schema, restriction);
  }
  return restriction;
}
function computeIntegerRestriction(schema) {
  let integerOnly = false;
  if (schema.type !== void 0) {
    const types = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
    integerOnly = types.includes("integer") && !types.includes("number");
  } else if (typeof schema.const === "number") {
    integerOnly = Number.isInteger(schema.const);
  } else if (Array.isArray(schema.enum)) {
    const numbers = schema.enum.filter((value) => typeof value === "number");
    integerOnly = numbers.length > 0 && numbers.every((value) => Number.isInteger(value));
  }
  if (!integerOnly) return null;
  let lo = -Infinity;
  let hi = Infinity;
  if (typeof schema.minimum === "number") lo = Math.ceil(schema.minimum);
  if (typeof schema.exclusiveMinimum === "number") lo = Math.max(lo, Math.floor(schema.exclusiveMinimum) + 1);
  if (typeof schema.maximum === "number") hi = Math.floor(schema.maximum);
  if (typeof schema.exclusiveMaximum === "number") hi = Math.min(hi, Math.ceil(schema.exclusiveMaximum) - 1);
  if (!Number.isSafeInteger(lo)) lo = -Infinity;
  if (!Number.isSafeInteger(hi)) hi = Infinity;
  return { lo, hi };
}
function integerDigitsReachable(lo, hi, negative, digits) {
  if (digits.length > 16) return negative ? lo === -Infinity : hi === Infinity;
  let low = Number(digits);
  let high = low + 1;
  const extensible = low !== 0;
  for (; ; ) {
    if (negative) {
      if (-(high - 1) <= hi && -low >= lo) return true;
      if (-low < lo) return false;
    } else {
      if (low <= hi && high - 1 >= lo) return true;
      if (low > hi) return false;
    }
    if (!extensible) return false;
    low *= 10;
    high *= 10;
  }
}
function integerScaleReachable(lo, hi, negative, digits, exponentPrefix) {
  if (digits.length > 16) return negative ? lo === -Infinity : hi === Infinity;
  const base = Number(digits);
  if (base === 0) return lo <= 0 && 0 <= hi;
  let magnitude = base;
  for (let exponent = 0; exponent <= 999; ++exponent) {
    const value = negative ? -magnitude : magnitude;
    const inRange = (lo === -Infinity || value >= lo) && (hi === Infinity || value <= hi);
    if (inRange && exponentTypeable(exponent, exponentPrefix)) return true;
    if (negative ? lo !== -Infinity && value < lo : hi !== Infinity && value > hi) return false;
    magnitude *= 10;
  }
  return false;
}
function exponentTypeable(exponent, prefix) {
  const typed = prefix === "" ? 0 : Number(prefix);
  for (let extra = Math.max(0, 1 - prefix.length); extra <= SCALE_DIGIT_LIMIT - prefix.length; ++extra) {
    const scale = 10 ** extra;
    if (exponent >= typed * scale && exponent < (typed + 1) * scale) return true;
  }
  return false;
}
function finishNumber(state) {
  const text = state.text;
  if (!numberComplete(text)) return DEAD;
  return completeValue(state, { kind: "number", value: Number(text), raw: text });
}
function completeValue(state, node) {
  if (!validateNode(state.schema, node)) return DEAD;
  if (state.stack.length === 0) return { mode: "done", schema: state.schema, stack: [], guidance: state.guidance };
  const frame = state.stack.at(-1);
  if (frame.kind === "object") {
    if (frame.key === void 0) return DEAD;
    const seen = new Set(frame.seen);
    seen.add(frame.key);
    const entries = [...frame.entries, { key: frame.key, node }];
    if (!partialObjectValid(frame.schema, entries, /* @__PURE__ */ new Set())) return DEAD;
    return {
      mode: "after-value",
      schema: frame.schema,
      stack: replaceTop(state.stack, { kind: "object", schema: frame.schema, seen, entries }),
      guidance: state.guidance
    };
  }
  return {
    mode: "after-value",
    schema: frame.schema,
    stack: replaceTop(state.stack, { ...frame, length: frame.length + 1, items: [...frame.items, node] }),
    guidance: state.guidance
  };
}
function afterValue(state, byte) {
  const frame = state.stack.at(-1);
  if (frame === void 0) return DEAD;
  if (frame.kind === "object") {
    if (byte === 125) return closeObject(state);
    if (!objectCanAddProperty(frame)) return DEAD;
    return separatorByte(
      { ...state, mode: "item-separator", index: 0 },
      byte,
      state.guidance.itemBytes,
      "object-key"
    );
  }
  if (byte === 93) return closeArray(state);
  if (exceedsMaxItems(frame)) return DEAD;
  return separatorByte({ ...state, mode: "item-separator", index: 0 }, byte, state.guidance.itemBytes, "array-value");
}
function separatorByte(state, byte, separator, completedMode) {
  const index = state.index ?? 0;
  if (byte !== separator[index]) return DEAD;
  if (index + 1 < separator.length) return { ...state, index: index + 1 };
  const frame = state.stack.at(-1);
  return {
    ...state,
    mode: completedMode,
    schema: completedMode === "value" ? topObject(state).childSchema : completedMode === "array-value" && frame?.kind === "array" ? itemSchema(frame.schema, frame.length) : state.schema,
    index: void 0
  };
}
function separatorExpects(state, byte) {
  if (state.mode === "colon") return state.guidance.keyBytes[state.index ?? 0] === byte;
  if (state.mode === "item-separator") return state.guidance.itemBytes[state.index ?? 0] === byte;
  return false;
}
function closeObject(state) {
  const frame = state.stack.at(-1);
  if (frame?.kind !== "object") return DEAD;
  const value = /* @__PURE__ */ Object.create(null);
  for (const entry of frame.entries) value[entry.key] = entry.node.value;
  return completeValue(
    { ...state, schema: frame.schema, stack: state.stack.slice(0, -1) },
    { kind: "object", value, entries: [...frame.entries] }
  );
}
function closeArray(state) {
  const frame = state.stack.at(-1);
  if (frame?.kind !== "array") return DEAD;
  return completeValue(
    { ...state, schema: frame.schema, stack: state.stack.slice(0, -1) },
    { kind: "array", value: frame.items.map((item) => item.value), items: [...frame.items] }
  );
}
function selectSchema(schema, kind) {
  return schemaMayAcceptKind(schema, kind, /* @__PURE__ */ new Set()) ? schema : null;
}
function propertySchema(schema, key, entries = []) {
  if (schema === true) return true;
  if (schema === false) return null;
  const schemas = [];
  const direct = directPropertySchema(schema, key);
  if (direct === null) return null;
  if (direct !== true) schemas.push(direct);
  for (const candidate of [schema, ...Array.isArray(schema.allOf) ? schema.allOf.filter(isSchema) : []]) {
    if (candidate === true || candidate === false) continue;
    const branch = selectedConditionalBranch(candidate, entries);
    if (branch === void 0 || branch === true) continue;
    if (branch === false) return null;
    const branchSchema = directPropertySchema(branch, key);
    if (branchSchema === null) return null;
    if (branchSchema !== true) schemas.push(branchSchema);
  }
  if (schemas.length === 0) return true;
  return schemas.length === 1 ? schemas[0] : { allOf: schemas };
}
function directPropertySchema(schema, key) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const schemas = [];
  if (isSchema(properties[key])) schemas.push(properties[key]);
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, candidate] of Object.entries(schema.patternProperties)) {
      if (new RegExp(pattern, "u").test(key) && isSchema(candidate)) schemas.push(candidate);
    }
  }
  if (schemas.length === 0) {
    if (schema.additionalProperties === false) return null;
    return isSchema(schema.additionalProperties) ? schema.additionalProperties : true;
  }
  return schemas.length === 1 ? schemas[0] : { allOf: schemas };
}
function selectedConditionalBranch(schema, entries) {
  if (!isSchema(schema.if) || schema.if === true || schema.if === false) return void 0;
  const required = Array.isArray(schema.if.required) ? schema.if.required : [];
  if (required.length === 0 || !required.every((key) => entries.some((entry) => entry.key === key))) return void 0;
  const node = objectNode(entries);
  const branch = validateNode(schema.if, node) ? schema.then : schema.else;
  return isSchema(branch) ? branch : void 0;
}
function partialObjectValid(schema, entries, seen) {
  if (schema === true) return true;
  if (schema === false) return false;
  if (seen.has(schema)) return true;
  seen.add(schema);
  try {
    for (const entry of entries) {
      const child = directPropertySchema(schema, entry.key);
      if (child === null || child !== true && !validateNode(child, entry.node)) return false;
    }
    if (typeof schema.$ref === "string" && !partialObjectValid(resolveReference(schema, schema.$ref), entries, seen))
      return false;
    if (Array.isArray(schema.allOf) && !schema.allOf.every((child) => !isSchema(child) || partialObjectValid(child, entries, seen)))
      return false;
    const branch = selectedConditionalBranch(schema, entries);
    return branch === void 0 || partialObjectValid(branch, entries, seen);
  } finally {
    seen.delete(schema);
  }
}
function objectNode(entries) {
  const value = /* @__PURE__ */ Object.create(null);
  for (const entry of entries) value[entry.key] = entry.node.value;
  return { kind: "object", value, entries: [...entries] };
}
function itemSchema(schema, index) {
  if (schema === true || schema === false || hasDeferredStructure(schema)) return schema === false ? false : true;
  if (Array.isArray(schema.prefixItems) && isSchema(schema.prefixItems[index])) return schema.prefixItems[index];
  if (Array.isArray(schema.items)) {
    if (isSchema(schema.items[index])) return schema.items[index];
    return isSchema(schema.additionalItems) ? schema.additionalItems : true;
  }
  return isSchema(schema.items) ? schema.items : true;
}
function keyPrefixAllowed(state, bytes) {
  const frame = topObject(state);
  if (frame.schema === true || frame.schema === false) return true;
  const properties = encodedPropertyKeys(frame.schema);
  if (properties === null) return true;
  return properties.some(({ key, bytes: propertyBytes }) => {
    if (frame.seen.has(key) || bytes.length > propertyBytes.length) return false;
    for (let index = 0; index < bytes.length; ++index) {
      if (bytes[index] !== propertyBytes[index]) return false;
    }
    return true;
  });
}
function keyEscapeAllowed(state) {
  const frame = topObject(state);
  if (frame.schema === true || frame.schema === false) return true;
  const properties = encodedPropertyKeys(frame.schema);
  if (properties === null) return true;
  if (state.highSurrogate !== void 0) return true;
  const bytes = state.bytes ?? [];
  return properties.some(({ key, bytes: propertyBytes }) => {
    if (frame.seen.has(key) || propertyBytes.length <= bytes.length) return false;
    for (let index = 0; index < bytes.length; ++index) {
      if (bytes[index] !== propertyBytes[index]) return false;
    }
    const next = propertyBytes[bytes.length];
    return next < 32 || next === 34 || next === 92 || next >= 128;
  });
}
function objectCanAddProperty(frame) {
  if (frame.schema === true || frame.schema === false) return true;
  const properties = encodedPropertyKeys(frame.schema);
  return properties === null || properties.some(({ key }) => !frame.seen.has(key));
}
function stringContentAllowed(schema, bytes, length) {
  const values = finiteStringValues(schema);
  if (values !== null && !values.some(({ bytes: valueBytes }) => {
    if (bytes.length > valueBytes.length) return false;
    for (let index = 0; index < bytes.length; ++index) {
      if (bytes[index] !== valueBytes[index]) return false;
    }
    return true;
  }))
    return false;
  const maximum = directStringMaxLength(schema);
  return maximum === void 0 || length <= maximum;
}
function stringEscapeAllowed(state) {
  const values = finiteStringValues(state.schema);
  const maximum = directStringMaxLength(state.schema);
  if (maximum !== void 0 && (state.stringLength ?? 0) >= maximum) return false;
  if (values === null) return true;
  if (state.highSurrogate !== void 0) return true;
  const bytes = state.bytes ?? [];
  return values.some(({ bytes: valueBytes }) => {
    if (valueBytes.length <= bytes.length) return false;
    for (let index = 0; index < bytes.length; ++index) {
      if (bytes[index] !== valueBytes[index]) return false;
    }
    const next = valueBytes[bytes.length];
    return next < 32 || next === 34 || next === 92 || next >= 128;
  });
}
function directStringMaxLength(schema) {
  return schema !== true && schema !== false && typeof schema.maxLength === "number" ? schema.maxLength : void 0;
}
function finiteStringValues(schema) {
  if (schema === true || schema === false) return null;
  let values = finiteStringCache.get(schema);
  if (values !== void 0) return values;
  let candidates = null;
  if (typeof schema.const === "string") candidates = [schema.const];
  else if (Array.isArray(schema.enum))
    candidates = schema.enum.filter((value) => typeof value === "string");
  values = candidates === null ? null : [...new Set(candidates)].filter((value) => validateNode(schema, { kind: "string", value })).map((value) => ({ value, bytes: encoder.encode(value) }));
  finiteStringCache.set(schema, values);
  return values;
}
function unicodeKeyPrefixAllowed(state, hexPrefix) {
  const frame = topObject(state);
  if (frame.schema === true || frame.schema === false) return true;
  const properties = encodedPropertyKeys(frame.schema);
  if (properties === null) return true;
  const prefix = decodeString(state.bytes ?? []);
  if (prefix === null) return true;
  return properties.some(({ key }) => {
    if (frame.seen.has(key) || !key.startsWith(prefix)) return false;
    const offset = prefix.length;
    let codeUnit = key.charCodeAt(offset);
    if (state.highSurrogate !== void 0) {
      if (codeUnit !== state.highSurrogate) return false;
      codeUnit = key.charCodeAt(offset + 1);
    }
    return Number.isInteger(codeUnit) && codeUnit.toString(16).padStart(4, "0").startsWith(hexPrefix.toLowerCase());
  });
}
function encodedPropertyKeys(schema) {
  let properties = propertyKeyBytes.get(schema);
  if (properties === void 0) {
    const keys = constrainedPropertyKeys(schema, /* @__PURE__ */ new Set());
    properties = keys === null ? null : [...keys].map((key) => ({ key, bytes: encoder.encode(key) }));
    propertyKeyBytes.set(schema, properties);
  }
  return properties;
}
function constrainedPropertyKeys(schema, seen) {
  if (schema === true || schema === false || seen.has(schema)) return null;
  seen.add(schema);
  try {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    let result = schema.additionalProperties === false && !isRecord(schema.patternProperties) ? new Set(Object.keys(properties)) : null;
    if (typeof schema.$ref === "string") {
      result = intersectKeySets(result, constrainedPropertyKeys(resolveReference(schema, schema.$ref), seen));
    }
    if (Array.isArray(schema.allOf)) {
      for (const child of schema.allOf) {
        if (isSchema(child)) result = intersectKeySets(result, constrainedPropertyKeys(child, seen));
      }
    }
    for (const keyword of ["anyOf", "oneOf"]) {
      if (!Array.isArray(schema[keyword])) continue;
      let union2 = /* @__PURE__ */ new Set();
      for (const child of schema[keyword]) {
        if (!isSchema(child) || !schemaMayAcceptKind(child, "object", /* @__PURE__ */ new Set())) continue;
        const childKeys = constrainedPropertyKeys(child, seen);
        if (childKeys === null) {
          union2 = null;
          break;
        }
        for (const key of childKeys) union2.add(key);
      }
      result = intersectKeySets(result, union2);
    }
    return result;
  } finally {
    seen.delete(schema);
  }
}
function intersectKeySets(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return new Set([...left].filter((key) => right.has(key)));
}
function exceedsMaxItems(frame) {
  return frame.schema !== true && frame.schema !== false && !hasDeferredStructure(frame.schema) && typeof frame.schema.maxItems === "number" ? frame.length >= frame.schema.maxItems : false;
}
var schemaContexts = /* @__PURE__ */ new WeakMap();
function validateNode(schema, node, active = /* @__PURE__ */ new Map()) {
  if (schema === true) return true;
  if (schema === false) return false;
  let nodes = active.get(schema);
  if (nodes?.has(node)) return true;
  if (nodes === void 0) {
    nodes = /* @__PURE__ */ new Set();
    active.set(schema, nodes);
  }
  nodes.add(node);
  try {
    if (typeof schema.$ref === "string" && !validateNode(resolveReference(schema, schema.$ref), node, active))
      return false;
    if (schema.type !== void 0) {
      const types = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
      if (!types.some((type) => nodeHasType(node, type))) return false;
    }
    if (schema.const !== void 0 && !nodeEqualsValue(node, schema.const)) return false;
    if (Array.isArray(schema.enum) && !schema.enum.some((value) => nodeEqualsValue(node, value))) return false;
    if (Array.isArray(schema.allOf) && !schema.allOf.every((child) => isSchema(child) && validateNode(child, node, active)))
      return false;
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => isSchema(child) && validateNode(child, node, active)))
      return false;
    if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => isSchema(child) && validateNode(child, node, active)).length !== 1)
      return false;
    if (isSchema(schema.not) && validateNode(schema.not, node, active)) return false;
    if (isSchema(schema.if)) {
      const branch = validateNode(schema.if, node, active) ? schema.then : schema.else;
      if (isSchema(branch) && !validateNode(branch, node, active)) return false;
    }
    if (node.kind === "number" && !validateNumericNode(schema, node)) return false;
    if (node.kind === "string" && !validateStringNode(schema, node.value)) return false;
    if (node.kind === "array" && !validateArrayNode(schema, node, active)) return false;
    if (node.kind === "object" && !validateObjectNode(schema, node, active)) return false;
    return true;
  } finally {
    nodes.delete(node);
  }
}
function validateNumericNode(schema, node) {
  const value = decimal(node.raw);
  if (schema.minimum !== void 0 && compareDecimal(value, decimal(String(schema.minimum))) < 0) return false;
  if (schema.maximum !== void 0 && compareDecimal(value, decimal(String(schema.maximum))) > 0) return false;
  if (schema.exclusiveMinimum !== void 0 && compareDecimal(value, decimal(String(schema.exclusiveMinimum))) <= 0)
    return false;
  if (schema.exclusiveMaximum !== void 0 && compareDecimal(value, decimal(String(schema.exclusiveMaximum))) >= 0)
    return false;
  return schema.multipleOf === void 0 || decimalMultiple(value, decimal(String(schema.multipleOf)));
}
function validateStringNode(schema, value) {
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) return false;
  if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return false;
  return typeof schema.format !== "string" || formatMatches(schema.format, value);
}
function validateArrayNode(schema, node, active) {
  if (typeof schema.minItems === "number" && node.items.length < schema.minItems) return false;
  if (typeof schema.maxItems === "number" && node.items.length > schema.maxItems) return false;
  if (schema.uniqueItems === true) {
    for (let index = 0; index < node.items.length; ++index) {
      if (node.items.slice(0, index).some((other) => nodesEqual(other, node.items[index]))) return false;
    }
  }
  const legacyTuple = Array.isArray(schema.items) ? schema.items : void 0;
  const prefix = (Array.isArray(schema.prefixItems) ? schema.prefixItems : legacyTuple) ?? [];
  for (let index = 0; index < Math.min(prefix.length, node.items.length); ++index) {
    if (!isSchema(prefix[index]) || !validateNode(prefix[index], node.items[index], active)) return false;
  }
  const remaining = legacyTuple ? schema.additionalItems : schema.items;
  if (isSchema(remaining)) {
    for (let index = prefix.length; index < node.items.length; ++index) {
      if (!validateNode(remaining, node.items[index], active)) return false;
    }
  }
  if (isSchema(schema.contains)) {
    const matches = node.items.filter((item) => validateNode(schema.contains, item, active)).length;
    const minimum = typeof schema.minContains === "number" ? schema.minContains : 1;
    if (matches < minimum || typeof schema.maxContains === "number" && matches > schema.maxContains) return false;
  }
  return true;
}
function validateObjectNode(schema, node, active) {
  const entries = new Map(node.entries.map((entry) => [entry.key, entry.node]));
  if (entries.size !== node.entries.length) return false;
  if (typeof schema.minProperties === "number" && entries.size < schema.minProperties) return false;
  if (typeof schema.maxProperties === "number" && entries.size > schema.maxProperties) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.every((key) => typeof key === "string" && entries.has(key))) return false;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const patterns = isRecord(schema.patternProperties) ? schema.patternProperties : {};
  for (const [key, child] of entries) {
    if (isSchema(schema.propertyNames) && !validateNode(schema.propertyNames, { kind: "string", value: key }, active))
      return false;
    let matched = false;
    if (isSchema(properties[key])) {
      matched = true;
      if (!validateNode(properties[key], child, active)) return false;
    }
    for (const [pattern, patternSchema] of Object.entries(patterns)) {
      if (new RegExp(pattern, "u").test(key)) {
        matched = true;
        if (!isSchema(patternSchema) || !validateNode(patternSchema, child, active)) return false;
      }
    }
    if (!matched) {
      if (schema.additionalProperties === false) return false;
      if (isSchema(schema.additionalProperties) && !validateNode(schema.additionalProperties, child, active))
        return false;
    }
  }
  const dependentRequired = isRecord(schema.dependentRequired) ? schema.dependentRequired : {};
  for (const [key, dependencies2] of Object.entries(dependentRequired)) {
    if (entries.has(key) && Array.isArray(dependencies2) && !dependencies2.every((dependency) => typeof dependency === "string" && entries.has(dependency)))
      return false;
  }
  const dependentSchemas = isRecord(schema.dependentSchemas) ? schema.dependentSchemas : {};
  for (const [key, dependency] of Object.entries(dependentSchemas)) {
    if (entries.has(key) && (!isSchema(dependency) || !validateNode(dependency, node, active))) return false;
  }
  const dependencies = isRecord(schema.dependencies) ? schema.dependencies : {};
  for (const [key, dependency] of Object.entries(dependencies)) {
    if (!entries.has(key)) continue;
    if (Array.isArray(dependency)) {
      if (!dependency.every((requiredKey) => typeof requiredKey === "string" && entries.has(requiredKey)))
        return false;
    } else if (!isSchema(dependency) || !validateNode(dependency, node, active)) return false;
  }
  return true;
}
function nodeHasType(node, type) {
  if (type === "integer") return node.kind === "number" && decimalInteger(decimal(node.raw));
  if (type === "number") return node.kind === "number";
  return node.kind === type;
}
function nodeEqualsValue(node, value) {
  if (node.kind === "number")
    return typeof value === "number" && compareDecimal(decimal(node.raw), decimal(String(value))) === 0;
  if (node.kind === "array")
    return Array.isArray(value) && node.items.length === value.length && node.items.every((item, index) => nodeEqualsValue(item, value[index]));
  if (node.kind === "object") {
    if (!isRecord(value)) return false;
    const entries = new Map(node.entries.map((entry) => [entry.key, entry.node]));
    return entries.size === Object.keys(value).length && Object.entries(value).every(([key, child]) => entries.has(key) && nodeEqualsValue(entries.get(key), child));
  }
  return Object.is(node.value, value);
}
function nodesEqual(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "number" && right.kind === "number")
    return compareDecimal(decimal(left.raw), decimal(right.raw)) === 0;
  if (left.kind === "array" && right.kind === "array")
    return left.items.length === right.items.length && left.items.every((item, index) => nodesEqual(item, right.items[index]));
  if (left.kind === "object" && right.kind === "object") {
    const rightEntries = new Map(right.entries.map((entry) => [entry.key, entry.node]));
    return left.entries.length === rightEntries.size && left.entries.every(
      (entry) => rightEntries.has(entry.key) && nodesEqual(entry.node, rightEntries.get(entry.key))
    );
  }
  return Object.is(left.value, right.value);
}
function decimal(raw) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits === "") return { coefficient: 0n, exponent: 0n };
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailing > 0) digits = digits.slice(0, -trailing);
  return {
    coefficient: BigInt(`${match[1]}${digits}`),
    exponent: BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(trailing)
  };
}
function compareDecimal(left, right) {
  if (left.coefficient === right.coefficient && left.exponent === right.exponent) return 0;
  if (left.coefficient === 0n) return right.coefficient < 0n ? 1 : -1;
  if (right.coefficient === 0n) return left.coefficient < 0n ? -1 : 1;
  if (left.coefficient < 0n && right.coefficient >= 0n) return -1;
  if (left.coefficient >= 0n && right.coefficient < 0n) return 1;
  const negative = left.coefficient < 0n;
  const leftAbsolute = left.coefficient < 0n ? -left.coefficient : left.coefficient;
  const rightAbsolute = right.coefficient < 0n ? -right.coefficient : right.coefficient;
  const leftMagnitude = BigInt(leftAbsolute.toString().length) + left.exponent;
  const rightMagnitude = BigInt(rightAbsolute.toString().length) + right.exponent;
  if (leftMagnitude !== rightMagnitude) {
    const comparison = leftMagnitude < rightMagnitude ? -1 : 1;
    return negative ? -comparison : comparison;
  }
  const exponent = left.exponent < right.exponent ? left.exponent : right.exponent;
  const scaledLeft = left.coefficient * 10n ** (left.exponent - exponent);
  const scaledRight = right.coefficient * 10n ** (right.exponent - exponent);
  return scaledLeft < scaledRight ? -1 : scaledLeft > scaledRight ? 1 : 0;
}
function decimalInteger(value) {
  return value.coefficient === 0n || value.exponent >= 0n;
}
function decimalMultiple(value, divisor) {
  if (divisor.coefficient === 0n) return false;
  if (value.coefficient === 0n) return true;
  const numerator = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const denominator = divisor.coefficient < 0n ? -divisor.coefficient : divisor.coefficient;
  const exponent = value.exponent - divisor.exponent;
  if (exponent >= 0n) {
    return numerator % denominator * modularPower(10n, exponent, denominator) % denominator === 0n;
  }
  const places = -exponent;
  if (places >= BigInt(numerator.toString().length)) return false;
  return numerator % (denominator * 10n ** places) === 0n;
}
function modularPower(base, exponent, modulus) {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = result * base % modulus;
    base = base * base % modulus;
    exponent >>= 1n;
  }
  return result;
}
function hasDeferredStructure(schema) {
  return schema !== true && schema !== false && ["$ref", "allOf", "anyOf", "oneOf", "not", "if"].some((key) => schema[key] !== void 0);
}
function schemaMayAcceptKind(schema, kind, seen) {
  if (schema === true) return true;
  if (schema === false) return false;
  if (seen.has(schema)) return true;
  seen.add(schema);
  if (typeof schema.$ref === "string" && !schemaMayAcceptKind(resolveReference(schema, schema.$ref), kind, seen))
    return false;
  if (!allowsKind(schema, kind)) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((child) => isSchema(child) && schemaMayAcceptKind(child, kind, seen)))
    return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => isSchema(child) && schemaMayAcceptKind(child, kind, seen)))
    return false;
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((child) => isSchema(child) && schemaMayAcceptKind(child, kind, seen)))
    return false;
  return true;
}
function resolveReference(owner, reference) {
  if (!reference.startsWith("#"))
    throw new TypeError(`External JSON Schema reference ${JSON.stringify(reference)} is unsupported.`);
  const root = schemaContexts.get(owner);
  if (root === void 0) throw new Error("Missing JSON Schema context.");
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) {
    throw new TypeError(`JSON Schema reference ${JSON.stringify(reference)} must contain a JSON Pointer.`);
  }
  let current = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = decodeURIComponent(encoded).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current) || !(key in current))
      throw new TypeError(`JSON Schema reference ${JSON.stringify(reference)} does not resolve.`);
    current = current[key];
  }
  if (!isSchema(current))
    throw new TypeError(`JSON Schema reference ${JSON.stringify(reference)} does not resolve to a schema.`);
  return current;
}
function registerSchemaContext(schema, root, seen = /* @__PURE__ */ new Set()) {
  if (!isRecord(schema) || seen.has(schema)) return;
  seen.add(schema);
  schemaContexts.set(schema, root);
  for (const child of schemaChildren(schema)) registerSchemaContext(child, root, seen);
}
function schemaChildren(schema) {
  const result = [];
  for (const key of [
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
    "additionalProperties",
    "additionalItems"
  ]) {
    if (isSchema(schema[key])) result.push(schema[key]);
  }
  if (isSchema(schema.items)) result.push(schema.items);
  if (Array.isArray(schema.items)) result.push(...schema.items.filter(isSchema));
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) result.push(...schema[key].filter(isSchema));
  }
  for (const key of ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]) {
    if (isRecord(schema[key]))
      result.push(...Object.values(schema[key]).filter(isSchema));
  }
  if (isRecord(schema.dependencies)) {
    result.push(...Object.values(schema.dependencies).filter(isSchema));
  }
  return result;
}
function checkReferences(schema, seen = /* @__PURE__ */ new Set()) {
  if (!isRecord(schema) || seen.has(schema)) return;
  seen.add(schema);
  if (typeof schema.$ref === "string") resolveReference(schema, schema.$ref);
  for (const child of schemaChildren(schema)) checkReferences(child, seen);
}
function assertPattern(value, path) {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  try {
    new RegExp(value, "u");
  } catch {
    throw new TypeError(`${path} must be a valid Unicode RegExp.`);
  }
}
function guidanceFrom(schema) {
  if (!isRecord(schema) || schema["x-guidance"] === void 0) return DEFAULT_GUIDANCE;
  if (!isRecord(schema["x-guidance"])) throw new TypeError("x-guidance must be an object.");
  const source = schema["x-guidance"];
  for (const key of Object.keys(source)) {
    if (!["item_separator", "key_separator", "whitespace_flexible"].includes(key)) {
      throw new TypeError(`Unsupported x-guidance option ${JSON.stringify(key)}.`);
    }
  }
  const itemSeparator = source.item_separator ?? ",";
  const keySeparator = source.key_separator ?? ":";
  const whitespaceFlexible = source.whitespace_flexible ?? true;
  if (typeof itemSeparator !== "string" || itemSeparator.length === 0) {
    throw new TypeError("x-guidance.item_separator must be a non-empty string.");
  }
  if (typeof keySeparator !== "string" || keySeparator.length === 0) {
    throw new TypeError("x-guidance.key_separator must be a non-empty string.");
  }
  if (typeof whitespaceFlexible !== "boolean")
    throw new TypeError("x-guidance.whitespace_flexible must be a boolean.");
  return {
    itemSeparator,
    keySeparator,
    itemBytes: encoder.encode(itemSeparator),
    keyBytes: encoder.encode(keySeparator),
    whitespaceFlexible
  };
}
function formatMatches(format, value) {
  switch (format) {
    case "date":
      return validDate(value);
    case "time":
      return validTime(value);
    case "date-time": {
      const separator = value.search(/[Tt]/);
      return separator > 0 && validDate(value.slice(0, separator)) && validTime(value.slice(separator + 1));
    }
    case "duration":
      return /^(?:P\d+W|P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(
        value
      );
    case "email": {
      const at = value.lastIndexOf("@");
      if (at <= 0 || at === value.length - 1) return false;
      const local = value.slice(0, at);
      const domain = value.slice(at + 1);
      if (local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local))
        return false;
      return /^\[(.+)\]$/.test(domain) ? validIpv4(domain.slice(1, -1)) : validHostname(domain);
    }
    case "hostname":
      return validHostname(value);
    case "ipv4":
      return validIpv4(value);
    case "ipv6":
      return validIpv6(value);
    case "uuid":
      return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
    case "uri":
      return validUriText(value, true);
    case "uri-reference":
      return validUriText(value, false);
    case "regex":
      try {
        new RegExp(value, "u");
        return true;
      } catch {
        return false;
      }
    case "json-pointer":
      return /^(?:\/(?:[^~/]|~[01])*)*$/u.test(value);
    case "relative-json-pointer":
      return /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^~/]|~[01])*)*)$/u.test(value);
    default:
      return true;
  }
}
function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function validTime(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 60 || second === 60 && (hour !== 23 || minute !== 59)) return false;
  return match[4] === void 0 || Number(match[4]) <= 23 && Number(match[5]) <= 59;
}
function validHostname(value) {
  return value.length > 0 && value.length <= 253 && !value.endsWith(".") && value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
function validIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}
function validIpv6(value) {
  if (value.includes(":::") || value.split("::").length > 2) return false;
  const compressed = value.includes("::");
  const groups = value.split(":").filter(Boolean);
  if (!groups.every(
    (group, index) => group.includes(".") ? index === groups.length - 1 && validIpv4(group) : /^[\da-f]{1,4}$/i.test(group)
  ))
    return false;
  const count = groups.reduce((total, group) => total + (group.includes(".") ? 2 : 1), 0);
  return compressed ? count < 8 : count === 8;
}
function validUriText(value, absolute) {
  if (/[\s\\<>^`{|}\0]/.test(value) || /%(?![\da-f]{2})/i.test(value)) return false;
  let rest = value;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest);
  if (absolute && !scheme) return false;
  if (scheme) rest = rest.slice(scheme[0].length);
  const fragment = rest.indexOf("#");
  if (fragment !== -1) {
    if (!uriQuery.test(rest.slice(fragment + 1))) return false;
    rest = rest.slice(0, fragment);
  }
  const query = rest.indexOf("?");
  if (query !== -1) {
    if (!uriQuery.test(rest.slice(query + 1))) return false;
    rest = rest.slice(0, query);
  }
  if (rest.startsWith("//")) {
    const slash = rest.indexOf("/", 2);
    const authority = rest.slice(2, slash === -1 ? void 0 : slash);
    const path = slash === -1 ? "" : rest.slice(slash);
    return validAuthority(authority) && uriPath.test(path);
  }
  if (!uriPath.test(rest)) return false;
  if (scheme || rest === "" || rest.startsWith("/")) return true;
  return !rest.slice(0, rest.indexOf("/") === -1 ? void 0 : rest.indexOf("/")).includes(":");
}
var uriEncoded = "%[\\da-fA-F]{2}";
var uriPchar = `(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|${uriEncoded})`;
var uriPath = new RegExp(`^(?:${uriPchar}|/)*$`);
var uriQuery = new RegExp(`^(?:${uriPchar}|[/?])*$`);
var uriRegName = new RegExp(`^(?:[A-Za-z0-9._~!$&'()*+,;=-]|${uriEncoded})*$`);
var uriUserInfo = new RegExp(`^(?:[A-Za-z0-9._~!$&'()*+,;=:-]|${uriEncoded})*$`);
function validAuthority(authority) {
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    if (authority.indexOf("@") !== at || !uriUserInfo.test(authority.slice(0, at))) return false;
    authority = authority.slice(at + 1);
  }
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return false;
    const host2 = authority.slice(1, close);
    const suffix = authority.slice(close + 1);
    return (validIpv6(host2) || /^v[\da-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/i.test(host2)) && (suffix === "" || /^:\d*$/.test(suffix));
  }
  const colon = authority.lastIndexOf(":");
  let host = authority;
  if (colon !== -1) {
    if (authority.indexOf(":") !== colon || !/^\d*$/.test(authority.slice(colon + 1))) return false;
    host = authority.slice(0, colon);
  }
  return uriRegName.test(host);
}
function checkSchema(schema, path) {
  if (typeof schema === "boolean") return;
  if (!isRecord(schema)) throw new TypeError(`${path} must be a boolean or object schema.`);
  const supported = /* @__PURE__ */ new Set([
    "type",
    "const",
    "enum",
    "properties",
    "required",
    "additionalProperties",
    "minProperties",
    "maxProperties",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "contains",
    "minContains",
    "maxContains",
    "patternProperties",
    "propertyNames",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
    "anyOf",
    "allOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "$ref",
    "$defs",
    "definitions",
    "additionalItems",
    "x-guidance",
    "title",
    "description",
    "$schema",
    "$id",
    "$comment",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "contentEncoding",
    "contentMediaType",
    "contentSchema"
  ]);
  for (const key of Object.keys(schema)) {
    if (!supported.has(key))
      throw new TypeError(`${path}: unsupported JSON Schema keyword ${JSON.stringify(key)}.`);
  }
  const configuredTypes = schema.type === void 0 ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (configuredTypes.some(
    (type) => !["null", "boolean", "number", "integer", "string", "array", "object"].includes(String(type))
  )) {
    throw new TypeError(`${path}.type contains an unsupported JSON type.`);
  }
  for (const keyword of [
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
    "additionalProperties",
    "additionalItems"
  ]) {
    if (schema[keyword] !== void 0 && !isSchema(schema[keyword])) {
      throw new TypeError(`${path}.${keyword} must be a boolean or object schema.`);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const value = schema[keyword];
    if (value !== void 0 && (!Array.isArray(value) || keyword !== "prefixItems" && value.length === 0 || value.some((child) => !isSchema(child)))) {
      throw new TypeError(`${path}.${keyword} must be an array of schemas.`);
    }
  }
  for (const keyword of ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]) {
    const value = schema[keyword];
    if (value !== void 0 && (!isRecord(value) || Object.values(value).some((child) => !isSchema(child)))) {
      throw new TypeError(`${path}.${keyword} must be an object containing schemas.`);
    }
  }
  if (schema.items !== void 0 && !isSchema(schema.items) && !(Array.isArray(schema.items) && schema.items.every(isSchema))) {
    throw new TypeError(`${path}.items must be a schema or array of schemas.`);
  }
  if (schema.required !== void 0 && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string") || new Set(schema.required).size !== schema.required.length)) {
    throw new TypeError(`${path}.required must be an array of unique strings.`);
  }
  if (schema.dependentRequired !== void 0) {
    if (!isRecord(schema.dependentRequired)) throw new TypeError(`${path}.dependentRequired must be an object.`);
    for (const dependency of Object.values(schema.dependentRequired)) {
      if (!Array.isArray(dependency) || dependency.some((key) => typeof key !== "string") || new Set(dependency).size !== dependency.length) {
        throw new TypeError(`${path}.dependentRequired values must be arrays of unique strings.`);
      }
    }
  }
  if (schema.dependencies !== void 0 && !isRecord(schema.dependencies)) {
    throw new TypeError(`${path}.dependencies must be an object.`);
  }
  if (schema.$ref !== void 0 && typeof schema.$ref !== "string")
    throw new TypeError(`${path}.$ref must be a string.`);
  if (schema.enum !== void 0 && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new TypeError(`${path}.enum must be a non-empty array.`);
  }
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    const value = schema[keyword];
    if (value !== void 0 && (typeof value !== "number" || !Number.isFinite(value) || keyword === "multipleOf" && value <= 0)) {
      throw new TypeError(
        `${path}.${keyword} must be ${keyword === "multipleOf" ? "a positive" : "a finite"} number.`
      );
    }
  }
  if (schema.pattern !== void 0) assertPattern(schema.pattern, `${path}.pattern`);
  if (isRecord(schema.patternProperties)) {
    for (const pattern of Object.keys(schema.patternProperties))
      assertPattern(pattern, `${path}.patternProperties`);
  }
  if (schema.uniqueItems !== void 0 && typeof schema.uniqueItems !== "boolean") {
    throw new TypeError(`${path}.uniqueItems must be a boolean.`);
  }
  for (const keyword of [
    "minItems",
    "maxItems",
    "minContains",
    "maxContains",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength"
  ]) {
    const value = schema[keyword];
    if (value !== void 0 && (!Number.isInteger(value) || value < 0)) {
      throw new TypeError(`${path}.${keyword} must be a non-negative integer.`);
    }
  }
  if (schema["x-guidance"] !== void 0 && path !== "$") {
    throw new TypeError("x-guidance is only supported on the root schema.");
  }
  schemaChildren(schema).forEach((child, index) => checkSchema(child, `${path}.schema[${index}]`));
}
function allowsKind(schema, kind) {
  if (schema.const !== void 0 && valueKind(schema.const) !== kind && !(kind === "number" && valueKind(schema.const) === "integer"))
    return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => valueKind(value) === kind || kind === "number" && valueKind(value) === "integer"))
    return false;
  if (schema.type === void 0) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes(kind) || kind === "number" && types.includes("integer") || kind === "integer" && types.includes("number");
}
function valueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (["boolean", "string"].includes(typeof value)) return typeof value;
  return void 0;
}
function byteKind(byte) {
  if (byte === 34) return "string";
  if (byte === 123) return "object";
  if (byte === 91) return "array";
  if (byte === 116 || byte === 102) return "boolean";
  if (byte === 110) return "null";
  if (byte === 45 || isDigit(byte)) return "number";
  return void 0;
}
function numberPrefixValid(value) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d*)?$/.test(value) || /^-?(?:0|[1-9]\d*)\.$/.test(value) || value === "-";
}
function numberComplete(value) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}
function isNumberByte(byte) {
  return isDigit(byte) || byte === 46 || byte === 69 || byte === 101 || byte === 43 || byte === 45;
}
function decodeString(bytes) {
  try {
    return decoder.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}
function topObject(state) {
  return state.stack.at(-1);
}
function replaceTop(stack, frame) {
  return [...stack.slice(0, -1), frame];
}
function allowsWhitespace(mode) {
  return ["value", "array-value", "object-key", "colon", "item-separator", "after-value", "done"].includes(mode);
}
function isWhitespace(byte) {
  return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}
function isDigit(byte) {
  return byte >= 48 && byte <= 57;
}
function isHex(byte) {
  return isDigit(byte) || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102;
}
function isSchema(value) {
  return typeof value === "boolean" || isRecord(value);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/engine/regex.ts
var EMPTY = { kind: "empty" };
var encoder2 = new TextEncoder();
function compileRegex(source) {
  const machine = new RegexMachine(new RegexParser(source).parse());
  return {
    initial: machine.initial,
    transition: (state, byte) => machine.transition(state, byte),
    viable: (state) => state >= 0,
    accepting: (state) => machine.accepting(state),
    maskKey: (state) => machine.stateKey(state)
  };
}
var RegexParser = class {
  constructor(source) {
    this.source = source;
  }
  index = 0;
  parse() {
    if (this.source.startsWith("^")) this.index++;
    const expression = this.alternation();
    if (this.peek() === "$" && this.index === this.source.length - 1) this.index++;
    if (this.index !== this.source.length) this.fail(`unexpected ${JSON.stringify(this.peek())}`);
    return expression;
  }
  alternation() {
    const choices = [this.concatenation()];
    while (this.peek() === "|") {
      this.index++;
      choices.push(this.concatenation());
    }
    return choice(choices);
  }
  concatenation() {
    const parts = [];
    while (this.index < this.source.length && this.peek() !== ")" && this.peek() !== "|") {
      if (this.peek() === "$" && this.index === this.source.length - 1) break;
      parts.push(this.quantified());
    }
    return sequence(parts);
  }
  quantified() {
    const atom = this.atom();
    const quantifier = this.peek();
    if (!["*", "+", "?", "{"].includes(quantifier ?? "")) return atom;
    let minimum;
    let maximum;
    if (quantifier === "*") {
      this.index++;
      [minimum, maximum] = [0, null];
    } else if (quantifier === "+") {
      this.index++;
      [minimum, maximum] = [1, null];
    } else if (quantifier === "?") {
      this.index++;
      [minimum, maximum] = [0, 1];
    } else {
      [minimum, maximum] = this.bounds();
    }
    if (this.peek() === "?" || this.peek() === "+") this.fail("lazy and possessive quantifiers are unsupported");
    const parts = Array.from({ length: minimum }, () => atom);
    if (maximum === null) parts.push(star(atom));
    else for (let count = minimum; count < maximum; ++count) parts.push(choice([EMPTY, atom]));
    return sequence(parts);
  }
  atom() {
    const character = this.peek();
    if (character === void 0) this.fail("expected an expression");
    if (character === "(") {
      this.index++;
      if (this.source.startsWith("?:", this.index)) this.index += 2;
      else if (this.peek() === "?") this.fail("only non-capturing special groups are supported");
      const result = this.alternation();
      if (this.peek() !== ")") this.fail("unterminated group");
      this.index++;
      return result;
    }
    if (character === "[") return this.characterClass();
    if (character === ".") {
      this.index++;
      return byteSet(range(0, 255));
    }
    if (character === "\\") return this.escape(false).expression;
    if ("*+?{})".includes(character)) this.fail(`unexpected ${JSON.stringify(character)}`);
    this.index += character.length;
    return literal(character);
  }
  characterClass() {
    this.index++;
    const negated = this.peek() === "^";
    if (negated) this.index++;
    const bytes = new Uint32Array(8);
    let hasValue = false;
    while (this.peek() !== "]") {
      if (this.peek() === void 0) this.fail("unterminated character class");
      const first = this.classValue();
      if (this.peek() === "-" && this.source[this.index + 1] !== "]") {
        this.index++;
        const last = this.classValue();
        if (first.single === void 0 || last.single === void 0 || first.single > last.single) {
          this.fail("invalid character class range");
        }
        addRange(bytes, first.single, last.single);
      } else {
        union(bytes, first.bytes);
      }
      hasValue = true;
    }
    this.index++;
    if (!hasValue) this.fail("empty character class");
    if (negated) for (let word = 0; word < bytes.length; ++word) bytes[word] = ~bytes[word];
    return byteSet(bytes);
  }
  classValue() {
    if (this.peek() === "\\") {
      const escaped = this.escape(true);
      if (escaped.bytes === void 0) this.fail("multi-byte escapes are unsupported in character classes");
      return { bytes: escaped.bytes, single: escaped.single };
    }
    const character = this.peek();
    this.index += character.length;
    const encoded = encoder2.encode(character);
    if (encoded.length !== 1) this.fail("non-ASCII character classes are unsupported");
    return { bytes: singleton(encoded[0]), single: encoded[0] };
  }
  escape(inClass) {
    this.index++;
    const code = this.peek();
    if (code === void 0) this.fail("trailing escape");
    this.index++;
    if ("dDsSwW".includes(code)) {
      const bytes2 = shorthand(code.toLowerCase());
      if (code === code.toUpperCase()) for (let word = 0; word < bytes2.length; ++word) bytes2[word] = ~bytes2[word];
      return { expression: byteSet(bytes2), bytes: bytes2 };
    }
    if (code === "b" && !inClass) this.fail("word boundaries are unsupported");
    let value;
    if (code === "x") value = this.hex(2);
    else if (code === "u") value = this.hex(4);
    else
      value = { n: 10, r: 13, t: 9, f: 12, v: 11, b: 8 }[code] ?? code.codePointAt(0);
    const text = String.fromCodePoint(value);
    const encoded = encoder2.encode(text);
    const bytes = encoded.length === 1 ? singleton(encoded[0]) : void 0;
    return { expression: literal(text), bytes, single: encoded.length === 1 ? encoded[0] : void 0 };
  }
  bounds() {
    this.index++;
    const minimum = this.decimal();
    let maximum = minimum;
    if (this.peek() === ",") {
      this.index++;
      maximum = this.peek() === "}" ? null : this.decimal();
    }
    if (this.peek() !== "}") this.fail("unterminated repetition");
    this.index++;
    if (minimum > 1e3 || maximum !== null && (maximum < minimum || maximum > 1e3)) {
      this.fail("invalid or excessive repetition");
    }
    return [minimum, maximum];
  }
  decimal() {
    const start = this.index;
    while (/\d/.test(this.peek() ?? "")) this.index++;
    if (start === this.index) this.fail("expected a repetition count");
    return Number(this.source.slice(start, this.index));
  }
  hex(length) {
    const value = this.source.slice(this.index, this.index + length);
    if (!new RegExp(`^[\\da-f]{${length}}$`, "i").test(value)) this.fail("invalid hexadecimal escape");
    this.index += length;
    return Number.parseInt(value, 16);
  }
  peek() {
    return this.source[this.index];
  }
  fail(message) {
    throw new SyntaxError(`Invalid regex at index ${this.index}: ${message}.`);
  }
};
var OP_SET = 0;
var OP_SPLIT = 1;
var OP_JUMP = 2;
var OP_MATCH = 3;
var UNKNOWN = -2;
var NfaBuilder = class {
  ops = [];
  out1 = [];
  out2 = [];
  sets = [];
  compile(expression) {
    switch (expression.kind) {
      case "empty": {
        const state = this.emit(OP_JUMP);
        return { start: state, outs: [state << 1] };
      }
      case "set": {
        const state = this.emit(OP_SET, -1, -1, expression.bytes);
        return { start: state, outs: [state << 1] };
      }
      case "sequence": {
        let result = this.compile(expression.parts[0]);
        for (let index = 1; index < expression.parts.length; ++index) {
          const next = this.compile(expression.parts[index]);
          this.patch(result.outs, next.start);
          result = { start: result.start, outs: next.outs };
        }
        return result;
      }
      case "choice": {
        let result = this.compile(expression.choices[0]);
        for (let index = 1; index < expression.choices.length; ++index) {
          const right = this.compile(expression.choices[index]);
          result = {
            start: this.emit(OP_SPLIT, result.start, right.start),
            outs: [...result.outs, ...right.outs]
          };
        }
        return result;
      }
      case "star": {
        const child = this.compile(expression.child);
        const split = this.emit(OP_SPLIT, child.start);
        this.patch(child.outs, split);
        return { start: split, outs: [split << 1 | 1] };
      }
    }
  }
  emit(op, first = -1, second = -1, set) {
    const state = this.ops.length;
    this.ops.push(op);
    this.out1.push(first);
    this.out2.push(second);
    this.sets.push(set ?? new Uint32Array(0));
    return state;
  }
  patch(outs, target) {
    for (const output of outs) {
      if (output & 1) this.out2[output >>> 1] = target;
      else this.out1[output >>> 1] = target;
    }
  }
};
var RegexMachine = class {
  initial;
  builder = new NfaBuilder();
  states = [];
  acceptingStates = [];
  transitionTables = [];
  stateIds = /* @__PURE__ */ new Map();
  stateKeys = [];
  constructor(expression) {
    const fragment = this.builder.compile(expression);
    const match = this.builder.emit(OP_MATCH);
    this.builder.patch(fragment.outs, match);
    this.initial = this.intern(this.closure([fragment.start]));
  }
  transition(state, byte) {
    if (state < 0) return -1;
    const table = this.transitionTables[state];
    const cached = table[byte];
    if (cached !== UNKNOWN) return cached;
    const seeds = [];
    for (const pc of this.states[state]) {
      if (this.builder.ops[pc] !== OP_SET) continue;
      const set = this.builder.sets[pc];
      if (set[byte >>> 5] & 1 << (byte & 31)) seeds.push(this.builder.out1[pc]);
    }
    const next = seeds.length === 0 ? -1 : this.intern(this.closure(seeds));
    table[byte] = next;
    return next;
  }
  accepting(state) {
    return state >= 0 && this.acceptingStates[state];
  }
  // The interned NFA state set is intrinsic to the regex (unlike the interned
  // ids, which depend on discovery order), so it is a stable mask-cache key
  // across constraint instances compiled from the same source.
  stateKey(state) {
    return state >= 0 ? this.stateKeys[state] : void 0;
  }
  closure(seeds) {
    const result = [];
    const stack = [...seeds];
    const seen = /* @__PURE__ */ new Set();
    while (stack.length > 0) {
      const state = stack.pop();
      if (state < 0 || seen.has(state)) continue;
      seen.add(state);
      const op = this.builder.ops[state];
      if (op === OP_SPLIT) {
        stack.push(this.builder.out1[state], this.builder.out2[state]);
      } else if (op === OP_JUMP) {
        stack.push(this.builder.out1[state]);
      } else {
        result.push(state);
      }
    }
    result.sort((left, right) => left - right);
    return result;
  }
  intern(active) {
    const key = active.join(",");
    const existing = this.stateIds.get(key);
    if (existing !== void 0) return existing;
    if (this.states.length >= 4096) throw new Error("Regex produced too many runtime states.");
    const id = this.states.length;
    const transitions = new Int32Array(256);
    transitions.fill(UNKNOWN);
    this.states.push(active);
    this.acceptingStates.push(active.some((state) => this.builder.ops[state] === OP_MATCH));
    this.transitionTables.push(transitions);
    this.stateIds.set(key, id);
    this.stateKeys.push(key);
    return id;
  }
};
function choice(items) {
  const flattened = items.flatMap((item) => item.kind === "choice" ? item.choices : [item]);
  if (flattened.length === 1) return flattened[0];
  return { kind: "choice", choices: flattened };
}
function sequence(items) {
  const flattened = items.flatMap((item) => item.kind === "sequence" ? item.parts : [item]).filter((item) => item !== EMPTY);
  if (flattened.length === 0) return EMPTY;
  if (flattened.length === 1) return flattened[0];
  return { kind: "sequence", parts: flattened };
}
function star(child) {
  if (child === EMPTY) return EMPTY;
  if (child.kind === "star") return child;
  return { kind: "star", child };
}
function literal(value) {
  return sequence([...encoder2.encode(value)].map((byte) => byteSet(singleton(byte))));
}
function byteSet(bytes) {
  return { kind: "set", bytes };
}
function shorthand(code) {
  const bytes = new Uint32Array(8);
  if (code === "d" || code === "w") addRange(bytes, 48, 57);
  if (code === "w") {
    addRange(bytes, 65, 90);
    addRange(bytes, 97, 122);
    add(bytes, 95);
  }
  if (code === "s") for (const byte of [9, 10, 11, 12, 13, 32]) add(bytes, byte);
  return bytes;
}
function singleton(byte) {
  const bytes = new Uint32Array(8);
  add(bytes, byte);
  return bytes;
}
function range(first, last) {
  const bytes = new Uint32Array(8);
  addRange(bytes, first, last);
  return bytes;
}
function addRange(bytes, first, last) {
  for (let byte = first; byte <= last; ++byte) add(bytes, byte);
}
function add(bytes, byte) {
  bytes[byte >>> 5] |= 1 << (byte & 31);
}
function union(target, source) {
  for (let word = 0; word < target.length; ++word) target[word] |= source[word];
}

// src/engine/tokenizer.ts
var encoder3 = new TextEncoder();
var byteLevelMap;
function extractTokenizer(tokenizer) {
  const source = asRecord(tokenizer, "tokenizer");
  if (Array.isArray(source.tokens)) {
    return normalizeDirectTokenizer(source);
  }
  const tokenizerJson = getTokenizerJson(source);
  const vocabulary = getVocabulary(source, tokenizerJson);
  if (vocabulary === void 0) {
    throw new TypeError("Could not extract the tokenizer vocabulary.");
  }
  const vocabularyTokens = Object.keys(vocabulary);
  let size = 0;
  for (const token of vocabularyTokens) {
    const id = Number(vocabulary[token]);
    if (!Number.isInteger(id) || id < 0) throw new TypeError(`Tokenizer has an invalid token ID for ${token}.`);
    if (id + 1 > size) size = id + 1;
  }
  const tokenBytes = tokenBytesConverter(tokenizerJson);
  const tokens = new Array(size);
  for (const token of vocabularyTokens) {
    tokens[Number(vocabulary[token])] = tokenBytes(token);
  }
  const addedTokens = field(tokenizerJson, "added_tokens");
  if (Array.isArray(addedTokens)) {
    for (const added of addedTokens) {
      if (!isRecord2(added) || !Number.isInteger(added.id)) continue;
      while (tokens.length <= Number(added.id)) tokens.push(void 0);
      tokens[Number(added.id)] = encoder3.encode(typeof added.content === "string" ? added.content : "");
    }
  }
  for (let id = 0; id < tokens.length; ++id) {
    if (tokens[id] === void 0) throw new Error(`Tokenizer vocabulary is missing token ID ${id}.`);
  }
  const eosTokenId = tokenId(source, tokenizerJson, ["eos_token_id", "eosTokenId", "eos_token", "eosToken"]);
  if (eosTokenId === void 0) throw new TypeError("Tokenizer does not expose an EOS token ID.");
  const specialTokenIds = /* @__PURE__ */ new Set([eosTokenId]);
  for (const value of [
    source.special_token_ids,
    source.specialTokenIds,
    source.all_special_ids,
    source.allSpecialIds
  ]) {
    if (Array.isArray(value)) {
      for (const id of value) if (Number.isInteger(id)) specialTokenIds.add(Number(id));
    }
  }
  if (Array.isArray(addedTokens)) {
    for (const added of addedTokens) {
      if (isRecord2(added) && added.special === true && Number.isInteger(added.id))
        specialTokenIds.add(Number(added.id));
    }
  }
  return { tokens, eosTokenId, specialTokenIds };
}
function normalizeDirectTokenizer(source) {
  const configuredTokens = source.tokens;
  const tokens = configuredTokens.map((token, id) => {
    if (!(token instanceof Uint8Array) && !Array.isArray(token)) {
      throw new TypeError(`Tokenizer token ${id} must be a byte array.`);
    }
    const values = Array.from(token);
    if (values.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      throw new TypeError(`Tokenizer token ${id} is invalid.`);
    return Uint8Array.from(values);
  });
  const eosTokenId = Number(source.eosTokenId ?? source.eos_token_id);
  if (!Number.isInteger(eosTokenId) || eosTokenId < 0 || eosTokenId >= tokens.length) {
    throw new TypeError("A valid eos_token_id is required with tokenizer tokens.");
  }
  const configured = source.specialTokenIds ?? source.special_token_ids;
  const specialTokenIds = /* @__PURE__ */ new Set([eosTokenId]);
  if (Array.isArray(configured)) for (const id of configured) specialTokenIds.add(Number(id));
  return { tokens, eosTokenId, specialTokenIds };
}
function getTokenizerJson(source) {
  const value = source._tokenizerJSON ?? source.tokenizerJSON ?? source.tokenizer_json;
  return typeof value === "string" ? JSON.parse(value) : value;
}
function getVocabulary(source, tokenizerJson) {
  const modelVocabulary = field(field(tokenizerJson, "model"), "vocab");
  if (isRecord2(modelVocabulary)) return modelVocabulary;
  for (const name of ["get_vocab", "getVocab"]) {
    const method = source[name];
    if (typeof method !== "function") continue;
    const value = method.call(source, true);
    if (value instanceof Map) return Object.fromEntries(value);
    if (isRecord2(value)) return value;
  }
  return isRecord2(source.vocab) ? source.vocab : void 0;
}
function tokenBytesConverter(tokenizerJson) {
  if (hasComponent(field(tokenizerJson, "decoder"), "ByteLevel") || hasComponent(field(tokenizerJson, "pre_tokenizer"), "ByteLevel")) {
    const map = getByteLevelMap();
    return (token) => {
      const fallback = /^<0x([\da-f]{2})>$/i.exec(token);
      if (fallback) return Uint8Array.of(Number.parseInt(fallback[1], 16));
      const bytes = [];
      for (const character of token) {
        const byte = map.get(character);
        if (byte === void 0) bytes.push(...encoder3.encode(character));
        else bytes.push(byte);
      }
      return Uint8Array.from(bytes);
    };
  }
  const modelType = field(field(tokenizerJson, "model"), "type");
  const sentencePiece = modelType === "Unigram" || modelType === "SentencePiece";
  const prefix = field(field(tokenizerJson, "model"), "continuing_subword_prefix");
  return (token) => {
    const fallback = /^<0x([\da-f]{2})>$/i.exec(token);
    if (fallback) return Uint8Array.of(Number.parseInt(fallback[1], 16));
    if (sentencePiece || token.includes("\u2581")) return encoder3.encode(token.replaceAll("\u2581", " "));
    return encoder3.encode(
      typeof prefix === "string" && token.startsWith(prefix) ? token.slice(prefix.length) : token
    );
  };
}
function getByteLevelMap() {
  if (byteLevelMap !== void 0) return byteLevelMap;
  const visible = /* @__PURE__ */ new Set();
  for (let code = 33; code <= 126; ++code) visible.add(code);
  for (let code = 161; code <= 172; ++code) visible.add(code);
  for (let code = 174; code <= 255; ++code) visible.add(code);
  let extra = 0;
  byteLevelMap = /* @__PURE__ */ new Map();
  for (let byte = 0; byte < 256; ++byte) {
    byteLevelMap.set(String.fromCharCode(visible.has(byte) ? byte : 256 + extra++), byte);
  }
  return byteLevelMap;
}
function tokenId(source, tokenizerJson, keys) {
  const vocabulary = getVocabulary(source, tokenizerJson);
  for (const key of keys) {
    const value = source[key] ?? field(tokenizerJson, key);
    if (Number.isInteger(value)) return Number(value);
    if (typeof value === "string" && Number.isInteger(vocabulary?.[value])) return Number(vocabulary[value]);
  }
  return void 0;
}
function hasComponent(value, type) {
  if (Array.isArray(value)) return value.some((item) => hasComponent(item, type));
  return isRecord2(value) && (value.type === type || Object.values(value).some((item) => hasComponent(item, type)));
}
function field(value, key) {
  return isRecord2(value) ? value[key] : void 0;
}
function asRecord(value, name) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/engine/constraint.ts
var tokenizerCache = /* @__PURE__ */ new WeakMap();
var JSON_OBJECT_SCHEMA = { type: "object" };
function prepareTokenizer(tokenizerSource) {
  cachedTokenizer(tokenizerSource);
}
function createTokenConstraint(tokenizerSource, responseFormat) {
  const tokenizer = cachedTokenizer(tokenizerSource);
  const machine = createMachine(responseFormat, tokenizer);
  const maskCache = cacheFor(tokenizer, responseFormat);
  let state = machine.initial;
  const tokenStates = new Array(tokenizer.data.tokens.length);
  const tokenStamps = new Int32Array(tokenizer.data.tokens.length);
  let stamp = 0;
  return {
    vocabSize: tokenizer.data.tokens.length,
    fillMask(target) {
      const words = Math.ceil(tokenizer.data.tokens.length / 32);
      if (target.length < words) throw new RangeError(`Mask target requires at least ${words} words.`);
      target.fill(0);
      stamp++;
      const cacheKey = machine.maskKey?.(state);
      const cachedMask = cacheKey === void 0 ? void 0 : maskCache?.get(cacheKey);
      if (cachedMask !== void 0) {
        target.set(cachedMask);
        return true;
      }
      let allowed = 0;
      if (machine.accepting(state)) {
        setBit(target, tokenizer.data.eosTokenId);
        allowed++;
      }
      const stringCapacity2 = machine.stringCapacity?.(state);
      if (stringCapacity2 !== void 0) {
        const safe = boundedStringMask(tokenizer, stringCapacity2);
        target.set(safe.mask);
        allowed += safe.count;
      }
      const nodes = [stringCapacity2 === void 0 ? tokenizer.trie : tokenizer.stringExceptionalTrie];
      const states = [state];
      while (nodes.length > 0) {
        const node = nodes.pop();
        const current = states.pop();
        for (const tokenId2 of node.tokenIds) {
          if (tokenizer.data.specialTokenIds.has(tokenId2)) continue;
          setBit(target, tokenId2);
          tokenStates[tokenId2] = current;
          tokenStamps[tokenId2] = stamp;
          allowed++;
        }
        for (let index = 0; index < node.childNodes.length; ++index) {
          const next = machine.transition(current, node.childBytes[index]);
          if (!machine.viable(next)) continue;
          nodes.push(node.childNodes[index]);
          states.push(next);
        }
      }
      if (allowed > 0 && cacheKey !== void 0) {
        maskCache?.set(cacheKey, target.subarray(0, words));
      }
      return allowed > 0;
    },
    commit(tokenId2) {
      if (!Number.isInteger(tokenId2) || tokenId2 < 0 || tokenId2 >= tokenizer.data.tokens.length) {
        throw new RangeError(`Token ${tokenId2} is outside the tokenizer vocabulary.`);
      }
      if (tokenId2 === tokenizer.data.eosTokenId) {
        if (!machine.accepting(state)) throw new Error(`Token ${tokenId2} does not satisfy the constraint.`);
        return true;
      }
      if (tokenizer.data.specialTokenIds.has(tokenId2)) {
        throw new Error(`Token ${tokenId2} does not satisfy the constraint.`);
      }
      let next;
      if (tokenStamps[tokenId2] === stamp && stamp > 0) {
        next = tokenStates[tokenId2];
      } else {
        next = state;
        for (const byte of tokenizer.data.tokens[tokenId2]) next = machine.transition(next, byte);
      }
      stamp++;
      if (!machine.viable(next)) throw new Error(`Token ${tokenId2} does not satisfy the constraint.`);
      state = next;
      return false;
    }
  };
}
function createMachine(responseFormat, tokenizer) {
  if (responseFormat?.type === "regex") {
    if (typeof responseFormat.regex !== "string") throw new TypeError("response_format.regex must be a string.");
    return compileRegex(responseFormat.regex);
  }
  if (responseFormat?.type === "json_schema") {
    return compileJsonSchema(responseFormat.json_schema, tokenizer.maxTokenByteLength);
  }
  if (responseFormat?.type === "json_object") {
    return compileJsonSchema(JSON_OBJECT_SCHEMA, tokenizer.maxTokenByteLength);
  }
  throw new TypeError(`Unsupported response format: ${String(responseFormat?.type)}.`);
}
function cachedTokenizer(source) {
  let cached = tokenizerCache.get(source);
  if (cached === void 0) {
    const data = extractTokenizer(source);
    const stringExceptionalTokenIds = [];
    const stringSafeMask = new Uint32Array(Math.ceil(data.tokens.length / 32));
    const stringSafeLengths = new Uint32Array(data.tokens.length);
    let stringSafeCount = 0;
    let maxStringSafeLength = 0;
    let maxTokenByteLength = 0;
    for (let tokenId2 = 0; tokenId2 < data.tokens.length; ++tokenId2) {
      const special = data.specialTokenIds.has(tokenId2);
      if (!special && data.tokens[tokenId2].length > maxTokenByteLength) {
        maxTokenByteLength = data.tokens[tokenId2].length;
      }
      const length = special ? void 0 : safeStringTokenLength(data.tokens[tokenId2]);
      if (length !== void 0) {
        stringSafeCount++;
        stringSafeLengths[tokenId2] = length;
        if (length > maxStringSafeLength) maxStringSafeLength = length;
        setBit(stringSafeMask, tokenId2);
      } else {
        stringExceptionalTokenIds.push(tokenId2);
      }
    }
    cached = {
      data,
      trie: createTrie(data.tokens),
      stringExceptionalTrie: createTrie(data.tokens, stringExceptionalTokenIds),
      stringSafeMask,
      stringSafeCount,
      stringSafeLengths,
      maxStringSafeLength,
      maxTokenByteLength,
      boundedStringMasks: /* @__PURE__ */ new Map(),
      schemaMaskCaches: /* @__PURE__ */ new WeakMap(),
      booleanSchemaMaskCaches: [new MaskCache(), new MaskCache()],
      jsonObjectMaskCache: new MaskCache(),
      regexMaskCaches: /* @__PURE__ */ new Map()
    };
    tokenizerCache.set(source, cached);
  }
  return cached;
}
function cacheFor(tokenizer, responseFormat) {
  if (responseFormat.type === "regex") {
    let cache2 = tokenizer.regexMaskCaches.get(responseFormat.regex);
    if (cache2 === void 0) {
      cache2 = new MaskCache();
      if (tokenizer.regexMaskCaches.size >= 16) {
        tokenizer.regexMaskCaches.delete(tokenizer.regexMaskCaches.keys().next().value);
      }
      tokenizer.regexMaskCaches.set(responseFormat.regex, cache2);
    }
    return cache2;
  }
  if (responseFormat.type === "json_object") return tokenizer.jsonObjectMaskCache;
  const schema = responseFormat.json_schema;
  if (typeof schema === "boolean") return tokenizer.booleanSchemaMaskCaches[schema ? 1 : 0];
  let cache = tokenizer.schemaMaskCaches.get(schema);
  if (cache === void 0) {
    cache = new MaskCache();
    tokenizer.schemaMaskCaches.set(schema, cache);
  }
  return cache;
}
var MaskCache = class {
  masks = /* @__PURE__ */ new Map();
  words = 0;
  get(key) {
    const mask = this.masks.get(key);
    if (mask === void 0) return void 0;
    this.masks.delete(key);
    this.masks.set(key, mask);
    return mask;
  }
  set(key, source) {
    const mask = source.slice();
    const previous = this.masks.get(key);
    if (previous !== void 0) {
      this.words -= previous.length;
      this.masks.delete(key);
    }
    this.masks.set(key, mask);
    this.words += mask.length;
    while (this.masks.size > 256 || this.words > 1048576) {
      const oldestKey = this.masks.keys().next().value;
      const oldest = this.masks.get(oldestKey);
      this.masks.delete(oldestKey);
      this.words -= oldest.length;
    }
  }
};
function createTrie(tokens, tokenIds) {
  const root = { childBytes: [], childNodes: [], tokenIds: [] };
  const size = tokenIds === void 0 ? tokens.length : tokenIds.length;
  for (let index = 0; index < size; ++index) {
    const tokenId2 = tokenIds === void 0 ? index : tokenIds[index];
    const bytes = tokens[tokenId2];
    let node = root;
    for (let position = 0; position < bytes.length; ++position) {
      const byte = bytes[position];
      const childIndex = node.childBytes.indexOf(byte);
      if (childIndex === -1) {
        const child = { childBytes: [], childNodes: [], tokenIds: [] };
        node.childBytes.push(byte);
        node.childNodes.push(child);
        node = child;
      } else {
        node = node.childNodes[childIndex];
      }
    }
    node.tokenIds.push(tokenId2);
  }
  return root;
}
var safeStringDecoder = new TextDecoder("utf-8", { fatal: true });
function safeStringTokenLength(bytes) {
  if (bytes.length === 0) return void 0;
  let length = 0;
  for (const byte of bytes) {
    if (byte < 32 || byte === 34 || byte === 92) return void 0;
    if ((byte & 192) !== 128) length++;
  }
  try {
    safeStringDecoder.decode(bytes);
  } catch {
    return void 0;
  }
  return length;
}
function boundedStringMask(tokenizer, capacity) {
  if (capacity >= tokenizer.maxStringSafeLength) {
    return { mask: tokenizer.stringSafeMask, count: tokenizer.stringSafeCount };
  }
  let cached = tokenizer.boundedStringMasks.get(capacity);
  if (cached !== void 0) return cached;
  const mask = new Uint32Array(Math.ceil(tokenizer.data.tokens.length / 32));
  let count = 0;
  for (let tokenId2 = 0; tokenId2 < tokenizer.stringSafeLengths.length; ++tokenId2) {
    const length = tokenizer.stringSafeLengths[tokenId2];
    if (length === 0 || length > capacity) continue;
    setBit(mask, tokenId2);
    count++;
  }
  cached = { mask, count };
  tokenizer.boundedStringMasks.set(capacity, cached);
  return cached;
}
function setBit(mask, tokenId2) {
  mask[tokenId2 >>> 5] |= 1 << (tokenId2 & 31);
}

// src/utils/mask.ts
function applyMask(logits, mask, vocabSize) {
  const data = logits.data;
  const stride = logits.dims.at(-1);
  if (vocabSize > stride) {
    throw new Error(`Constraint vocabulary size ${vocabSize} exceeds logits vocabulary size ${stride}.`);
  }
  for (let offset = 0; offset < data.length; offset += stride) {
    const fullWords = vocabSize >>> 5;
    for (let word = 0; word < fullWords; ++word) {
      const bits = mask[word] | 0;
      if (bits === -1) continue;
      const start = offset + (word << 5);
      if (bits === 0) {
        data.fill(-Infinity, start, start + 32);
      } else {
        for (let bit = 0; bit < 32; ++bit) {
          if (!(bits & 1 << bit)) data[start + bit] = -Infinity;
        }
      }
    }
    for (let tokenId2 = fullWords << 5; tokenId2 < vocabSize; ++tokenId2) {
      if (!(mask[tokenId2 >>> 5] & 1 << (tokenId2 & 31))) data[offset + tokenId2] = -Infinity;
    }
    data.fill(-Infinity, offset + vocabSize, offset + stride);
  }
}

// src/ResponseConstraint.ts
var ResponseConstraint = class {
  /**
   * Precomputes the tokenizer-derived data structures used by every
   * constraint. The first constraint per tokenizer otherwise pays this cost
   * (hundreds of milliseconds for large vocabularies) inside
   * `fromResponseFormat`; call this once after loading the model to pay it
   * early instead.
   */
  static warmup(tokenizer) {
    prepareTokenizer(tokenizer);
  }
  static fromResponseFormat(tokenizer, responseFormat) {
    const state = {
      completed: false,
      constraint: createTokenConstraint(tokenizer, responseFormat)
    };
    const logits_processor = new LogitsProcessorList();
    logits_processor.push(new ConstraintLogitsProcessor(state));
    return {
      logits_processor,
      stopping_criteria: new ConstraintStoppingCriteria(state)
    };
  }
};
var ConstraintLogitsProcessor = class extends LogitsProcessor {
  constructor(state) {
    super();
    this.state = state;
  }
  _call(inputIds, logits) {
    assertSingleSequence(inputIds.length);
    if (this.state.completed) return logits;
    const logitsVocabSize = logits.dims.at(-1);
    if (logitsVocabSize === void 0 || !Number.isInteger(logitsVocabSize) || logitsVocabSize <= 0) {
      throw new Error("ResponseConstraint requires logits with a vocabulary dimension.");
    }
    const words = Math.ceil(logitsVocabSize / 32);
    if (this.state.mask?.length !== words) this.state.mask = new Uint32Array(words);
    if (!this.state.constraint.fillMask(this.state.mask)) {
      throw new Error("The constraint reached a dead end before producing a valid output.");
    }
    applyMask(logits, this.state.mask, this.state.constraint.vocabSize);
    return logits;
  }
  onTokensSampled(tokenIds, inputIds) {
    assertSingleSequence(tokenIds.length);
    assertSingleSequence(inputIds.length);
    if (!this.state.completed) this.state.completed = this.state.constraint.commit(tokenIds[0]);
  }
};
var ConstraintStoppingCriteria = class extends StoppingCriteria {
  constructor(state) {
    super();
    this.state = state;
  }
  _call(inputIds) {
    assertSingleSequence(inputIds.length);
    return [this.state.completed];
  }
};
function assertSingleSequence(batchSize) {
  if (batchSize !== 1) {
    throw new Error(`ResponseConstraint currently supports batch size 1; received ${batchSize}.`);
  }
}
export {
  ResponseConstraint
};
