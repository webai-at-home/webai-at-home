"""Copy an ONNX graph with every intermediate value promoted to a graph output.

Two execution providers that disagree about a graph's answer disagree at some
one node first, and every node after that one is only carrying the mistake
forward. A graph whose only outputs are its real outputs cannot say which node
that was, so this writes a copy that also returns everything in between.

The copy is for reading, not for running a model. It defeats every fusion the
runtime would otherwise do — a value that has to be returned cannot be folded
away — so it is slower than the graph it came from and its timings mean nothing.

Nothing is renamed and no node is touched. The output list grows and that is
the whole change, so a divergence found in the copy is a divergence in the
original.

Usage::

    packages/_onnx_experiments/tools/.venv/bin/python \\
      packages/_onnx_experiments/tools/model_graphs/expose_graph_intermediates.py \\
      --graph /tmp/qwen3-30b-a3b-graphs/layer_00.onnx \\
      --output /tmp/qwen3-30b-a3b-graphs/layer_00.intermediates.onnx
"""

import argparse
import pathlib

import onnx


###############################################################################
###############################################################################
#	ExposeGraphIntermediates — promotes every intermediate value to a graph output
###############################################################################
###############################################################################


class ExposeGraphIntermediates:
    """Rewrites one graph's output list."""

    @staticmethod
    def rewrite(graph_path: pathlib.Path, output_path: pathlib.Path) -> tuple[int, int]:
        """Write a copy of one graph that also returns every intermediate value.

        :param graph_path: the graph to copy.
        :param output_path: where to write the copy.
        :returns: how many outputs the original had, and how many the copy has.
        """
        model = onnx.load(str(graph_path))
        graph = model.graph

        already_returned = {value.name for value in graph.output}
        # An initializer is a weight rather than something a node computed, and
        # returning one would say nothing about which node went wrong.
        initializer_names = {value.name for value in graph.initializer}
        original_output_count = len(graph.output)

        for node in graph.node:
            for name in node.output:
                if name == "" or name in already_returned or name in initializer_names:
                    continue
                already_returned.add(name)
                # The element type and the shape are left unstated on purpose.
                # Shape inference gets some of them wrong on a graph like this,
                # and a declared shape that is wrong is refused at load time,
                # while an undeclared one is worked out at run time.
                graph.output.append(onnx.helper.make_empty_tensor_value_info(name))

        onnx.save(model, str(output_path))
        return original_output_count, len(graph.output)


def main() -> None:
    """Rewrite one graph named on the command line.

    :returns: nothing.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", required=True, help="the graph to copy")
    parser.add_argument("--output", required=True, help="where to write the copy")
    arguments = parser.parse_args()

    before, after = ExposeGraphIntermediates.rewrite(
        pathlib.Path(arguments.graph), pathlib.Path(arguments.output),
    )
    print(f"{arguments.graph} returned {before} values")
    print(f"{arguments.output} returns {after}")


if __name__ == "__main__":
    main()
