import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { readdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import git from "isomorphic-git";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitActions } from "../../src/gitActions";
import { PromiseQueue } from "../../src/promiseQueue";
import { SyncSupervisor } from "../../src/syncSupervisor";
import { withCleanup } from "../helpers/cleanup";
import { createRepoWithOrigin, type TestRepo } from "../helpers/gitRepo";
import { createIsomorphicGitManager } from "../helpers/isomorphicGit";

afterEach(() => {
    vi.restoreAllMocks();
});

const INBOX = "00、手机收件箱";

async function createPhone() {
    const repo = withCleanup(await createRepoWithOrigin());
    repo.write(`${INBOX}/灵感.md`, "灵感\n");
    repo.write("elsewhere/note.md", "not for the phone to commit\n");
    const context = createIsomorphicGitManager(repo.repoPath);
    const { plugin, manager } = context;
    Object.assign(plugin.settings, {
        autoCommitGlobMode: "include",
        autoCommitGlobs: `${INBOX}/**`,
        autoCommitMessage: "vault backup",
        pullBeforePush: true,
        disablePush: false,
        weakNetworkMode: false,
        syncOnLeave: false,
        keepAwakeWhileSyncing: false,
        rescueFolder: "",
    });
    plugin.updateCachedStatus = vi.fn(() => manager.status());
    plugin.isAllInitialized = vi.fn().mockResolvedValue(true);
    plugin.tools = {
        hasTooBigFiles: vi.fn().mockResolvedValue(false),
    } as unknown as typeof plugin.tools;
    plugin.displayMessage = vi.fn();
    return { repo, ...context };
}

/** The real sync supervisor on the test plugin. */
function superviseWith(
    context: Awaited<ReturnType<typeof createPhone>>,
    settings: { weakNetworkMode?: boolean; syncOnLeave?: boolean }
) {
    const { plugin } = context;
    Object.assign(plugin.settings, settings);
    let syncLog: string | null = null;
    Object.assign(plugin, {
        gitReady: true,
        promiseQueue: new PromiseQueue(),
        addRibbonIcon: vi.fn(() => ({})),
        localStorage: {
            ...plugin.localStorage,
            getPausedAutomatics: () => false,
            getSyncLog: () => syncLog,
            setSyncLog: (value: string | null) => (syncLog = value),
        },
    });
    const gitActions = new GitActions(plugin);
    const supervisor = new SyncSupervisor(plugin);
    Object.assign(plugin, { gitActions, syncSupervisor: supervisor });
    supervisor.start();
    return { gitActions, supervisor };
}

async function pushTo(repo: TestRepo) {
    await repo.raw([
        "update-ref",
        "refs/remotes/origin/main",
        await repo.head(),
    ]);
    return { status: "pushed" as const, files: 1 };
}

