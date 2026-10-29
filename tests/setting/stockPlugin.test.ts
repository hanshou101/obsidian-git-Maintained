import { describe, expect, it, vi } from "vitest";
import type ObsidianGit from "../../src/main";
import { LocalStorageSettings } from "../../src/setting/localStorageSettings";
import { STOCK_PLUGIN_ID, StockPlugin } from "../../src/setting/stockPlugin";

type FakeVault = {
    id?: string;
    configDir?: string;
    enabledPlugins?: string[];
    hasPluginsApi?: boolean;
    files?: Record<string, string>;
    storage?: Record<string, unknown>;
};

function createPlugin(vault: FakeVault = {}) {
    const files = new Map(Object.entries(vault.files ?? {}));
    const storage = new Map(Object.entries(vault.storage ?? {}));
    const log = vi.fn();
    const plugin = {
        manifest: { id: vault.id ?? "git-maintained" },
        app: {
            vault: {
                configDir: vault.configDir ?? ".obsidian",
                adapter: {
                    exists: (file: string) => Promise.resolve(files.has(file)),
                    read: (file: string) => Promise.resolve(files.get(file)),
                },
            },
            plugins:
                vault.hasPluginsApi === false
                    ? undefined
                    : { enabledPlugins: new Set(vault.enabledPlugins ?? []) },
            loadLocalStorage: (key: string) => storage.get(key) ?? null,
            saveLocalStorage: (key: string, value: unknown) => {
                storage.set(key, value);
            },
        },
        log,
    } as unknown as ObsidianGit;
    plugin.localStorage = new LocalStorageSettings(plugin);
    return { plugin, stock: new StockPlugin(plugin), storage, log };
}

describe("StockPlugin", () => {
    it("is enabled when the vault enabled obsidian-git", () => {
        expect(
            createPlugin({
                enabledPlugins: ["dataview", STOCK_PLUGIN_ID],
            }).stock.isEnabled()
        ).toBe(true);
        expect(
            createPlugin({ enabledPlugins: ["dataview"] }).stock.isEnabled()
        ).toBe(false);
    });

    it("is not enabled without the private plugins API", () => {
        expect(createPlugin({ hasPluginsApi: false }).stock.isEnabled()).toBe(
            false
        );
    });

    it("never treats a build with the stock id as next to itself", async () => {
        const { stock } = createPlugin({
            id: STOCK_PLUGIN_ID,
            enabledPlugins: [STOCK_PLUGIN_ID],
            files: {
                ".obsidian/plugins/obsidian-git/data.json":
                    '{"autoSaveInterval":5}',
            },
        });

        expect(stock.isEnabled()).toBe(false);
        await expect(stock.importSettings()).resolves.toBeNull();
    });

    it("takes over data.json and the device-local values", async () => {
        const { stock, storage } = createPlugin({
            configDir: ".obsidian-phone",
            files: {
                ".obsidian-phone/plugins/obsidian-git/data.json":
                    '{"autoSaveInterval":5,"autoCommitGlobs":"00/**"}',
            },
            storage: {
                "obsidian-git:username": "alice",
                "obsidian-git:hostname": "phone",
                "obsidian-git:gitPath": "/usr/bin/git",
                "obsidian-git:envVars": '["A=1"]',
                "obsidian-git:lastAutoPull": "2026-10-29T00:00:00.000Z",
                "obsidian-git:pluginDisabled": "true",
                "obsidian-git:pausedAutomatics": "true",
                "git-maintained:hostname": "kept",
            },
        });

        await expect(stock.importSettings()).resolves.toEqual({
            autoSaveInterval: 5,
            autoCommitGlobs: "00/**",
        });
        expect(storage.get("git-maintained:username")).toBe("alice");
        expect(storage.get("git-maintained:gitPath")).toBe("/usr/bin/git");
        expect(storage.get("git-maintained:envVars")).toBe('["A=1"]');
        expect(storage.get("git-maintained:lastAutoPull")).toBe(
            "2026-10-29T00:00:00.000Z"
        );
        // A value of its own wins; turning Git off is not taken over.
        expect(storage.get("git-maintained:hostname")).toBe("kept");
        expect(storage.has("git-maintained:pluginDisabled")).toBe(false);
        expect(storage.has("git-maintained:pausedAutomatics")).toBe(false);
    });

    it("takes over nothing when the stock plugin has no data.json", async () => {
        const { stock, storage } = createPlugin({
            storage: { "obsidian-git:username": "alice" },
        });

        await expect(stock.importSettings()).resolves.toBeNull();
        expect(storage.has("git-maintained:username")).toBe(false);
    });

    it.each(["[]", "null", "1"])(
        "takes over nothing from the data.json %s",
        async (content) => {
            const { stock, storage } = createPlugin({
                files: { ".obsidian/plugins/obsidian-git/data.json": content },
                storage: { "obsidian-git:username": "alice" },
            });

            await expect(stock.importSettings()).resolves.toBeNull();
            expect(storage.has("git-maintained:username")).toBe(false);
        }
    );

    it("logs and takes over nothing when data.json is not JSON", async () => {
        const { stock, storage, log } = createPlugin({
            files: { ".obsidian/plugins/obsidian-git/data.json": "{" },
            storage: { "obsidian-git:username": "alice" },
        });

        await expect(stock.importSettings()).resolves.toBeNull();
        expect(storage.has("git-maintained:username")).toBe(false);
        expect(log).toHaveBeenCalledWith(
            "Could not read .obsidian/plugins/obsidian-git/data.json:",
            expect.any(SyntaxError)
        );
    });
});
