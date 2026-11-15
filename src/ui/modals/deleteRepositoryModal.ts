import { Modal, type App } from "obsidian";
import { syncLanguage } from "../../syncProblems";

export type DeleteRepositoryChoice = "cancel" | "git-only" | "git-and-files";

export interface DeleteRepositoryModalOptions {
    configDir: string;
    queueBusy: boolean;
    pendingCount: number;
}

export class DeleteRepositoryModal extends Modal {
    private readonly options: DeleteRepositoryModalOptions;
    private readonly zh = syncLanguage() === "zh";
    private resolved = false;
    private resolvePromise!: (choice: DeleteRepositoryChoice) => void;

    constructor(app: App, options: DeleteRepositoryModalOptions) {
        super(app);
        this.options = options;
        this.scope.register([], "Escape", () => {
            this.resolveAndClose("cancel");
            return false;
        });
    }

    openAndGetChoice(): Promise<DeleteRepositoryChoice> {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            this.open();
        });
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("git-maintained-delete-modal");
        this.setTitle(this.zh ? "删除 Git 仓库" : "Delete Git repository");

        contentEl.createEl("p", {
            text: this.zh
                ? "请选择清理方式。若当前同步卡住并希望重新克隆仓库，建议先确认是否只需重置 Git 记录，还是连同工作区笔记一起清空。"
                : "Choose how to remove the repository. You can delete only the .git metadata folder, or also clear vault files before re-cloning.",
        });

        if (this.options.queueBusy) {
            const warnEl = contentEl.createDiv({
                cls: "git-maintained-delete-modal-warning",
            });
            const extra =
                this.options.pendingCount > 0
                    ? this.zh
                        ? `（另有 ${this.options.pendingCount} 个排队任务）`
                        : ` (${this.options.pendingCount} queued)`
                    : "";
            warnEl.setText(
                this.zh
                    ? `当前有正在运行或等待中的同步任务${extra}；确认删除后会立即停止自动同步并清空待执行队列。`
                    : `Sync tasks are currently active or waiting${extra}; confirming will stop automatic sync and clear the pending queue immediately.`
            );
        }

        const safeBtnRow = contentEl.createDiv({
            cls: "git-maintained-delete-modal-actions",
        });
        const gitOnlyBtn = safeBtnRow.createEl("button", {
            cls: "mod-cta",
            text: this.zh
                ? "仅删除 .git 目录（保留所有笔记和文件）"
                : "Delete .git folder only (keep all notes and files)",
        });
        gitOnlyBtn.addEventListener("click", () =>
            this.resolveAndClose("git-only")
        );

        const dangerBox = contentEl.createDiv({
            cls: "git-maintained-delete-modal-danger-box",
        });
        dangerBox.createEl("p", {
            cls: "git-maintained-delete-modal-danger-title",
            text: this.zh
                ? "彻底重置工作区（适合删库重拉前一键清理）"
                : "Full workspace reset (before re-cloning)",
        });
        dangerBox.createEl("p", {
            cls: "git-maintained-delete-modal-danger-desc",
            text: this.zh
                ? `会删除 .git 以及仓库根目录下的全部笔记和子文件夹，但会保留 Obsidian 配置目录「${this.options.configDir}」。`
                : `Deletes .git and all notes and folders in the vault root, while preserving Obsidian config directory "${this.options.configDir}".`,
        });

        const confirmRow = dangerBox.createEl("label", {
            cls: "git-maintained-delete-modal-confirm-row",
        });
        const checkbox = confirmRow.createEl("input", {
            type: "checkbox",
        });
        confirmRow.createSpan({
            text: this.zh
                ? `我确认删除所有笔记与文件夹（保留 ${this.options.configDir}），且此操作不可恢复`
                : `I confirm permanently deleting all vault notes and folders (keeping ${this.options.configDir})`,
        });

        const deleteAllBtn = dangerBox.createEl("button", {
            cls: "mod-warning",
            text: this.zh
                ? "删除 .git 并清空所有工作区文件"
                : "Delete .git and clear all vault files",
        });
        deleteAllBtn.disabled = true;
        checkbox.addEventListener("change", () => {
            deleteAllBtn.disabled = !checkbox.checked;
        });
        deleteAllBtn.addEventListener("click", () => {
            if (checkbox.checked) {
                this.resolveAndClose("git-and-files");
            }
        });

        const footerEl = contentEl.createDiv({
            cls: "modal-button-container",
        });
        const cancelBtn = footerEl.createEl("button", {
            text: this.zh ? "取消" : "Cancel",
        });
        cancelBtn.addEventListener("click", () =>
            this.resolveAndClose("cancel")
        );
    }

    override onClose(): void {
        if (!this.resolved) {
            this.resolved = true;
            this.resolvePromise?.("cancel");
        }
        this.contentEl.empty();
    }

    private resolveAndClose(choice: DeleteRepositoryChoice): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolvePromise?.(choice);
        this.close();
    }
}
