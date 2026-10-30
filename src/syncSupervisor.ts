import { Errors } from "isomorphic-git";
import type { WorkspaceLeaf } from "obsidian";
import { Notice, Platform, setIcon } from "obsidian";
import {
    createAutoCommitPathSelector,
    parseAutoCommitGlobs,
} from "./autoCommitGlobs";
import { SYNC_STATUS_VIEW_CONFIG } from "./constants";
import type { GitActionResult } from "./gitAction";
import type { PullRecovery } from "./gitManager/gitManager";
import type ObsidianGit from "./main";
import {
    BATTERY_HINT,
    classifySyncError,
    isNetworkProblem,
    problemText,
    syncLanguage,
    type Language,
    type SyncProblem,
} from "./syncProblems";
import type {
    CommitAndSyncResult,
    CommitResult,
    PullResult,
    PushResult,
} from "./types";

/**
 * obsidian-git-Maintained: watches every sync and keeps a history of it on
 * this device. With weak network mode or syncing on leave turned on it also
 * acts: it retries failed syncs, syncs when Obsidian goes to the background
 * and comes back, keeps the screen on while there is something to upload,
 * and replaces scattered error pop-ups with one notice that opens the sync
 * status view.
 *
 * Measured on Android 15 (AME-1119): JavaScript and file writes go on in the
 * background, but about 5 s after Obsidian leaves the foreground (at once
 * while battery saver is on) the system cuts off its network, unless its
 * battery usage is "Unrestricted". A sync started on leaving therefore always
 * commits on the device, and uploads at once only where the system allows
 * it; otherwise it uploads as soon as Obsidian is back.
 */

export type SyncReason =
    "auto" | "manual" | "leave" | "resume" | "online" | "retry" | "startup";

export type SyncPhase =
    "syncing" | "attention" | "waiting" | "pending" | "idle";

/** Whether Android let Obsidian use the network in the background. */
export type BackgroundNetwork = "unknown" | "allowed" | "blocked";

export interface SyncLogEntry {
    /** Epoch milliseconds. */
    t: number;
    level: "info" | "success" | "warning" | "error";
    text: string;
    detail?: string;
}

export interface SyncProblemState extends SyncProblem {
    since: number;
    lastAt: number;
    attempts: number;
}

export interface SyncStateSnapshot {
    phase: SyncPhase;
    running?: { reason: SyncReason; startedAt: number };
    problem?: SyncProblemState;
    nextRetryAt?: number;
    pendingEdits: boolean;
    ahead?: number;
    online: boolean;
    visible: boolean;
    background: BackgroundNetwork;
    lastSuccessAt?: number;
    lastPushAt?: number;
    lastPullAt?: number;
    lastCheckAt?: number;
    weakNetworkMode: boolean;
    syncOnLeave: boolean;
}

interface RunRecord {
    reason: SyncReason;
    startedAt: number;
    hiddenAtStart: boolean;
    committed: number;
    pulled: number;
    pushed: number | null;
    pushedAny: boolean;
}

interface StoredState {
    version: 1;
    entries: SyncLogEntry[];
    problem?: SyncProblemState;
    lastSuccessAt?: number;
    lastPushAt?: number;
    lastPullAt?: number;
    lastBatteryHintAt?: number;
    background?: BackgroundNetwork;
}

interface ListenerHandle {
    remove(): Promise<void> | void;
}

interface CapacitorPlugins {
    App?: {
        addListener(
            event: "pause" | "resume",
            callback: () => void
        ): Promise<ListenerHandle> | ListenerHandle;
    };
    KeepAwake?: {
        keepAwake(): Promise<void>;
        allowSleep(): Promise<void>;
        isKeptAwake(): Promise<{ isKeptAwake: boolean }>;
    };
}

function capacitor(): CapacitorPlugins | undefined {
    return (window as unknown as { Capacitor?: { Plugins?: CapacitorPlugins } })
        .Capacitor?.Plugins;
}

