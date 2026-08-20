///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonSchemaCompiler — turns one JSON Schema document into the nodes a grammar reads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What kind of JSON value a schema node describes. */
export type CompiledSchemaKind = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'any';

/**
 * One node of a compiled schema, holding everything the grammar asks of it while reading.
 *
 * Nodes are shared and never copied, so they may be as rich as they like. The reader's own state is
 * what has to stay cheap to copy, and it holds nothing but numbers and small arrays of numbers,
 * every one of them an index into the array these nodes live in.
 */
export type CompiledSchemaNode = {
	/** What kind of JSON value this node describes, `any` when the schema declared no type. */
	kind: CompiledSchemaKind;
	/** The declared properties of an object, in the order the schema declared them. */
	propertyNames: string[];
	/** The node index of each declared property's own schema, in the same order. */
	propertyNodeIndexes: number[];
	/** Which of the declared properties must be written, one bit per property. */
	requiredMask: number;
	/** Whether a key outside the declared properties may be written. */
	allowsOtherProperties: boolean;
	/** The node index every item of an array must satisfy, or `-1` when the schema declared none. */
	itemNodeIndex: number;
	/** The exact JSON texts this value may be written as, empty when the schema declared no enumeration. */
	enumTexts: string[];
};

/**
 * The largest number of declared properties one object may have, and of values one enumeration may
 * hold.
 *
 * Both are tracked as a bit per entry in one number, because the reader's state is copied once per
 * entry of a vocabulary of 262144 at every generation step, and a number is the cheapest thing to
 * copy there is. A schema over this limit is refused rather than enforced in part.
 */
const LARGEST_TRACKED_COUNT = 31;

/** The keywords this compiler reads and acts on. */
const ENFORCED_KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum'];

/**
 * The keywords this compiler reads past, because each of them describes a schema rather than
 * constraining the value.
 */
const ANNOTATION_KEYWORDS = ['$schema', 'title', 'description'];

/**
 * Turns one JSON Schema document into a flat array of nodes, or refuses it.
 *
 * The subset enforced is `type`, `properties`, `required`, `additionalProperties`, `items`, and
 * `enum`. Every other keyword is refused rather than read past, which is the same rule the rest of
 * this project follows for a request it cannot honour: a schema that is enforced in part is worse
 * than a refused one and worse than an enforced one both, because the answer comes back looking
 * exactly as it should and satisfies less than it says.
 *
 * This lives in the protocol because a consumer refuses an unenforceable schema at submission and a
 * worker enforces the enforceable one, and the two have to agree about which is which. Measured live
 * against Gemma 4 E2B in the de-risk step of milestone 6 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219), where all five schemas
 * compiled here were satisfied by the answers a mask built from them produced.
 */
