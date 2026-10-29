import type ObsidianGit from "../main";
import type { ObsidianGitSettings } from "../types";

/**
 * obsidian-git-Maintained: the id of the stock Obsidian Git plugin. The
 * edition has an id of its own, so Obsidian never offers a stock release as
 * an update of it.
 */
export const STOCK_PLUGIN_ID = "obsidian-git";

/** The stock plugin in the same vault, as seen from the maintained edition. */
export class StockPlugin {
    constructor(private readonly plugin: ObsidianGit) {}

    /**
     * Whether the stock plugin is enabled. It registers the same views and
     * runs the same automatic routines on the same repository, so the edition
     * does not start next to it.
     */
    isEnabled(): boolean {
        return (
            this.plugin.manifest.id !== STOCK_PLUGIN_ID &&
            this.plugin.app.plugins?.enabledPlugins?.has(STOCK_PLUGIN_ID) ===
                true
        );
    }

    /**
     * Takes over the stock plugin's settings in this vault: copies its
     * device-local values and returns its data.json. Returns null when the
     * stock plugin has no readable data.json here.
     */
    async importSettings(): Promise<ObsidianGitSettings | null> {
        if (this.plugin.manifest.id === STOCK_PLUGIN_ID) return null;
        const { adapter, configDir } = this.plugin.app.vault;
        const dataFile = `${configDir}/plugins/${STOCK_PLUGIN_ID}/data.json`;
        if (!(await adapter.exists(dataFile))) return null;

        let data: unknown;
        try {
            data = JSON.parse(await adapter.read(dataFile));
        } catch (error) {
            this.plugin.log(`Could not read ${dataFile}:`, error);
            return null;
        }
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            return null;
        }
        this.plugin.localStorage.importFrom(STOCK_PLUGIN_ID);
        return data as ObsidianGitSettings;
    }
}
