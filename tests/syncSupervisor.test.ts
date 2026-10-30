import { Platform } from "obsidian";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from "vitest";
import { NetworkUnavailableError } from "../src/gitManager/networkPolicy";
import type ObsidianGit from "../src/main";
import { PromiseQueue } from "../src/promiseQueue";
import {
    KEEP_AWAKE_MAX_MS,
    OFFLINE_FALLBACK_MS,
    RETRY_DELAYS_MS,
    SyncSupervisor,
    type SyncReason,
} from "../src/syncSupervisor";
import { GitConflictError, type ObsidianGitSettings } from "../src/types";

const notices = vi.hoisted(
    () => [] as { message: string; timeout: number | undefined }[]
);

vi.mock("obsidian", async (importOriginal) => {
    const actual = await importOriginal<typeof import("obsidian")>();
    class Notice extends actual.Notice {
        constructor(message: string | DocumentFragment, timeout?: number) {
            super(message, timeout);
            notices.push({
                message:
                    typeof message === "string"
                        ? message
                        : (message.textContent ?? ""),
                timeout,
            });
        }
    }
    return { ...actual, Notice };
});

const INBOX = "00、手机收件箱";
const dropped = () =>
    new Error("Request Failed. IOException unexpected end of stream");

type Handlers = Record<string, () => void>;
type CommitAndSyncCall = {
    fromAutoBackup: boolean;
    mode?: string;
    reason?: SyncReason;
};
type CommitAndSyncMock = Mock<(options: CommitAndSyncCall) => Promise<unknown>>;

const succeeding = (): CommitAndSyncMock =>
    vi.fn(() => Promise.resolve({ status: "success" }));

function createPlugin(settings: Partial<ObsidianGitSettings> = {}) {
    const storage: { syncLog: string | null } = { syncLog: null };
    const handlers: Handlers = {};
    const commitsAhead = vi.fn(() => Promise.resolve<number | undefined>(0));
    const cancel = vi.fn();
    const plugin = {
        gitReady: true,
        manifest: { name: "Git (Maintained)", version: "test" },
        settings: {
            weakNetworkMode: false,
            syncOnLeave: false,
            keepAwakeWhileSyncing: false,
            autoCommitGlobMode: "include",
            autoCommitGlobs: `${INBOX}/**`,
            rescueFolder: "",
            ...settings,
        },
        promiseQueue: new PromiseQueue(),
        gitManager: {
            commitsAhead,
            getRelativeRepoPath: (path: string) => path,
            getRelativeVaultPath: (path: string) => path,
        },
        gitActions: { commitAndSync: succeeding() },
        localStorage: {
            getPausedAutomatics: vi.fn(() => false),
            getSyncLog: () => storage.syncLog,
            setSyncLog: (value: string | null) => (storage.syncLog = value),
        },
        autoCommitDebouncer: { cancel },
        addRibbonIcon: vi.fn(() => ({})),
        registerDomEvent: (
            _target: unknown,
            type: string,
            callback: () => void
        ) => {
            handlers[type] = callback;
        },
        register: vi.fn(),
        app: { workspace: { getLeavesOfType: () => [] } },
    };
    return {
        plugin: plugin as unknown as ObsidianGit,
        raw: plugin,
        storage,
        handlers,
        commitsAhead,
        cancel,
    };
}

/** Lets the promise queue run what was queued, and what that queued. */
async function settle(plugin: ObsidianGit) {
    for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) =>
            plugin.promiseQueue.addTask(() => Promise.resolve(), resolve)
        );
    }
}

/** A commit-and-sync that fails with `error`, as GitActions would run it. */
function failingSync(
    supervisor: SyncSupervisor,
    error: () => unknown
): CommitAndSyncMock {
    return vi.fn(async ({ fromAutoBackup, reason }: CommitAndSyncCall) => {
        supervisor.syncStarted(fromAutoBackup, reason);
        supervisor.observeError(error());
        await supervisor.syncFinished({ status: "failed" });
        return { status: "failed" };
    });
}

async function succeedOnce(supervisor: SyncSupervisor) {
    supervisor.syncStarted(true);
    supervisor.beforeCommit();
    supervisor.recordCommit({ status: "committed", files: 1 });
    supervisor.recordPull({ status: "up-to-date" });
    supervisor.recordPush({ status: "pushed", files: 1 });
    await supervisor.syncFinished({
        status: "success",
        value: {
            status: "synced",
            commit: { status: "committed", files: 1 },
        },
    });
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
    notices.length = 0;
    visibility = "visible";
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
            get visibilityState() {
                return visibility;
            },
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "Capacitor");
    Platform.isMobileApp = false;
});

