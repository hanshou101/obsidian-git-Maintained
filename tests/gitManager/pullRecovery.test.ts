import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitActions } from "../../src/gitActions";
import type { PullRecovery } from "../../src/gitManager/gitManager";
import { withCleanup } from "../helpers/cleanup";
import { createRepoWithOrigin, type TestRepo } from "../helpers/gitRepo";
import { createIsomorphicGitManager } from "../helpers/isomorphicGit";

afterEach(() => {
    vi.restoreAllMocks();
});

// The five files of the error on the phone (AME-1119), and three files the
// same pull added.
const ROOT = "AI-First时代，知识库（toAI完全公开）/比赛各种比赛，用AI打比赛";
const MODIFIED = [
    `${ROOT}/.frac.md`,
    `${ROOT}/03、方法论：怎么打AI比赛.md`,
    `${ROOT}/12、清台作战/.frac.md`,
    `${ROOT}/12、清台作战/00、作战总纲.md`,
    `${ROOT}/12、清台作战/02、审美闸：UI 标准、风格菜单与把关.md`,
];
const ADDED = [
    `${ROOT}/12、清台作战/03、新增一.md`,
    `${ROOT}/12、清台作战/04、新增二.md`,
    `${ROOT}/13、新专题/00、总纲.md`,
];
const INBOX = "00、手机收件箱";
const PHONE_NOTE = `${INBOX}/手机上写的.md`;
const JOURNAL = ".git/git-maintained-pull.json";

const remoteContent = (file: string) => `${file}: remote\n`;

interface Phone {
    repo: TestRepo;
    /** The commit the phone was on before the pull. */
    local: string;
    /** What GitHub has. */
    remote: string;
}

/**
 * The phone has a commit of its own on top of `base`; the remote has two
 * commits that change MODIFIED and add ADDED.
 */
async function createPhone({ newer = false } = {}): Promise<Phone> {
    const repo = withCleanup(await createRepoWithOrigin());
    for (const file of MODIFIED) repo.write(file, `${file}: base\n`);
    await repo.git.add(".");
    await repo.git.commit("notes");
    const base = await repo.head();

    for (const file of [...MODIFIED.slice(0, 3), ADDED[0]!]) {
        repo.write(file, remoteContent(file));
    }
    await repo.git.add(".");
    await repo.git.commit("remote 1");
    for (const file of [...MODIFIED.slice(3), ...ADDED.slice(1)]) {
        repo.write(file, remoteContent(file));
    }
    await repo.git.add(".");
    await repo.git.commit("remote 2");
    if (newer) {
        // GitHub moved on after the pull that was cut off.
        await repo.writeAndCommit(MODIFIED[0]!, "newer\n", "remote 3");
    }
    const remote = await repo.head();
    await repo.raw(["update-ref", "refs/remotes/origin/main", remote]);

    await repo.raw(["reset", "--hard", base]);
    await repo.writeAndCommit(PHONE_NOTE, "灵感\n", "phone note");
    return { repo, local: await repo.head(), remote };
}

function phoneManager(repo: TestRepo, rescueFolder = "") {
    const context = createIsomorphicGitManager(repo.repoPath);
    const recoveries: PullRecovery[] = [];
    context.plugin.settings.rescueFolder = rescueFolder;
    (context.plugin as unknown as { syncSupervisor: unknown }).syncSupervisor =
        {
            recordPullRecovery: (recovery: PullRecovery) =>
                recoveries.push(recovery),
            expectWrites: vi.fn(),
        };
    vi.spyOn(context.manager, "fetch").mockResolvedValue();
    return { ...context, recoveries };
}

const read = (repo: TestRepo, file: string) =>
    readFile(path.join(repo.repoPath, file), "utf8");

const exists = (repo: TestRepo, file: string) =>
    stat(path.join(repo.repoPath, file)).then(
        () => true,
        () => false
    );