const MAX_LOG_ENTRIES = 300;
/** Delays of the automatic retries in weak network mode; the last repeats. */
export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
/** An unexplained error is retried this many times, then reported. */
export const MAX_OTHER_ATTEMPTS = 5;
/** Without an `online` event, an offline sync is tried again after this. */
export const OFFLINE_FALLBACK_MS = 300_000;
/** The screen is kept on at most this long after the last edit. */
export const KEEP_AWAKE_MAX_MS = 120_000;
/** A failure lasting this long, with something to upload, is announced once. */
export const LONG_PROBLEM_MS = 10 * 60_000;
/** Coming back to Obsidian pulls when the last pull is older than this. */
export const RESUME_PULL_AFTER_MS = 2 * 60_000;
/** The battery hint pops up at most once in this period. */
const BATTERY_HINT_EVERY_MS = 7 * 24 * 60 * 60_000;
/** How long a file the plugin writes is expected to come back as an event. */
const ECHO_MS = 30_000;

export class SyncSupervisor {
    private active = false;
    private registered = false;
    private loaded = false;
    private startedOnce = false;
    private log: SyncLogEntry[] = [];
    private readonly listeners = new Set<() => void>();
    private problem?: SyncProblemState;
    private run?: RunRecord;
    private queued = false;
    private retryTimer?: number;
    private nextRetryAt?: number;
    private pendingEdits = false;
    private editCounter = 0;
    private editsAtCommitStart = 0;
    private lastEditAt?: number;
    /** Vault paths written by a pull, until their vault event comes. */
    private readonly echoes = new Map<string, number>();
    private selector?: { key: string; select: (path: string) => boolean };
    private ahead?: number;
    private background: BackgroundNetwork = "unknown";
    private lastSuccessAt?: number;
    private lastPushAt?: number;
    private lastPullAt?: number;
    private lastCheckAt?: number;
    private lastBatteryHintAt?: number;
    private visible = true;
    /** The problem the last "needs you" notice was about. */
    private noticeFor?: string;
    private longNoticeShown = false;
    private awakeHeld = false;
    private awakeTimer?: number;
    private ribbonEl?: HTMLElement;

    constructor(private readonly plugin: ObsidianGit) {}

    // region: lifecycle

    /** Registers DOM and app events once; they stay for the plugin's life. */
    register(): void {
        if (this.registered) return;
        this.registered = true;
        this.visible = !isHidden();
        this.plugin.registerDomEvent(document, "visibilitychange", () => {
            if (isHidden()) this.onLeave();
            else this.onReturn();
        });
        this.plugin.registerDomEvent(window, "online", () => this.onOnline());
        this.plugin.registerDomEvent(window, "offline", () => this.emit());
        const app = capacitor()?.App;
        if (app) {
            const listen = (event: "pause" | "resume", callback: () => void) =>
                void Promise.resolve(app.addListener(event, callback)).then(
                    (handle) =>
                        this.plugin.register(() => void handle.remove()),
                    (error) => console.error(error)
                );
            // On Android, `pause` comes about 0.7 s before visibilitychange.
            listen("pause", () => this.onLeave());
            listen("resume", () => this.onReturn());
        }
    }

    /** Called whenever Git is ready (again). */
    start(): void {
        this.active = true;
        this.load();
        this.ensureRibbon();
        const first = !this.startedOnce;
        this.startedOnce = true;
        this.plugin.promiseQueue.addTask(async () => {
            await this.refreshAhead();
            this.emit();
            if (!this.managing) return;
            if (first && (this.ahead ?? 0) > 0) {
                this.requestSync("startup");
            } else if (this.problem?.retryable) {
                this.scheduleRetry();
            }
        });
        this.emit();
    }

    /** Called when Git is unloaded or reloaded. */
    stop(): void {
        this.active = false;
        // `unloadPlugin` clears the promise queue.
        this.queued = false;
        this.clearRetryTimer();
        window.clearTimeout(this.awakeTimer);
        void this.releaseKeepAwake();
        this.save();
        this.emit();
    }

    /** Whether the supervisor acts, not only records. */
    get managing(): boolean {
        const settings = this.plugin.settings;
        return settings.weakNetworkMode || settings.syncOnLeave;
    }

    private ensureRibbon(): void {
        if (this.ribbonEl || !this.managing) return;
        this.ribbonEl = this.plugin.addRibbonIcon(
            SYNC_STATUS_VIEW_CONFIG.icon,
            this.text("同步状态", "Sync status"),
            () => void this.openView()
        );
        this.renderRibbon();
    }

    // endregion

    // region: state for the view

    get language(): Language {
        return syncLanguage();
    }

    text(zh: string, en: string): string {
        return this.language === "zh" ? zh : en;
    }

