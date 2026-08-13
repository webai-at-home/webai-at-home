# Directory Context: `/packages/_tiny_iris_classifier`

## Purpose

A small end-to-end example that trains an Iris classifier in Python, exports the complete preprocessing and classification pipeline to ONNX, verifies the model with ONNX Runtime, and runs that same model in a browser with ONNX Runtime Web. It is the smallest demonstration that one model file works unchanged on both sides.

## Key Exports & Entry Points

- `training/train.py`: trains the classifier and writes `training/iris.onnx`.
- `training/verify.py`: runs the exported model with ONNX Runtime in Python and checks the answers.
- `training/requirements.txt` and `training/requirements-lock.txt`: the Python dependencies, installed into a `training/.venv` virtual environment.
- `web/index.html` and `web/src/main.js`: the browser page that runs the same model with ONNX Runtime Web.
- `web/public/models/iris.onnx`: the copy of the exported model the browser page loads.

## Rules

- The leading underscore in the folder name marks this package as an example. It is not an npm workspace — it has no `package.json` at this level — and no working package may import from it.
- `web/` has its own `package.json` and its own lock file, and is installed and run from inside `web/`, not from the repository root.
- The Python side and the browser side must use the same model file: after `training/train.py` writes `training/iris.onnx`, copy it to `web/public/models/iris.onnx`.
- `training/.venv/` is a local virtual environment and is never committed.

## Background

- The full step-by-step instructions live in [`README.md`](README.md). Keep them working; they are what makes this example useful.