describe("GitActions with the sync supervisor", () => {
    it("looks only at the include globs' folders for an automatic commit", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        superviseWith(context, { syncOnLeave: true });
        const scoped = vi.spyOn(manager, "scopedStatus");

        const result = await plugin.gitActions.commit({
            fromAuto: true,
            mode: "all",
        });

        expect(result).toEqual({
            status: "success",
            value: { status: "committed", files: 1 },
        });
        expect(scoped).toHaveBeenCalledWith([INBOX]);
        expect(plugin.updateCachedStatus).not.toHaveBeenCalled();
        await expect(repo.statusPorcelain()).resolves.toBe("?? elsewhere/");
    });

    it("walks the whole tree as before when both options are off", async () => {
        const context = await createPhone();
        const { manager, plugin } = context;
        superviseWith(context, {});
        const scoped = vi.spyOn(manager, "scopedStatus");

        await plugin.gitActions.commit({ fromAuto: true, mode: "all" });

        expect(scoped).not.toHaveBeenCalled();
        expect(plugin.updateCachedStatus).toHaveBeenCalled();
    });

    it("commits on the device and retries quietly when the network drops in weak network mode", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { supervisor } = superviseWith(context, {
            weakNetworkMode: true,
        });
        vi.spyOn(manager, "fetch").mockRejectedValue(
            new Error(
                "Request Failed. IOException unexpected end of stream on https://github.com/owner/repo.git/..."
            )
        );

        const result = await plugin.gitActions.commitAndSync({
            fromAutoBackup: true,
            mode: "all",
        });

        expect(result).toEqual({ status: "failed" });
        expect(plugin.displayError).not.toHaveBeenCalled();
        expect(await repo.headMessage()).toBe("vault backup");
        const state = supervisor.snapshot();
        expect(state).toMatchObject({
            phase: "waiting",
            ahead: 1,
            problem: { kind: "network", attempts: 1 },
        });
        expect(state.nextRetryAt! - Date.now()).toBeGreaterThan(14_000);
        expect(supervisor.entries[supervisor.entries.length - 1]?.text).toBe(
            "Auto sync failed: The connection to the Git server is unstable"
        );
        supervisor.stop();
    });

    it("pops the network error up as before without weak network mode", async () => {
        const context = await createPhone();
        const { manager, plugin } = context;
        const { supervisor } = superviseWith(context, { syncOnLeave: true });
        vi.spyOn(manager, "fetch").mockRejectedValue(
            new Error("Request Failed. UnknownHostException github.com")
        );

        await plugin.gitActions.commitAndSync({
            fromAutoBackup: true,
            mode: "all",
        });

        expect(plugin.displayError).toHaveBeenCalledTimes(1);
        expect(supervisor.snapshot().nextRetryAt).toBeUndefined();
        supervisor.stop();
    });

    it("records a whole sync in the history", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { supervisor } = superviseWith(context, {
            weakNetworkMode: true,
        });
        vi.spyOn(manager, "fetch").mockResolvedValue();
        vi.spyOn(manager, "canPush").mockResolvedValue(true);
        vi.spyOn(manager, "push").mockImplementation(() => pushTo(repo));

        const result = await plugin.gitActions.commitAndSync({
            fromAutoBackup: true,
            mode: "all",
            reason: "leave",
        });

        expect(result).toMatchObject({
            status: "success",
            value: { status: "synced" },
        });
        expect(supervisor.snapshot()).toMatchObject({
            phase: "idle",
            ahead: 0,
            problem: undefined,
        });
        expect(supervisor.snapshot().lastPushAt).toBeDefined();
        expect(supervisor.entries.map((entry) => entry.text)).toEqual([
            "Sync on leaving Obsidian: committed 1, pushed changes to 1",
        ]);
        supervisor.stop();
    });
});

describe("IsomorphicGit commitsAhead", () => {
    it("counts like git rev-list, also with merges in the history", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        // A history with a merge in it, as 2A-META has many.
        await repo.git.checkoutLocalBranch("side");
        await repo.writeAndCommit("side.md", "side\n", "side");
        await repo.git.checkout("main");
        await repo.writeAndCommit("main.md", "main\n", "main");
        await repo.raw(["merge", "--no-ff", "-m", "merge side", "side"]);
        for (let i = 0; i < 5; i++) {
            await repo.writeAndCommit(`old-${i}.md`, `${i}\n`, `old ${i}`);
        }
        const remote = await repo.head();
        await repo.raw(["update-ref", "refs/remotes/origin/main", remote]);
        const { manager } = createIsomorphicGitManager(repo.repoPath);

        await expect(manager.commitsAhead()).resolves.toBe(0);

        await repo.writeAndCommit(`${INBOX}/a.md`, "a\n", "phone 1");
        await repo.writeAndCommit(`${INBOX}/b.md`, "b\n", "phone 2");
        await expect(manager.commitsAhead()).resolves.toBe(2);

        // The remote moves on and the phone merges it.
        const local = await repo.head();
        await repo.raw(["checkout", "--quiet", "--detach", remote]);
        await repo.writeAndCommit("desk.md", "desk\n", "desk");
        const desk = await repo.head();
        await repo.raw(["checkout", "--quiet", "main"]);
        await repo.raw(["merge", "--no-ff", "-m", "merge desk", desk]);
        await repo.raw(["update-ref", "refs/remotes/origin/main", desk]);
        expect(local).not.toBe(await repo.head());

        await expect(manager.commitsAhead()).resolves.toBe(
            Number(await repo.raw(["rev-list", "--count", "origin/main..HEAD"]))
        );
        await expect(manager.commitsAhead()).resolves.toBe(3);
    }, 20_000);
});

