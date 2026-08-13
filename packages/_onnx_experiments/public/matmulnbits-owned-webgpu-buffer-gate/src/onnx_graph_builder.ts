///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OnnxGraphBuilder — writes the tiny ONNX model this gate runs, as protobuf bytes
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds the one-node ONNX model that this gate executes, directly as protobuf bytes, with no build step and no
 * committed model file.
 *
 * The model exists only to answer the question of milestone zero of
 * https://github.com/webai-at-home/webai-at-home/issues/169, so it is deliberately the smallest graph that can ask it:
 * a single `MatMulNBits` node whose quantized weight tensor and scale tensor are declared as **graph inputs** rather
 * than as initializers. Every published ONNX export declares those two tensors as initializers, which makes them owned
 * by the session, immutable, and loaded whole. Declaring them as inputs is what allows this project to own the buffer
 * that holds them and to overwrite it between calls.
 */

/** The `elem_type` value that ONNX uses for a 32-bit floating point tensor. */
const ONNX_ELEMENT_TYPE_FLOAT32 = 1;
/** The `elem_type` value that ONNX uses for an unsigned 8-bit integer tensor. */
const ONNX_ELEMENT_TYPE_UINT8 = 2;
/** The `AttributeProto.AttributeType` value for a single 64-bit integer attribute. */
const ONNX_ATTRIBUTE_TYPE_INT = 2;
/** The ONNX intermediate representation version that the produced model declares. */
const ONNX_IR_VERSION = 9;
/** The operator set version that the produced model declares for the default ONNX domain. */
const ONNX_DEFAULT_OPSET_VERSION = 17;
/** The operator set version that the produced model declares for the Microsoft contributed operator domain. */
const MICROSOFT_OPSET_VERSION = 1;
/** The operator domain that `MatMulNBits` belongs to. It is a contributed operator, not a standard ONNX one. */
const MICROSOFT_DOMAIN = 'com.microsoft';

/** The names this gate gives to the three inputs and the one output of the produced graph. */
export const GRAPH_TENSOR_NAMES = {
	/** The activation vector entering the projection, shaped `[1, hiddenSize]`. */
	hiddenState: 'hidden_state',
	/** The 4-bit quantized weight blocks, shaped `[outputSize, blocksPerRow, blobSize]`. */
	expertWeightQuantized: 'expert_weight_quantized',
	/** The per-block scale factors, shaped `[outputSize * blocksPerRow]`. */
	expertWeightScales: 'expert_weight_scales',
	/** The projected activation vector leaving the node, shaped `[1, outputSize]`. */
	projected: 'projected',
} as const;

/** The shape of one `MatMulNBits` graph, and the derived block geometry the caller needs to lay out its buffers. */
export type MatMulNBitsGraph = {
	/** The serialized ONNX model, ready to hand to `InferenceSession.create`. */
	modelBytes: Uint8Array;
	/** The length of the activation vector entering the node, which `MatMulNBits` calls `K`. */
	hiddenSize: number;
	/** The length of the activation vector leaving the node, which `MatMulNBits` calls `N`. */
	outputSize: number;
	/** The number of weight values that share one scale factor. */
	blockSize: number;
	/** The number of quantized blocks along one row of the weight matrix, which is `ceil(hiddenSize / blockSize)`. */
	blocksPerRow: number;
	/** The number of bytes one quantized block occupies, which is `blockSize * 4 / 8` at 4 bits. */
	blobSize: number;
	/** The full byte length of the quantized weight tensor. */
	quantizedByteLength: number;
	/** The number of scale factors in the scale tensor. */
	scaleCount: number;
};

/**
 * Writes a one-node `MatMulNBits` ONNX model whose weight tensors are graph inputs.
 */
