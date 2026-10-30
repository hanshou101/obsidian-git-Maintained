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
    });
});
