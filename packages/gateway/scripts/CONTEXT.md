# Directory Context: `/packages/gateway/scripts`

## Purpose
Holds the gateway's maintenance commands, run by a person from a terminal rather than by the gateway itself. No source file in the repository imports from here.

## Key Exports & Entry Points
- `release-deploy.sh`: raises the patch number of `packages/gateway/package.json`, commits it, tags the commit `v<version>`, and pushes the commit with the tag, which starts the `Deploy to Coolify` workflow in `.github/workflows/deploy_to_coolify.yml`.

## Local Rules & Boundaries
- Every file here is a standalone command with the executable permission set and a `#!/usr/bin/env bash` first line.
- A command here resolves the repository root from its own location and changes into it, so it behaves the same from any working directory.
- A command here must not call Coolify directly. Deployment is started by pushing a tag whose name begins with `v`, and the GitHub Actions workflow is the only thing that talks to Coolify.
