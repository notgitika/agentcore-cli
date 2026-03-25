# Release Process

This document describes the release process for both AgentCore packages. Releases are always done **CDK first, then
CLI**, since the CLI depends on `@aws/agentcore-cdk`.

## Release Order

1. **`@aws/agentcore-cdk`** (CDK L3 Constructs)
2. **`@aws/agentcore`** (CLI)

## Overview

Both packages use a GitHub Actions `workflow_dispatch` workflow with the same four-stage pipeline:

1. **Prepare Release** — bump version, update changelog, open a PR to `main`
2. **Test and Build** — lint, typecheck, build, test on the release branch
3. **Release Approval** — manual approval gate in a GitHub Environment
4. **Publish to npm** — publish, tag, and create a GitHub Release

The workflow must be triggered from the `main` branch.

---

## CDK L3 Constructs (`@aws/agentcore-cdk`)

**Workflow:** `agentcore-l3-cdk-constructs/.github/workflows/release.yml`

### Inputs

| Input            | Options                                          | Notes                                           |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| `bump_type`      | `alpha`, `patch`, `minor`, `major`, `prerelease` | Required                                        |
| `changelog`      | free text                                        | Optional — auto-generates from commits if empty |
| `prerelease_tag` | e.g. `alpha`, `beta`, `rc`                       | Only used with `prerelease` bump type           |

### Version bumping

Runs `npx tsx scripts/bump-version.ts <bump_type>` which updates `package.json`, `package-lock.json`, and
`CHANGELOG.md`.

### Pipeline details

| Stage            | Environment    | Notes                                                                                                          |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| Prepare Release  | —              | Creates `release/v<VERSION>` branch and PR against `main`                                                      |
| Test and Build   | —              | Runs lint, typecheck, build; uploads `dist/` and tarball as artifacts                                          |
| Release Approval | `npm-approval` | Manual approval required                                                                                       |
| Publish to npm   | `npm`          | Uses `NPM_SECRET` token; checks version doesn't already exist on npm; polls npm for availability after publish |

### Auth

Uses token-based npm auth via the `NPM_SECRET` repository secret.

---

## CLI (`@aws/agentcore`)

**Workflow:** `agentcore-cli/.github/workflows/release.yml`

### Inputs

| Input            | Options                                                             | Notes                                           |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| `bump_type`      | `preview`, `preview-major`, `patch`, `minor`, `major`, `prerelease` | Required                                        |
| `changelog`      | free text                                                           | Optional — auto-generates from commits if empty |
| `prerelease_tag` | e.g. `alpha`, `beta`, `rc`                                          | Only used with `prerelease` bump type           |

### Version bumping

Same approach as CDK — runs `npx tsx scripts/bump-version.ts <bump_type>`. The CLI additionally supports `preview` and
`preview-major` bump types for the `0.x.y-preview.N.M` versioning scheme.

### Pipeline details

| Stage            | Environment            | Notes                                                                                                    |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Prepare Release  | —                      | Creates `release/v<VERSION>` branch and PR against `main`                                                |
| Test and Build   | —                      | Runs lint, typecheck, build, **unit tests**; also configures git + installs `uv` for Python test support |
| Release Approval | `npm-publish-approval` | Manual approval required                                                                                 |
| Publish to npm   | `npm-publish`          | Uses OIDC trusted publishing (no npm token needed); publishes with `--provenance --tag latest`           |

### Auth

Uses GitHub OIDC trusted publishing — no `NPM_TOKEN` or secret needed. Requires `id-token: write` permission and npm >=
11.5.1.

---

## Step-by-step: How to cut a release

### 1. Release CDK L3 Constructs

1. Go to **Actions > Release** in the `agentcore-l3-cdk-constructs` repo.
2. Click **Run workflow** from `main`.
3. Select `bump_type` (e.g. `alpha` for pre-GA, `patch`/`minor`/`major` for GA).
4. Optionally provide a `changelog` message.
5. Wait for the PR to be created on `release/v<VERSION>`.
6. Review the PR — verify CHANGELOG.md and version numbers.
7. Merge the PR to `main`.
8. Approve the deployment in the `npm-approval` environment.
9. Verify the package appears on npm: `npm view @aws/agentcore-cdk@<VERSION>`.

### 2. Release CLI

1. If the CLI depends on the new CDK version, update the dependency in `agentcore-cli/package.json` first and merge that
   to `main`.
2. Go to **Actions > Release** in the `agentcore-cli` repo.
3. Click **Run workflow** from `main`.
4. Select `bump_type` (e.g. `preview` for pre-GA, `patch`/`minor`/`major` for GA).
5. Optionally provide a `changelog` message.
6. Wait for the PR to be created on `release/v<VERSION>`.
7. Review the PR — verify CHANGELOG.md and version numbers.
8. Merge the PR to `main`.
9. Approve the deployment in the `npm-publish-approval` environment.
10. Verify: `npm view @aws/agentcore@<VERSION>`.

---

## Key differences between the two workflows

|                  | CDK L3 Constructs                                  | CLI                                                                 |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| **Package**      | `@aws/agentcore-cdk`                               | `@aws/agentcore`                                                    |
| **npm auth**     | `NPM_SECRET` token                                 | OIDC trusted publishing                                             |
| **Approval env** | `npm-approval`                                     | `npm-publish-approval`                                              |
| **Publish env**  | `npm`                                              | `npm-publish`                                                       |
| **Bump types**   | `alpha`, `patch`, `minor`, `major`, `prerelease`   | `preview`, `preview-major`, `patch`, `minor`, `major`, `prerelease` |
| **Extra checks** | Version existence check + npm availability polling | Installs `uv` for Python; runs unit tests in CI                     |
| **PR token**     | `PAT_TOKEN` secret                                 | Default `github.token`                                              |
