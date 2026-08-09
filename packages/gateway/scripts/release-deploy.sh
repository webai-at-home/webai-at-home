#!/usr/bin/env bash
#
# Releases a new version of the gateway and deploys it to Coolify.
#
# It raises the patch number of packages/gateway/package.json, commits that change, tags the commit,
# and pushes the commit together with the tag. Pushing a tag whose name starts with "v" starts the
# "Deploy to Coolify" workflow in .github/workflows/deploy_to_coolify.yml, and that workflow is what
# asks Coolify to deploy. This script never calls Coolify itself, because doing both would deploy
# twice.
#
# Automatic Deployment is turned off on the Coolify application, so a push to main no longer
# redeploys the container and no longer disconnects every worker browser tab. See
# https://github.com/webai-at-home/webai-at-home/issues/149.
#
# "npm version patch" is asked not to make the git tag itself, with --no-git-tag-version, because
# inside a workspace package it writes the raised version into package.json but then names the tag
# after the version before the raise, and leaves the change uncommitted. The commit and the tag
# below are therefore made here rather than by npm.

set -euo pipefail

repository_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${repository_directory}"

if [ -n "$(git status --porcelain)" ]; then
	echo "The working directory has uncommitted changes. Commit or put them aside first." >&2
	exit 1
fi

npm version patch --no-git-tag-version --workspace @webai/gateway

version="$(node -p "require('./packages/gateway/package.json').version")"

git add packages/gateway/package.json package-lock.json
git commit -m "Release version ${version}"
# The tag is annotated, with --annotate, because "git push --follow-tags" below pushes annotated
# tags only and silently leaves a lightweight tag behind on this machine. A tag that never reaches
# GitHub never starts the Deploy to Coolify workflow, and nothing reports that it did not.
git tag --annotate --message "Release version ${version}" "v${version}"
git push --follow-tags

echo "Pushed v${version}. The Deploy to Coolify workflow now asks Coolify to deploy."