async function expectPulled(repo: TestRepo, remote: string, local: string) {
    const parents = (
        await repo.raw(["rev-list", "--parents", "-n", "1", "HEAD"])
    ).split(" ");
    expect(parents.slice(1).sort()).toEqual([local, remote].sort());
    for (const file of [...MODIFIED, ...ADDED]) {
        await expect(read(repo, file)).resolves.toBe(remoteContent(file));
    }
    await expect(read(repo, PHONE_NOTE)).resolves.toBe("灵感\n");
}

describe("IsomorphicGit after a pull that was cut off (AME-1119)", () => {
    it("heals the state the phone was stuck in and pulls", async () => {
        const { repo, local, remote } = await createPhone();
        // A pull stopped half-way in checkout: the first five files of
        // the incoming commits written, the added files not yet, the index
        // and the branch still old. Every pull since stopped on them.
        for (const file of MODIFIED) repo.write(file, remoteContent(file));
        const { manager, recoveries } = phoneManager(repo);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
        });

        await expectPulled(repo, remote, local);
        await expect(repo.statusPorcelain()).resolves.toBe("");
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]!.restored.sort()).toEqual([...MODIFIED].sort());
        expect(recoveries[0]!.rescued).toEqual([]);
    });

    it("also heals a file left with an older version of the incoming history", async () => {
        const { repo } = await createPhone({ newer: true });
        // What the pull that was cut off wrote; GitHub changed it since.
        repo.write(MODIFIED[0]!, remoteContent(MODIFIED[0]!));
        const { manager, recoveries } = phoneManager(repo);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
        });

        await expect(read(repo, MODIFIED[0]!)).resolves.toBe("newer\n");
        await expect(repo.statusPorcelain()).resolves.toBe("");
        expect(recoveries[0]!.restored).toEqual([MODIFIED[0]]);
    });

    it("finishes a pull that was killed while writing files", async () => {
        const { repo, local, remote } = await createPhone();
        const { manager, recoveries } = phoneManager(repo);
        vi.spyOn(git, "checkout").mockImplementationOnce(() => {
            repo.write(MODIFIED[0]!, remoteContent(MODIFIED[0]!));
            repo.write(MODIFIED[1]!, remoteContent(MODIFIED[1]!));
            return Promise.reject(new Error("Obsidian was killed"));
        });

        await expect(manager.pull()).rejects.toThrow("Obsidian was killed");
        expect(await repo.head()).toBe(local);
        expect(await exists(repo, JOURNAL)).toBe(true);

        // The next pull finishes the one that was cut off first.
        await expect(manager.pull()).resolves.toEqual({
            status: "up-to-date",
        });
        await expectPulled(repo, remote, local);
        await expect(repo.statusPorcelain()).resolves.toBe("");
        expect(await exists(repo, JOURNAL)).toBe(false);
        expect(recoveries).toEqual([
            {
                resumed: true,
                files: MODIFIED.length + ADDED.length,
                // The two files the killed checkout had written.
                restored: MODIFIED.slice(0, 2),
                rescued: [],
            },
        ]);
    });

    it("does not commit the half-written files of a killed pull", async () => {
        const { repo, local, remote } = await createPhone();
        const { manager, plugin } = phoneManager(repo);
        vi.spyOn(git, "checkout").mockImplementationOnce(() => {
            repo.write(MODIFIED[0]!, remoteContent(MODIFIED[0]!));
            return Promise.reject(new Error("Obsidian was killed"));
        });
        await expect(manager.pull()).rejects.toThrow("Obsidian was killed");
        repo.write(`${INBOX}/又一条.md`, "又一条\n");
        // GitActions without the sync supervisor, as on desktop tests.
        Reflect.deleteProperty(plugin, "syncSupervisor");
        Object.assign(plugin.settings, {
            autoCommitGlobMode: "exclude",
            autoCommitGlobs: "",
            autoCommitMessage: "vault backup",
        });
        plugin.updateCachedStatus = vi.fn(() => manager.status());
        plugin.isAllInitialized = vi.fn().mockResolvedValue(true);
        plugin.tools = {
            hasTooBigFiles: vi.fn().mockResolvedValue(false),
        } as unknown as typeof plugin.tools;
        plugin.displayMessage = vi.fn();

        const result = await new GitActions(plugin).commit({
            fromAuto: true,
            mode: "all",
        });

        expect(result).toEqual({
            status: "success",
            value: { status: "committed", files: 1 },
        });
        // The pull was finished first; the commit holds only the new note.
        const parents = (
            await repo.raw(["rev-list", "--parents", "-n", "1", "HEAD^"])
        ).split(" ");
        expect(parents.slice(1).sort()).toEqual([local, remote].sort());
        expect(await repo.raw(["diff", "--name-only", "HEAD^", "HEAD"])).toBe(
            `${INBOX}/又一条.md`
        );
        await expect(repo.statusPorcelain()).resolves.toBe("");
    });
});

