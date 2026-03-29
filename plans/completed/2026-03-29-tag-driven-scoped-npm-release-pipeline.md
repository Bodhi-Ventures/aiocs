# Tag-driven scoped npm release pipeline

Created: 2026-03-29

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `aiocs` publicly as `@bodhi-ventures/aiocs` through a stable tag-driven GitHub Actions pipeline that never mutates git state.

**Architecture:** Keep `package.json` as the single source of truth for version and package identity, then make the release workflow a pure verifier/publisher triggered only by stable tags. Align CI, release checks, and README instructions so the repository, package metadata, and automation all describe the same release contract.

**Tech Stack:** GitHub Actions, npmjs public org packages, pnpm, Node 22, Playwright, Vitest

---

## Objective

Make `aiocs` publishable as the public scoped package `@bodhi-ventures/aiocs` and replace the current workflow-dispatch release job with a stable, rerunnable, tag-only release pipeline. The workflow must validate the tag against `package.json`, publish to npm using the org `NPM_TOKEN`, and create the GitHub release without editing files, creating commits, or creating tags.

## Current State

- `package.json` still uses the unscoped package name `aiocs`.
- The release workflow is `workflow_dispatch`-driven and currently edits `package.json`, creates commits, tags, and configures a synthetic git author.
- CI validates build/test/package/docker, but the release workflow still reflects the older mutable-release model.
- README install instructions still point to `npm install --global aiocs`.
- The approved release design lives in `docs/superpowers/specs/2026-03-29-tag-driven-release-pipeline-design.md`.

## Constraints

- Keep CLI binary names unchanged: `docs` and `aiocs-mcp`.
- Stable releases only. No prereleases or alternate dist-tags in this scope.
- Releases must be created only from pushed tags matching `vX.Y.Z`.
- The workflow must be safely rerunnable after partial success.
- Do not touch unrelated repo changes, including the current unrelated `AGENTS.md` modification.

## Non-Goals

- No new binary distribution format beyond npm.
- No `workflow_dispatch` recovery path.
- No version bump automation in GitHub Actions.
- No changes to runtime behavior of the CLI or MCP server beyond smoke validation.

## Acceptance Checks

- `package.json.name` is `@bodhi-ventures/aiocs`.
- `package.json.publishConfig` explicitly enforces public scoped publishing with provenance.
- README install and release instructions use `npm install -g @bodhi-ventures/aiocs` and a tag-only release flow.
- The release workflow triggers on stable tags only and does not mutate git state.
- The release workflow fails fast when the tag/version/name contract is violated.
- The release workflow skips npm publish and GitHub release creation when rerun after partial success.
- CI and release workflow assertions remain aligned with the shipped package surface.

## Evidence To Collect

- Updated package metadata diff in `package.json`.
- Updated workflow diffs in `.github/workflows/release.yml` and any CI assertions that need alignment.
- Updated README release/install documentation.
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `npm pack --dry-run`
- Static workflow validation via repository tests and file assertions.

## Review Gates

- Mandatory `reviewer`
- Conditional `refactor_auditor` via classifier
- Conditional `verifier` via classifier with `test`, `build`, `command`, `automation`, and `explicit_request` signals

## Open Risks

- npm org publishing can still fail if the npmjs org/package configuration is wrong outside the repo.
- The first live tag release is still the only full proof of publication and GitHub release creation.
- Changing the scoped package name may require updating any tests/docs that assert the current package identity.

## Task 1: Harden package metadata for scoped public publishing

**Files:**
- Modify: `package.json`
- Test: `tests/release/release-assets.test.ts`

- [ ] **Step 1: Write/adjust failing release-asset assertions for scoped publish metadata**

Update `tests/release/release-assets.test.ts` to expect:
- package name `@bodhi-ventures/aiocs`
- explicit `publishConfig.access = public`
- explicit `publishConfig.provenance = true`

- [ ] **Step 2: Run targeted test to verify the current metadata fails**

Run: `pnpm --dir <repo-root> test tests/release/release-assets.test.ts`
Expected: FAIL on package name or publish metadata assertions.

- [ ] **Step 3: Update package metadata**

Modify `package.json`:
- rename `name` to `@bodhi-ventures/aiocs`
- add `publishConfig` with `access: public` and `provenance: true`

- [ ] **Step 4: Re-run the targeted metadata test**

Run: `pnpm --dir <repo-root> test tests/release/release-assets.test.ts`
Expected: PASS for the updated package metadata expectations.

## Task 2: Replace the mutable release workflow with a tag-driven pipeline

**Files:**
- Modify: `.github/workflows/release.yml`
- Test: `tests/release/release-assets.test.ts`

- [ ] **Step 1: Write/adjust failing workflow assertions**

Update `tests/release/release-assets.test.ts` to assert the release workflow:
- triggers on pushed tags
- does not contain `workflow_dispatch`
- does not configure git author or run `npm version`, `git commit`, or `git tag`
- validates the scoped package name and tag/version contract
- checks npm/GitHub release existence for reruns

- [ ] **Step 2: Run targeted release-asset test to confirm the current workflow fails**

Run: `pnpm --dir <repo-root> test tests/release/release-assets.test.ts`
Expected: FAIL because the current workflow still uses `workflow_dispatch` and mutable git steps.

- [ ] **Step 3: Rewrite `release.yml` to the tag-only model**

Implement:
- `on.push.tags: ['v*.*.*']`
- stable semver extraction from `github.ref_name`
- package name and version validation
- full verification stack before publish
- npm publish guarded by an npm existence check
- GitHub release creation guarded by a release existence check
- no git mutation steps

- [ ] **Step 4: Re-run the targeted workflow test**

Run: `pnpm --dir <repo-root> test tests/release/release-assets.test.ts`
Expected: PASS for the release workflow assertions.

## Task 3: Align CI and documentation with the scoped tag-release contract

**Files:**
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml` (if needed)
- Test: `tests/release/release-assets.test.ts`

- [ ] **Step 1: Update docs assertions if README/release wording is validated**

Extend `tests/release/release-assets.test.ts` to assert:
- scoped npm install command in README
- short release instructions describing version bump, commit, tag, push
- any CI expectations that changed because of the scoped package/release model

- [ ] **Step 2: Run the targeted test to confirm doc/CI mismatches**

Run: `pnpm --dir <repo-root> test tests/release/release-assets.test.ts`
Expected: FAIL until README/CI are aligned.

- [ ] **Step 3: Update README and CI**

Modify `README.md`:
- replace `npm install --global aiocs` with `npm install -g @bodhi-ventures/aiocs`
- add a short stable release section with the tag-driven flow

Modify `.github/workflows/ci.yml` only if needed to keep the smoke/validation surfaces aligned with the new package identity.

- [ ] **Step 4: Re-run the targeted test**

Run: `pnpm --dir <repo-root> test tests/release/release-assets.test.ts`
Expected: PASS with the updated README and CI assertions.

## Task 4: Run full verification on the final release pipeline

**Files:**
- Modify: `plans/active/2026-03-29-tag-driven-scoped-npm-release-pipeline.md`

- [ ] **Step 1: Run the full repository verification stack**

Run:
- `pnpm --dir <repo-root> lint`
- `pnpm --dir <repo-root> test`
- `pnpm --dir <repo-root> build`
- `cd <repo-root> && npm pack --dry-run`

Expected: all commands pass on the final tree.

- [ ] **Step 2: Capture final evidence in the completion summary**

Record the exact commands and outcomes when reporting back, including any static assertions about the release workflow and package metadata.

## Next Handoff Step

Execute the plan inline in this session by following the tasks in order, then run the repository finish-with-review loop before claiming completion.
