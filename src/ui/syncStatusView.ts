import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Notice, Platform, setIcon } from "obsidian";
import { SYNC_STATUS_VIEW_CONFIG } from "src/constants";
import type ObsidianGit from "src/main";
import { problemText } from "src/syncProblems";
import type { SyncLogEntry, SyncStateSnapshot } from "src/syncSupervisor";

/**
 * obsidian-git-Maintained: where the sync state, the current problem and the
 * history of this device can be read at any time (AME-1119), instead of
 * pop-ups that are gone before anyone reads them.
 */
export default class SyncStatusView extends ItemView {
    private unsubscribe?: () => void;
    private subtitleEl?: HTMLElement;
    private liveProgressEl?: HTMLElement;
    private barTrackEl?: HTMLElement;
    private barFillEl?: HTMLElement;
    private syncNowBtn?: HTMLButtonElement;
    private lastStructuralKey = "";
    private idleTickCounter = 0;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: ObsidianGit
    ) {
        super(leaf);
    }

    private get supervisor() {
        return this.plugin.syncSupervisor;
    }

    private t(zh: string, en: string): string {
        return this.supervisor.text(zh, en);
    }

    getViewType(): string {
        return SYNC_STATUS_VIEW_CONFIG.type;
    }

    getDisplayText(): string {
        return this.t("同步状态", SYNC_STATUS_VIEW_CONFIG.name);
    }

    getIcon(): string {
        return SYNC_STATUS_VIEW_CONFIG.icon;
    }

    async onOpen(): Promise<void> {
        this.unsubscribe = this.supervisor.onChange(() => this.onStateChange());
        // Live elapsed timer / progress while syncing, relative times every 15s when idle.
        this.registerInterval(window.setInterval(() => this.tick(), 1_000));
        this.render();
        await super.onOpen();
    }

    async onClose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        await super.onClose();
    }

    private structuralKey(state: SyncStateSnapshot): string {
        return [
            state.phase,
            state.problem?.kind ?? "",
            state.problem?.attempts ?? 0,
            state.problem?.files.join("|") ?? "",
            this.supervisor.entries.length,
            state.ahead ?? "",
            state.pendingEdits ? "1" : "0",
            state.online ? "1" : "0",
            state.background,
            state.lastSuccessAt ?? "",
            state.lastPushAt ?? "",
            state.lastPullAt ?? "",
        ].join("::");
    }

    private onStateChange(): void {
        const state = this.supervisor.snapshot();
        const key = this.structuralKey(state);
        if (
            key === this.lastStructuralKey &&
            (state.phase === "syncing" || state.nextRetryAt !== undefined)
        ) {
            this.updateLiveElements(state);
            return;
        }
        this.render(state);
    }

    private tick(): void {
        const state = this.supervisor.snapshot();
        if (state.phase === "syncing" || state.nextRetryAt !== undefined) {
            this.idleTickCounter = 0;
            this.updateLiveElements(state);
            return;
        }
        this.idleTickCounter++;
        if (this.idleTickCounter >= 15) {
            this.idleTickCounter = 0;
            this.render(state);
        }
    }

    private render(snapshot?: SyncStateSnapshot): void {
        const state = snapshot ?? this.supervisor.snapshot();
        this.lastStructuralKey = this.structuralKey(state);
        this.subtitleEl = undefined;
        this.liveProgressEl = undefined;
        this.barTrackEl = undefined;
        this.barFillEl = undefined;
        this.syncNowBtn = undefined;

        const root = this.contentEl;
        root.empty();
        root.addClass("git-maintained-sync-status");
        this.renderHeader(root, state);
        this.renderActions(root);
        if (state.problem) this.renderProblem(root, state);
        this.renderFacts(root, state);
        this.renderHistory(root, this.supervisor.entries);
        this.updateLiveElements(state);
    }

    private renderHeader(root: HTMLElement, state: SyncStateSnapshot): void {
        const header = root.createDiv({
            cls: `git-maintained-sync-header is-${state.phase}`,
        });
        const icon = header.createDiv({ cls: "git-maintained-sync-icon" });
        const text = header.createDiv();
        const title = text.createDiv({ cls: "git-maintained-sync-title" });
        const sub = text.createDiv({ cls: "git-maintained-sync-subtitle" });
        this.subtitleEl = sub;
        const problem = state.problem;
        const problemTitle = problem
            ? problemText(problem, this.supervisor.language).title
            : "";
        switch (state.phase) {
            case "syncing": {
                setIcon(icon, "refresh-cw");
                title.setText(this.t("正在同步…", "Syncing…"));
                this.liveProgressEl = text.createDiv({
                    cls: "git-maintained-sync-live-progress",
                });
                this.barTrackEl = text.createDiv({
                    cls: "git-maintained-op-modal-bar-track",
                });
                this.barFillEl = this.barTrackEl.createDiv({
                    cls: "git-maintained-op-modal-bar-fill",
                });
                break;
            }
            case "attention":
                setIcon(icon, "alert-triangle");
                title.setText(this.t("需要你处理", "Needs you"));
                sub.setText(problemTitle);
                break;
            case "waiting":
                setIcon(icon, state.online ? "clock" : "cloud-off");
                title.setText(
                    this.t(
                        "还没传上去，改动在手机上是安全的",
                        "Not uploaded yet; your changes are safe here"
                    )
                );
                sub.setText(`${problemTitle} · ${this.nextStep(state)}`);
                break;
            case "pending":
                setIcon(icon, "upload-cloud");
                title.setText(
                    this.t("有改动等着上传", "Changes waiting to be uploaded")
                );
                sub.setText(
                    (state.ahead ?? 0) > 0
                        ? this.t(
                              `${state.ahead} 个提交还没上传`,
                              `${state.ahead} commits not uploaded`
                          )
                        : this.t(
                              "停笔一会儿就会自动提交并上传",
                              "Committed and uploaded once you stop editing"
                          )
                );
                break;
            case "idle":
                setIcon(icon, "check-circle");
                title.setText(this.t("已同步", "Up to date"));
                sub.setText(
                    state.lastSuccessAt
                        ? this.t(
                              `最近一次成功同步：${this.when(state.lastSuccessAt)}`,
                              `Last successful sync: ${this.when(state.lastSuccessAt)}`
                          )
                        : this.t(
                              "这台设备上还没有同步记录",
                              "No sync recorded on this device yet"
                          )
                );
                break;
        }
    }

    private nextStep(state: SyncStateSnapshot): string {
        if (state.nextRetryAt) {
            const seconds = Math.max(
                0,
                Math.round((state.nextRetryAt - Date.now()) / 1000)
            );
            return this.t(
                `${seconds} 秒后自动重试`,
                `retrying in ${seconds} s`
            );
        }
        if (!state.online) {
            return this.t(
                "网络恢复后马上重试",
                "retrying when the network is back"
            );
        }
        if (state.problem?.kind === "background-blocked") {
            return this.t(
                "回到 Obsidian 时马上重试",
                "retrying when Obsidian is back in the foreground"
            );
        }
        return this.t("下一次同步时重试", "retrying with the next sync");
    }

    private renderActions(root: HTMLElement): void {
        const actions = root.createDiv({ cls: "git-maintained-sync-actions" });
        const syncNow = actions.createEl("button", {
            cls: "mod-cta",
            text: this.t("立即同步", "Sync now"),
        });
        this.syncNowBtn = syncNow;
        syncNow.addEventListener("click", () => {
            if (!this.plugin.gitReady) {
                new Notice(this.t("Git 还没准备好", "Git is not ready"));
                return;
            }
            this.supervisor.requestSync("manual");
        });
        const copy = actions.createEl("button", {
            text: this.t("复制详情", "Copy details"),
        });
        copy.addEventListener("click", () => {
            navigator.clipboard.writeText(this.supervisor.details()).then(
                () => new Notice(this.t("已复制", "Copied")),
                (error) => this.plugin.displayError(error)
            );
        });
        const clear = actions.createEl("button", {
            text: this.t("清空记录", "Clear history"),
        });
        clear.addEventListener("click", () => this.supervisor.clearLog());
    }

    private updateLiveElements(state: SyncStateSnapshot): void {
        if (state.phase === "syncing" && state.running && this.subtitleEl) {
            const elapsed = Math.max(
                0,
                Math.round((Date.now() - state.running.startedAt) / 1000)
            );
            const queuedNote =
                state.running.queuedManual && state.running.reason !== "manual"
                    ? this.t(" · 已排队手动同步", " · manual queued")
                    : "";
            this.subtitleEl.setText(
                `${this.supervisor.reasonText(state.running.reason)} · ${this.t(
                    `已 ${elapsed} 秒`,
                    `${elapsed} s`
                )}${queuedNote}`
            );
            if (this.liveProgressEl) {
                const detail = [
                    state.running.step,
                    state.running.progress?.label,
                ]
                    .filter((x): x is string => Boolean(x))
                    .join(" · ");
                this.liveProgressEl.setText(
                    detail ||
                        this.t("正在执行同步步骤…", "Executing sync step…")
                );
            }
            if (this.barTrackEl && this.barFillEl) {
                const pct = state.running.progress?.percent;
                if (pct !== undefined) {
                    this.barTrackEl.removeClass("is-indeterminate");
                    this.barFillEl.style.width = `${pct}%`;
                } else {
                    this.barTrackEl.addClass("is-indeterminate");
                    this.barFillEl.style.width = "40%";
                }
            }
        } else if (
            state.phase === "waiting" &&
            state.problem &&
            this.subtitleEl
        ) {
            const problemTitle = problemText(
                state.problem,
                this.supervisor.language
            ).title;
            this.subtitleEl.setText(
                `${problemTitle} · ${this.nextStep(state)}`
            );
        }

        if (this.syncNowBtn) {
            if (state.phase === "syncing" && state.running) {
                if (
                    state.running.reason === "manual" ||
                    state.running.queuedManual
                ) {
                    this.syncNowBtn.disabled = true;
                    this.syncNowBtn.setText(
                        state.running.queuedManual &&
                            state.running.reason !== "manual"
                            ? this.t("已排队手动同步…", "Manual sync queued…")
                            : this.t("同步进行中…", "Syncing…")
                    );
                } else {
                    this.syncNowBtn.disabled = false;
                    this.syncNowBtn.setText(
                        this.t("排队立即同步", "Queue manual sync")
                    );
                }
            } else {
                this.syncNowBtn.disabled = false;
                this.syncNowBtn.setText(this.t("立即同步", "Sync now"));
            }
        }
    }

    private renderProblem(root: HTMLElement, state: SyncStateSnapshot): void {
        const problem = state.problem!;
        const text = problemText(
            problem,
            this.supervisor.language,
            state.weakNetworkMode
        );
        const box = root.createDiv({
            cls: `git-maintained-sync-problem ${problem.needsUser ? "is-attention" : "is-waiting"}`,
        });
        box.createDiv({
            cls: "git-maintained-sync-problem-title",
            text: text.title,
        });
        box.createDiv({ text: text.explain });
        box.createDiv({
            cls: "git-maintained-sync-problem-action",
            text: this.t(
                `怎么办：${text.action}`,
                `What to do: ${text.action}`
            ),
        });
        if (
            problem.kind === "conflict" ||
            problem.kind === "merge-in-progress" ||
            problem.kind === "local-changes" ||
            problem.kind === "untracked-collision"
        ) {
            const actionRow = box.createDiv({
                cls: "git-maintained-sync-problem-actions",
            });
            const isConflict =
                problem.kind === "conflict" ||
                problem.kind === "merge-in-progress";
            const rescueBtn = actionRow.createEl("button", {
                cls: "mod-cta",
                text: isConflict
                    ? this.t(
                          "备份冲突改动并以远端为准同步",
                          "Backup conflicts & sync with remote"
                      )
                    : this.t(
                          "一键备份阻塞改动并继续同步",
                          "Backup blocking changes & sync"
                      ),
            });
            rescueBtn.addEventListener("click", () => {
                if (isConflict) {
                    this.plugin.promiseQueue.addTask(() =>
                        this.plugin.gitActions.rescueConflictsAndSync({
                            interactive: true,
                        })
                    );
                    return;
                }
                void (async () => {
                    if (!this.plugin.settings.rescueFolder.trim()) {
                        this.plugin.settings.rescueFolder = "_冲突备份";
                        await this.plugin.saveSettings();
                    }
                    this.supervisor.requestSync("manual");
                })();
            });

            const discardBtn = actionRow.createEl("button", {
                cls: "mod-warning",
                text: this.t("放弃本地未提交改动", "Discard local changes"),
            });
            discardBtn.addEventListener("click", () => {
                this.plugin.promiseQueue.addTask(() =>
                    this.plugin.gitActions.discardAll(undefined, {
                        interactive: true,
                    })
                );
            });
        }
        box.createDiv({
            cls: "git-maintained-sync-muted",
            text: this.t(
                `从 ${this.when(problem.since)} 开始，已经 ${problem.attempts} 次`,
                `Since ${this.when(problem.since)}, ${problem.attempts} ${problem.attempts === 1 ? "time" : "times"}`
            ),
        });
        if (problem.files.length > 0) {
            const files = box.createEl("ul");
            for (const file of problem.files.slice(0, 20)) {
                files.createEl("li", { text: file });
            }
            if (problem.files.length > 20) {
                files.createEl("li", {
                    text: this.t(
                        `……还有 ${problem.files.length - 20} 个`,
                        `… and ${problem.files.length - 20} more`
                    ),
                });
            }
        }
        if (problem.raw) {
            const raw = box.createEl("details");
            raw.createEl("summary", {
                text: this.t("原始错误信息", "Original error"),
            });
            raw.createEl("pre", { text: problem.raw });
        }
    }

    private renderFacts(root: HTMLElement, state: SyncStateSnapshot): void {
        const facts = root.createDiv({ cls: "git-maintained-sync-facts" });
        const row = (name: string, value: string) => {
            const line = facts.createDiv({ cls: "git-maintained-sync-fact" });
            line.createSpan({ cls: "git-maintained-sync-muted", text: name });
            line.createSpan({ text: value });
        };
        const never = this.t("还没有", "never");
        row(
            this.t("最近一次成功同步", "Last successful sync"),
            state.lastSuccessAt ? this.when(state.lastSuccessAt) : never
        );
        row(
            this.t("最近一次上传", "Last push"),
            state.lastPushAt ? this.when(state.lastPushAt) : never
        );
        row(
            this.t("最近一次拉取", "Last pull"),
            state.lastPullAt ? this.when(state.lastPullAt) : never
        );
        row(
            this.t("还没上传的提交", "Commits not uploaded"),
            state.ahead === undefined ? "?" : String(state.ahead)
        );
        row(
            this.t("还没提交的改动", "Edits not committed"),
            state.pendingEdits ? this.t("有", "yes") : this.t("没有", "no")
        );
        row(
            this.t("网络", "Network"),
            state.online ? this.t("在线", "online") : this.t("离线", "offline")
        );
        row(
            this.t("后台联网", "Network in the background"),
            {
                unknown: this.t("还不知道", "not known yet"),
                allowed: this.t("可以（锁屏后也能上传）", "allowed"),
                blocked: this.t(
                    "被系统拦截（锁屏后传不上去，回来才传）",
                    "blocked by Android (uploads wait for your return)"
                ),
            }[state.background]
        );
        const on = this.t("开", "on");
        const off = this.t("关", "off");
        row(
            this.t("弱网模式", "Weak network mode"),
            state.weakNetworkMode ? on : off
        );
        row(
            this.t("离开和回来时同步", "Sync when leaving and returning"),
            state.syncOnLeave ? on : off
        );
        if (Platform.isMobileApp) {
            row(
                this.t("上传时屏幕常亮", "Screen kept on while uploading"),
                this.plugin.settings.keepAwakeWhileSyncing
                    ? this.supervisor.keepingAwake
                        ? this.t("开（现在亮着）", "on (now)")
                        : on
                    : off
            );
        }
        if (state.background === "blocked") {
            facts.createDiv({
                cls: "git-maintained-sync-hint",
                text: problemText(
                    {
                        kind: "background-blocked",
                        retryable: true,
                        needsUser: false,
                        files: [],
                        raw: "",
                    },
                    this.supervisor.language
                ).action,
            });
        }
    }

    private renderHistory(
        root: HTMLElement,
        entries: readonly SyncLogEntry[]
    ): void {
        root.createEl("h4", {
            text: this.t(
                "历史记录（这台设备，最近 300 条，重启后还在）",
                "History (this device, latest 300, kept across restarts)"
            ),
        });
        if (entries.length === 0) {
            root.createDiv({
                cls: "git-maintained-sync-muted",
                text: this.t("还没有记录", "Nothing yet"),
            });
            return;
        }
        const list = root.createDiv({ cls: "git-maintained-sync-history" });
        for (const entry of [...entries].reverse().slice(0, 100)) {
            const item = list.createDiv({
                cls: `git-maintained-sync-entry is-${entry.level}`,
            });
            const head = item.createDiv({
                cls: "git-maintained-sync-entry-head",
            });
            const icon = head.createSpan({
                cls: "git-maintained-sync-entry-icon",
            });
            setIcon(
                icon,
                {
                    info: "info",
                    success: "check",
                    warning: "alert-circle",
                    error: "x-circle",
                }[entry.level]
            );
            head.createSpan({
                cls: "git-maintained-sync-muted",
                text: this.format(entry.t),
            });
            item.createDiv({ text: entry.text });
            if (entry.detail) {
                const detail = item.createEl("details");
                detail.createEl("summary", { text: this.t("详情", "Details") });
                detail.createEl("pre", { text: entry.detail });
            }
        }
    }

    /** Date and time, plus how long ago. */
    private when(t: number): string {
        const seconds = Math.round((Date.now() - t) / 1000);
        let ago: string;
        if (seconds < 60) {
            ago = this.t("刚刚", "just now");
        } else if (seconds < 3600) {
            const minutes = Math.round(seconds / 60);
            ago = this.t(`${minutes} 分钟前`, `${minutes} min ago`);
        } else if (seconds < 86_400) {
            const hours = Math.round(seconds / 3600);
            ago = this.t(`${hours} 小时前`, `${hours} h ago`);
        } else {
            const days = Math.round(seconds / 86_400);
            ago = this.t(`${days} 天前`, `${days} days ago`);
        }
        return `${this.format(t)}（${ago}）`;
    }

    private format(t: number): string {
        const date = new Date(t);
        const pad = (value: number) => String(value).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
}