describe("IsomorphicGit with local changes in the way of a pull", () => {
    it("still stops on an unknown local edit without a rescue folder", async () => {
        const { repo, local } = await createPhone();
        for (const file of MODIFIED.slice(1)) {
            repo.write(file, remoteContent(file));
        }
        repo.write(MODIFIED[0]!, "手机上改的\n");
        const { manager } = phoneManager(repo);

        await expect(manager.pull()).rejects.toThrow(
            `Cannot pull with uncommitted working tree changes: ${MODIFIED[0]}`
        );
        expect(await repo.head()).toBe(local);
        await expect(read(repo, MODIFIED[0]!)).resolves.toBe("手机上改的\n");
    });

    it("copies an unknown local edit into the rescue folder and pulls", async () => {
        const { repo, local, remote } = await createPhone();
        repo.write(MODIFIED[0]!, "手机上改的\n");
        const rescue = `${INBOX}/_冲突备份`;
        const { manager, recoveries } = phoneManager(repo, rescue);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
        });

        await expectPulled(repo, remote, local);
        const [stamp, ...others] = await readdir(
            path.join(repo.repoPath, rescue)
        );
        expect(others).toEqual([]);
        expect(stamp).toMatch(/^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d$/);
        const copy = `${rescue}/${stamp}/${MODIFIED[0]}`;
        await expect(read(repo, copy)).resolves.toBe("手机上改的\n");
        expect(recoveries[0]!.rescued).toEqual([{ path: MODIFIED[0], copy }]);
        // The copy is a new file the next commit picks up.
        await expect(repo.statusPorcelain()).resolves.toBe(`?? ${rescue}/`);
    });

    it("puts back a file deleted on the phone that the pull changes", async () => {
        const { repo, local, remote } = await createPhone();
        repo.remove(MODIFIED[3]!);
        const { manager, recoveries } = phoneManager(repo, `${INBOX}/_rescued`);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
        });

        await expectPulled(repo, remote, local);
        expect(recoveries[0]!.rescued).toEqual([
            { path: MODIFIED[3], copy: "" },
        ]);
    });

    it("lets an untracked file identical to an incoming one through", async () => {
        const { repo, local, remote } = await createPhone();
        repo.write(ADDED[0]!, remoteContent(ADDED[0]!));
        const { manager, recoveries } = phoneManager(repo);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
        });

        await expectPulled(repo, remote, local);
        expect(recoveries[0]!.restored).toEqual([ADDED[0]]);
    });

    it("still stops on a different untracked file without a rescue folder", async () => {
        const { repo, local } = await createPhone();
        repo.write(ADDED[0]!, "手机上新建的\n");
        const { manager } = phoneManager(repo);

        await expect(manager.pull()).rejects.toThrow(
            `Cannot pull because an untracked file would be overwritten: ${ADDED[0]}`
        );
        expect(await repo.head()).toBe(local);
        await expect(read(repo, ADDED[0]!)).resolves.toBe("手机上新建的\n");
    });
});