export class OnnxGraphBuilder {
	/**
	 * Builds the ONNX model that this gate runs.
	 *
	 * @param hiddenSize - The length of the activation vector entering the projection, which `MatMulNBits` calls `K`.
	 * @param outputSize - The length of the activation vector leaving the projection, which `MatMulNBits` calls `N`.
	 * @param blockSize - The number of weight values that share one scale factor. `MatMulNBits` requires a multiple of 16.
	 * @returns The serialized model together with the block geometry derived from the three sizes.
	 */
	static buildMatMulNBitsGraph(hiddenSize: number, outputSize: number, blockSize: number): MatMulNBitsGraph {
		const blocksPerRow = Math.ceil(hiddenSize / blockSize);
		const blobSize = (blockSize * 4) / 8;
		const quantizedByteLength = outputSize * blocksPerRow * blobSize;
		const scaleCount = outputSize * blocksPerRow;

		const node = OnnxGraphBuilder._node({
			opType: 'MatMulNBits',
			name: 'expert_projection',
			domain: MICROSOFT_DOMAIN,
			inputs: [
				GRAPH_TENSOR_NAMES.hiddenState,
				GRAPH_TENSOR_NAMES.expertWeightQuantized,
				GRAPH_TENSOR_NAMES.expertWeightScales,
			],
			outputs: [GRAPH_TENSOR_NAMES.projected],
			attributes: [
				OnnxGraphBuilder._integerAttribute('K', hiddenSize),
				OnnxGraphBuilder._integerAttribute('N', outputSize),
				OnnxGraphBuilder._integerAttribute('bits', 4),
				OnnxGraphBuilder._integerAttribute('block_size', blockSize),
				OnnxGraphBuilder._integerAttribute('accuracy_level', 0),
			],
		});

		const graph = OnnxGraphBuilder._graph({
			name: 'owned_webgpu_buffer_gate',
			nodes: [node],
			inputs: [
				OnnxGraphBuilder._valueInfo(GRAPH_TENSOR_NAMES.hiddenState, ONNX_ELEMENT_TYPE_FLOAT32, [1, hiddenSize]),
				OnnxGraphBuilder._valueInfo(GRAPH_TENSOR_NAMES.expertWeightQuantized, ONNX_ELEMENT_TYPE_UINT8, [
					outputSize,
					blocksPerRow,
					blobSize,
				]),
				OnnxGraphBuilder._valueInfo(GRAPH_TENSOR_NAMES.expertWeightScales, ONNX_ELEMENT_TYPE_FLOAT32, [scaleCount]),
			],
			outputs: [
				OnnxGraphBuilder._valueInfo(GRAPH_TENSOR_NAMES.projected, ONNX_ELEMENT_TYPE_FLOAT32, [1, outputSize]),
			],
		});

		const modelContent = [
			...OnnxGraphBuilder._varintField(1, ONNX_IR_VERSION),
			...OnnxGraphBuilder._stringField(2, 'webai-at-home-issue-169-milestone-zero'),
			...OnnxGraphBuilder._lengthDelimitedField(7, graph),
			...OnnxGraphBuilder._lengthDelimitedField(8, OnnxGraphBuilder._operatorSetId('', ONNX_DEFAULT_OPSET_VERSION)),
			...OnnxGraphBuilder._lengthDelimitedField(
				8,
				OnnxGraphBuilder._operatorSetId(MICROSOFT_DOMAIN, MICROSOFT_OPSET_VERSION),
			),
		];

		return {
			modelBytes: Uint8Array.from(modelContent),
			hiddenSize: hiddenSize,
			outputSize: outputSize,
			blockSize: blockSize,
			blocksPerRow: blocksPerRow,
			blobSize: blobSize,
			quantizedByteLength: quantizedByteLength,
			scaleCount: scaleCount,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Protocol Buffer Encoding
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Encodes one non-negative integer in the base-128 variable-length form that protocol buffers use.
	 *
	 * Division is used rather than a bit shift so that values above 2^31 stay correct.
	 *
	 * @param value - The non-negative integer to encode.
	 * @returns The encoded bytes.
	 */
	static _varint(value: number): number[] {
		const bytes: number[] = [];
		let remaining = value;
		while (remaining >= 128) {
			bytes.push((remaining % 128) + 128);
			remaining = Math.floor(remaining / 128);
		}
		bytes.push(remaining);
		return bytes;
	}

	/**
	 * Encodes the tag byte or bytes that introduce one protocol buffer field.
	 *
	 * @param fieldNumber - The field number declared in the ONNX protocol buffer schema.
	 * @param wireType - The wire type, which is 0 for a variable-length integer and 2 for a length-delimited value.
	 * @returns The encoded tag bytes.
	 */
	static _tag(fieldNumber: number, wireType: number): number[] {
		return OnnxGraphBuilder._varint(fieldNumber * 8 + wireType);
	}

	/**
	 * Encodes one field holding a non-negative integer.
	 *
	 * @param fieldNumber - The field number declared in the ONNX protocol buffer schema.
	 * @param value - The value to encode.
	 * @returns The encoded field bytes.
	 */
	static _varintField(fieldNumber: number, value: number): number[] {
		return [...OnnxGraphBuilder._tag(fieldNumber, 0), ...OnnxGraphBuilder._varint(value)];
	}

	/**
	 * Encodes one field holding a length-delimited payload, which covers both nested messages and byte strings.
	 *
	 * @param fieldNumber - The field number declared in the ONNX protocol buffer schema.
	 * @param payload - The already-encoded content of the nested message or byte string.
	 * @returns The encoded field bytes.
	 */
	static _lengthDelimitedField(fieldNumber: number, payload: number[]): number[] {
		return [...OnnxGraphBuilder._tag(fieldNumber, 2), ...OnnxGraphBuilder._varint(payload.length), ...payload];
	}

	/**
	 * Encodes one field holding a text value, written as UTF-8.
	 *
	 * @param fieldNumber - The field number declared in the ONNX protocol buffer schema.
	 * @param text - The text to encode.
	 * @returns The encoded field bytes.
	 */
	static _stringField(fieldNumber: number, text: string): number[] {
		return OnnxGraphBuilder._lengthDelimitedField(fieldNumber, [...new TextEncoder().encode(text)]);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	ONNX Message Encoding
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Encodes the content of an `OperatorSetIdProto`, which states one operator domain and the version used from it.
	 *
	 * @param domain - The operator domain. The empty string names the default ONNX domain.
	 * @param version - The operator set version used from that domain.
	 * @returns The encoded message content.
	 */
	static _operatorSetId(domain: string, version: number): number[] {
		return [...OnnxGraphBuilder._stringField(1, domain), ...OnnxGraphBuilder._varintField(2, version)];
	}

	/**
	 * Encodes the content of a `TypeProto` describing a tensor of a fixed element type and a fully known shape.
	 *
	 * @param elementType - The ONNX `elem_type` value for the tensor's element type.
	 * @param dimensions - The tensor's shape, with every dimension a known value rather than a named parameter.
	 * @returns The encoded message content.
	 */
	static _typeProto(elementType: number, dimensions: number[]): number[] {
		const shape = dimensions.flatMap((dimension) => {
			return OnnxGraphBuilder._lengthDelimitedField(1, OnnxGraphBuilder._varintField(1, dimension));
		});
		const tensorType = [
			...OnnxGraphBuilder._varintField(1, elementType),
			...OnnxGraphBuilder._lengthDelimitedField(2, shape),
		];
		return OnnxGraphBuilder._lengthDelimitedField(1, tensorType);
	}

	/**
	 * Encodes the content of a `ValueInfoProto`, which names one graph input or output and gives its type.
	 *
	 * @param name - The tensor name, which is how the caller refers to it when running the session.
	 * @param elementType - The ONNX `elem_type` value for the tensor's element type.
	 * @param dimensions - The tensor's shape.
	 * @returns The encoded message content.
	 */
	static _valueInfo(name: string, elementType: number, dimensions: number[]): number[] {
		return [
			...OnnxGraphBuilder._stringField(1, name),
			...OnnxGraphBuilder._lengthDelimitedField(2, OnnxGraphBuilder._typeProto(elementType, dimensions)),
		];
	}

	/**
	 * Encodes the content of an `AttributeProto` holding a single 64-bit integer.
	 *
	 * @param name - The attribute name as the operator declares it.
	 * @param value - The integer value.
	 * @returns The encoded message content.
	 */
	static _integerAttribute(name: string, value: number): number[] {
		return [
			...OnnxGraphBuilder._stringField(1, name),
			...OnnxGraphBuilder._varintField(3, value),
			...OnnxGraphBuilder._varintField(20, ONNX_ATTRIBUTE_TYPE_INT),
		];
	}

	/**
	 * Encodes the content of a `NodeProto`, which is one operator call inside the graph.
	 *
	 * @param options - The node description.
	 * @param options.inputs - The names of the tensors entering the node, in the order the operator declares them.
	 * @param options.outputs - The names of the tensors leaving the node.
	 * @param options.opType - The operator name.
	 * @param options.name - The node's own name, which appears in ONNX Runtime error messages.
	 * @param options.domain - The operator domain the operator belongs to.
	 * @param options.attributes - The already-encoded content of each attribute.
	 * @returns The encoded message content.
	 */
	static _node(options: {
		inputs: string[];
		outputs: string[];
		opType: string;
		name: string;
		domain: string;
		attributes: number[][];
	}): number[] {
		return [
			...options.inputs.flatMap((input) => OnnxGraphBuilder._stringField(1, input)),
			...options.outputs.flatMap((output) => OnnxGraphBuilder._stringField(2, output)),
			...OnnxGraphBuilder._stringField(3, options.name),
			...OnnxGraphBuilder._stringField(4, options.opType),
			...options.attributes.flatMap((attribute) => OnnxGraphBuilder._lengthDelimitedField(5, attribute)),
			...OnnxGraphBuilder._stringField(7, options.domain),
		];
	}

	/**
	 * Encodes the content of a `GraphProto`, which holds the nodes and declares the graph's inputs and outputs.
	 *
	 * @param options - The graph description.
	 * @param options.name - The graph's name.
	 * @param options.nodes - The already-encoded content of each node.
	 * @param options.inputs - The already-encoded content of each input declaration.
	 * @param options.outputs - The already-encoded content of each output declaration.
	 * @returns The encoded message content.
	 */
	static _graph(options: { name: string; nodes: number[][]; inputs: number[][]; outputs: number[][] }): number[] {
		return [
			...options.nodes.flatMap((node) => OnnxGraphBuilder._lengthDelimitedField(1, node)),
			...OnnxGraphBuilder._stringField(2, options.name),
			...options.inputs.flatMap((input) => OnnxGraphBuilder._lengthDelimitedField(11, input)),
			...options.outputs.flatMap((output) => OnnxGraphBuilder._lengthDelimitedField(12, output)),
		];
	}
}
