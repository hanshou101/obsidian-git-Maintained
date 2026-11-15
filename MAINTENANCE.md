# Maintenance model

This repository is an independent, long-lived maintained edition of Obsidian Git.

## Repository roles

- `origin`: `https://github.com/hanshou101/obsidian-git-Maintained.git` — the authoritative development and release repository.
- `upstream`: `https://github.com/Vinzent03/obsidian-git.git` (default branch `master`) — a read-only reference for reviewing changes from the original project.
- A separate GitHub fork may be used only when contributing selected changes back upstream. Upstream pull requests never gate this repository's merges or releases.

## Upstream base

|                     |                                                                                   |
| ------------------- | --------------------------------------------------------------------------------- |
| Upstream repository | `https://github.com/Vinzent03/obsidian-git`                                       |
| Base release        | 2.42.0 (upstream tag `2.42.0`)                                                    |
| Base commit         | `31621dd04cac27dad9537ea2a828f0048366da1b` ("chore(release): 2.42.0", 2026-10-18) |

The history of `main` starts with one import commit, `6574efb8953fab3d8c70cbe66839f938951b643a` ("Import upstream obsidian-git 2.42.0"), whose tree is identical to the base commit. Upstream's own history is not in this repository: GitHub push protection rejects it, because upstream commits from 2022 contain a personal access token. Upstream tags are not pushed here either: every tag pushed to this repository starts the release workflow.

To see what upstream has done since the base, diff against the base commit instead of comparing files by hand. Add the upstream remote once (`git remote add upstream https://github.com/Vinzent03/obsidian-git.git`), then:

```bash
git fetch upstream --no-tags
git log --oneline 31621dd04cac27dad9537ea2a828f0048366da1b..upstream/master
git diff --stat 31621dd04cac27dad9537ea2a828f0048366da1b upstream/master
git diff 31621dd04cac27dad9537ea2a828f0048366da1b upstream/master -- <path>
```

What this edition changed is `git diff 6574efb8953fab3d8c70cbe66839f938951b643a main`.

Whenever upstream changes are brought in, update this table to the new upstream commit in the same pull request, so the recorded base always matches the code.

## What this edition changes

