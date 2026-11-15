import { Modal, Notice, type App } from "obsidian";
import { syncLanguage } from "../../syncProblems";
import type { GitProgress } from "../../types";

export type OperationProgressState =
    "queued" | "running" | "success" | "error" | "cancelled";

export interface OperationProgressOptions {
    title: string;
    initialStep?: string;
    cancellable?: boolean;
    onCancel?: () => void;
}

export class OperationProgressModal extends Modal {
    private readonly options: OperationProgressOptions;
    private readonly zh = syncLanguage() === "zh";
    private state: OperationProgressState = "running";
    private stepText: string;
    private progressText = "";
    private progressPercent: number | undefined;
    private summaryText = "";
    private detailLines: string[] = [];
    private startedAt = Date.now();
    private timerId: number | undefined;
    private cancelled = false;
    private opened = false;
    private closedByUser = false;

    private badgeEl?: HTMLElement;
    private stepEl?: HTMLElement;
    private barTrackEl?: HTMLElement;
    private barFillEl?: HTMLElement;
    private progressDetailEl?: HTMLElement;
    private elapsedEl?: HTMLElement;
    private detailsListEl?: HTMLElement;
    private footerEl?: HTMLElement;

    constructor(app: App, options: OperationProgressOptions) {
        super(app);
        this.options = options;
        this.stepText =
            options.initialStep ??
            (this.zh ? "正在准备操作…" : "Preparing operation…");
        this.scope.register([], "Escape", () => {
            this.handleDismiss();
            return false;
        });
        this.scope.register([], "Enter", () => {
            if (this.isFinished()) {
                this.close();
                return false;
            }
            return true;
        });
    }

    override onOpen(): void {
        this.opened = true;
        this.closedByUser = false;
        this.setTitle(this.options.title);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("git-maintained-op-modal");

        const headerEl = contentEl.createDiv({
            cls: "git-maintained-op-modal-header",
        });
        this.badgeEl = headerEl.createSpan({
            cls: "git-maintained-op-modal-badge",
        });
        this.elapsedEl = headerEl.createSpan({
            cls: "git-maintained-op-modal-elapsed",
        });

        this.stepEl = contentEl.createDiv({
            cls: "git-maintained-op-modal-step",
        });

        this.barTrackEl = contentEl.createDiv({
            cls: "git-maintained-op-modal-bar-track",
        });
        this.barFillEl = this.barTrackEl.createDiv({
            cls: "git-maintained-op-modal-bar-fill",
        });

        this.progressDetailEl = contentEl.createDiv({
            cls: "git-maintained-op-modal-progress-detail",
        });

        this.detailsListEl = contentEl.createDiv({
            cls: "git-maintained-op-modal-details",
        });

        this.footerEl = contentEl.createDiv({
            cls: "modal-button-container git-maintained-op-modal-footer",
        });

        this.startTimer();
        this.render();
    }

    override onClose(): void {
        this.stopTimer();
        if (!this.isFinished()) {
            this.closedByUser = true;
            if (this.options.cancellable && !this.cancelled) {
                this.cancelled = true;
                this.state = "cancelled";
                this.options.onCancel?.();
            }
        }
        this.opened = false;
        this.contentEl.empty();
    }

    isCancelled(): boolean {
        return this.cancelled;
    }

    isFinished(): boolean {
        return (
            this.state === "success" ||
            this.state === "error" ||
            this.state === "cancelled"
        );
    }

    setQueued(waitingLabel?: string): void {
        if (this.isFinished()) return;
        this.state = "queued";
        this.stepText =
            waitingLabel ??
            (this.zh
                ? "已有其他 Git 任务正在执行，正在排队等待…"
                : "Another Git task is currently running, waiting in queue…");
        this.progressText = "";
        this.progressPercent = undefined;
        this.render();
    }

    setRunning(step?: string): void {
        if (this.isFinished()) return;
        this.state = "running";
        if (step !== undefined) {
            this.stepText = step;
        }
        this.render();
    }

    setStep(step: string): void {
        if (this.isFinished()) return;
        this.state = "running";
        this.stepText = step;
        this.render();
    }

    setProgress(
        progress:
            | GitProgress
            | {
                  phase?: string;
                  loaded: number;
                  total?: number;
              }
    ): void {
        if (this.isFinished()) return;
        this.state = "running";
        if ("action" in progress) {
            const phase = progress.stage
                ? `${progress.action} (${progress.stage})`
                : progress.action;
            if (progress.total && progress.total > 0) {
                const processed = progress.processed ?? 0;
                const pct =
                    progress.progress ??
                    Math.max(
                        0,
                        Math.min(
                            100,
                            Math.round((processed / progress.total) * 100)
                        )
                    );
                this.progressPercent = pct;
                this.progressText = `${phase}: ${processed}/${progress.total} (${pct}%)`;
            } else if (progress.progress !== undefined) {
                this.progressPercent = progress.progress;
                this.progressText = `${phase}: ${progress.progress}%`;
            } else {
                this.progressPercent = undefined;
                this.progressText = phase;
            }
        } else {
            const phase =
                progress.phase?.trim() || (this.zh ? "传输中" : "Working");
            if (progress.total && progress.total > 0) {
                const pct = Math.max(
                    0,
                    Math.min(
                        100,
                        Math.round((progress.loaded / progress.total) * 100)
                    )
                );
                this.progressPercent = pct;
                this.progressText = `${phase}: ${progress.loaded}/${progress.total} (${pct}%)`;
            } else {
                this.progressPercent = undefined;
                this.progressText = `${phase}: ${progress.loaded}`;
            }
        }
        this.render();
    }

