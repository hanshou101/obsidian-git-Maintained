# Maintenance model

This repository is an independent, long-lived maintained edition of Obsidian Git.

## Repository roles

- `origin`: `https://github.com/hanshou101/obsidian-git-Maintained.git` — the authoritative development and release repository.
- `upstream`: `https://github.com/Vinzent03/obsidian-git.git` (default branch `master`) — a read-only reference for reviewing changes from the original project.
- A separate GitHub fork may be used only when contributing selected changes back upstream. Upstream pull requests never gate this repository's merges or releases.

## Upstream base

| | |
|---|---|
| Upstream repository | `https://github.com/Vinzent03/obsidian-git` |
| Base release | 2.42.0 (upstream tag `2.42.0`) |
| Base commit | `31621dd04cac27dad9537ea2a828f0048366da1b` ("chore(release): 2.42.0", 2026-10-18) |

Everything this edition took from upstream is the history up to the base commit; `main` contains that history unchanged, so the base commit exists in this repository too. Upstream tags are not pushed here: every tag pushed to this repository starts the release workflow.

To see what upstream has done since the base, diff against the base commit instead of comparing files by hand:

```bash
git fetch upstream --no-tags
git log --oneline 31621dd04cac27dad9537ea2a828f0048366da1b..upstream/master
git diff --stat 31621dd04cac27dad9537ea2a828f0048366da1b upstream/master
git diff 31621dd04cac27dad9537ea2a828f0048366da1b upstream/master -- <path>
```

The same base commit shows exactly what this edition changed: `git diff 31621dd04cac27dad9537ea2a828f0048366da1b main`.

Whenever upstream changes are merged in, update this table to the new upstream commit in the same pull request, so the recorded base always matches the code.

## What this edition changes