describe("SyncSupervisor history", () => {
    it("keeps the history and the state across restarts", async () => {
        const { plugin } = createPlugin({ weakNetworkMode: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        supervisor.syncStarted(true);
        supervisor.observeError(dropped());
        await supervisor.syncFinished({ status: "failed" });
        await succeedOnce(supervisor);
        supervisor.stop();

        const again = new SyncSupervisor(plugin);
        again.start();
        expect(again.entries.map((entry) => entry.level)).toEqual([
            "warning",
            "success",
        ]);
        expect(again.snapshot().lastSuccessAt).toBe(
            supervisor.snapshot().lastSuccessAt
        );
        expect(again.snapshot().lastPushAt).toBeDefined();
        expect(again.details()).toContain("weak network mode: true");
    });

    it("records, but neither retries nor hides pop-ups, when both options are off", async () => {
        const { plugin } = createPlugin();
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);

        supervisor.syncStarted(true);
        expect(supervisor.observeError(dropped())).toBe(false);
        await supervisor.syncFinished({ status: "failed" });

        expect(supervisor.snapshot()).toMatchObject({
            phase: "waiting",
            nextRetryAt: undefined,
        });
        expect(supervisor.entries).toHaveLength(1);
        expect(notices).toEqual([]);
        expect(plugin.addRibbonIcon).not.toHaveBeenCalled();
    });
});

describe("SyncSupervisor in weak network mode", () => {
    it("retries a failed sync after 15 s, 30 s, 1 min, 2 min, then every 5 min", async () => {
        const { plugin, raw } = createPlugin({ weakNetworkMode: true });
        const supervisor = new SyncSupervisor(plugin);
        raw.gitActions.commitAndSync = failingSync(supervisor, dropped);
        supervisor.start();
        await settle(plugin);

        supervisor.syncStarted(true);
        expect(supervisor.observeError(dropped())).toBe(true);
        await supervisor.syncFinished({ status: "failed" });

        const delays: number[] = [];
        for (let i = 0; i < 6; i++) {
            const next = supervisor.snapshot().nextRetryAt!;
            delays.push(next - Date.now());
            await vi.advanceTimersByTimeAsync(next - Date.now());
            await settle(plugin);
        }
        expect(delays).toEqual([
            ...RETRY_DELAYS_MS,
            RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1],
        ]);
        expect(raw.gitActions.commitAndSync).toHaveBeenCalledTimes(6);
        expect(raw.gitActions.commitAndSync).toHaveBeenLastCalledWith({
            fromAutoBackup: true,
            mode: "all",
            reason: "retry",
        });
        expect(supervisor.snapshot().problem?.attempts).toBe(7);
        // Network errors stay out of pop-ups.
        expect(notices).toEqual([]);
    });

    it("waits for the network while offline and syncs when it comes back", async () => {
        const { plugin, raw, handlers } = createPlugin({
            weakNetworkMode: true,
        });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.register();
        supervisor.start();
        await settle(plugin);

        supervisor.syncStarted(true);
        supervisor.observeError(
            new NetworkUnavailableError("offline", "https://github.com/a/b")
        );
        await supervisor.syncFinished({ status: "failed" });
        expect(supervisor.snapshot().nextRetryAt! - Date.now()).toBe(
            OFFLINE_FALLBACK_MS
        );

        handlers.online!();
        await settle(plugin);
        expect(raw.gitActions.commitAndSync).toHaveBeenCalledWith({
            fromAutoBackup: true,
            mode: "all",
            reason: "online",
        });
        expect(supervisor.snapshot().nextRetryAt).toBeUndefined();
    });

    it("says once that a problem is over when it was announced or lasted", async () => {
        const { plugin } = createPlugin({ weakNetworkMode: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        supervisor.syncStarted(true);
        supervisor.observeError(dropped());
        await supervisor.syncFinished({ status: "failed" });
        vi.setSystemTime(Date.now() + 2 * 60_000);

        await succeedOnce(supervisor);

        expect(supervisor.snapshot()).toMatchObject({
            phase: "idle",
            problem: undefined,
            nextRetryAt: undefined,
        });
        expect(notices).toEqual([
            { message: "Git: syncing works again.", timeout: 6000 },
        ]);
    });
});

describe("SyncSupervisor problems that need the user", () => {
    it("shows one notice that stays, however often the sync fails", async () => {
        const { plugin } = createPlugin({ syncOnLeave: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        const blocked = new Error(
            "Cannot pull with uncommitted working tree changes: notes/a.md, notes/b.md"
        );

        for (let i = 0; i < 3; i++) {
            supervisor.syncStarted(true);
            expect(supervisor.observeError(blocked)).toBe(true);
            await supervisor.syncFinished({ status: "failed" });
        }

        expect(notices).toHaveLength(1);
        expect(notices[0]!.timeout).toBe(0);
        expect(notices[0]!.message).toContain("2 local changes block the pull");
        expect(supervisor.snapshot()).toMatchObject({
            phase: "attention",
            problem: { kind: "local-changes", attempts: 3 },
        });
        // Not retried on a timer: nothing would change.
        expect(supervisor.snapshot().nextRetryAt).toBeUndefined();
    });

    it("stops retrying an unexplained error after five attempts and reports it", async () => {
        const { plugin } = createPlugin({ weakNetworkMode: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        const odd = new Error("Something odd");

        for (let i = 1; i <= 5; i++) {
            supervisor.syncStarted(true);
            // Unknown errors keep their pop-up until they are reported.
            expect(supervisor.observeError(odd)).toBe(i === 5);
            await supervisor.syncFinished({ status: "failed" });
        }

        expect(supervisor.snapshot().problem).toMatchObject({
            kind: "other",
            retryable: false,
            needsUser: true,
        });
        expect(supervisor.snapshot().nextRetryAt).toBeUndefined();
        expect(notices).toHaveLength(1);
    });

    it("leaves conflicts to the usual conflict handling", () => {
        const { plugin } = createPlugin({ weakNetworkMode: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        const conflict = new GitConflictError(["a.md"], new Error("conflict"));
        expect(supervisor.observeError(conflict)).toBe(false);
        expect(notices).toEqual([]);
    });
});

describe("SyncSupervisor when Obsidian leaves and returns", () => {
    it("commits and syncs at once on leaving with edits, and again on return", async () => {
        const { plugin, raw, cancel } = createPlugin({ syncOnLeave: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);
        raw.gitActions.commitAndSync = failingSync(
            supervisor,
            () =>
                new Error(
                    "Request Failed. SocketException Software caused connection abort"
                )
        );

        expect(supervisor.noteVaultChange(`${INBOX}/note.md`)).toBe(true);
        visibility = "hidden";
        supervisor.onLeave();
        await settle(plugin);

        expect(cancel).toHaveBeenCalled();
        expect(raw.gitActions.commitAndSync).toHaveBeenCalledWith({
            fromAutoBackup: true,
            mode: "all",
            reason: "leave",
        });
        expect(supervisor.snapshot()).toMatchObject({
            background: "blocked",
            problem: { kind: "background-blocked" },
            nextRetryAt: undefined,
        });
        expect(notices).toEqual([]);

        raw.gitActions.commitAndSync = succeeding();
        visibility = "visible";
        supervisor.onReturn();
        await settle(plugin);

        expect(raw.gitActions.commitAndSync).toHaveBeenCalledWith({
            fromAutoBackup: true,
            mode: "all",
            reason: "resume",
        });
        // The battery hint, once.
        expect(notices).toHaveLength(1);
        expect(notices[0]!.message).toContain("Unrestricted");
    });

    it("tells a sync after the return from one in the background", async () => {
        const { plugin } = createPlugin({ syncOnLeave: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);
        visibility = "hidden";
        supervisor.onLeave();
        supervisor.syncStarted(true, "leave");
        supervisor.observeError(
            new Error(
                "Request Failed. SocketException Software caused connection abort"
            )
        );
        await supervisor.syncFinished({ status: "failed" });

        // Capacitor's resume comes before visibilitychange.
        supervisor.onReturn();
        expect(visibility).toBe("hidden");
        await succeedOnce(supervisor);

        expect(supervisor.snapshot().background).toBe("blocked");
        const last = supervisor.entries[supervisor.entries.length - 1]!;
        expect(last.text).not.toContain("background");

        // A sync that starts and ends in the background shows the network
        // works there.
        supervisor.onLeave();
        await succeedOnce(supervisor);
        expect(supervisor.snapshot().background).toBe("allowed");
        expect(
            supervisor.entries[supervisor.entries.length - 1]!.text
        ).toContain("(in the background)");
    });

    it("does nothing on leaving when there is nothing to upload", async () => {
        const { plugin, raw } = createPlugin({ syncOnLeave: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);

        visibility = "hidden";
        supervisor.onLeave();
        await settle(plugin);

        expect(raw.gitActions.commitAndSync).not.toHaveBeenCalled();
    });

    it("uploads what an earlier session committed but could not push", async () => {
        const { plugin, raw, commitsAhead } = createPlugin({
            syncOnLeave: true,
        });
        commitsAhead.mockResolvedValue(2);
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);

        expect(raw.gitActions.commitAndSync).toHaveBeenCalledWith({
            fromAutoBackup: true,
            mode: "all",
            reason: "startup",
        });
    });

    it("leaves the automatic syncs alone while the automatic routines are paused", async () => {
        const { plugin, raw } = createPlugin({ syncOnLeave: true });
        raw.localStorage.getPausedAutomatics.mockReturnValue(true);
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);

        supervisor.noteVaultChange(`${INBOX}/note.md`);
        visibility = "hidden";
        supervisor.onLeave();
        await settle(plugin);
        expect(raw.gitActions.commitAndSync).not.toHaveBeenCalled();

        supervisor.requestSync("manual");
        await settle(plugin);
        expect(raw.gitActions.commitAndSync).toHaveBeenCalledTimes(1);
    });
});

describe("SyncSupervisor edits", () => {
    it("counts only edits an automatic commit can pick up, not the files a pull writes", () => {
        const { plugin } = createPlugin({ syncOnLeave: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();

        expect(supervisor.noteVaultChange("elsewhere/note.md")).toBe(false);
        supervisor.expectWrites([`${INBOX}/pulled.md`]);
        expect(supervisor.noteVaultChange(`${INBOX}/pulled.md`)).toBe(false);
        expect(supervisor.snapshot().pendingEdits).toBe(false);
        // The next event for that file is an edit again.
        expect(supervisor.noteVaultChange(`${INBOX}/pulled.md`)).toBe(true);
        // Moving a note out of the inbox changes the inbox.
        expect(
            supervisor.noteVaultChange("elsewhere/moved.md", `${INBOX}/a.md`)
        ).toBe(true);
    });

    it("forgets edits a commit saw, and keeps those made during the commit", () => {
        const { plugin } = createPlugin({ syncOnLeave: true });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();

        supervisor.noteVaultChange(`${INBOX}/a.md`);
        supervisor.beforeCommit();
        supervisor.noteVaultChange(`${INBOX}/b.md`);
        supervisor.recordCommit({ status: "committed", files: 1 });
        expect(supervisor.snapshot().pendingEdits).toBe(true);

        supervisor.beforeCommit();
        supervisor.recordCommit({ status: "committed", files: 1 });
        expect(supervisor.snapshot()).toMatchObject({
            pendingEdits: false,
            ahead: 2,
            phase: "pending",
        });
    });

    it("keeps the screen on while an upload is due, at most 2 minutes after the last edit", async () => {
        Platform.isMobileApp = true;
        const keepAwake = {
            keepAwake: vi.fn(() => Promise.resolve()),
            allowSleep: vi.fn(() => Promise.resolve()),
            isKeptAwake: vi.fn(() => Promise.resolve({ isKeptAwake: false })),
        };
        Object.defineProperty(globalThis, "Capacitor", {
            configurable: true,
            value: { Plugins: { KeepAwake: keepAwake } },
        });
        const { plugin } = createPlugin({
            syncOnLeave: true,
            keepAwakeWhileSyncing: true,
        });
        const supervisor = new SyncSupervisor(plugin);
        supervisor.start();
        await settle(plugin);

        supervisor.noteVaultChange(`${INBOX}/a.md`);
        await vi.waitFor(() => expect(supervisor.keepingAwake).toBe(true));
        expect(keepAwake.keepAwake).toHaveBeenCalledTimes(1);

        // Uploaded: the screen may turn off again.
        await succeedOnce(supervisor);
        await vi.waitFor(() => expect(supervisor.keepingAwake).toBe(false));
        expect(keepAwake.allowSleep).toHaveBeenCalledTimes(1);

        // Not uploaded: at most two minutes.
        supervisor.noteVaultChange(`${INBOX}/b.md`);
        await vi.waitFor(() => expect(supervisor.keepingAwake).toBe(true));
        await vi.advanceTimersByTimeAsync(KEEP_AWAKE_MAX_MS + 200);
        expect(supervisor.keepingAwake).toBe(false);
        expect(keepAwake.allowSleep).toHaveBeenCalledTimes(2);
    });
});
