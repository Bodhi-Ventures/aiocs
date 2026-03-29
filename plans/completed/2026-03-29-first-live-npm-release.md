# First live npm release

Created: 2026-03-29

## Objective

Publish the first stable public npm release of `@bodhi-ventures/aiocs` from the open-source
GitHub repository, validate that the tag-driven GitHub Actions workflow works end to end, and
fix any release-blocking issues discovered during the first live run.

## Current State

- Repository root is the `aiocs` checkout on `main`.
- `package.json` is configured for the scoped package `@bodhi-ventures/aiocs` at version `0.1.0`.
- Release workflow is tag-driven on stable tags `vX.Y.Z`.
- GitHub auth is available locally through `gh`.
- Local npm auth is not configured, so the first publish must flow through GitHub Actions using
  the org-level `NPM_TOKEN` secret.
- The scoped package is not yet published on npm.

## Constraints

- Publish only a stable release; no prerelease tags or dist-tags.
- Use the existing tag-driven workflow as the canonical release path.
- Keep `package.json` as the source of truth for the release version.
- If release-blocking issues are found, fix them in the primary implementation path, verify them,
  push them, and rerun the tag release as needed.
- Do not mutate git state from GitHub Actions beyond the release artifact itself.

## Non-Goals

- Introducing a new release model or manual publish path.
- Shipping a new feature unrelated to release correctness.
- Publishing additional packages or prerelease channels.

## Acceptance Checks

- Local preflight passes:
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `npm pack --dry-run`
  - `node dist/cli.js --version`
- A stable tag `v0.1.0` exists on GitHub and triggers the release workflow.
- GitHub Actions release workflow completes successfully.
- `@bodhi-ventures/aiocs@0.1.0` is visible on npm.
- A GitHub release for `v0.1.0` exists with generated notes.
- Any issues found during the first live release are fixed, verified, committed, and pushed.

## Evidence To Collect

- Preflight command output.
- Pushed release tag.
- GitHub Actions run URL and final status.
- npm package presence/version after publish.
- GitHub release presence after publish.
- Commit SHAs for any fixes made during the release pass.

## Outcome

- Local preflight passed on the release commit:
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `npm pack --dry-run`
  - `node dist/cli.js --version`
- Release tag pushed: `v0.1.0`
- GitHub Actions release run succeeded:
  - Run URL: `https://github.com/Bodhi-Ventures/aiocs/actions/runs/23718801321`
  - Job URL: `https://github.com/Bodhi-Ventures/aiocs/actions/runs/23718801321/job/69090219330`
- npm publication succeeded:
  - `npm view @bodhi-ventures/aiocs version` => `0.1.0`
- GitHub release created successfully:
  - `https://github.com/Bodhi-Ventures/aiocs/releases/tag/v0.1.0`
- No release-blocking code fixes were required during the first live run.

## Review Gates

- Run the local verification stack before creating the release tag.
- If code or workflow files change during fixes, run the repo completion loop before claiming the
  release is complete.
- Archive this plan when the live release is proven complete.

## Open Risks

- GitHub Actions may fail on the first live run because the workflow has only been statically
  validated so far.
- npm organization publish permissions or token scope may be insufficient.
- Post-tag fixes may require one or more follow-up commits before the release succeeds.

## Resolved Risks

- The first live tag-driven release completed successfully without workflow changes.
- The org-level npm token had sufficient permissions to publish the scoped public package.
- GitHub release creation from the tag worked as designed.

## Next Handoff Step

For the next release, bump `package.json.version`, commit the change, push to `main`, create the
matching stable tag `vX.Y.Z`, and push the tag to trigger the same release workflow.