1. **Mobile push after a merge.** isomorphic-git 1.44.3 builds the pack for a push by walking back from the local branch until it reaches one of the commits the remote advertises. After a mobile pull merges remote changes, the walk passes the remote tip on the other side of the merge and continues to the root commit, so the push re-sends the whole history. isomorphic-git [PR #2458](https://github.com/isomorphic-git/isomorphic-git/pull/2458) fixes this; it is not in any isomorphic-git release yet. This edition applies that change as a dependency patch (next section). `tests/gitManager/isomorphicGitPushAfterMerge.test.ts` pushes through a real `git http-backend` and fails without the patch.
2. **Manual commits can follow the auto commit globs.** The setting `manualCommitUsesAutoCommitGlobs` (Settings → Git → Automatic → "Use these globs for manual commits too", default off) makes manual commits use the same file selection as the automatic routine. The change is in `performCommit` in `src/gitActions.ts`, with the setting in `src/types.ts`, `src/constants.ts`, and `src/setting/settings.ts`. `tests/gitManager/gitManager.test.ts` covers it on both Git backends.
3. **Build with Vite.** Like every plugin in the HugeRepo collection, the bundle is built with Vite 8 (`vite.config.mjs`) instead of upstream's `esbuild.config.mjs`. The config keeps what the esbuild build did: one CommonJS `main.js` whose `module.exports` is the plugin class, the same external modules (a package name also covers its subpaths, so `fs` covers `fs/promises`), the injected `Buffer` from `polyfill_buffer.js`, `process.env.NODE_ENV` replaced, ES2018 output, Svelte with injected CSS, and `"use strict"` at the top. `svelte-check` reads the Svelte options from the same file.
4. **Its own plugin id, `git-maintained`.** Obsidian's update check looks up each installed plugin id in the community plugin list and offers the listed repository's newer release; with the stock id `obsidian-git`, every newer upstream release would be offered as an update that replaces this edition. (On Obsidian 1.14.5, the check offered upstream Easy Git 1.9.0 over an installed `easy-git` 1.7.2, the same situation.) `git-maintained` is not in the list (checked 2026-10-29). What the id change touches:
    - `src/setting/stockPlugin.ts` and `src/main.ts`: while the stock plugin is enabled in the vault (`app.plugins.enabledPlugins`, a private API), `onload` shows a notice and returns before registering anything, because both plugins register the same view types and would sync the same repository. At the first start (no own `data.json`), `loadSettings` copies the stock `data.json` and the device-local values (`LocalStorageSettings.importFrom`, not `pluginDisabled` or `pausedAutomatics`), saves its own `data.json`, and shows a notice.
    - `src/gitManager/simpleGit.ts`: the askpass helper, its `.git/info/exclude` entry, and the temporary patch file go into the plugin's own folder (`manifest.dir`) instead of `plugins/obsidian-git`.
    - Kept as in upstream on purpose: view types, workspace event names (`obsidian-git:*`), CSS classes, and the default secret name `obsidian-git-password`, so open panes and the stored password carry over. Obsidian prefixes command ids with the plugin id, so commands are `git-maintained:*` and hotkeys must be bound again.
    - Tests: `tests/setting/stockPlugin.test.ts`, and `tests/gitManager/askpass.test.ts` for the folder.
5. **Phone sync & mobile UX (`AME-1119`, `AME-1406`).** Settings live on their own page, Settings → Git (Maintained) → Phone sync (`weakNetworkMode`, `syncOnLeave`, `keepAwakeWhileSyncing`, `rescueFolder`), plus `autoSyncDelaySeconds` on the Automatic page. Their defaults keep upstream's behavior; with all of them off, the core phone-sync UI additions are the sync status view (with live progress and conflict recovery actions), local sync history, and mobile-friendly pull/clone/branch/delete modals.
    - `src/gitManager/isomorphicGit.ts`: `pull()` writes a journal (`.git/git-maintained-pull.json`) before checkout and removes it once the branch moved; interrupted pulls recover before every pull and commit, and `rescueCommittedConflicts()` / `buildAutoRescuedMergeCommit()` auto-rescue clean local conflict versions (stage-2 / unmerged local blobs) into `rescueFolder` (or `_冲突备份` during forced one-tap override via `withRescueFolderOverride()`) via `rescueVaultFolder()`, leaving `materializeMergeConflictScoped()` clean for unaffected dirty edits. Local blockers that already exist in incoming history are reset transparently without a setting, while unknown local work stops unless `rescueFolder` is set. `commitsAhead()`, and standard `.filter((e) => e !== "HEAD")` in `getRemoteBranches()` are included, alongside normalized directory paths in `MyAdapter.readdir()`.
    - Sync queuing, conflict resolution & modals (`AME-1406`): `SyncSupervisor.requestSync()` records `running.queuedManual = true` so manual sync requests triggered during an automatic sync queue a follow-up instead of being dropped, and startup auto-pull (`boot-pull`) reports through `SyncSupervisor`. `GitActions.performCommit()` (when `!fromAuto`) marks marker-free edited files or deleted conflicted files as resolved, and `GitActions.rescueConflictsAndSync()` implements one-tap **Backup conflicts & sync with remote** (`withRescueFolderOverride` + `pendingRescuedVaultPaths` + `commitRescuedPathsAfterPull` so rescued files still commit even if `autoCommitGlobs` omits the rescue folder). `OperationProgressModal` wraps manual `Pull`, `Fetch`, `Push` (`openQueuedProgressModal`), and `Clone` (ignoring `disablePopups` for manual `Pull`), staying open with summary/details and a `Close` button unless `closeOnSuccess: true` is passed by `withProgressModal` (used in `switchRemoteBranch`); `GeneralModal` (`limit = 500`) filters substrings and ranks exact or `/<query>` suffix > prefix > shorter length; `DeleteRepositoryModal.openAndGetChoice()` returns `DeleteRepositoryChoice` (`"cancel" | "git-only" | "git-and-files"`) with immediate workspace refresh.
    - `src/gitManager/networkPolicy.ts`: timeouts, offline fast-fail and read retries for `requestUrl`, active only in weak network mode.
    - `src/syncSupervisor.ts` (`plugin.syncSupervisor`): history, retries, leave/return triggers, keep-awake, notices. `src/syncProblems.ts` classifies errors and holds the texts (Chinese and English). `src/ui/syncStatusView.ts` is the view. `GitActions` reports to the supervisor (`syncStarted`/`syncFinished`, `recordCommit`/`recordPull`/`recordPush`) and passes it the errors of commits, pulls and pushes first (`runGitAction`'s `observeError`), so it can keep network errors out of pop-ups.
    - Only while weak network mode or syncing on leave is on: vault events for files no automatic commit can pick up, and the files a pull writes, no longer start the auto commit timer; automatic commits with include globs look only at the globs' folders on mobile.
    - Tests: `tests/gitManager/pullRecovery.test.ts` (the stuck state from the phone, a killed checkout, the rescue folder), `tests/gitManager/phoneSync.test.ts`, `tests/gitManager/networkPolicy.test.ts`, `tests/syncSupervisor.test.ts`, `tests/syncProblems.test.ts`, `tests/autoCommitGlobs.test.ts`, `tests/automaticsManager.test.ts`.
6. **Edition metadata.** `manifest.json` names the plugin "Git (Maintained)". The production bundle `main.js` is tracked (upstream ignores it). `.prettierignore` keeps the `.frac.md` context files out of the Prettier check, and the Dependabot configuration is removed.

## pnpm patches (`isomorphic-git` & `diff3`)

Code changes to the plugin go into `src/`. Dependency fixes live as pnpm patches:

- `patches/isomorphic-git@1.44.3.patch` is a unified diff against the published isomorphic-git 1.44.3 package. It replaces the body of `listCommitsAndTags` in `index.cjs` (used by Node and the tests) and `index.js` (used by the Vite bundle) with the code from PR #2458.
- `patches/diff3@0.0.4.patch` removes an undeclared `ed = delta + 2 * p;` assignment inside `onp.js` (`compose()`) that crashed with `ReferenceError: ed is not defined` in Vite's `"use strict";` bundle during three-way merges.
- `pnpm-workspace.yaml` registers both under `patchedDependencies`; `pnpm-lock.yaml` pins their hashes. pnpm applies them on every install and stops with an error if either no longer applies, so neither can silently drop out of a build.
- Never edit files in `node_modules`, and never post-process `main.js` with string replacements. A change to a dependency goes through the patch; everything else goes through `src/`.

To change the patch, run `pnpm patch isomorphic-git@1.44.3`, edit both `index.cjs` and `index.js` in the directory it prints, then run `pnpm patch-commit <that directory>`.

**Exit plan.** When an isomorphic-git release contains PR #2458, upgrade isomorphic-git, delete the patch file and its `patchedDependencies` entry, and keep the push test: it must still pass without the patch. If isomorphic-git has to be upgraded before that, recreate the patch for the new version; the push test shows whether the fix still holds.

## Versioning

Versions are `<upstream version>-maintained.<n>`, for example `2.42.0-maintained.1`. Keep `package.json`, `manifest.json`, and `versions.json` in step by hand; upstream's `pnpm run release` (commit-and-tag-version) computes upstream-style versions and is not used here.

Obsidian never offers an update for this edition, because its id `git-maintained` is not in the community plugin list; keep it that way, and never change the id back to `obsidian-git` (see "What this edition changes"). Updates reach users through BRAT, which installs a new release only when one is picked. BRAT requires the release tag to equal the manifest version.

## HugeRepo integration

This repository is consumed as `submodules/obsidian-git` by [`hanshou101/Awesome_ObsidianPlugin_HugeRepo`](https://github.com/hanshou101/Awesome_ObsidianPlugin_HugeRepo), which also tracks the installable files in `dist/obsidian-git/`, regenerated by `scripts/update-obsidian-git-package.mjs`. Before work that can affect builds, releases, the submodule pointer, or installable artifacts, maintainers and agents must read the HugeRepo [Submodule integration contract](https://github.com/hanshou101/Awesome_ObsidianPlugin_HugeRepo/blob/main/SUBMODULE_INTEGRATION.md).

**Definition of done.** A change here is not finished when its PR merges. It is finished when a separate HugeRepo PR has advanced `submodules/obsidian-git` to the merged commit and regenerated `dist/obsidian-git/`. If the HugeRepo does not have the submodule yet, that PR adds the submodule, the update script, `dist/obsidian-git/`, and `docs/obsidian-git.md` together. Never publish `dist/` files or releases from an unmerged branch of this repository.

## Updating from upstream

Upstream changes are imported deliberately, not automatically. Because `main` does not share history with upstream, bring them in as the diff between the recorded base commit and the new upstream commit:

```bash
git fetch upstream --no-tags
git switch -c review/upstream-<version> main
git diff --binary 31621dd04cac27dad9537ea2a828f0048366da1b <new upstream commit> | git apply --3way
```

Resolve conflicts in favor of this edition's changes. Commit with a message that names both upstream commits. Review the full diff, make sure `pnpm install` still applies the isomorphic-git patch, run the validation below, rebuild and commit `main.js`, set the version to `<new upstream version>-maintained.1`, update the "Upstream base" table, and open a pull request into `main`.

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
3. `.github/workflows/releases.yml` checks that the tag equals the manifest version, builds the plugin, stops unless the build is byte-identical to the tracked `main.js`, attests the build, and publishes `main.js`, `manifest.json`, `styles.css`, and a zip of the three (`git-maintained-<tag>.zip`, with a `git-maintained/` folder).
4. Then do the HugeRepo integration PR described above.

Dependencies are upgraded deliberately, usually together with an upstream merge, so this repository has no Dependabot version-update configuration.