async function attachHttpBackend(
    repo: TestRepo,
    manager: Awaited<ReturnType<typeof createPhone>>["manager"]
) {
    await repo.raw([
        "-C",
        repo.remotePath,
        "config",
        "http.receivepack",
        "true",
    ]);
    const remoteRepoDir = path.basename(repo.remotePath);
    const projectRoot = path.dirname(repo.remotePath);
    await manager.setRemote("origin", `http://127.0.0.1/${remoteRepoDir}`);

    const pushedObjectCounts: number[] = [];
    manager.network.request = (param) => {
        const { pathname, search } = new URL(param.url);
        const rawBody = param.body;
        const input =
            typeof rawBody === "string"
                ? Buffer.from(rawBody)
                : rawBody instanceof ArrayBuffer
                  ? Buffer.from(rawBody)
                  : rawBody
                    ? Buffer.from(rawBody)
                    : Buffer.alloc(0);
        if (
            (param.method ?? "GET") === "POST" &&
            pathname.endsWith("/git-receive-pack")
        ) {
            const packIdx = input.indexOf("PACK");
            pushedObjectCounts.push(
                packIdx >= 0 ? input.readUInt32BE(packIdx + 8) : 0
            );
        }
        const contentType =
            Object.entries(param.headers ?? {}).find(
                ([k]) => k.toLowerCase() === "content-type"
            )?.[1] ?? "";
        const res = spawnSync("git", ["http-backend"], {
            input,
            maxBuffer: 1 << 30,
            env: {
                PATH: process.env.PATH,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: "1",
                PATH_INFO: pathname,
                QUERY_STRING: search.replace(/^\?/, ""),
                REQUEST_METHOD: param.method ?? "GET",
                CONTENT_TYPE: contentType,
                CONTENT_LENGTH: String(input.length),
                REMOTE_USER: "test",
                REMOTE_ADDR: "127.0.0.1",
            },
        });
        if (res.error) return Promise.reject(res.error);
        const out = res.stdout;
        let sep = out.indexOf("\r\n\r\n");
        let skip = 4;
        if (sep < 0) {
            sep = out.indexOf("\n\n");
            skip = 2;
        }
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of out
            .subarray(0, sep)
            .toString("latin1")
            .split(/\r?\n/)) {
            const colon = line.indexOf(":");
            if (colon < 0) continue;
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            if (key === "status") {
                status = parseInt(val, 10);
            } else {
                headers[key] = val;
            }
        }
        const bodySlice = out.subarray(sep + skip);
        return Promise.resolve({
            status,
            headers,
            arrayBuffer: bodySlice.buffer.slice(
                bodySlice.byteOffset,
                bodySlice.byteOffset + bodySlice.byteLength
            ),
        });
    };
    return { pushedObjectCounts };
}

async function createDesktopClone(remotePath: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "obsidian-git-desk-"));
    withCleanup({
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    });
    await simpleGit(dir).clone(remotePath, dir);
    const desk = simpleGit({ baseDir: dir });
    await desk.addConfig("user.email", "desk@example.com");
    await desk.addConfig("user.name", "Desk");
    return { dir, git: desk };
}

async function collectFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(rel: string) {
        const abs = rel ? path.join(root, rel) : root;
        const entries = await readdir(abs, { withFileTypes: true }).catch(
            () => []
        );
        for (const entry of entries) {
            const next = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(next);
            } else if (entry.isFile()) {
                out.push(next);
            }
        }
    }
    await walk("");
    return out;
}