    finishSuccess(summary: string, details: string[] = []): void {
        if (this.cancelled) return;
        this.stopTimer();
        this.state = "success";
        this.summaryText = summary;
        this.detailLines = details.filter((line) => line.trim().length > 0);
        this.progressPercent = 100;
        if (this.opened) {
            this.render();
        } else if (this.closedByUser) {
            new Notice(summary, 5000);
        }
    }

    finishError(summary: string, details: string[] = []): void {
        if (this.cancelled) return;
        this.stopTimer();
        this.state = "error";
        this.summaryText = summary;
        this.detailLines = details.filter((line) => line.trim().length > 0);
        if (this.opened) {
            this.render();
        } else if (this.closedByUser) {
            new Notice(summary, 10000);
        }
    }

    private handleDismiss(): void {
        if (this.isFinished()) {
            this.close();
            return;
        }
        if (this.options.cancellable) {
            this.cancelled = true;
            this.state = "cancelled";
            this.stopTimer();
            this.options.onCancel?.();
            this.close();
            return;
        }
        this.closedByUser = true;
        this.close();
    }

    private startTimer(): void {
        this.stopTimer();
        this.timerId = window.setInterval(() => {
            if (!this.opened || this.isFinished()) {
                this.stopTimer();
                return;
            }
            this.renderElapsed();
        }, 1000);
    }

    private stopTimer(): void {
        if (this.timerId !== undefined) {
            window.clearInterval(this.timerId);
            this.timerId = undefined;
        }
    }

    private renderElapsed(): void {
        if (!this.elapsedEl) return;
        const seconds = Math.max(
            0,
            Math.floor((Date.now() - this.startedAt) / 1000)
        );
        this.elapsedEl.setText(
            this.zh ? `已用时 ${seconds} 秒` : `Elapsed ${seconds}s`
        );
    }

    private render(): void {
        if (!this.opened || !this.badgeEl || !this.stepEl) return;

        this.badgeEl.removeClass(
            "is-queued",
            "is-running",
            "is-success",
            "is-error",
            "is-cancelled"
        );
        this.badgeEl.addClass(`is-${this.state}`);

        const badgeLabels: Record<OperationProgressState, string> = {
            queued: this.zh ? "排队中" : "Queued",
            running: this.zh ? "进行中" : "Running",
            success: this.zh ? "已完成" : "Completed",
            error: this.zh ? "失败" : "Failed",
            cancelled: this.zh ? "已取消" : "Cancelled",
        };
        this.badgeEl.setText(badgeLabels[this.state]);
        this.renderElapsed();

        this.stepEl.setText(
            this.state === "success" || this.state === "error"
                ? this.summaryText
                : this.stepText
        );

        if (this.barTrackEl && this.barFillEl) {
            if (this.state === "queued" || this.state === "running") {
                this.barTrackEl.style.display = "block";
                if (this.progressPercent !== undefined) {
                    this.barTrackEl.removeClass("is-indeterminate");
                    this.barFillEl.style.width = `${this.progressPercent}%`;
                } else {
                    this.barTrackEl.addClass("is-indeterminate");
                    this.barFillEl.style.width = "40%";
                }
            } else {
                this.barTrackEl.style.display = "none";
            }
        }

        if (this.progressDetailEl) {
            const detail =
                this.state === "queued" || this.state === "running"
                    ? this.progressText
                    : "";
            this.progressDetailEl.setText(detail);
            this.progressDetailEl.style.display = detail ? "block" : "none";
        }

        if (this.detailsListEl) {
            this.detailsListEl.empty();
            if (
                this.detailLines.length > 0 &&
                (this.state === "success" || this.state === "error")
            ) {
                this.detailsListEl.style.display = "block";
                for (const line of this.detailLines) {
                    this.detailsListEl.createDiv({
                        cls: "git-maintained-op-modal-detail-line",
                        text: line,
                    });
                }
            } else {
                this.detailsListEl.style.display = "none";
            }
        }

        if (this.footerEl) {
            this.footerEl.empty();
            if (this.isFinished()) {
                const closeBtn = this.footerEl.createEl("button", {
                    cls: "mod-cta",
                    text: this.zh ? "关闭" : "Close",
                });
                closeBtn.addEventListener("click", () => this.close());
            } else if (this.options.cancellable) {
                const cancelBtn = this.footerEl.createEl("button", {
                    cls: "mod-warning",
                    text: this.zh ? "取消" : "Cancel",
                });
                cancelBtn.addEventListener("click", () => this.handleDismiss());
            } else {
                const hideBtn = this.footerEl.createEl("button", {
                    text: this.zh ? "后台继续运行" : "Run in background",
                });
                hideBtn.addEventListener("click", () => this.handleDismiss());
            }
        }
    }
}