    get phase(): SyncPhase {
        if (this.run) return "syncing";
        if (this.problem?.needsUser) return "attention";
        if (this.problem) return "waiting";
        if (this.pendingEdits || (this.ahead ?? 0) > 0) return "pending";
        return "idle";
    }

    snapshot(): SyncStateSnapshot {
        return {
            phase: this.phase,
            running: this.run && {
                reason: this.run.reason,
                startedAt: this.run.startedAt,
            },
            problem: this.problem && { ...this.problem },
            nextRetryAt: this.nextRetryAt,
            pendingEdits: this.pendingEdits,
            ahead: this.ahead,
            online: isOnline(),
            visible: this.visible,
            background: this.background,
            lastSuccessAt: this.lastSuccessAt,
            lastPushAt: this.lastPushAt,
            lastPullAt: this.lastPullAt,
            lastCheckAt: this.lastCheckAt,
            weakNetworkMode: this.plugin.settings.weakNetworkMode,
            syncOnLeave: this.plugin.settings.syncOnLeave,
        };
    }

    get entries(): readonly SyncLogEntry[] {
        return this.log;
    }

    /**
     * Whether Obsidian is in the background. Capacitor's `pause` and
     * `resume` come before `visibilitychange`, so this is ahead of
     * `document.visibilityState`.
     */
    get inBackground(): boolean {
        return !this.visible;
    }