describe("IsomorphicGit + GitActions end-to-end conflict recovery and branch maintenance", () => {
    it("auto-rescues conflicts into rescueFolder, commits copies, and pushes stacked commits via smart HTTP without alternation", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { gitActions } = superviseWith(context, {
            weakNetworkMode: true,
            syncOnLeave: true,
        });
        plugin.settings.rescueFolder = `${INBOX}/_冲突备份`;
        plugin.settings.commitMessage = "vault backup";
        plugin.settings.autoStageOnEmptyIndex = true;
        (
            plugin as unknown as { handleConflict: ReturnType<typeof vi.fn> }
        ).handleConflict = vi.fn();

        for (let i = 0; i < 20; i++) {
            await repo.writeAndCommit(
                `history/note-${i}.md`,
                `history ${i}\n${"x".repeat(120)}\n`,
                `history ${i}`
            );
        }
        await repo.writeAndCommit(
            `${INBOX}/shared.md`,
            "base shared\n",
            "add shared"
        );
        await repo.git.push(["--quiet", "origin", "main"]);

        // Desktop advances origin/main on the same file.
        const desk = await createDesktopClone(repo.remotePath);
        await repo.git.raw([
            "-C",
            desk.dir,
            "commit",
            "--allow-empty",
            "-m",
            "noop check",
        ]);
        await writeFile(
            path.join(desk.dir, `${INBOX}/shared.md`),
            "desktop authoritative version\n"
        );
        await desk.git.add(`${INBOX}/shared.md`);
        await desk.git.commit("desktop shared update");
        await desk.git.push("origin", "main");

        // Phone stacks 5 unpushed commits.
        await repo.writeAndCommit(
            `${INBOX}/shared.md`,
            "phone conflicting draft\n",
            "phone shared update"
        );
        for (let i = 1; i <= 4; i++) {
            await repo.writeAndCommit(
                `${INBOX}/stacked-${i}.md`,
                `stacked ${i}\n`,
                `phone stacked ${i}`
            );
        }
        await expect(manager.commitsAhead()).resolves.toBe(5);

        const { pushedObjectCounts } = await attachHttpBackend(repo, manager);

        const syncRes = await gitActions.commitAndSync({
            fromAutoBackup: true,
            mode: "all",
            reason: "leave",
        });

        expect(syncRes.status).toBe("success");
        expect(await manager.isMergeInProgress()).toBe(false);
        expect(await manager.commitsAhead()).toBe(0);
        expect(pushedObjectCounts.length).toBe(1);
        expect(pushedObjectCounts[0]!).toBeLessThan(40);

        const remoteHead = await repo.raw([
            "-C",
            repo.remotePath,
            "rev-parse",
            "main",
        ]);
        expect(remoteHead).toBe(await repo.head());
        await repo.raw(["-C", repo.remotePath, "fsck", "--no-dangling"]);

        const worktreeContent = await readFile(
            path.join(repo.repoPath, `${INBOX}/shared.md`),
            "utf8"
        );
        expect(worktreeContent).toBe("desktop authoritative version\n");

        const rescueFiles = await collectFiles(
            path.join(repo.repoPath, `${INBOX}/_冲突备份`)
        );
        expect(rescueFiles).toHaveLength(1);
        const rescuedText = await readFile(
            path.join(repo.repoPath, `${INBOX}/_冲突备份/${rescueFiles[0]}`),
            "utf8"
        );
        expect(rescuedText).toBe("phone conflicting draft\n");

        const remoteFiles = await repo.raw([
            "-C",
            repo.remotePath,
            "ls-tree",
            "-r",
            "--name-only",
            "main",
        ]);
        expect(remoteFiles).toContain(`${INBOX}/_冲突备份/${rescueFiles[0]}`);
        expect(rescueFiles.some((f) => f.includes("elsewhere"))).toBe(false);

        // Immediate follow-up auto sync does not sweep outside-scope dirty notes or oscillate.
        const secondAutoSync = await gitActions.commitAndSync({
            fromAutoBackup: true,
            mode: "all",
            reason: "auto",
        });
        expect(secondAutoSync).toMatchObject({
            status: "success",
            value: { status: "nothing-to-push" },
        });

        // Manual sync commits the remaining out-of-scope note once, then settles cleanly.
        const manualSync = await gitActions.commitAndSync({
            fromAutoBackup: false,
            mode: "all",
            reason: "manual",
        });
        expect(manualSync).toMatchObject({
            status: "success",
            value: { status: "synced" },
        });
        const manualFollowUp = await gitActions.commitAndSync({
            fromAutoBackup: false,
            mode: "all",
            reason: "manual",
        });
        expect(manualFollowUp).toMatchObject({
            status: "success",
            value: { status: "nothing-to-push" },
        });
    }, 20_000);

    it("supports manual conflict resolution by editing out markers or deleting conflicted files, while blocking remaining markers", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { gitActions } = superviseWith(context, {
            weakNetworkMode: true,
        });
        plugin.settings.rescueFolder = "";
        plugin.settings.commitMessage = "manual resolve";
        plugin.settings.autoStageOnEmptyIndex = true;
        const handleConflict = vi.fn();
        (
            plugin as unknown as { handleConflict: typeof handleConflict }
        ).handleConflict = handleConflict;

        await repo.writeAndCommit(
            `${INBOX}/edit-resolve.md`,
            "base 1\n",
            "base 1"
        );
        await repo.writeAndCommit(
            `${INBOX}/delete-resolve.md`,
            "base 2\n",
            "base 2"
        );
        await repo.git.push(["--quiet", "origin", "main"]);

        const desk = await createDesktopClone(repo.remotePath);
        await writeFile(
            path.join(desk.dir, `${INBOX}/edit-resolve.md`),
            "remote 1\n"
        );
        await writeFile(
            path.join(desk.dir, `${INBOX}/delete-resolve.md`),
            "remote 2\n"
        );
        await desk.git.add(".");
        await desk.git.commit("remote diverge");
        await desk.git.push("origin", "main");

        // Stack 5 local commits on phone including both conflicted files.
        await repo.writeAndCommit(
            `${INBOX}/edit-resolve.md`,
            "phone 1\n",
            "phone 1"
        );
        await repo.writeAndCommit(
            `${INBOX}/delete-resolve.md`,
            "phone 2\n",
            "phone 2"
        );
        for (let i = 1; i <= 3; i++) {
            await repo.writeAndCommit(
                `${INBOX}/extra-${i}.md`,
                `extra ${i}\n`,
                `extra ${i}`
            );
        }
        await expect(manager.commitsAhead()).resolves.toBe(5);

        await attachHttpBackend(repo, manager);

        // Initial pull produces on-disk conflict markers and MERGE_HEAD.
        const initialPull = await gitActions.pull();
        expect(initialPull.status).toBe("failed");
        expect(await manager.isMergeInProgress()).toBe(true);
        expect((await manager.status()).conflicted).toEqual([
            `${INBOX}/delete-resolve.md`,
            `${INBOX}/edit-resolve.md`,
        ]);

        // Delete one conflicted file, leave markers in the other -> blocked on remaining markers only.
        repo.remove(`${INBOX}/delete-resolve.md`);
        handleConflict.mockClear();
        const partialSync = await gitActions.commitAndSync({
            fromAutoBackup: false,
            mode: "all",
            reason: "manual",
        });
        expect(partialSync.status).toBe("failed");
        expect(handleConflict).toHaveBeenCalledWith([
            `${INBOX}/edit-resolve.md`,
        ]);
        expect(await manager.isMergeInProgress()).toBe(true);

        // Now resolve the remaining file cleanly and tap Sync now (fromAutoBackup: false).
        repo.write(`${INBOX}/edit-resolve.md`, "manually merged 1\n");
        const resolvedSync = await gitActions.commitAndSync({
            fromAutoBackup: false,
            mode: "all",
            reason: "manual",
        });

        expect(resolvedSync).toMatchObject({
            status: "success",
            value: { status: "synced" },
        });
        expect(await manager.isMergeInProgress()).toBe(false);
        expect(await manager.commitsAhead()).toBe(0);

        const remoteHead = await repo.raw([
            "-C",
            repo.remotePath,
            "rev-parse",
            "main",
        ]);
        expect(remoteHead).toBe(await repo.head());
        const parents = (
            await repo.raw(["rev-list", "--parents", "-n", "1", "HEAD"])
        )
            .trim()
            .split(/\s+/);
        expect(parents.slice(1)).toHaveLength(2);
    }, 20_000);

    it("rescueConflictsAndSync extracts pre-conflict version from active merge markers and recovers cleanly", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { gitActions } = superviseWith(context, {
            weakNetworkMode: true,
        });
        plugin.settings.rescueFolder = "";
        plugin.settings.commitMessage = "vault backup";
        plugin.settings.autoStageOnEmptyIndex = true;
        (
            plugin as unknown as { handleConflict: ReturnType<typeof vi.fn> }
        ).handleConflict = vi.fn();

        await repo.writeAndCommit(`${INBOX}/note.md`, "base\n", "base");
        await repo.git.push(["--quiet", "origin", "main"]);

        const desk = await createDesktopClone(repo.remotePath);
        await writeFile(path.join(desk.dir, `${INBOX}/note.md`), "remote\n");
        await desk.git.add(`${INBOX}/note.md`);
        await desk.git.commit("remote update");
        await desk.git.push("origin", "main");

        await repo.writeAndCommit(
            `${INBOX}/note.md`,
            "phone pre-conflict\n",
            "phone update"
        );
        await attachHttpBackend(repo, manager);

        await gitActions.pull();
        expect(await manager.isMergeInProgress()).toBe(true);
        const diskWithMarkers = await readFile(
            path.join(repo.repoPath, `${INBOX}/note.md`),
            "utf8"
        );
        expect(diskWithMarkers).toContain("<<<<<<<");

        plugin.settings.rescueFolder = `${INBOX}/_冲突备份`;
        const recovery = await gitActions.rescueConflictsAndSync();
        expect(recovery.status).toBe("success");
        expect(await manager.isMergeInProgress()).toBe(false);
        expect(
            await readFile(path.join(repo.repoPath, `${INBOX}/note.md`), "utf8")
        ).toBe("remote\n");

        const rescueFiles = await collectFiles(
            path.join(repo.repoPath, `${INBOX}/_冲突备份`)
        );
        expect(rescueFiles).toHaveLength(1);
        const rescued = await readFile(
            path.join(repo.repoPath, `${INBOX}/_冲突备份/${rescueFiles[0]}`),
            "utf8"
        );
        expect(rescued).toBe("phone pre-conflict\n");
        expect(rescued).not.toContain("<<<<<<<");
    }, 20_000);

    it("rescueConflictsAndSync recovers when rescueFolder setting is empty and autoCommitGlobs excludes _冲突备份", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { gitActions, supervisor } = superviseWith(context, {
            weakNetworkMode: true,
        });
        const recoverySpy = vi.spyOn(supervisor, "recordPullRecovery");
        plugin.settings.rescueFolder = "";
        plugin.settings.commitMessage = "vault backup";
        plugin.settings.autoCommitGlobs = INBOX;
        plugin.settings.autoCommitGlobMode = "include";
        plugin.settings.manualCommitUsesAutoCommitGlobs = true;
        plugin.settings.autoStageOnEmptyIndex = true;
        (
            plugin as unknown as { handleConflict: ReturnType<typeof vi.fn> }
        ).handleConflict = vi.fn();

        await repo.writeAndCommit(`${INBOX}/note.md`, "base\n", "base");
        await repo.git.push(["--quiet", "origin", "main"]);

        const desk = await createDesktopClone(repo.remotePath);
        await writeFile(path.join(desk.dir, `${INBOX}/note.md`), "remote\n");
        await desk.git.add(`${INBOX}/note.md`);
        await desk.git.commit("remote update");
        await desk.git.push("origin", "main");

        repo.write(`${INBOX}/note.md`, "phone pre-conflict\n");
        await attachHttpBackend(repo, manager);

        await gitActions.commitAndSync({
            fromAutoBackup: false,
            mode: "all",
            reason: "manual",
        });
        expect(await manager.isMergeInProgress()).toBe(true);
        recoverySpy.mockClear();

        const recovery = await gitActions.rescueConflictsAndSync();
        expect(recovery).toMatchObject({
            status: "success",
            value: { status: "synced" },
        });
        expect(recoverySpy).not.toHaveBeenCalled();
        expect(plugin.settings.rescueFolder).toBe("");
        expect(await manager.isMergeInProgress()).toBe(false);
        expect(
            await readFile(path.join(repo.repoPath, `${INBOX}/note.md`), "utf8")
        ).toBe("remote\n");

        const rescueFiles = await collectFiles(
            path.join(repo.repoPath, "_冲突备份")
        );
        expect(rescueFiles).toHaveLength(1);
        const rescued = await readFile(
            path.join(repo.repoPath, `_冲突备份/${rescueFiles[0]}`),
            "utf8"
        );
        expect(rescued).toBe("phone pre-conflict\n");
        expect(rescued).not.toContain("<<<<<<<");

        await desk.git.pull("origin", "main");
        const deskRescued = await readFile(
            path.join(desk.dir, `_冲突备份/${rescueFiles[0]}`),
            "utf8"
        );
        expect(deskRescued).toBe("phone pre-conflict\n");
        const parentsLog = (
            await repo.raw(["rev-list", "--parents", "-n", "3", "HEAD"])
        )
            .trim()
            .split("\n");
        expect(
            parentsLog.some((line) => line.trim().split(/\s+/).length >= 3)
        ).toBe(true);
    }, 20_000);

    it("discardAll aborts active merges, unstages newly added files, and resets worktree edits", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { gitActions } = superviseWith(context, {});
        plugin.settings.rescueFolder = "";
        (
            plugin as unknown as { handleConflict: ReturnType<typeof vi.fn> }
        ).handleConflict = vi.fn();

        await repo.writeAndCommit(`${INBOX}/c.md`, "base\n", "base");
        await repo.git.push(["--quiet", "origin", "main"]);

        const desk = await createDesktopClone(repo.remotePath);
        await writeFile(path.join(desk.dir, `${INBOX}/c.md`), "remote\n");
        await desk.git.add(`${INBOX}/c.md`);
        await desk.git.commit("remote");
        await desk.git.push("origin", "main");

        await repo.writeAndCommit(`${INBOX}/c.md`, "phone\n", "phone");
        await attachHttpBackend(repo, manager);
        await gitActions.pull();
        expect(await manager.isMergeInProgress()).toBe(true);

        repo.write(`${INBOX}/newly-staged.md`, "staged brand new\n");
        await manager.stage(`${INBOX}/newly-staged.md`, false);

        await manager.discardAll({});

        expect(await manager.isMergeInProgress()).toBe(false);
        expect((await manager.status()).conflicted).toEqual([]);
        expect(
            await readFile(path.join(repo.repoPath, `${INBOX}/c.md`), "utf8")
        ).toBe("phone\n");
        const statusAfter = await manager.status();
        expect(statusAfter.staged).toEqual([]);
    }, 20_000);

    it("updateUpstreamBranch attaches existing remote ref without pushing and fetch prunes deleted remote branches", async () => {
        const context = await createPhone();
        const { manager, repo } = context;
        await attachHttpBackend(repo, manager);

        // Push a temporary remote branch, fetch it on phone, then delete remotely.
        const desk = await createDesktopClone(repo.remotePath);
        await desk.git.checkoutLocalBranch("feature/stale");
        await writeFile(path.join(desk.dir, "feature.md"), "feature\n");
        await desk.git.add("feature.md");
        await desk.git.commit("feature commit");
        await desk.git.push("origin", "feature/stale");

        await manager.fetch("origin");
        expect(await manager.getRemoteBranches("origin")).toContain(
            "origin/feature/stale"
        );

        // Delete remote branch and verify fetch prunes the stale remote tracking ref.
        await repo.raw([
            "-C",
            repo.remotePath,
            "branch",
            "-D",
            "feature/stale",
        ]);
        await manager.fetch("origin");
        expect(await manager.getRemoteBranches("origin")).not.toContain(
            "origin/feature/stale"
        );

        // Unset local upstream config and re-attach without invoking git.push.
        await repo.raw(["config", "--unset", "branch.main.remote"]);
        await repo.raw(["config", "--unset", "branch.main.merge"]);
        const pushSpy = vi.spyOn(git, "push");
        await manager.updateUpstreamBranch("origin/main");

        expect(pushSpy).not.toHaveBeenCalled();
        expect((await manager.branchInfo()).tracking).toBe("origin/main");
    }, 20_000);

    it("diff3/onp runs cleanly under strict mode without ReferenceError (AME-1406)", async () => {
        const { runInThisContext } = await import("node:vm");
        const loadStrictCjs = async (
            relPath: string,
            customRequire: (id: string) => unknown
        ): Promise<unknown> => {
            const source = await readFile(path.resolve(relPath), "utf8");
            const mod: { exports: unknown } = { exports: {} };
            const factory = runInThisContext(
                `(function(module, exports, require) {\n"use strict";\n${source}\n})`,
                { filename: relPath }
            ) as (
                moduleObj: { exports: unknown },
                exportsObj: unknown,
                req: (id: string) => unknown
            ) => void;
            factory(mod, mod.exports, customRequire);
            return mod.exports;
        };

        const onp = await loadStrictCjs("node_modules/diff3/onp.js", () => {
            throw new Error("unexpected require in onp.js");
        });
        const diff3Merge = (await loadStrictCjs(
            "node_modules/diff3/diff3.js",
            (id) => {
                if (id.includes("onp")) {
                    return onp;
                }
                throw new Error(`unexpected require in diff3.js: ${id}`);
            }
        )) as (
            a: string[],
            o: string[],
            b: string[]
        ) => Array<{
            ok?: string[];
            conflict?: { a: string[]; o: string[]; b: string[] };
        }>;

        const chunks = diff3Merge(["phone\n"], ["base\n"], ["desktop\n"]);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.conflict?.a).toEqual(["phone\n"]);
        expect(chunks[0]?.conflict?.o).toEqual(["base\n"]);
        expect(chunks[0]?.conflict?.b).toEqual(["desktop\n"]);
    });

    it("suppresses Vault write echoes when rescueFolder is inside autoCommitGlobs so phase finishes idle (AME-1406)", async () => {
        const context = await createPhone();
        const { manager, plugin, repo } = context;
        const { gitActions, supervisor } = superviseWith(context, {
            weakNetworkMode: true,
        });
        plugin.settings.rescueFolder = `${INBOX}/_冲突备份`;
        plugin.settings.commitMessage = "vault backup";
        plugin.settings.autoCommitGlobs = INBOX;
        plugin.settings.autoCommitGlobMode = "include";
        plugin.settings.manualCommitUsesAutoCommitGlobs = true;
        plugin.settings.autoStageOnEmptyIndex = true;

        await repo.writeAndCommit(`${INBOX}/echo-note.md`, "base\n", "base");
        await repo.git.push(["--quiet", "origin", "main"]);

        const desk = await createDesktopClone(repo.remotePath);
        await writeFile(
            path.join(desk.dir, `${INBOX}/echo-note.md`),
            "remote\n"
        );
        await desk.git.add(`${INBOX}/echo-note.md`);
        await desk.git.commit("remote update");
        await desk.git.push("origin", "main");

        // Hook vault.createBinary / adapter.writeBinary to simulate Obsidian's Vault create events.
        const vaultObj = plugin.app.vault as unknown as {
            createBinary: (
                vaultPath: string,
                data: ArrayBuffer
            ) => Promise<void>;
        };
        const origCreateBinary = vaultObj.createBinary.bind(vaultObj);
        vaultObj.createBinary = async (
            vaultPath: string,
            data: ArrayBuffer
        ) => {
            await origCreateBinary(vaultPath, data);
            if (!vaultPath.startsWith(".git")) {
                supervisor.noteVaultChange(vaultPath);
            }
        };

        repo.write(`${INBOX}/echo-note.md`, "phone edit\n");
        supervisor.noteVaultChange(`${INBOX}/echo-note.md`);
        await attachHttpBackend(repo, manager);

        const res = await gitActions.commitAndSync({
            fromAutoBackup: false,
            mode: "all",
            reason: "manual",
        });

        expect(res).toMatchObject({
            status: "success",
            value: { status: "synced" },
        });
        expect(supervisor.snapshot().pendingEdits).toBe(false);
        expect(supervisor.snapshot().ahead).toBe(0);
        expect(supervisor.snapshot().phase).toBe("idle");
        const rescueFiles = await collectFiles(
            path.join(repo.repoPath, `${INBOX}/_冲突备份`)
        );
        expect(rescueFiles).toHaveLength(1);
    }, 20_000);
});
