import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type ObsidianGit from "../../src/main";
import { GeneralModal } from "../../src/ui/modals/generalModal";
import { OperationProgressModal } from "../../src/ui/modals/operationProgressModal";

function fakePlugin() {
    return {
        app: new App(),
    } as unknown as ObsidianGit;
}

describe("GeneralModal", () => {
    it("filters options case-insensitively and avoids duplicating exact matches", () => {
        const modal = new GeneralModal(fakePlugin(), {
            options: [
                "origin/feature/alpha",
                "origin/main-backup",
                "origin/main",
                "origin/master",
                "origin/dev/MainStage",
            ],
        });

        expect(modal.limit).toBeGreaterThanOrEqual(500);
        expect(modal.getSuggestions("main")).toEqual([
            "main",
            "origin/main",
            "origin/main-backup",
            "origin/dev/MainStage",
        ]);
        expect(modal.getSuggestions("ORIGIN/MAIN")).toEqual([
            "ORIGIN/MAIN",
            "origin/main",
            "origin/main-backup",
        ]);
        expect(modal.getSuggestions("origin/main")).toEqual([
            "origin/main",
            "origin/main-backup",
        ]);
    });

    it("keeps options unfiltered on empty query and respects onlySelection", () => {
        const modal = new GeneralModal(fakePlugin(), {
            options: ["origin/main", "origin/dev"],
            onlySelection: true,
        });

        expect(modal.getSuggestions("")).toEqual(["origin/main", "origin/dev"]);
        expect(modal.getSuggestions("main")).toEqual(["origin/main"]);
        expect(modal.getSuggestions("nonexistent")).toEqual([]);
    });

    it("prepends typed custom value before partial matches and supports allowEmpty", () => {
        const modal = new GeneralModal(fakePlugin(), {
            options: ["origin/release-1", "origin/release-2"],
            allowEmpty: true,
        });

        expect(modal.getSuggestions("")).toEqual([
            " ",
            "origin/release-1",
            "origin/release-2",
        ]);
        expect(modal.getSuggestions("hotfix")).toEqual(["hotfix"]);
        expect(modal.getSuggestions("release")).toEqual([
            "release",
            "origin/release-1",
            "origin/release-2",
        ]);
    });
});

describe("OperationProgressModal", () => {
    it("tracks queued, progress, completion, and cancellation states cleanly", () => {
        const onCancel = vi.fn();
        const modal = new OperationProgressModal(new App(), {
            title: "Pulling remote changes",
            cancellable: true,
            onCancel,
        });

        modal.setQueued("Waiting in queue…");
        modal.setRunning("Fetching remote…");
        modal.setProgress({
            action: "Fetching",
            stage: "Receiving objects",
            processed: 3,
            total: 6,
        });
        expect(modal.isFinished()).toBe(false);
        expect(modal.isCancelled()).toBe(false);

        modal.finishSuccess("Pulled 3 files");
        expect(modal.isFinished()).toBe(true);

        // Subsequent progress updates after completion are ignored.
        modal.setProgress({ phase: "Late", loaded: 1, total: 1 });
        expect(modal.isCancelled()).toBe(false);
    });
});