    /** Whether this plugin keeps the screen on right now. */
    get keepingAwake(): boolean {
        return this.awakeHeld;
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        this.renderRibbon();
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                console.error(error);
            }
        }
    }

    private renderRibbon(): void {
        if (!this.ribbonEl) return;
        const icon = {
            syncing: "refresh-cw",
            attention: "alert-triangle",
            waiting: isOnline() ? "clock" : "cloud-off",
            pending: "upload-cloud",
            idle: "check-circle",
        }[this.phase];
        setIcon(this.ribbonEl, icon);
    }

    async openView(): Promise<void> {
        const workspace = this.plugin.app.workspace;
        let leaf: WorkspaceLeaf | undefined = workspace
            .getLeavesOfType(SYNC_STATUS_VIEW_CONFIG.type)
            .first();
        if (!leaf) {
            leaf = workspace.getLeaf(true);
            await leaf.setViewState({
                type: SYNC_STATUS_VIEW_CONFIG.type,
                active: true,
            });
        }
        await workspace.revealLeaf(leaf);
    }

    /** The state and the latest history as plain text, for "Copy details". */
    details(): string {
        const state = this.snapshot();
        const time = (t?: number) =>
            t === undefined ? "-" : new Date(t).toLocaleString();
        const problem = state.problem;
        return [
            `${this.plugin.manifest.name} ${this.plugin.manifest.version}`,
            `phase: ${state.phase}`,
            `problem: ${problem ? `${problem.kind} x${problem.attempts} since ${time(problem.since)}: ${problem.raw}` : "-"}`,
            `files: ${problem?.files.join(", ") || "-"}`,
            `next retry: ${time(state.nextRetryAt)}`,
            `pending edits: ${state.pendingEdits}; commits to upload: ${state.ahead ?? "-"}`,
            `online: ${state.online}; visible: ${state.visible}; background network: ${state.background}`,
            `last success: ${time(state.lastSuccessAt)}; last push: ${time(state.lastPushAt)}; last pull: ${time(state.lastPullAt)}`,
            `weak network mode: ${state.weakNetworkMode}; sync on leave: ${state.syncOnLeave}`,
            "",
            ...this.log
                .slice(-60)
                .map(
                    (entry) =>
                        `${time(entry.t)} [${entry.level}] ${entry.text}${entry.detail ? `\n    ${entry.detail.replace(/\n/g, "\n    ")}` : ""}`
                ),
        ].join("\n");
    }

    // endregion

    // region: triggers

    /**
     * A vault file was created, modified, deleted or renamed. Returns whether
     * it is an edit an automatic commit could pick up (and not the plugin's
     * own write).
     */
    noteVaultChange(vaultPath: string, oldPath?: string): boolean {
        if (!this.active || !this.plugin.gitReady) return false;
        const paths =
            oldPath === undefined ? [vaultPath] : [vaultPath, oldPath];
        const edits = paths.filter(
            (path) => !this.isEcho(path) && this.isCommitCandidate(path)
        );
        if (edits.length === 0) return false;
        this.pendingEdits = true;
        this.editCounter++;
        this.lastEditAt = Date.now();
        void this.updateKeepAwake();
        this.emit();
        return true;
    }

    /** The plugin is about to write these repository paths (a pull). */
    expectWrites(repoPaths: readonly string[]): void {
        const now = Date.now();
        for (const [path, until] of this.echoes) {
            if (until <= now) this.echoes.delete(path);
        }
        for (const path of repoPaths) {
            this.echoes.set(
                this.plugin.gitManager.getRelativeVaultPath(path),
                now + ECHO_MS
            );
        }
    }

    private isEcho(vaultPath: string): boolean {
        const until = this.echoes.get(vaultPath);
        if (until === undefined) return false;
        this.echoes.delete(vaultPath);
        return until > Date.now();
    }

    /** Whether an automatic commit could stage this vault path. */
    isCommitCandidate(vaultPath: string): boolean {
        const { autoCommitGlobMode: mode, autoCommitGlobs } =
            this.plugin.settings;
        const key = `${mode}\n${autoCommitGlobs}`;
        if (this.selector?.key !== key) {
            const globs = parseAutoCommitGlobs(autoCommitGlobs);
            this.selector = {
                key,
                select:
                    mode !== "include" && globs.length === 0
                        ? () => true
                        : createAutoCommitPathSelector({ mode, globs }),
            };
        }
        let repoPath: string;
        try {
            repoPath = this.plugin.gitManager.getRelativeRepoPath(
                vaultPath,
                true
            );
        } catch {
            return true;
        }
        return this.selector.select(repoPath);
    }

    /** Obsidian went to the background (screen locked, app switched). */
    onLeave(): void {
        if (!this.visible) return;
        this.visible = false;
        window.clearTimeout(this.awakeTimer);
        void this.releaseKeepAwake();
        this.save();
        this.emit();
        if (!this.active || !this.plugin.settings.syncOnLeave) return;
        if (
            this.pendingEdits ||
            (this.ahead ?? 0) > 0 ||
            this.problem?.retryable
        ) {
            // Do now what the edit timer would do later.
            this.plugin.autoCommitDebouncer?.cancel();
            this.requestSync("leave");
        }
    }

    /** Obsidian is in the foreground again. */
    onReturn(): void {
        if (this.visible) return;
        this.visible = true;
        this.emit();
        if (!this.active || !this.managing) return;
        const syncOnLeave = this.plugin.settings.syncOnLeave;
        if (syncOnLeave) this.maybeShowBatteryHint();
        const pullDue =
            this.lastPullAt === undefined ||
            Date.now() - this.lastPullAt > RESUME_PULL_AFTER_MS;
        if (
            this.problem?.retryable ||
            (syncOnLeave &&
                (this.pendingEdits || (this.ahead ?? 0) > 0 || pullDue))
        ) {
            this.requestSync("resume");
        }
        void this.updateKeepAwake();
    }

    private onOnline(): void {
        this.emit();
        if (!this.active || !this.plugin.settings.weakNetworkMode) return;
        if (this.problem?.retryable) this.requestSync("online");
    }

    /** Queues one commit-and-sync, unless one is already waiting. */
    requestSync(reason: SyncReason): void {
        if (!this.active || !this.plugin.gitReady || this.queued) return;
        if (
            reason !== "manual" &&
            this.plugin.localStorage.getPausedAutomatics()
        ) {
            return;
        }
        this.queued = true;
        this.clearRetryTimer();
        this.plugin.promiseQueue.addTask(async () => {
            this.queued = false;
            if (!this.active) return;
            await this.plugin.gitActions.commitAndSync({
                fromAutoBackup: true,
                mode: "all",
                reason,
            });
        });
    }

    private maybeShowBatteryHint(): void {
        if (
            this.background !== "blocked" ||
            (this.lastBatteryHintAt !== undefined &&
                Date.now() - this.lastBatteryHintAt < BATTERY_HINT_EVERY_MS)
        ) {
            return;
        }
        this.lastBatteryHintAt = Date.now();
        this.save();
        this.notice(
            this.text(
                `Git：锁屏或切到别的应用后，系统断开了 Obsidian 的网络。改动已在手机上提交，现在上传。${BATTERY_HINT.zh}`,
                `Git: Android cut off Obsidian's network in the background. Your changes were committed on this device and are uploaded now. ${BATTERY_HINT.en}`
            ),
            15_000
        );
    }

    // endregion

    // region: hooks called by GitActions and the mobile backend

    /** A commit-and-sync starts. */
    syncStarted(fromAuto: boolean, reason?: SyncReason): void {
        this.run = {
            reason: reason ?? (fromAuto ? "auto" : "manual"),
            startedAt: Date.now(),
            hiddenAtStart: !this.visible,
            committed: 0,
            pulled: 0,
            pushed: null,
            pushedAny: false,
        };
        void this.updateKeepAwake();
        this.emit();
    }

    /** A commit-and-sync ended. Runs inside the promise queue. */
    async syncFinished(
        result: GitActionResult<CommitAndSyncResult>
    ): Promise<void> {
        const run = this.run;
        this.run = undefined;
        this.lastCheckAt = Date.now();
        if (run && result.status === "success") {
            const value = result.value;
            switch (value.status) {
                case "synced":
                case "nothing-to-push":
                case "commit-only":
                    this.succeeded(run);
                    break;
                case "skipped":
                    if (value.reason === "push-skipped") {
                        this.addLog(
                            "warning",
                            this.text(
                                "提交了，但没有上传：没有设置上游分支，或推送被挡住",
                                "Committed, but not pushed: no upstream branch, or the push was blocked"
                            )
                        );
                    }
                    break;
            }
        }
        await this.refreshAhead();
        void this.updateKeepAwake();
        this.save();
        this.emit();
    }

    /** Called at the start of every commit, to know which edits it saw. */
    beforeCommit(): void {
        this.editsAtCommitStart = this.editCounter;
    }

    recordCommit(result: CommitResult): void {
        if (
            (result.status === "committed" ||
                result.status === "nothing-to-commit") &&
            this.editCounter === this.editsAtCommitStart
        ) {
            this.pendingEdits = false;
        }
        if (result.status !== "committed") {
            this.emit();
            return;
        }
        this.ahead = (this.ahead ?? 0) + 1;
        if (this.run) {
            this.run.committed += result.files;
        } else {
            this.addLog(
                "success",
                this.text(
                    `提交了 ${result.files} 个文件`,
                    `Committed ${result.files} ${result.files === 1 ? "file" : "files"}`
                )
            );
        }
        this.emit();
    }

    recordPull(result: PullResult): void {
        if (result.status !== "updated" && result.status !== "up-to-date") {
            return;
        }
        this.lastPullAt = Date.now();
        const files =
            result.status === "updated"
                ? result.files.length + result.outsideVault
                : 0;
        if (this.run) {
            this.run.pulled += files;
        } else {
            if (files > 0) {
                this.addLog(
                    "success",
                    this.text(
                        `拉下来 ${files} 个文件`,
                        `Pulled ${files} ${files === 1 ? "file" : "files"}`
                    )
                );
            }
            this.networkWorks();
        }
        this.emit();
    }

    recordPush(result: PushResult): void {
        if (result.status !== "pushed" && result.status !== "up-to-date") {
            return;
        }
        this.ahead = 0;
        if (result.status === "pushed") {
            this.lastPushAt = Date.now();
            if (this.run) {
                this.run.pushedAny = true;
                this.run.pushed = (this.run.pushed ?? 0) + (result.files ?? 0);
            } else {
                this.addLog("success", this.text("上传成功", "Pushed"));
            }
        }
        if (!this.run) this.networkWorks();
        this.emit();
    }

    /** What the mobile backend did about a pull cut off half-way. */
    recordPullRecovery(recovery: PullRecovery): void {
        if (recovery.resumed) {
            this.addLog(
                "warning",
                this.text(
                    `上一次拉取在写文件时被打断了（Obsidian 被关掉，或在后台被系统停住），已经接着做完：${recovery.files} 个文件`,
                    `A pull was cut off while writing files (Obsidian was closed or stopped in the background); it was finished now: ${recovery.files} files`
                ),
                recovery.restored.join("\n") || undefined
            );
        } else if (recovery.restored.length > 0) {
            this.addLog(
                "warning",
                this.text(
                    `${recovery.restored.length} 个文件是被打断的拉取留下的半成品（内容和 GitHub 上历史中的某个版本完全一样，不是手机上的改动），已复原，拉取继续`,
                    `${recovery.restored.length} files were left half-updated by a pull that was cut off (their content is a version from the history, not a local edit); they were reset and the pull went on`
                ),
                recovery.restored.join("\n")
            );
            this.notice(
                this.text(
                    `Git：修好了一次被打断的拉取留下的 ${recovery.restored.length} 个文件，同步继续。`,
                    `Git: repaired ${recovery.restored.length} files left by a pull that was cut off; syncing goes on.`
                ),
                8000
            );
        }
        if (recovery.rescued.length > 0) {
            const copies = recovery.rescued.map(({ path, copy }) =>
                copy === ""
                    ? this.text(
                          `${path}（手机上删掉了它，已恢复）`,
                          `${path} (deleted here; restored)`
                      )
                    : `${path} → ${copy}`
            );
            this.addLog(
                "warning",
                this.text(
                    `${recovery.rescued.length} 个文件在手机上有不在任何提交里的改动，挡住了拉取：改动已另存到救援文件夹，原文件换成仓库里的版本。另存的副本随下一次同步上传`,
                    `${recovery.rescued.length} local changes that are in no commit stood in the way of the pull: they were copied into the rescue folder and the files reset. The copies are uploaded with the next sync`
                ),
                copies.join("\n")
            );
            this.notice(
                this.text(
                    `Git：手机上有 ${recovery.rescued.length} 个文件的改动挡住了拉取，已另存到「${this.plugin.settings.rescueFolder}」，随下一次同步上传。点这里看详情。`,
                    `Git: ${recovery.rescued.length} local changes were in the way of the pull and were copied to "${this.plugin.settings.rescueFolder}"; they are uploaded with the next sync. Tap for details.`
                ),
                0
            );
        }
        this.save();
        this.emit();
    }

    /**
     * Sees the error of a commit, pull, push or commit-and-sync before it is
     * reported. Returns true when the usual pop-up should be skipped because
     * the supervisor takes care of the error.
     */
    observeError(error: unknown): boolean {
        if (error instanceof Errors.UserCanceledError) return false;
        const classified = classifySyncError(error, {
            online: isOnline(),
            hidden: !this.visible || this.run?.hiddenAtStart === true,
        });
        const now = Date.now();
        const previous = this.problem;
        const same = previous?.kind === classified.kind;
        const state: SyncProblemState = {
            ...classified,
            since: same ? previous.since : now,
            lastAt: now,
            attempts: same ? previous.attempts + 1 : 1,
        };
        if (state.kind === "other" && state.attempts >= MAX_OTHER_ATTEMPTS) {
            state.retryable = false;
            state.needsUser = true;
        }
        if (!same) this.longNoticeShown = false;
        this.problem = state;
        if (state.kind === "background-blocked") this.background = "blocked";
        const prefix = this.run
            ? this.reasonText(this.run.reason) +
              this.text("失败：", " failed: ")
            : "";
        this.addLog(
            state.needsUser ? "error" : "warning",
            prefix + problemText(state, this.language).title,
            [state.raw, ...state.files].filter(Boolean).join("\n")
        );
        if (this.plugin.settings.weakNetworkMode) this.scheduleRetry();
        this.announce(state);
        this.save();
        this.emit();
        if (!this.managing) return false;
        switch (state.kind) {
            case "background-blocked":
                // Expected when syncing on leave; retried on return.
                return true;
            case "offline":
            case "network":
            case "push-rejected":
                return this.plugin.settings.weakNetworkMode;
            case "conflict":
                // Upstream's conflict handling stays as it is.
                return false;
            case "auth":
            case "not-found":
            case "local-changes":
            case "untracked-collision":
            case "merge-in-progress":
            case "config":
            case "other":
                // The supervisor's own notice replaces the pop-up.
                return state.needsUser;
        }
    }

    // endregion

    // region: problems, retries, notices

    private succeeded(run: RunRecord): void {
        const now = Date.now();
        // Started and ended in the background: the network worked there.
        const hidden = run.hiddenAtStart && !this.visible;
        const problem = this.problem;
        this.lastSuccessAt = now;
        if (hidden && (run.pushedAny || run.pulled > 0)) {
            this.background = "allowed";
        }
        const parts: string[] = [];
        if (run.committed > 0) {
            parts.push(
                this.text(
                    `提交 ${run.committed} 个文件`,
                    `committed ${run.committed}`
                )
            );
        }
        if (run.pulled > 0) {
            parts.push(
                this.text(`拉下 ${run.pulled} 个文件`, `pulled ${run.pulled}`)
            );
        }
        if (run.pushedAny) {
            parts.push(
                run.pushed
                    ? this.text(
                          `上传 ${run.pushed} 个文件的改动`,
                          `pushed changes to ${run.pushed}`
                      )
                    : this.text("上传成功", "pushed")
            );
        }
        if (parts.length > 0 || problem) {
            this.addLog(
                "success",
                this.reasonText(run.reason) +
                    this.text("：", ": ") +
                    (parts.length > 0
                        ? parts.join(this.text("，", ", "))
                        : this.text("没有变化", "no changes")) +
                    (hidden
                        ? this.text("（在后台完成）", " (in the background)")
                        : "")
            );
        }
        if (
            problem &&
            (this.noticeFor !== undefined ||
                this.longNoticeShown ||
                now - problem.since > 60_000)
        ) {
            this.notice(
                this.text("Git：同步恢复正常。", "Git: syncing works again."),
                6000
            );
        }
        this.clearProblem();
        this.noticeFor = undefined;
        this.longNoticeShown = false;
    }

    /** A standalone pull or push worked: network problems are over. */
    private networkWorks(): void {
        if (this.problem && isNetworkProblem(this.problem.kind)) {
            this.clearProblem();
            if (this.managing && (this.ahead ?? 0) > 0) {
                this.requestSync("online");
            }
        }
    }

    private clearProblem(): void {
        this.problem = undefined;
        this.clearRetryTimer();
    }

    private scheduleRetry(): void {
        this.clearRetryTimer();
        const problem = this.problem;
        if (!this.active || !problem?.retryable) return;
        let delay: number;
        if (problem.kind === "offline") {
            delay = OFFLINE_FALLBACK_MS;
        } else if (problem.kind === "background-blocked" && !this.visible) {
            // A retry in the background meets the same block; coming back
            // to Obsidian retries.
            return;
        } else {
            delay =
                RETRY_DELAYS_MS[
                    Math.min(problem.attempts, RETRY_DELAYS_MS.length) - 1
                ]!;
        }
        this.nextRetryAt = Date.now() + delay;
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = undefined;
            this.nextRetryAt = undefined;
            this.requestSync("retry");
        }, delay);
    }

    private clearRetryTimer(): void {
        if (this.retryTimer !== undefined) {
            window.clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.nextRetryAt = undefined;
    }

    private announce(problem: SyncProblemState): void {
        if (!this.managing) return;
        const title = problemText(problem, this.language).title;
        if (problem.needsUser) {
            // Upstream already explains conflicts.
            if (problem.kind === "conflict") return;
            const signature = `${problem.kind}:${problem.files.join("|")}`;
            if (this.noticeFor === signature) return;
            this.noticeFor = signature;
            this.notice(
                this.text(
                    `Git：${title}。点这里看怎么处理。`,
                    `Git: ${title}. Tap to see what to do.`
                ),
                0
            );
            return;
        }
        const minutes = Math.round((Date.now() - problem.since) / 60_000);
        if (
            !this.longNoticeShown &&
            Date.now() - problem.since >= LONG_PROBLEM_MS &&
            (this.pendingEdits || (this.ahead ?? 0) > 0)
        ) {
            this.longNoticeShown = true;
            this.notice(
                this.text(
                    `Git：已经 ${minutes} 分钟没能上传（${title}），会继续自动重试。点这里看同步状态。`,
                    `Git: nothing could be uploaded for ${minutes} minutes (${title}); retrying. Tap for the sync status.`
                ),
                0
            );
        }
    }

    private notice(message: string, duration: number): void {
        const notice = new Notice(message, duration);
        notice.messageEl.addEventListener("click", () => void this.openView());
    }

    reasonText(reason: SyncReason): string {
        const texts: Record<SyncReason, [string, string]> = {
            auto: ["自动同步", "Auto sync"],
            manual: ["手动同步", "Manual sync"],
            leave: ["离开 Obsidian 时同步", "Sync on leaving Obsidian"],
            resume: ["回到 Obsidian 时同步", "Sync on returning to Obsidian"],
            online: ["网络恢复后同步", "Sync after the network came back"],
            retry: ["自动重试", "Automatic retry"],
            startup: ["启动后补传", "Upload after startup"],
        };
        const [zh, en] = texts[reason];
        return this.text(zh, en);
    }

    // endregion

    // region: keeping the screen on

    private async updateKeepAwake(): Promise<void> {
        window.clearTimeout(this.awakeTimer);
        const sinceEdit =
            this.lastEditAt === undefined
                ? Infinity
                : Date.now() - this.lastEditAt;
        const want =
            this.active &&
            this.plugin.settings.keepAwakeWhileSyncing &&
            Platform.isMobileApp &&
            this.visible &&
            (this.pendingEdits || (this.ahead ?? 0) > 0) &&
            !this.problem?.needsUser &&
            sinceEdit < KEEP_AWAKE_MAX_MS;
        if (!want) {
            await this.releaseKeepAwake();
            return;
        }
        this.awakeTimer = window.setTimeout(
            () => void this.updateKeepAwake(),
            KEEP_AWAKE_MAX_MS - sinceEdit + 100
        );
        await this.acquireKeepAwake();
    }

    private async acquireKeepAwake(): Promise<void> {
        const keepAwake = capacitor()?.KeepAwake;
        if (!keepAwake || this.awakeHeld) return;
        try {
            // Somebody else keeps the screen on: leave that alone.
            if ((await keepAwake.isKeptAwake()).isKeptAwake) return;
            await keepAwake.keepAwake();
            this.awakeHeld = true;
        } catch (error) {
            console.error(error);
        }
    }

    private async releaseKeepAwake(): Promise<void> {
        const keepAwake = capacitor()?.KeepAwake;
        if (!keepAwake || !this.awakeHeld) return;
        this.awakeHeld = false;
        try {
            await keepAwake.allowSleep();
        } catch (error) {
            console.error(error);
        }
    }

    // endregion

    // region: history

    private async refreshAhead(): Promise<void> {
        if (!this.plugin.gitReady) return;
        try {
            this.ahead = await this.plugin.gitManager.commitsAhead();
        } catch (error) {
            console.error(error);
        }
    }

    private addLog(
        level: SyncLogEntry["level"],
        text: string,
        detail?: string
    ): void {
        this.log.push({ t: Date.now(), level, text, detail });
        if (this.log.length > MAX_LOG_ENTRIES) {
            this.log.splice(0, this.log.length - MAX_LOG_ENTRIES);
        }
        this.save();
    }

    /** Reads the history this device kept (local storage, not the vault). */
    private load(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = this.plugin.localStorage.getSyncLog();
            if (!raw) return;
            const stored = JSON.parse(raw) as Partial<StoredState>;
            if (Array.isArray(stored.entries)) {
                this.log = [...stored.entries, ...this.log].slice(
                    -MAX_LOG_ENTRIES
                );
            }
            this.problem ??= stored.problem;
            this.lastSuccessAt ??= stored.lastSuccessAt;
            this.lastPushAt ??= stored.lastPushAt;
            this.lastPullAt ??= stored.lastPullAt;
            this.lastBatteryHintAt ??= stored.lastBatteryHintAt;
            if (this.background === "unknown" && stored.background) {
                this.background = stored.background;
            }
        } catch (error) {
            console.error(error);
        }
    }

    private save(): void {
        if (!this.loaded) return;
        const stored: StoredState = {
            version: 1,
            entries: this.log,
            problem: this.problem,
            lastSuccessAt: this.lastSuccessAt,
            lastPushAt: this.lastPushAt,
            lastPullAt: this.lastPullAt,
            lastBatteryHintAt: this.lastBatteryHintAt,
            background: this.background,
        };
        try {
            this.plugin.localStorage.setSyncLog(JSON.stringify(stored));
        } catch (error) {
            console.error(error);
        }
    }

    /** Empties the history (the "Clear history" button). */
    clearLog(): void {
        this.log = [];
        this.save();
        this.emit();
    }

    // endregion
}

function isHidden(): boolean {
    return (
        typeof document !== "undefined" && document.visibilityState === "hidden"
    );
}

function isOnline(): boolean {
    return typeof navigator === "undefined" || navigator.onLine !== false;
}