1. **Mobile push after a merge.** isomorphic-git 1.44.3 builds the pack for a push by walking back from the local branch until it reaches one of the commits the remote advertises. After a mobile pull merges remote changes, the walk passes the remote tip on the other side of the merge and continues to the root commit, so the push re-sends the whole history. isomorphic-git [PR #2458](https://github.com/isomorphic-git/isomorphic-git/pull/2458) fixes this; it is not in any isomorphic-git release yet. This edition applies that change as a dependency patch (next section). `tests/gitManager/isomorphicGitPushAfterMerge.test.ts` pushes through a real `git http-backend` and fails without the patch.
2. **Manual commits can follow the auto commit globs.** The setting `manualCommitUsesAutoCommitGlobs` (Settings → Git → Automatic → "Use these globs for manual commits too", default off) makes manual commits use the same file selection as the automatic routine. The change is in `performCommit` in `src/gitActions.ts`, with the setting in `src/types.ts`, `src/constants.ts`, and `src/setting/settings.ts`. `tests/gitManager/gitManager.test.ts` covers it on both Git backends.
3. **Build with Vite.** Like every plugin in the HugeRepo collection, the bundle is built with Vite 8 (`vite.config.mjs`) instead of upstream's `esbuild.config.mjs`. The config keeps what the esbuild build did: one CommonJS `main.js` whose `module.exports` is the plugin class, the same external modules (a package name also covers its subpaths, so `fs` covers `fs/promises`), the injected `Buffer` from `polyfill_buffer.js`, `process.env.NODE_ENV` replaced, ES2018 output, Svelte with injected CSS, and `"use strict"` at the top. `svelte-check` reads the Svelte options from the same file.
4. **Edition metadata.** `manifest.json` names the plugin "Git (Maintained)" and keeps the id `obsidian-git`, so it installs over the stock plugin and keeps its settings. The production bundle `main.js` is tracked (upstream ignores it). `.prettierignore` keeps the `.frac.md` context files out of the Prettier check, and the Dependabot configuration is removed.

## The isomorphic-git patch

Code changes to the plugin go into `src/`. The push walk is inside isomorphic-git, so its fix is carried as a pnpm patch:

- `patches/isomorphic-git@1.44.3.patch` is a unified diff against the published isomorphic-git 1.44.3 package. It replaces the body of `listCommitsAndTags` in `index.cjs` (used by Node and the tests) and `index.js` (used by the Vite bundle) with the code from PR #2458.
- `pnpm-workspace.yaml` registers it under `patchedDependencies`; `pnpm-lock.yaml` pins its hash. pnpm applies it on every install and stops with an error if it no longer applies, so it cannot silently drop out of a build.
- Never edit files in `node_modules`, and never post-process `main.js` with string replacements. A change to a dependency goes through the patch; everything else goes through `src/`.

To change the patch, run `pnpm patch isomorphic-git@1.44.3`, edit both `index.cjs` and `index.js` in the directory it prints, then run `pnpm patch-commit <that directory>`.

**Exit plan.** When an isomorphic-git release contains PR #2458, upgrade isomorphic-git, delete the patch file and its `patchedDependencies` entry, and keep the push test: it must still pass without the patch. If isomorphic-git has to be upgraded before that, recreate the patch for the new version; the push test shows whether the fix still holds.

## Versioning

Versions are `<upstream version>-maintained.<n>`, for example `2.42.0-maintained.1`. Keep `package.json`, `manifest.json`, and `versions.json` in step by hand; upstream's `pnpm run release` (commit-and-tag-version) computes upstream-style versions and is not used here.

Obsidian compares plugin versions by splitting them on `.` and reading the leading number of each part, so `2.42.0-maintained.1` reads as 2.42.0.1. Stock 2.42.0 is therefore not offered as an update over it, but any upstream release from 2.42.1 on is, because Obsidian still associates the id `obsidian-git` with the upstream repository. BRAT requires the release tag to equal the manifest version.

## HugeRepo integration

This repository is consumed as `submodules/obsidian-git` by [`hanshou101/Awesome_ObsidianPlugin_HugeRepo`](https://github.com/hanshou101/Awesome_ObsidianPlugin_HugeRepo), which also tracks the installable files in `dist/obsidian-git/`, regenerated by `scripts/update-obsidian-git-package.mjs`. Before work that can affect builds, releases, the submodule pointer, or installable artifacts, maintainers and agents must read the HugeRepo [Submodule integration contract](https://github.com/hanshou101/Awesome_ObsidianPlugin_HugeRepo/blob/main/SUBMODULE_INTEGRATION.md).

**Definition of done.** A change here is not finished when its PR merges. It is finished when a separate HugeRepo PR has advanced `submodules/obsidian-git` to the merged commit and regenerated `dist/obsidian-git/`. If the HugeRepo does not have the submodule yet, that PR adds the submodule, the update script, `dist/obsidian-git/`, and `docs/obsidian-git.md` together. Never publish `dist/` files or releases from an unmerged branch of this repository.

## Updating from upstream

Upstream changes are imported deliberately, not automatically:

```bash
git fetch upstream --no-tags
git switch -c review/upstream-<version> main
git merge --no-ff <upstream release commit>
```

Review the full diff from the recorded base commit to the new one (see "Upstream base"), make sure `pnpm install` still applies the isomorphic-git patch, run the validation below, rebuild and commit `main.js`, set the version to `<new upstream version>-maintained.1`, update the "Upstream base" table, and open a pull request into `main`.

## Local validation

Requires Node.js 24 or later, pnpm 11 or later, and a Git CLI that provides `git http-backend` (the push test runs it).

```bash
pnpm install --frozen-lockfile
pnpm run all                      # tsc, svelte-check, prettier, eslint, vitest
pnpm run build
git diff --exit-code -- main.js   # the tracked bundle matches the source
git diff --check
```

The tracked `main.js` must be rebuilt and committed with every change that affects the bundle, including dependency and patch changes.

## Releases

1. Bump the version as described above, rebuild, and merge the change through a pull request.
2. On the merged commit, create an annotated tag named exactly as the manifest version (no `v` prefix); its message becomes the release notes. Push only that tag.
3. `.github/workflows/releases.yml` checks that the tag equals the manifest version, builds the plugin, attests the build, and publishes `main.js`, `manifest.json`, `styles.css`, and a zip of the three.
4. Then do the HugeRepo integration PR described above.

Dependencies are upgraded deliberately, usually together with an upstream merge, so this repository has no Dependabot version-update configuration.
