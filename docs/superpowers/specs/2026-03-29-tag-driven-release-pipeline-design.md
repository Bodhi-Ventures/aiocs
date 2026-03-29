# Tag-Driven Release Pipeline Design

## Summary

`aiocs` should release as the public scoped npm package `@bodhi-ventures/aiocs` through a stable, tag-driven GitHub Actions workflow. The repository remains the source of truth for versioning. Releases are created only from pushed stable tags of the form `vX.Y.Z`.

The workflow must never mutate git state. It should validate the tag against `package.json`, run the full release verification stack, publish publicly to npm with provenance, and create a GitHub release from the same tag.

## Goals

- publish `aiocs` publicly under `@bodhi-ventures/aiocs`
- eliminate workflow-managed version bumps, commits, and tag creation
- remove improvised git author configuration from the release workflow
- make the release contract deterministic and easy to reason about
- keep CI and release validation aligned with the actual shipped package surface

## Non-Goals

- prerelease publishing
- automatic releases from `main`
- workspace/multi-package publishing
- alternative binary distribution outside npm

## Current State

- `package.json` still uses the unscoped package name `aiocs`
- the current release workflow is `workflow_dispatch`-driven
- the workflow edits `package.json`, creates commits and tags, and configures a bot git identity
- release automation is more complex than necessary and mixes version mutation with publishing

## Chosen Design

### Package Identity

- rename the npm package to `@bodhi-ventures/aiocs`
- keep the package public
- keep CLI command names unchanged:
  - `docs`
  - `aiocs-mcp`
- add explicit `publishConfig`:
  - `access: public`
  - `provenance: true`

### Release Trigger

- release workflow triggers only on pushed stable semver tags matching `v*.*.*`
- the tag version must match `package.json.version` exactly
- only stable releases are supported; prerelease tags are rejected

### Release Workflow Behavior

- check out the tagged revision
- install dependencies and release prerequisites
- fail fast unless all of these are true:
  - tag matches `vX.Y.Z`
  - `package.json.version === X.Y.Z`
  - `package.json.name === @bodhi-ventures/aiocs`
- run full release validation:
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `npm pack --dry-run`
  - built CLI smoke, at minimum `node dist/cli.js --version`
- publish to npm with the existing `NPM_TOKEN` org secret
- create a GitHub release for the pushed tag
- if a GitHub release already exists for that tag, do not recreate it

### Git Behavior

- the workflow never edits files
- the workflow never commits
- the workflow never creates tags
- the workflow never configures a synthetic git author

Version bumps happen in normal development flow:

1. update `package.json.version`
2. commit the version bump
3. create tag `vX.Y.Z`
4. push commit and tag

## CI Alignment

CI remains the pre-release gate and should stay close to the release workflow:

- install dependencies
- install Playwright Chromium
- run lint, tests, build, and `npm pack --dry-run`
- validate Docker image and compose config
- smoke test the packaged CLI surface

CI should also assert package metadata consistency where useful, especially the scoped package name.

## Documentation Changes

Update repository docs to reflect the scoped public package and release process:

- install command becomes `npm install -g @bodhi-ventures/aiocs`
- add a short release section to the README describing the tag-based flow
- keep the CLI-facing command examples unchanged

## Risks

- npm org publishing can still fail if org/package permissions are not configured correctly on npmjs
- the first release is the highest-risk run because the scoped package has not been proven yet
- GitHub Actions can only validate the workflow structure locally; final proof requires one live tag release

## Acceptance Criteria

- `package.json` is updated to `@bodhi-ventures/aiocs`
- release workflow triggers on stable tags only
- release workflow does not mutate git state
- release workflow validates tag/version/name consistency before publishing
- README/install docs reference the scoped package name
- local verification passes on the updated tree:
  - lint
  - tests
  - build
  - `npm pack --dry-run`
- the first real release can be executed by bumping version, pushing a `vX.Y.Z` tag, and observing npm + GitHub release creation

## Follow-Up

After implementation, do one real tagged stable release to prove the pipeline end to end.