export class JsonSchemaCompiler {
	/**
	 * Compiles one schema document.
	 *
	 * @param schema The schema document, as the request carried it.
	 * @returns The compiled nodes, the root being the node at index 0.
	 * @throws If the document is not an object, or names a keyword this grammar cannot enforce.
	 */
	static compile(schema: Record<string, unknown>): CompiledSchemaNode[] {
		const nodes: CompiledSchemaNode[] = [];
		JsonSchemaCompiler._compileInto(nodes, schema, '#');
		return nodes;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Compiles one schema document into the array being built, and returns where it landed.
	 *
	 * The node is reserved before its children are compiled, so a node's index never changes once it
	 * has been handed out.
	 *
	 * @param nodes The array being built, added to in place.
	 * @param schema The schema document to compile.
	 * @param path Where this document sits in the whole schema, named in any refusal.
	 * @returns The index this document's node landed at.
	 * @throws If the document is not an object, or names a keyword this grammar cannot enforce.
	 */
	private static _compileInto(nodes: CompiledSchemaNode[], schema: unknown, path: string): number {
		if (typeof schema !== 'object' || schema === null || Array.isArray(schema) === true) {
			throw new Error(`The schema at ${path} is not a JSON object, and every schema this grammar enforces is one.`);
		}
		const document = schema as Record<string, unknown>;
		JsonSchemaCompiler._refuseUnenforceableKeywords(document, path);
		const node: CompiledSchemaNode = {
			kind: JsonSchemaCompiler._kindOf(document, path),
			propertyNames: [],
			propertyNodeIndexes: [],
			requiredMask: 0,
			allowsOtherProperties: document.additionalProperties !== false,
			itemNodeIndex: -1,
			enumTexts: JsonSchemaCompiler._enumTextsOf(document, path),
		};
		const nodeIndex = nodes.length;
		nodes.push(node);
		if (document.properties !== undefined) {
			JsonSchemaCompiler._compileProperties(nodes, node, document, path);
		} else if (document.required !== undefined) {
			// A required key whose own schema was never declared is a key this grammar would have to
			// wait for without being able to say what may follow it, so it is refused rather than
			// enforced halfway.
			throw new Error(`The schema at ${path} requires properties without declaring any, and this grammar enforces a required property only when the schema declares it.`);
		}
		if (document.items !== undefined) {
			node.itemNodeIndex = JsonSchemaCompiler._compileInto(nodes, document.items, `${path}/items`);
		}
		return nodeIndex;
	}

	/**
	 * Refuses a schema document that names a keyword this grammar cannot enforce.
	 *
	 * @param document The schema document.
	 * @param path Where this document sits in the whole schema.
	 * @throws If any keyword is neither enforced nor a pure annotation.
	 */
	private static _refuseUnenforceableKeywords(document: Record<string, unknown>, path: string): void {
		for (const keyword of Object.keys(document)) {
			if (ENFORCED_KEYWORDS.includes(keyword) === true || ANNOTATION_KEYWORDS.includes(keyword) === true) {
				continue;
			}
			throw new Error(`The schema at ${path} uses "${keyword}", which this grammar cannot enforce while the answer is being written. The keywords it enforces are ${ENFORCED_KEYWORDS.join(', ')}.`);
		}
	}

	/**
	 * Reads the declared type of one schema document.
	 *
	 * @param document The schema document.
	 * @param path Where this document sits in the whole schema.
	 * @returns The kind of value the document describes, `any` when it declared no type.
	 * @throws If the type is a list of types, or is not one this grammar knows.
	 */
	private static _kindOf(document: Record<string, unknown>, path: string): CompiledSchemaKind {
		const declaredType = document.type;
		if (declaredType === undefined) {
			return 'any';
		}
		if (Array.isArray(declaredType) === true) {
			throw new Error(`The schema at ${path} declares a list of types, and this grammar enforces one type at a time.`);
		}
		const knownKinds: CompiledSchemaKind[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
		if (typeof declaredType !== 'string' || knownKinds.includes(declaredType as CompiledSchemaKind) === false) {
			throw new Error(`The schema at ${path} declares the type ${JSON.stringify(declaredType)}, which is not one of ${knownKinds.join(', ')}.`);
		}
		return declaredType as CompiledSchemaKind;
	}

	/**
	 * Reads the enumeration of one schema document, as the exact texts the value may be written as.
	 *
	 * An enumeration is held as the written form of each value rather than as the values themselves,
	 * because what the reader compares against is the text the model is writing. `"celsius"`, `42`,
	 * and `true` are all one text each, so a string, a number, and a boolean are enforced by the same
	 * few lines.
	 *
	 * @param document The schema document.
	 * @param path Where this document sits in the whole schema.
	 * @returns The written form of every value the enumeration allows, empty when it declared none.
	 * @throws If the enumeration is not a list, is empty, or holds more values than can be tracked.
	 */
	private static _enumTextsOf(document: Record<string, unknown>, path: string): string[] {
		const declaredEnum = document.enum;
		if (declaredEnum === undefined) {
			return [];
		}
		if (Array.isArray(declaredEnum) === false || declaredEnum.length === 0) {
			throw new Error(`The schema at ${path} declares an enum that is not a list of at least one value.`);
		}
		if (declaredEnum.length > LARGEST_TRACKED_COUNT) {
			throw new Error(`The schema at ${path} declares ${declaredEnum.length} enum values, and this grammar tracks at most ${LARGEST_TRACKED_COUNT}.`);
		}
		return declaredEnum.map((value: unknown) => JSON.stringify(value));
	}

	/**
	 * Compiles the declared properties of one object schema into a node.
	 *
	 * @param nodes The array being built, added to in place.
	 * @param node The node being filled in, changed in place.
	 * @param document The schema document.
	 * @param path Where this document sits in the whole schema.
	 * @throws If the properties are not an object, there are more than can be tracked, or `required`
	 * names a property that was never declared.
	 */
	private static _compileProperties(nodes: CompiledSchemaNode[], node: CompiledSchemaNode, document: Record<string, unknown>, path: string): void {
		const properties = document.properties;
		if (typeof properties !== 'object' || properties === null || Array.isArray(properties) === true) {
			throw new Error(`The schema at ${path} declares properties that are not a JSON object.`);
		}
		const propertyEntries = Object.entries(properties as Record<string, unknown>);
		if (propertyEntries.length > LARGEST_TRACKED_COUNT) {
			throw new Error(`The schema at ${path} declares ${propertyEntries.length} properties, and this grammar tracks at most ${LARGEST_TRACKED_COUNT}.`);
		}
		for (const [propertyName, propertySchema] of propertyEntries) {
			node.propertyNames.push(propertyName);
			node.propertyNodeIndexes.push(JsonSchemaCompiler._compileInto(nodes, propertySchema, `${path}/properties/${propertyName}`));
		}
		const required = document.required ?? [];
		if (Array.isArray(required) === false) {
			throw new Error(`The schema at ${path} declares a required list that is not a list.`);
		}
		for (const requiredName of required) {
			const propertyIndex = node.propertyNames.indexOf(String(requiredName));
			if (propertyIndex === -1) {
				throw new Error(`The schema at ${path} requires the property ${JSON.stringify(requiredName)}, which it never declares.`);
			}
			node.requiredMask = node.requiredMask | (1 << propertyIndex);
		}
	}
}
