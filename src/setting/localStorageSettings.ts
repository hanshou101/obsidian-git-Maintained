import type { App } from "obsidian";
import type ObsidianGit from "../main";
export class LocalStorageSettings {
    private prefix: string;
    private app: App;
    constructor(private readonly plugin: ObsidianGit) {
        this.prefix = this.plugin.manifest.id + ":";
        this.app = plugin.app;
    }

    migrate(): void {
        const keys = [
            "password",
            "hostname",
            "lastAutoPull",
            "lastAutoBackup",
            "lastAutoPush",
            "gitPath",
            "pluginDisabled",
        ];
        for (const key of keys) {
            const old = localStorage.getItem(this.prefix + key);
            if (
                this.app.loadLocalStorage(this.prefix + key) == null &&
                old != null
            ) {
                if (old != null) {
                    this.app.saveLocalStorage(this.prefix + key, old);
                    localStorage.removeItem(this.prefix + key);
                }
            }
        }
    }

    /**
     * obsidian-git-Maintained: copies what the plugin `pluginId` stored on
     * this device, for every key this plugin has no value for yet.
     * `pluginDisabled` and `pausedAutomatics` are not copied: installing the
     * edition turns Git on for this device.
     */
    importFrom(pluginId: string): void {
        const keys = [
            "password",
            "username",
            "hostname",
            "gitPath",
            "PATHPaths",
            "envVars",
            "lastAutoPull",
            "lastAutoBackup",
            "lastAutoPush",
        ];
        for (const key of keys) {
            const value: unknown = this.app.loadLocalStorage(
                `${pluginId}:${key}`
            );
            if (
                value != null &&
                this.app.loadLocalStorage(this.prefix + key) == null
            ) {
                this.app.saveLocalStorage(this.prefix + key, value);
            }
        }
    }

    getLegacyPassword(): string | null {
        return this.app.loadLocalStorage(this.prefix + "password") as
            string | null;
    }

    setLegacyPassword(value: string): void {
        this.app.saveLocalStorage(this.prefix + "password", value);
    }

    clearLegacyPassword(): void {
        this.app.saveLocalStorage(this.prefix + "password", null);
        localStorage.removeItem(this.prefix + "password");
    }

    getUsername(): string | null {
        return this.app.loadLocalStorage(this.prefix + "username") as
            string | null;
    }

    setUsername(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "username", value);
    }

    getHostname(): string | null {
        return this.app.loadLocalStorage(this.prefix + "hostname") as
            string | null;
    }

    setHostname(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "hostname", value);
    }

    getLastAutoPull(): string | null {
        return this.app.loadLocalStorage(this.prefix + "lastAutoPull") as
            string | null;
    }

    setLastAutoPull(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "lastAutoPull", value);
    }

    getLastAutoBackup(): string | null {
        return this.app.loadLocalStorage(this.prefix + "lastAutoBackup") as
            string | null;
    }

    setLastAutoBackup(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "lastAutoBackup", value);
    }

    getLastAutoPush(): string | null {
        return this.app.loadLocalStorage(this.prefix + "lastAutoPush") as
            string | null;
    }

    setLastAutoPush(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "lastAutoPush", value);
    }

    getGitPath(): string | null {
        return this.app.loadLocalStorage(this.prefix + "gitPath") as
            string | null;
    }

    setGitPath(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "gitPath", value);
    }

    getPATHPaths(): string[] {
        return (
            (
                this.app.loadLocalStorage(this.prefix + "PATHPaths") as
                    string | null
            )?.split(":") ?? []
        );
    }

    setPATHPaths(value: string[]): void {
        return this.app.saveLocalStorage(
            this.prefix + "PATHPaths",
            value.join(":")
        );
    }

    getEnvVars(): string[] {
        return JSON.parse(
            (this.app.loadLocalStorage(this.prefix + "envVars") as
                string | undefined) ?? "[]"
        ) as string[];
    }

    setEnvVars(value: string[]): void {
        return this.app.saveLocalStorage(
            this.prefix + "envVars",
            JSON.stringify(value)
        );
    }

    /**
     * obsidian-git-Maintained: the sync history and state of this device, as
     * JSON (see `SyncSupervisor`). Kept here rather than in the vault, so it
     * is never committed.
     */
    getSyncLog(): string | null {
        return this.app.loadLocalStorage(this.prefix + "syncLog") as
            string | null;
    }

    setSyncLog(value: string | null): void {
        return this.app.saveLocalStorage(this.prefix + "syncLog", value);
    }

    getPluginDisabled(): boolean {
        return (
            this.app.loadLocalStorage(this.prefix + "pluginDisabled") == "true"
        );
    }

    setPluginDisabled(value: boolean): void {
        return this.app.saveLocalStorage(
            this.prefix + "pluginDisabled",
            `${value}`
        );
    }

    /**
     * Whether automatic routines are currently paused.
     * New timers should not be started when this is true.
     */
    getPausedAutomatics(): boolean {
        return (
            this.app.loadLocalStorage(this.prefix + "pausedAutomatics") ==
            "true"
        );
    }

    setPausedAutomatics(value: boolean): void {
        return this.app.saveLocalStorage(
            this.prefix + "pausedAutomatics",
            `${value}`
        );
    }

    /**
     * The length of the fallback spacing for the line authoring gutter, which
     * is used when the longest rendered gutter is not yet known.
     */
    getGutterSpacingFallbackLength(): number {
        return (
            (this.app.loadLocalStorage(
                this.prefix + "gutterSpacingFallbackLength"
            ) as number) ?? 5
        );
    }

    setGutterSpacingFallbackLength(value: number): void {
        return this.app.saveLocalStorage(
            this.prefix + "gutterSpacingFallbackLength",
            value
        );
    }
}
