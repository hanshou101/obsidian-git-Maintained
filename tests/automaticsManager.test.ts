import { debounce } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import AutomaticsManager from "../src/automaticsManager";
import { PromiseQueue } from "../src/promiseQueue";
import { createFakePlugin } from "./helpers/createFakePlugin";

vi.mock("obsidian", async (importOriginal) => {
    const actual = await importOriginal<typeof import("obsidian")>();
    return { ...actual, debounce: vi.fn(actual.debounce) };
});

function createPlugin(settings: Record<string, unknown>) {
    const plugin = createFakePlugin();
    Object.assign(plugin, {
        gitReady: true,
        settings: {
            autoSaveInterval: 5,
            autoBackupAfterFileChange: true,
            setLastSaveToLastCommit: false,
            differentIntervalCommitAndPush: false,
            autoPushInterval: 0,
            autoPullInterval: 0,
            autoSyncDelaySeconds: 0,
            ...settings,
        },
        localStorage: {
            getPausedAutomatics: () => false,
            getLastAutoBackup: () => undefined,
            setLastAutoBackup: vi.fn(),
            getLastAutoPull: () => undefined,
            getLastAutoPush: () => undefined,
        },
        promiseQueue: new PromiseQueue(),
        gitActions: { commitAndSync: vi.fn(() => Promise.resolve()) },
    });
    return plugin;
}

describe("AutomaticsManager wait after file edits", () => {
    it("waits the interval's minutes by default", async () => {
        vi.mocked(debounce).mockClear();
        const manager = new AutomaticsManager(createPlugin({}));
        await manager.init();
        expect(vi.mocked(debounce)).toHaveBeenCalledWith(
            expect.any(Function),
            5 * 60_000,
            true
        );
        manager.unload();
    });

    it("waits the seconds of autoSyncDelaySeconds instead, when set", async () => {
        vi.mocked(debounce).mockClear();
        const plugin = createPlugin({ autoSyncDelaySeconds: 10 });
        const manager = new AutomaticsManager(plugin);
        await manager.init();
        expect(vi.mocked(debounce)).toHaveBeenCalledWith(
            expect.any(Function),
            10_000,
            true
        );
        // A changed delay takes effect with the commit reload.
        plugin.settings.autoSyncDelaySeconds = 20;
        manager.reload("commit");
        expect(vi.mocked(debounce)).toHaveBeenLastCalledWith(
            expect.any(Function),
            20_000,
            true
        );
        manager.unload();
    });
});

describe("AutomaticsManager auto commit-and-sync after file edits", () => {
    it("commits an edit made during a run exactly once, via the active debouncer", async () => {
        const plugin = createFakePlugin();
        const setLastAutoBackup = vi.fn();
        const commitAndSync = vi.fn(() => {
            // A vault event while the first commit-and-sync is still running.
            if (commitAndSync.mock.calls.length === 1) {
                plugin.autoCommitDebouncer?.();
            }
            return Promise.resolve();
        });
        Object.assign(plugin, {
            gitReady: true,
            settings: {
                autoSaveInterval: 5,
                autoBackupAfterFileChange: true,
                setLastSaveToLastCommit: false,
                differentIntervalCommitAndPush: false,
                autoPushInterval: 0,
                autoPullInterval: 0,
            },
            localStorage: {
                getPausedAutomatics: () => false,
                getLastAutoBackup: () => undefined,
                setLastAutoBackup,
                getLastAutoPull: () => undefined,
                getLastAutoPush: () => undefined,
            },
            promiseQueue: new PromiseQueue(),
            gitActions: { commitAndSync },
        });
        const manager = new AutomaticsManager(plugin);
        await manager.init();

        const firstDebouncer = plugin.autoCommitDebouncer!;
        firstDebouncer();
        firstDebouncer.run();
        await vi.waitFor(() => expect(setLastAutoBackup).toHaveBeenCalled());
        expect(commitAndSync).toHaveBeenCalledTimes(1);

        // Vault events call plugin.autoCommitDebouncer, so the edit from the
        // first run must be pending there.
        plugin.autoCommitDebouncer!.run();
        await vi.waitFor(() =>
            expect(setLastAutoBackup).toHaveBeenCalledTimes(2)
        );
        expect(commitAndSync).toHaveBeenCalledTimes(2);

        // No other debouncer may stay armed with the same edit.
        firstDebouncer.run();
        await new Promise<void>((resolve) =>
            plugin.promiseQueue.addTask(() => Promise.resolve(), resolve)
        );
        expect(commitAndSync).toHaveBeenCalledTimes(2);

        manager.unload();
    });
});
