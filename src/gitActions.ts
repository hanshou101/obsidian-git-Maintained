import { Errors } from "isomorphic-git";
import { normalizePath, Notice, Platform, TFile, moment } from "obsidian";
import * as fsPromises from "fs/promises";
import { CustomMessageModal } from "src/ui/modals/customMessageModal";
import { hasConflictMarkers, IsomorphicGit } from "./gitManager/isomorphicGit";
import { redactUrl } from "./gitManager/networkPolicy";
import { SimpleGit } from "./gitManager/simpleGit";
import type {
    CommitAndSyncResult,
    CommitMode,
    Status,
    CommitResult,
    CloneRepositoryResult,
    CreateBranchResult,
    DeleteBranchResult,
    DeleteRepositoryResult,
    DiscardActionResult,
    EditRemoteResult,
    FetchResult,
    FileStatusResult,
    GitProgress,
    InitRepositoryResult,
    ListChangedFilesResult,
    NotReadyResult,
    PullResult,
    PushResult,
    RawCommandResult,
    RemoveRemoteResult,
    SetUpstreamResult,
    SwitchBranchResult,
    FileStateMutationResult,
} from "./types";
import { GitConflictError } from "./types";
import { BranchModal } from "./ui/modals/branchModal";
import { ChangedFilesModal } from "./ui/modals/changedFilesModal";
import { DeleteRepositoryModal } from "./ui/modals/deleteRepositoryModal";
import { GeneralModal } from "./ui/modals/generalModal";
import { OperationProgressModal } from "./ui/modals/operationProgressModal";
import {
    convertPathToAbsoluteGitignoreRule,
    formatRemoteUrl,
    spawnAsync,
    splitRemoteBranch,
} from "./utils";
import { DiscardModal } from "./ui/modals/discardModal";
import { runGitAction, type GitActionResult } from "./gitAction";
import {
    includeGlobScope,
    parseAutoCommitGlobs,
    type AutoCommitGlobSelection,
} from "./autoCommitGlobs";
import { syncLanguage } from "./syncProblems";
import type { SyncReason } from "./syncSupervisor";

import type ObsidianGit from "./main";

export type InteractiveOptions = {
    interactive?: boolean;
    progressModal?: OperationProgressModal;
};

type CommitOptions = {
    fromAuto: boolean;
    requestCustomMessage?: boolean;
    mode?: CommitMode;
    commitMessage?: string;
    amend?: boolean;
};

type CommitAndSyncOptions = {
    fromAutoBackup: boolean;
    requestCustomMessage?: boolean;
    commitMessage?: string;
    mode?: CommitMode;
    /** obsidian-git-Maintained: why the sync supervisor started this sync. */
    reason?: SyncReason;
    interactive?: boolean;
    progressModal?: OperationProgressModal;
};

function redactErrorMessage(error: unknown): string {
    let raw: string;
    if (error instanceof Error) {
        raw = error.message;
    } else if (typeof error === "string") {
        raw = error;
    } else if (error == null) {
        raw = "";
    } else if (
        typeof error === "number" ||
        typeof error === "boolean" ||
        typeof error === "bigint" ||
        typeof error === "symbol"
    ) {
        raw = String(error);
    } else {
        try {
            raw = JSON.stringify(error) ?? "";
        } catch {
            raw = "[unserializable error]";
        }
    }
    return raw.replace(/https?:\/\/[^\s"')]+/g, (url) => redactUrl(url));
}

export class GitActions {
    private pendingRescuedVaultPaths: string[] = [];

    constructor(private readonly plugin: ObsidianGit) {}

    openQueuedProgressModal(
        title: string,
        initialStep?: string,
        options?: { cancellable?: boolean; onCancel?: () => void }
    ): OperationProgressModal {
        const zh = syncLanguage() === "zh";
        const modal = new OperationProgressModal(this.plugin.app, {
            title,
            initialStep,
            cancellable: options?.cancellable,
            onCancel: options?.onCancel,
        });
        modal.open();
        if (this.plugin.promiseQueue.isRunning()) {
            const pending = this.plugin.promiseQueue.pendingCount();
            modal.setQueued(
                pending > 0
                    ? zh
                        ? `排队等待前序操作（另有 ${pending} 个待执行任务）…`
                        : `Waiting in queue (${pending} pending)…`
                    : zh
                      ? "排队等待当前操作完成…"
                      : "Waiting for current operation…"
            );
        }
        return modal;
    }

    private async withProgressModal<T>(
        opts: InteractiveOptions | undefined,
        config: {
            title: string;
            initialStep: string;
            cancellable?: boolean;
            onCancel?: () => void;
            closeOnSuccess?: boolean;
            modalRef?: (modal: OperationProgressModal) => void;
            summarizeSuccess?: (value: T) => {
                ok?: boolean;
                summary: string;
                details?: string[];
            };
        },
        fn: (modal?: OperationProgressModal) => Promise<T>
    ): Promise<T> {
        if (!opts?.interactive && !opts?.progressModal) {
            return fn(undefined);
        }
        const zh = syncLanguage() === "zh";
        const modal =
            opts.progressModal ??
            new OperationProgressModal(this.plugin.app, {
                title: config.title,
                initialStep: config.initialStep,
                cancellable: config.cancellable,
                onCancel: config.onCancel,
            });
        config.modalRef?.(modal);
        if (!opts.progressModal) {
            modal.open();
        }
        if (modal.isCancelled()) {
            throw new Errors.UserCanceledError();
        }
        modal.setRunning(config.initialStep);
        const unsubscribe = this.plugin.gitManager.onProgress(
            (progress: GitProgress) => {
                modal.setProgress(progress);
            }
        );
        try {
            const value = await fn(modal);
            if (modal.isCancelled()) {
                throw new Errors.UserCanceledError();
            }
            if (config.closeOnSuccess) {
                modal.close();
            } else {
                const report = config.summarizeSuccess?.(value) ?? {
                    ok: true,
                    summary: zh ? "已完成" : "Completed",
                };
                if (report.ok === false) {
                    modal.finishError(report.summary, report.details);
                } else {
                    modal.finishSuccess(report.summary, report.details);
                }
            }
            return value;
        } catch (error) {
            if (error instanceof Errors.UserCanceledError) {
                if (!modal.isCancelled()) {
                    modal.close();
                }
            } else {
                modal.finishError(
                    zh ? "操作失败" : "Operation failed",
                    [redactErrorMessage(error)].filter(Boolean)
                );
            }
            throw error;
        } finally {
            unsubscribe();
        }
    }

    private finishProgressIfNotReady(
        modal: OperationProgressModal | undefined,
        result: GitActionResult<{ status: string }>
    ): void {
        if (!modal || modal.isFinished() || modal.isCancelled()) return;
        if (result.status === "success" && result.value.status === "skipped") {
            const zh = syncLanguage() === "zh";
            modal.finishError(
                zh ? "Git 仓库尚未就绪" : "Git repository is not ready"
            );
        }
    }

    async addFileToGitignore(
        filePath: string,
        isFolder?: boolean
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runFileStateMutation(async () => {
            const gitRelativePath = this.plugin.gitManager.getRelativeRepoPath(
                filePath,
                true
            );
            // Define an absolute rule that can apply only for this item.
            const gitignoreRule = convertPathToAbsoluteGitignoreRule({
                isFolder,
                gitRelativePath,
            });
            await this.plugin.app.vault.adapter.append(
                this.plugin.gitManager.getRelativeVaultPath(".gitignore"),
                "\n" + gitignoreRule
            );
        });
    }

    async createNewRepo(): Promise<GitActionResult<InitRepositoryResult>> {
        const actionResult = await runGitAction<InitRepositoryResult>(
            this.plugin,
            async () => {
                await this.plugin.gitManager.init();
                await this.plugin.init({ fromReload: true });
                return { status: "initialized" };
            }
        );
        if (actionResult.status === "success") {
            this.reportInitRepositoryResult(actionResult.value);
        }
        return actionResult;
    }

    private reportInitRepositoryResult(result: InitRepositoryResult): void {
        switch (result.status) {
            case "initialized":
                this.plugin.displayMessage("Initialized new repo");
                return;
        }
    }

    async deleteRepository(
        options?: InteractiveOptions
    ): Promise<GitActionResult<DeleteRepositoryResult>> {
        const actionResult = await runGitAction<DeleteRepositoryResult>(
            this.plugin,
            async () => {
                const adapter = this.plugin.app.vault.adapter;
                const repositoryPath = this.plugin.settings.basePath
                    ? `${this.plugin.settings.basePath}/.git`
                    : ".git";
                if (!(await adapter.exists(repositoryPath))) {
                    return { status: "not-found" };
                }

                const choice = await new DeleteRepositoryModal(
                    this.plugin.app,
                    {
                        configDir: this.plugin.app.vault.configDir,
                        queueBusy: this.plugin.promiseQueue.isBusy(),
                        pendingCount: this.plugin.promiseQueue.pendingCount(),
                    }
                ).openAndGetChoice();
                if (choice === "cancel") {
                    return { status: "cancelled" };
                }

                this.plugin.promiseQueue.clearPending();
                this.plugin.automaticsManager.unload();
                this.plugin.syncSupervisor?.stop();

                const zh = syncLanguage() === "zh";
                const modal = options?.interactive
                    ? new OperationProgressModal(this.plugin.app, {
                          title: zh ? "删除仓库" : "Delete repository",
                          initialStep: zh
                              ? "正在删除 .git 目录…"
                              : "Deleting .git directory…",
                      })
                    : undefined;
                modal?.open();

                try {
                    await adapter.rmdir(repositoryPath, true);
                    if (choice === "git-and-files") {
                        modal?.setStep(
                            zh
                                ? "正在清空工作区文件（保留配置目录）…"
                                : "Clearing workspace files (preserving config folder)…"
                        );
                        const listed = await adapter.list("");
                        const normalizedConfigDir = normalizePath(
                            this.plugin.app.vault.configDir
                        );
                        const isInsideConfig = (p: string): boolean => {
                            const norm = normalizePath(p);
                            return (
                                norm === normalizedConfigDir ||
                                norm.startsWith(`${normalizedConfigDir}/`)
                            );
                        };
                        const filesToRemove = listed.files.filter(
                            (p) => !isInsideConfig(p)
                        );
                        const foldersToRemove = listed.folders.filter((p) => {
                            const norm = normalizePath(p);
                            return (
                                norm !== "" &&
                                norm !== "." &&
                                !isInsideConfig(norm)
                            );
                        });
                        const total =
                            filesToRemove.length + foldersToRemove.length;
                        let loaded = 0;
                        for (const filePath of filesToRemove) {
                            modal?.setProgress({
                                phase: zh
                                    ? "清理工作区文件"
                                    : "Removing vault files",
                                loaded: ++loaded,
                                total,
                            });
                            if (await adapter.exists(filePath)) {
                                await adapter.remove(filePath);
                            }
                        }
                        for (const folderPath of foldersToRemove) {
                            modal?.setProgress({
                                phase: zh
                                    ? "清理工作区文件夹"
                                    : "Removing vault folders",
                                loaded: ++loaded,
                                total,
                            });
                            if (await adapter.exists(folderPath)) {
                                await adapter.rmdir(folderPath, true);
                            }
                        }
                    }

                    modal?.setStep(
                        zh ? "正在重置插件状态…" : "Reloading plugin state…"
                    );
                    this.plugin.unloadPlugin();
                    this.plugin.syncSupervisor?.resetAfterRepoDelete();
                    await this.plugin.init({ fromReload: true });

                    modal?.finishSuccess(
                        zh
                            ? choice === "git-and-files"
                                ? "已删除 .git 并清空工作区文件（已保留 Obsidian 配置）"
                                : "已删除 .git 目录（所有笔记和文件已保留）"
                            : choice === "git-and-files"
                              ? "Deleted .git and cleared workspace files (Obsidian config kept)"
                              : "Deleted .git folder (notes preserved)"
                    );
                    return { status: "deleted" };
                } catch (error) {
                    modal?.finishError(
                        zh ? "删除仓库失败" : "Failed to delete repository",
                        [redactErrorMessage(error)].filter(Boolean)
                    );
                    throw error;
                }
            }
        );
        if (actionResult.status === "success") {
            this.reportDeleteRepositoryResult(actionResult.value);
        }
        return actionResult;
    }

    private reportDeleteRepositoryResult(result: DeleteRepositoryResult): void {
        switch (result.status) {
            case "deleted":
                this.plugin.displayMessage(
                    "Successfully deleted repository. Reloading plugin..."
                );
                return;
            case "not-found":
                this.plugin.displayMessage("No repository found");
                return;
            case "cancelled":
                return;
        }
    }

    async cloneNewRepo(
        options?: InteractiveOptions
    ): Promise<GitActionResult<CloneRepositoryResult>> {
        const actionResult = await runGitAction<CloneRepositoryResult>(
            this.plugin,
            () => this.performCloneNewRepo(options)
        );
        if (actionResult.status === "success") {
            this.reportCloneRepositoryResult(actionResult.value);
        }
        return actionResult;
    }

    private async performCloneNewRepo(
        options?: InteractiveOptions
    ): Promise<CloneRepositoryResult> {
        const url = await new GeneralModal(this.plugin, {
            placeholder: "Enter remote URL",
        }).openAndGetResult();
        if (!url) {
            return { status: "cancelled", reason: "no-url" };
        }

        const confirmOption = "Vault Root";
        let dir = await new GeneralModal(this.plugin, {
            options:
                this.plugin.gitManager instanceof IsomorphicGit
                    ? [confirmOption]
                    : [],
            placeholder:
                "Enter directory for clone. It needs to be empty or not existent.",
            allowEmpty: this.plugin.gitManager instanceof IsomorphicGit,
        }).openAndGetResult();
        if (dir === undefined) {
            return { status: "cancelled", reason: "no-directory" };
        }
        if (dir === confirmOption) {
            dir = ".";
        }

        dir = normalizePath(dir);
        if (dir === "/") {
            dir = ".";
        }

        if (dir === ".") {
            const containsConflictDir = await new GeneralModal(this.plugin, {
                options: ["NO", "YES"],
                placeholder: `Does your remote repo contain a ${this.plugin.app.vault.configDir} directory at the root?`,
                onlySelection: true,
            }).openAndGetResult();
            if (containsConflictDir === undefined) {
                return { status: "cancelled", reason: "safety-declined" };
            } else if (containsConflictDir === "YES") {
                const deleteConfirmation =
                    "DELETE ALL YOUR LOCAL CONFIG AND PLUGINS";
                const shouldDelete =
                    (await new GeneralModal(this.plugin, {
                        options: ["Abort clone", deleteConfirmation],
                        placeholder: `To avoid conflicts, the local ${this.plugin.app.vault.configDir} directory needs to be deleted.`,
                        onlySelection: true,
                    }).openAndGetResult()) === deleteConfirmation;
                if (!shouldDelete) {
                    return { status: "cancelled", reason: "safety-declined" };
                }
                await this.plugin.app.vault.adapter.rmdir(
                    this.plugin.app.vault.configDir,
                    true
                );
            }
        }

        const depth = await new GeneralModal(this.plugin, {
            placeholder: "Specify depth of clone. Leave empty for full clone.",
            allowEmpty: true,
        }).openAndGetResult();
        if (depth === undefined) {
            return { status: "cancelled", reason: "no-depth" };
        }

        let depthInt: number | undefined;
        if (depth !== "") {
            depthInt = parseInt(depth);
            if (isNaN(depthInt)) {
                return { status: "invalid", reason: "depth" };
            }
        }

        const zh = syncLanguage() === "zh";
        if (!options?.interactive && !options?.progressModal) {
            new Notice(`Cloning new repo into "${dir}"`);
        }
        const oldBase = this.plugin.settings.basePath;
        const customDir = dir !== ".";
        if (customDir) {
            this.plugin.settings.basePath = dir;
        }
        try {
            await this.withProgressModal(
                options,
                {
                    title: zh ? "克隆远程仓库" : "Cloning repository",
                    initialStep: zh
                        ? `正在克隆仓库到「${dir}」…`
                        : `Cloning repository into "${dir}"…`,
                    summarizeSuccess: () => ({
                        ok: true,
                        summary: zh
                            ? `仓库已克隆到「${dir}」，请重启 Obsidian 使插件完全重载`
                            : `Cloned repository into "${dir}". Please restart Obsidian.`,
                    }),
                },
                async (modal) => {
                    await this.plugin.gitManager.clone(
                        formatRemoteUrl(url),
                        dir,
                        depthInt
                    );
                    if (customDir) {
                        modal?.setStep(
                            zh
                                ? "正在保存仓库路径配置…"
                                : "Saving repository path setting…"
                        );
                        await this.plugin.saveSettings();
                    }
                }
            );
            return { status: "cloned" };
        } catch (error) {
            this.plugin.settings.basePath = oldBase;
            await this.plugin.saveSettings();
            throw error;
        }
    }

    private reportCloneRepositoryResult(result: CloneRepositoryResult): void {
        switch (result.status) {
            case "cloned":
                this.plugin.displayMessage("Cloned new repo.");
                this.plugin.displayMessage("Please restart Obsidian");
                return;
            case "cancelled": {
                const reason = result.reason;
                switch (reason) {
                    case "safety-declined":
                    case "no-depth":
                        this.plugin.displayMessage("Aborted clone");
                        return;
                    case "no-url":
                    case "no-directory":
                        return;
                }
                return;
            }
            case "invalid": {
                const reason = result.reason;
                switch (reason) {
                    case "depth":
                        this.plugin.displayMessage(
                            "Invalid depth. Aborting clone."
                        );
                        return;
                }
            }
        }
    }

    /**
     * @param sync obsidian-git-Maintained: a commit, pull or push, whose
     * error the sync supervisor sees first.
     */
    private runReadyGitAction<T>(
        action: () => Promise<T>,
        sync = false
    ): Promise<GitActionResult<T | NotReadyResult>> {
        const supervisor = this.plugin.syncSupervisor;
        return runGitAction(
            this.plugin,
            async () => {
                if (!(await this.plugin.isAllInitialized())) {
                    return { status: "skipped", reason: "not-ready" };
                }
                return action();
            },
            sync && supervisor
                ? (error) => supervisor.observeError(error)
                : undefined
        );
    }

    async listChangedFiles(
        options?: InteractiveOptions
    ): Promise<GitActionResult<ListChangedFilesResult>> {
        const zh = syncLanguage() === "zh";
        const actionResult =
            await this.runReadyGitAction<ListChangedFilesResult>(() =>
                this.withProgressModal<ListChangedFilesResult>(
                    options,
                    {
                        title: zh ? "列出已修改文件" : "List changed files",
                        initialStep: zh
                            ? "正在扫描仓库变更状态…"
                            : "Scanning repository status…",
                        cancellable: true,
                        summarizeSuccess: (res) => {
                            if (
                                res.status === "blocked" &&
                                res.reason === "too-many-changes"
                            ) {
                                return {
                                    ok: false,
                                    summary: zh
                                        ? `改动文件过多（${res.files} 个，上限 500）`
                                        : `Too many changed files (${res.files}, limit 500)`,
                                };
                            }
                            return {
                                ok: true,
                                summary: zh ? "扫描完成" : "Scan complete",
                            };
                        },
                    },
                    async (modal) => {
                        const status = await this.plugin.updateCachedStatus();
                        if (modal?.isCancelled()) {
                            throw new Errors.UserCanceledError();
                        }
                        const files =
                            status.changed.length + status.staged.length;
                        if (files > 500) {
                            return {
                                status: "blocked",
                                reason: "too-many-changes",
                                files,
                            };
                        }

                        modal?.close();
                        new ChangedFilesModal(this.plugin, status.all).open();
                        return { status: "displayed" };
                    }
                )
            );
        this.finishProgressIfNotReady(options?.progressModal, actionResult);
        if (actionResult.status === "success") {
            this.reportListChangedFilesResult(actionResult.value);
        }
        return actionResult;
    }

    private reportListChangedFilesResult(result: ListChangedFilesResult): void {
        switch (result.status) {
            case "displayed":
            case "skipped":
                return;
            case "blocked": {
                const reason = result.reason;
                switch (reason) {
                    case "too-many-changes":
                        this.plugin.displayError("Too many changes to display");
                        return;
                }
            }
        }
    }

    ///Used for command
    async pullChangesFromRemote(
        options?: InteractiveOptions & { isBoot?: boolean }
    ): Promise<void> {
        const actionResult = await this.pull(options);
        if (actionResult.status !== "success") {
            return;
        }
        const pullResult = actionResult.value;
        if (pullResult.status === "skipped") {
            return;
        }
        this.reportPullResult(pullResult);
        this.plugin.app.workspace.trigger("obsidian-git:refresh");
    }

    private reportPullResult(result: PullResult): void {
        switch (result.status) {
            case "updated": {
                const totalFiles = result.files.length + result.outsideVault;
                const outsideMessage =
                    result.outsideVault > 0
                        ? ` (${result.files.length} in the vault, ${result.outsideVault} outside)`
                        : "";
                this.plugin.displayMessage(
                    `Pulled ${totalFiles} ${
                        totalFiles == 1 ? "file" : "files"
                    } from remote${outsideMessage}`
                );
                this.plugin.lastPulledFiles = result.files;
                return;
            }
            case "up-to-date":
                this.plugin.displayMessage("Pull: Everything is up-to-date");
                return;
            case "skipped": {
                const reason = result.reason;
                switch (reason) {
                    case "not-ready":
                    case "no-upstream":
                        return;
                }
            }
        }
    }

    private resolveCommitMode(
        mode: CommitMode,
        stagedCount: number
    ): Exclude<CommitMode, "smart"> | "nothing" {
        if (mode === "all") return "all";
        if (stagedCount > 0) return "staged";
        if (mode === "staged") return "nothing";
        return this.plugin.settings.autoStageOnEmptyIndex ? "all" : "nothing";
    }

    async commitAndSync(
        options: CommitAndSyncOptions
    ): Promise<GitActionResult<CommitAndSyncResult>> {
        const zh = syncLanguage() === "zh";
        const supervisor = this.plugin.syncSupervisor;
        supervisor?.syncStarted(options.fromAutoBackup, options.reason);
        const result = await this.runReadyGitAction<CommitAndSyncResult>(
            () =>
                this.withProgressModal<CommitAndSyncResult>(
                    options,
                    {
                        title: zh ? "提交并同步" : "Commit and sync",
                        initialStep: zh
                            ? "正在准备提交并同步…"
                            : "Preparing commit and sync…",
                        summarizeSuccess: (res) => {
                            switch (res.status) {
                                case "synced":
                                    return {
                                        ok: true,
                                        summary: zh
                                            ? "提交并同步完成"
                                            : "Committed and synced",
                                    };
                                case "nothing-to-push":
                                    return {
                                        ok: true,
                                        summary: zh
                                            ? "同步完成（无需推送新提交）"
                                            : "Sync complete (nothing new to push)",
                                    };
                                case "commit-only":
                                    return {
                                        ok: true,
                                        summary: zh
                                            ? "已完成本地提交（推送已禁用）"
                                            : "Committed locally (push disabled)",
                                    };
                                case "skipped":
                                    return {
                                        ok: false,
                                        summary: zh
                                            ? "同步未完成：提交或推送被跳过"
                                            : "Sync incomplete: commit or push skipped",
                                    };
                            }
                        },
                    },
                    () => this.performCommitAndSync(options)
                ),
            true
        );
        this.finishProgressIfNotReady(options.progressModal, result);
        await supervisor?.syncFinished(result);
        return result;
    }

    async rescueConflictsAndSync(
        options?: InteractiveOptions
    ): Promise<GitActionResult<CommitAndSyncResult>> {
        const zh = syncLanguage() === "zh";
        const targetFolder =
            this.plugin.settings.rescueFolder?.trim() || "_冲突备份";
        const useModal = Boolean(
            options?.interactive || options?.progressModal
        );
        const modal = useModal
            ? (options?.progressModal ??
              new OperationProgressModal(this.plugin.app, {
                  title: zh
                      ? "备份冲突改动并以远端为准同步"
                      : "Backup conflicts and sync",
                  initialStep: zh
                      ? `正在将冲突本地改动提取到「${targetFolder}」…`
                      : `Saving conflicting local changes to "${targetFolder}"…`,
              }))
            : undefined;
        if (modal && !options?.progressModal) {
            modal.open();
        }
        modal?.setRunning(
            zh
                ? `正在将冲突本地改动提取到「${targetFolder}」…`
                : `Saving conflicting local changes to "${targetFolder}"…`
        );
        const unsubscribe = modal
            ? this.plugin.gitManager.onProgress((p: GitProgress) =>
                  modal.setProgress(p)
              )
            : undefined;

        let rescuedCount = 0;
        let rescuedDetails: string[] = [];
        try {
            const prepResult = await this.runReadyGitAction<
                { status: "prepared" } | NotReadyResult
            >(async () => {
                const rescue =
                    await this.plugin.gitManager.rescueConflictedChanges(
                        targetFolder
                    );
                rescuedCount = rescue.rescued.length;
                rescuedDetails = rescue.rescued.map(({ path, copy }) =>
                    copy ? `${path} → ${copy}` : `${path}`
                );
                if (rescue.skippedMarkers.length > 0) {
                    rescuedDetails.push(
                        zh
                            ? `注：以下文件工作区含冲突标记，已提取干净的历史/阶段版本：${rescue.skippedMarkers.join(", ")}`
                            : `Note: extracted clean stage copy for marker files: ${rescue.skippedMarkers.join(", ")}`
                    );
                }

                modal?.setStep(
                    zh
                        ? "正在中止未完成合并并复位索引…"
                        : "Aborting merge state and resetting index…"
                );
                await this.plugin.gitManager.abortMerge();

                const copies = rescue.rescued
                    .map((item) => item.copy)
                    .filter((copy): copy is string => Boolean(copy));
                this.pendingRescuedVaultPaths = [...new Set(copies)];

                this.plugin.setPluginState({ mergeInProgress: false });
                this.plugin.syncSupervisor?.clearConflictProblem();
                await this.plugin.updateCachedStatus();
                return { status: "prepared" };
            }, true);

            if (prepResult.status !== "success") {
                this.pendingRescuedVaultPaths = [];
                const problem = this.plugin.syncSupervisor?.snapshot().problem;
                modal?.finishError(
                    zh ? "清理冲突失败" : "Failed to prepare conflict rescue",
                    [problem?.raw].filter((x): x is string => Boolean(x))
                );
                return prepResult.status === "cancelled"
                    ? { status: "cancelled" }
                    : { status: "failed" };
            }
            if (prepResult.value.status === "skipped") {
                this.pendingRescuedVaultPaths = [];
                modal?.finishError(
                    zh ? "Git 仓库尚未就绪" : "Git repository is not ready"
                );
                return { status: "success", value: prepResult.value };
            }

            modal?.setStep(
                zh
                    ? "正在以远端版本为准重新同步并上传备份…"
                    : "Syncing with remote and uploading backup…"
            );
            const syncResult = await (async () => {
                try {
                    return await this.plugin.gitManager.withRescueFolderOverride(
                        targetFolder,
                        () =>
                            this.commitAndSync({
                                fromAutoBackup: false,
                                mode: "all",
                                reason: "manual",
                            })
                    );
                } finally {
                    this.pendingRescuedVaultPaths = [];
                }
            })();

            if (syncResult.status === "cancelled") {
                modal?.close();
            } else if (syncResult.status === "failed") {
                const problem = this.plugin.syncSupervisor?.snapshot().problem;
                modal?.finishError(
                    zh
                        ? "本地冲突已备份并清理合并状态，但同步未完成"
                        : "Conflicts backed up and cleared locally, but sync failed",
                    [problem?.raw, ...rescuedDetails].filter((x): x is string =>
                        Boolean(x)
                    )
                );
            } else {
                modal?.finishSuccess(
                    zh
                        ? rescuedCount > 0
                            ? `已备份 ${rescuedCount} 个冲突文件到「${targetFolder}」并完成同步`
                            : "已清理卡住的合并状态并完成同步"
                        : rescuedCount > 0
                          ? `Backed up ${rescuedCount} conflicted files to "${targetFolder}" and synced`
                          : "Cleared merge state and synced",
                    rescuedDetails
                );
            }
            return syncResult;
        } finally {
            unsubscribe?.();
        }
    }

    private async commitRescuedPathsAfterPull(
        fromAutoBackup: boolean
    ): Promise<void> {
        const rescuedVaultPaths = [
            ...new Set([
                ...this.pendingRescuedVaultPaths.splice(0),
                ...(this.plugin.syncSupervisor?.consumePendingRescuedPaths() ??
                    []),
            ]),
        ];
        if (rescuedVaultPaths.length === 0) return;

        let stagedCount = 0;
        for (const vaultPath of rescuedVaultPaths) {
            if (
                vaultPath &&
                (await this.plugin.app.vault.adapter.exists(vaultPath))
            ) {
                await this.plugin.gitManager.stage(vaultPath, true);
                stagedCount++;
            }
        }
        if (stagedCount === 0) return;

        const rawMessage = fromAutoBackup
            ? this.plugin.settings.autoCommitMessage
            : this.plugin.settings.commitMessage;
        const message = rawMessage?.trim()
            ? rawMessage
            : "backup rescued local changes";
        this.plugin.syncSupervisor?.beforeCommit();
        const files = await this.plugin.gitManager.commit({ message });
        this.plugin.syncSupervisor?.recordCommit({
            status: "committed",
            files,
        });
        this.plugin.app.workspace.trigger("obsidian-git:refresh");
    }

    private async performCommitAndSync({
        fromAutoBackup,
        requestCustomMessage = false,
        commitMessage,
        mode = "all",
    }: CommitAndSyncOptions): Promise<CommitAndSyncResult> {
        const zh = syncLanguage() === "zh";
        if (
            this.plugin.settings.syncMethod == "reset" &&
            this.plugin.settings.pullBeforePush
        ) {
            this.plugin.syncSupervisor?.setStep(
                zh ? "正在拉取远端更新…" : "Pulling remote changes…"
            );
            this.reportPullResult(await this.performPull());
            await this.commitRescuedPathsAfterPull(fromAutoBackup);
        }

        this.plugin.syncSupervisor?.setStep(
            zh ? "正在提交本地改动…" : "Committing local changes…"
        );
        const commitResult = await this.performCommit({
            fromAuto: fromAutoBackup,
            requestCustomMessage,
            commitMessage,
            mode,
        });
        this.plugin.syncSupervisor?.recordCommit(commitResult);
        this.reportCommitResult(commitResult);
        switch (commitResult.status) {
            case "committed":
            case "nothing-to-commit":
                break;
            case "skipped":
                return {
                    status: "skipped",
                    reason: "commit-skipped",
                    commit: commitResult,
                };
        }

        if (
            this.plugin.settings.syncMethod != "reset" &&
            this.plugin.settings.pullBeforePush
        ) {
            this.plugin.syncSupervisor?.setStep(
                zh ? "正在拉取并合并远端更新…" : "Pulling remote changes…"
            );
            this.reportPullResult(await this.performPull());
            await this.commitRescuedPathsAfterPull(fromAutoBackup);
        }

        if (this.plugin.settings.disablePush) {
            return {
                status: "commit-only",
                reason: "push-disabled",
                commit: commitResult,
            };
        }

        if (!(await this.isPushRemoteSet())) {
            return {
                status: "skipped",
                reason: "push-skipped",
                commit: commitResult,
            };
        }

        // Prevent trying to push every time. Only if unpushed commits are present
        if (await this.plugin.gitManager.canPush()) {
            this.plugin.syncSupervisor?.setStep(
                zh ? "正在推送到远程仓库…" : "Pushing to remote…"
            );
            // A conflicting pull throws before this point, so skip the status refresh.
            const pushResult = await this.performPush({ refreshStatus: false });
            this.reportPushResult(pushResult);
            switch (pushResult.status) {
                case "pushed":
                    return { status: "synced", commit: commitResult };
                case "up-to-date":
                    return {
                        status: "nothing-to-push",
                        commit: commitResult,
                    };
                case "blocked":
                case "skipped":
                    return {
                        status: "skipped",
                        reason: "push-skipped",
                        commit: commitResult,
                    };
            }
        }

        this.reportPushResult({ status: "up-to-date" });
        return { status: "nothing-to-push", commit: commitResult };
    }

    async commit(
        options: CommitOptions
    ): Promise<GitActionResult<CommitResult>> {
        const actionResult = await this.runReadyGitAction<CommitResult>(
            () => this.performCommit(options),
            true
        );
        if (actionResult.status === "success") {
            this.plugin.syncSupervisor?.recordCommit(actionResult.value);
            this.reportCommitResult(actionResult.value);
        }
        return actionResult;
    }

    private async performCommit({
        fromAuto,
        requestCustomMessage = false,
        mode = "all",
        commitMessage,
        amend = false,
    }: CommitOptions): Promise<CommitResult> {
        // obsidian-git-Maintained: a pull cut off half-way is finished first,
        // so its half-written files are not committed as local changes. If
        // that is not possible, the next pull reports why; the commit goes on.
        try {
            await this.plugin.gitManager.recoverInterruptedPull();
        } catch (error) {
            this.plugin.log("Interrupted pull not finished:", error);
        }
        this.plugin.syncSupervisor?.beforeCommit();
        // obsidian-git-Maintained: manual commits can opt into the same selection.
        const useGlobs =
            fromAuto || this.plugin.settings.manualCommitUsesAutoCommitGlobs;
        const autoGlobs = useGlobs
            ? parseAutoCommitGlobs(this.plugin.settings.autoCommitGlobs)
            : [];
        let status = await this.commitStatus(useGlobs, autoGlobs);
        const mergeInProgress = this.plugin.state.mergeInProgress;
        if (
            useGlobs &&
            this.plugin.settings.autoCommitGlobMode === "include" &&
            autoGlobs.length === 0
        ) {
            mode = "staged";
        }

        if (fromAuto && mergeInProgress) {
            if (status.conflicted.length + status.conflictedOutsideVault > 0) {
                throw new GitConflictError(
                    status.conflicted,
                    new Error(
                        "Automatic commit stopped because of unresolved conflicts"
                    )
                );
            }
            return { status: "skipped", reason: "merge-in-progress" };
        }

        if (
            !fromAuto &&
            (status.conflicted.length > 0 || status.conflictedOutsideVault > 0)
        ) {
            const stillConflicted: string[] = [];
            const adapter = this.plugin.app.vault.adapter;
            for (const filePath of status.conflicted) {
                const vaultPath =
                    this.plugin.gitManager.getRelativeVaultPath(filePath);
                if (!(await adapter.exists(vaultPath))) {
                    await this.plugin.gitManager.stage(filePath, false);
                    continue;
                }
                let hasMarkers: boolean;
                try {
                    const content = await adapter.read(vaultPath);
                    hasMarkers = hasConflictMarkers(content);
                } catch {
                    hasMarkers = false;
                }
                if (hasMarkers) {
                    stillConflicted.push(filePath);
                } else {
                    await this.plugin.gitManager.stage(filePath, false);
                }
            }
            if (
                stillConflicted.length > 0 ||
                status.conflictedOutsideVault > 0
            ) {
                throw new GitConflictError(
                    stillConflicted,
                    new Error("Unresolved conflict markers remain")
                );
            }
            status = await this.commitStatus(useGlobs, autoGlobs);
        }

        // Reuse the fresh status instead of walking the working tree again.
        const stagedFiles = status.staged;
        let unstagedFiles = status.changed;
        let resolvedMode: Exclude<CommitMode, "smart"> | "nothing" =
            this.resolveCommitMode(
                mode,
                stagedFiles.length + status.stagedOutsideVault
            );

        if (resolvedMode === "nothing" && mergeInProgress && !fromAuto) {
            resolvedMode = "staged";
        }

        if (resolvedMode === "nothing") {
            return {
                status: "nothing-to-commit",
                reason: "nothing-staged",
            };
        }

        const onlyStaged = resolvedMode === "staged";

        // The selection controls automatic staging, not files already staged.
        let selection: AutoCommitGlobSelection | undefined =
            useGlobs && !onlyStaged
                ? {
                      mode: this.plugin.settings.autoCommitGlobMode,
                      globs: autoGlobs,
                  }
                : undefined;
        if (selection) {
            const selected = await this.plugin.gitManager.selectAutoCommitFiles(
                status,
                selection
            );
            unstagedFiles = selected.files;
            selection = selected.selection;
        }

        if (
            await this.plugin.tools.hasTooBigFiles(
                onlyStaged ? stagedFiles : [...stagedFiles, ...unstagedFiles]
            )
        ) {
            return { status: "skipped", reason: "files-too-large" };
        }

        const changesCountToCommit =
            (onlyStaged ? 0 : unstagedFiles.length) +
                stagedFiles.length +
                status.stagedOutsideVault !==
            0;
        if (changesCountToCommit || mergeInProgress) {
            // The commit message from settings or previously set in the
            // source control view
            let cmtMessage =
                commitMessage ??
                (fromAuto
                    ? this.plugin.settings.autoCommitMessage
                    : this.plugin.settings.commitMessage);

            const requestMessage =
                (fromAuto && this.plugin.settings.customMessageOnAutoBackup) ||
                requestCustomMessage;

            // On desktop may run a script to get the commit message
            if (
                !requestMessage &&
                this.plugin.gitManager instanceof SimpleGit &&
                this.plugin.settings.commitMessageScript
            ) {
                cmtMessage = await this.getMessageFromScript(cmtMessage);
            }

            // An empty manual template means the user should enter a message.
            if (requestMessage || (!fromAuto && !cmtMessage?.trim())) {
                if (!this.plugin.settings.disablePopups && fromAuto) {
                    new Notice(
                        "Auto backup: Please enter a custom commit message. Leave empty to abort"
                    );
                }
                const modalMessage = await new CustomMessageModal(
                    this.plugin
                ).openAndGetResult();

                if (
                    modalMessage != undefined &&
                    modalMessage != "" &&
                    modalMessage != "..."
                ) {
                    cmtMessage = modalMessage;
                } else {
                    throw new Errors.UserCanceledError();
                }
            }

            // Check if commit message is empty after all processing
            if (!cmtMessage || cmtMessage.trim() === "") {
                throw new Errors.UserCanceledError();
            }

            let committedFiles: number;
            if (onlyStaged) {
                committedFiles = await this.plugin.gitManager.commit({
                    message: cmtMessage,
                    amend,
                });
            } else {
                committedFiles = await this.plugin.gitManager.commitAll({
                    message: cmtMessage,
                    status,
                    unstagedFiles,
                    selection,
                    amend,
                });
            }

            // Handle eventually resolved conflicts
            if (mergeInProgress) {
                this.plugin.setPluginState({ mergeInProgress: false });
                this.plugin.syncSupervisor?.clearConflictProblem();
            }
            if (
                this.plugin.gitManager instanceof SimpleGit ||
                mergeInProgress
            ) {
                await this.plugin.updateCachedStatus();
            }

            this.plugin.app.workspace.trigger("obsidian-git:refresh");
            if (committedFiles === 0 && !mergeInProgress) {
                // simple-git resolves with { changes: 0 } instead of
                // throwing when there is nothing to commit (e.g. the
                // detected change was already committed by a previous run).
                return {
                    status: "nothing-to-commit",
                    reason: "no-changes",
                };
            }
            return { status: "committed", files: committedFiles };
        } else {
            this.plugin.app.workspace.trigger("obsidian-git:refresh");
            return {
                status: "nothing-to-commit",
                reason: "no-changes",
            };
        }
    }

    /**
     * The status a commit starts from. obsidian-git-Maintained: when the
     * sync supervisor is on and include globs limit the commit to some
     * folders, the mobile backend only looks at those folders instead of
     * walking the whole working tree (seconds on a phone). The cached status
     * of the views is then left as it is.
     */
    private async commitStatus(
        useGlobs: boolean,
        autoGlobs: string[]
    ): Promise<Status> {
        const manager = this.plugin.gitManager;
        const scope =
            useGlobs &&
            this.plugin.settings.autoCommitGlobMode === "include" &&
            manager instanceof IsomorphicGit &&
            this.plugin.syncSupervisor?.managing
                ? includeGlobScope(autoGlobs)
                : undefined;
        if (scope === undefined) {
            return this.plugin.updateCachedStatus();
        }
        const status = await (manager as IsomorphicGit).scopedStatus(scope);
        this.plugin.setPluginState({
            mergeInProgress: await manager.isMergeInProgress(),
        });
        return status;
    }

    private async getMessageFromScript(cmtMessage: string) {
        const templateScript = this.plugin.settings.commitMessageScript;
        const hostname = this.plugin.localStorage.getHostname() || "";
        let formattedScript = templateScript.replace("{{hostname}}", hostname);

        formattedScript = formattedScript.replace(
            "{{date}}",
            moment().format(this.plugin.settings.commitDateFormat)
        );
        let shPath = "sh";
        if (Platform.isWin) {
            shPath = process.env.PROGRAMFILES + "\\Git\\bin\\sh.exe";
            let shExists: boolean;
            try {
                await fsPromises.access(shPath, fsPromises.constants.X_OK);
                shExists = true;
            } catch {
                shExists = false;
            }

            if (!shExists) {
                throw new Error(
                    `Cannot find sh.exe at ${shPath}. Please make sure Git is properly installed.`
                );
            }
        }

        const res = await spawnAsync(shPath, ["-c", formattedScript], {
            cwd: (this.plugin.gitManager as SimpleGit).absoluteRepoPath,
        });
        if (res.code != 0) {
            throw new Error(
                res.stderr ||
                    `Commit message script exited with code ${res.code}`
            );
        } else if (res.stdout.trim().length == 0) {
            this.plugin.displayMessage(
                "Stdout from commit message script is empty. Using default message."
            );
        } else {
            cmtMessage = res.stdout;
        }
        return cmtMessage;
    }

    private reportCommitResult(result: CommitResult): void {
        switch (result.status) {
            case "committed":
                this.plugin.displayMessage(
                    `Committed ${result.files} ${
                        result.files == 1 ? "file" : "files"
                    }`
                );
                return;
            case "nothing-to-commit": {
                const reason = result.reason;
                switch (reason) {
                    case "nothing-staged":
                        this.plugin.displayMessage(
                            "Nothing staged. Stage changes first or use Commit all changes."
                        );
                        return;
                    case "no-changes":
                        this.plugin.displayMessage("No changes to commit");
                        return;
                }
                return;
            }
            case "skipped": {
                const reason = result.reason;
                switch (reason) {
                    case "merge-in-progress":
                        this.plugin.displayError(
                            "Did not commit automatically because a merge is in progress. Commit it manually."
                        );
                        return;
                    case "not-ready":
                    case "files-too-large":
                        return;
                }
            }
        }
    }

    async push(
        options?: InteractiveOptions
    ): Promise<GitActionResult<PushResult>> {
        const zh = syncLanguage() === "zh";
        const actionResult = await this.runReadyGitAction<PushResult>(
            () =>
                this.withProgressModal<PushResult>(
                    options,
                    {
                        title: zh ? "推送到远端" : "Pushing to remote",
                        initialStep: zh
                            ? "正在检查提交并推送到远端…"
                            : "Checking commits and pushing to remote…",
                        summarizeSuccess: (res) => {
                            switch (res.status) {
                                case "pushed":
                                    return {
                                        ok: true,
                                        summary:
                                            res.files === null
                                                ? zh
                                                    ? "已推送到远端仓库"
                                                    : "Pushed to remote"
                                                : zh
                                                  ? `已推送 ${res.files} 个文件到远端仓库`
                                                  : `Pushed ${res.files} ${res.files === 1 ? "file" : "files"} to remote`,
                                    };
                                case "up-to-date":
                                    return {
                                        ok: true,
                                        summary: zh
                                            ? "没有需要推送的本地提交"
                                            : "No commits to push",
                                    };
                                case "blocked": {
                                    const reason = res.reason;
                                    if (reason === "no-branch") {
                                        return {
                                            ok: false,
                                            summary: zh
                                                ? "当前没有检出分支，无法推送"
                                                : "No current branch found. Cannot push.",
                                        };
                                    }
                                    if (reason === "conflicts") {
                                        return {
                                            ok: false,
                                            summary: zh
                                                ? `无法推送：仍有 ${res.files} 个文件处于冲突状态`
                                                : `Cannot push. Conflicts remain in ${res.files} ${res.files === 1 ? "file" : "files"}`,
                                        };
                                    }
                                    return {
                                        ok: false,
                                        summary: zh
                                            ? "无法推送：仍有未完成的合并"
                                            : "Cannot push while a merge is still in progress",
                                    };
                                }
                                case "skipped":
                                    return {
                                        ok: false,
                                        summary: zh
                                            ? "未配置或取消了上游分支，未执行推送"
                                            : "No upstream branch configured",
                                    };
                            }
                        },
                    },
                    () => this.performPush()
                ),
            true
        );
        this.finishProgressIfNotReady(options?.progressModal, actionResult);
        if (actionResult.status === "success") {
            this.reportPushResult(actionResult.value);
        }
        return actionResult;
    }

    private async performPush({
        refreshStatus = true,
    }: { refreshStatus?: boolean } = {}): Promise<PushResult> {
        if (!(await this.isPushRemoteSet())) {
            return { status: "skipped", reason: "no-upstream" };
        }
        this.plugin.syncSupervisor?.operationStarted("push");
        try {
            if (refreshStatus) {
                // Refresh because of pull
                const status = await this.plugin.updateCachedStatus();
                const conflictCount =
                    status.conflicted.length + status.conflictedOutsideVault;
                if (conflictCount > 0) {
                    return {
                        status: "blocked",
                        reason: "conflicts",
                        files: conflictCount,
                    };
                }
            }
            if (this.plugin.state.mergeInProgress) {
                return { status: "blocked", reason: "merge-in-progress" };
            }
            // Squash local unpushed commits into one before pushing, so frequent
            // local commits don't clutter the remote history. Only unpushed
            // history is rewritten (no force-push). Conflicts are excluded above.
            if (
                this.plugin.settings.squashCommitsBeforePush &&
                this.plugin.gitManager instanceof SimpleGit
            ) {
                await this.plugin.gitManager.squashAllUnpushedCommits();
            }
            this.plugin.log("Pushing....");
            const result = await this.plugin.gitManager.push();
            this.plugin.setPluginState({ offlineMode: false });
            this.plugin.syncSupervisor?.recordPush(result);
            this.plugin.app.workspace.trigger("obsidian-git:refresh");
            return result;
        } finally {
            this.plugin.syncSupervisor?.operationFinished();
        }
    }

    private reportPushResult(result: PushResult): void {
        switch (result.status) {
            case "pushed":
                if (result.files === null) {
                    this.plugin.displayMessage("Pushed to remote");
                } else {
                    this.plugin.displayMessage(
                        `Pushed ${result.files} ${
                            result.files == 1 ? "file" : "files"
                        } to remote`
                    );
                }
                return;
            case "up-to-date":
                this.plugin.displayMessage("No commits to push");
                return;
            case "blocked": {
                const reason = result.reason;
                switch (reason) {
                    case "no-branch":
                        this.plugin.displayError(
                            "No current branch found. Cannot push."
                        );
                        return;
                    case "conflicts":
                        this.plugin.displayError(
                            `Cannot push. You have conflicts in ${
                                result.files
                            } ${result.files == 1 ? "file" : "files"}`
                        );
                        return;
                    case "merge-in-progress":
                        this.plugin.displayError(
                            "Cannot push while a merge is still in progress"
                        );
                        return;
                }
                return;
            }
            case "skipped": {
                const reason = result.reason;
                switch (reason) {
                    case "not-ready":
                    case "no-upstream":
                        return;
                }
            }
        }
    }

    async pull(
        options?: InteractiveOptions & { isBoot?: boolean }
    ): Promise<GitActionResult<PullResult>> {
        const zh = syncLanguage() === "zh";
        const actionResult = await this.runReadyGitAction<PullResult>(
            () =>
                this.withProgressModal<PullResult>(
                    options,
                    {
                        title: zh ? "拉取远端更新" : "Pulling remote changes",
                        initialStep: zh
                            ? "正在检查上游并拉取远端更新…"
                            : "Checking upstream and pulling changes…",
                        summarizeSuccess: (res) => {
                            switch (res.status) {
                                case "updated": {
                                    const totalFiles =
                                        res.files.length + res.outsideVault;
                                    const details = res.files
                                        .slice(0, 15)
                                        .map((f) => f.vaultPath);
                                    if (res.files.length > 15) {
                                        details.push(
                                            zh
                                                ? `……共 ${res.files.length} 个文件`
                                                : `… and ${res.files.length - 15} more`
                                        );
                                    }
                                    return {
                                        ok: true,
                                        summary: zh
                                            ? `已从远端拉取 ${totalFiles} 个文件`
                                            : `Pulled ${totalFiles} ${totalFiles === 1 ? "file" : "files"} from remote`,
                                        details,
                                    };
                                }
                                case "up-to-date":
                                    return {
                                        ok: true,
                                        summary: zh
                                            ? "当前已是最新，无需拉取"
                                            : "Already up to date",
                                    };
                                case "skipped":
                                    return {
                                        ok: false,
                                        summary: zh
                                            ? "未配置或取消了上游分支，未执行拉取"
                                            : "No upstream branch configured",
                                    };
                            }
                        },
                    },
                    () => this.performPull(options?.isBoot)
                ),
            true
        );
        this.finishProgressIfNotReady(options?.progressModal, actionResult);
        return actionResult;
    }

    private async performPull(isBoot = false): Promise<PullResult> {
        if (!(await this.isPullRemoteSet())) {
            return { status: "skipped", reason: "no-upstream" };
        }
        this.plugin.syncSupervisor?.operationStarted("pull", isBoot);
        try {
            this.plugin.log("Pulling....");
            const result = await this.plugin.gitManager.pull();
            this.plugin.setPluginState({ offlineMode: false });
            this.plugin.syncSupervisor?.recordPull(result);
            return result;
        } finally {
            this.plugin.syncSupervisor?.operationFinished();
        }
    }

    async fetch(
        options?: InteractiveOptions
    ): Promise<GitActionResult<FetchResult>> {
        const zh = syncLanguage() === "zh";
        const actionResult = await this.runReadyGitAction<FetchResult>(() =>
            this.withProgressModal<FetchResult>(
                options,
                {
                    title: zh ? "获取远端索引" : "Fetching from remote",
                    initialStep: zh
                        ? "正在连接远端并获取最新引用…"
                        : "Fetching refs from remote…",
                    summarizeSuccess: (res) =>
                        res.status === "fetched"
                            ? {
                                  ok: true,
                                  summary: zh
                                      ? "已完成远端 Fetch"
                                      : "Fetched from remote",
                              }
                            : {
                                  ok: false,
                                  summary: zh
                                      ? "未设置上游分支，已跳过"
                                      : "Skipped: no upstream branch",
                              },
                },
                async () => {
                    if (!(await this.isPushRemoteSet())) {
                        return { status: "skipped", reason: "no-upstream" };
                    }
                    this.plugin.syncSupervisor?.operationStarted("fetch");
                    try {
                        await this.plugin.gitManager.fetch();
                        this.plugin.setPluginState({ offlineMode: false });
                        this.plugin.app.workspace.trigger(
                            "obsidian-git:refresh"
                        );
                        return { status: "fetched" };
                    } finally {
                        this.plugin.syncSupervisor?.operationFinished();
                    }
                }
            )
        );
        this.finishProgressIfNotReady(options?.progressModal, actionResult);
        if (actionResult.status === "success") {
            this.reportFetchResult(actionResult.value);
        }
        return actionResult;
    }

    private reportFetchResult(result: FetchResult): void {
        switch (result.status) {
            case "fetched":
                this.plugin.displayMessage("Fetched from remote");
                return;
            case "skipped": {
                const reason = result.reason;
                switch (reason) {
                    case "not-ready":
                    case "no-upstream":
                        return;
                }
            }
        }
    }

    async stageFile(
        file: TFile
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.stage(file.path, true);
    }

    async stage(
        path: string,
        relativeToVault: boolean
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runFileStateMutation(() =>
            this.plugin.gitManager.stage(path, relativeToVault)
        );
    }

    async stageAll(
        path?: string
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runFileStateMutation(() =>
            this.plugin.gitManager.stageAll({ dir: path })
        );
    }

    async unstageFile(
        file: TFile
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.unstage(file.path, true);
    }

    async unstage(
        path: string,
        relativeToVault: boolean
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runFileStateMutation(() =>
            this.plugin.gitManager.unstage(path, relativeToVault)
        );
    }

    async unstageAll(
        path?: string
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runFileStateMutation(() =>
            this.plugin.gitManager.unstageAll({ dir: path })
        );
    }

    async applyPatch(
        patch: string
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runFileStateMutation(async () => {
            if (!(this.plugin.gitManager instanceof SimpleGit)) {
                throw new Error(
                    "Applying a patch is only supported on desktop"
                );
            }
            await this.plugin.gitManager.applyPatch(patch);
        });
    }

    private async runFileStateMutation(
        action: () => Promise<void>
    ): Promise<GitActionResult<FileStateMutationResult>> {
        return this.runReadyGitAction<FileStateMutationResult>(async () => {
            await action();
            this.plugin.app.workspace.trigger("obsidian-git:refresh");
            return { status: "updated" };
        });
    }

    async setGitConfig(
        path: string,
        value: string | number | boolean | undefined
    ): Promise<GitActionResult<void>> {
        return runGitAction(this.plugin, () =>
            this.plugin.gitManager.setConfig(path, value)
        );
    }

    async runRawCommand(
        command: string
    ): Promise<GitActionResult<RawCommandResult>> {
        const notice = new Notice(`Running '${command}'...`, 999_999);
        const actionResult = await runGitAction<RawCommandResult>(
            this.plugin,
            async () => {
                if (!(this.plugin.gitManager instanceof SimpleGit)) {
                    throw new Error(
                        "Raw Git commands are only supported on desktop"
                    );
                }
                return {
                    status: "completed",
                    output: await this.plugin.gitManager.rawCommand(command),
                };
            }
        );
        if (actionResult.status === "success" && actionResult.value.output) {
            notice.setMessage(actionResult.value.output);
            window.setTimeout(() => notice.hide(), 5000);
        } else {
            notice.hide();
        }
        return actionResult;
    }

    async switchBranch(): Promise<GitActionResult<SwitchBranchResult>> {
        const actionResult = await this.runReadyGitAction<SwitchBranchResult>(
            async () => {
                const branchInfo = await this.plugin.gitManager.branchInfo();
                const selectedBranch = await new BranchModal(
                    this.plugin,
                    branchInfo.branches
                ).openAndGetReslt();
                if (selectedBranch === undefined) {
                    return { status: "cancelled" };
                }

                await this.plugin.gitManager.checkout(selectedBranch);
                this.plugin.app.workspace.trigger("obsidian-git:refresh");
                await this.plugin.branchBar?.display();
                return { status: "switched", branch: selectedBranch };
            }
        );
        if (actionResult.status === "success") {
            this.reportSwitchBranchResult(actionResult.value);
        }
        return actionResult;
    }

    async switchRemoteBranch(
        options?: InteractiveOptions
    ): Promise<GitActionResult<SwitchBranchResult>> {
        const zh = syncLanguage() === "zh";
        const actionResult = await this.runReadyGitAction<SwitchBranchResult>(
            async () => {
                const selectedBranch = await this.selectRemoteBranch(options);
                if (selectedBranch === undefined) {
                    return { status: "cancelled" };
                }
                const [remote, branch] = splitRemoteBranch(selectedBranch);
                if (branch === undefined || remote === undefined) {
                    return { status: "cancelled" };
                }

                await this.withProgressModal<void>(
                    options,
                    {
                        title: zh
                            ? "切换远端分支"
                            : "Switching to remote branch",
                        initialStep: zh
                            ? `正在检出分支「${selectedBranch}」…`
                            : `Checking out "${selectedBranch}"…`,
                        summarizeSuccess: () => ({
                            ok: true,
                            summary: zh
                                ? `已切换到 ${selectedBranch}`
                                : `Switched to ${selectedBranch}`,
                        }),
                    },
                    async () => {
                        await this.plugin.gitManager.checkout(branch, remote);
                        await this.plugin.branchBar?.display();
                    }
                );
                return { status: "switched", branch: selectedBranch };
            }
        );
        if (actionResult.status === "success") {
            this.reportSwitchBranchResult(actionResult.value);
        }
        return actionResult;
    }

    private reportSwitchBranchResult(result: SwitchBranchResult): void {
        switch (result.status) {
            case "switched":
                this.plugin.displayMessage(`Switched to ${result.branch}`);
                return;
            case "cancelled":
            case "skipped":
                return;
        }
    }

    async createBranch(): Promise<GitActionResult<CreateBranchResult>> {
        const actionResult = await this.runReadyGitAction<CreateBranchResult>(
            async () => {
                const branch = await new GeneralModal(this.plugin, {
                    placeholder: "Create new branch",
                }).openAndGetResult();
                if (branch === undefined) {
                    return { status: "cancelled" };
                }

                await this.plugin.gitManager.createBranch(branch);
                await this.plugin.branchBar?.display();
                return { status: "created", branch };
            }
        );
        if (actionResult.status === "success") {
            this.reportCreateBranchResult(actionResult.value);
        }
        return actionResult;
    }

    private reportCreateBranchResult(result: CreateBranchResult): void {
        switch (result.status) {
            case "created":
                this.plugin.displayMessage(
                    `Created new branch ${result.branch}`
                );
                return;
            case "cancelled":
            case "skipped":
                return;
        }
    }

    async deleteBranch(): Promise<GitActionResult<DeleteBranchResult>> {
        const actionResult = await this.runReadyGitAction<DeleteBranchResult>(
            async () => {
                const branchInfo = await this.plugin.gitManager.branchInfo();
                if (branchInfo.current) {
                    branchInfo.branches.remove(branchInfo.current);
                }
                const branch = await new GeneralModal(this.plugin, {
                    options: branchInfo.branches,
                    placeholder: "Delete branch",
                    onlySelection: true,
                }).openAndGetResult();
                if (branch === undefined) {
                    return { status: "cancelled" };
                }

                let force = false;
                const merged =
                    await this.plugin.gitManager.branchIsMerged(branch);
                if (!merged) {
                    const forceAnswer = await new GeneralModal(this.plugin, {
                        options: ["YES", "NO"],
                        placeholder:
                            "This branch isn't merged into HEAD. Force delete?",
                        onlySelection: true,
                    }).openAndGetResult();
                    if (forceAnswer !== "YES") {
                        return { status: "cancelled" };
                    }
                    force = true;
                }
                await this.plugin.gitManager.deleteBranch(branch, force);
                await this.plugin.branchBar?.display();
                return { status: "deleted", branch };
            }
        );
        if (actionResult.status === "success") {
            this.reportDeleteBranchResult(actionResult.value);
        }
        return actionResult;
    }

    private reportDeleteBranchResult(result: DeleteBranchResult): void {
        switch (result.status) {
            case "deleted":
                this.plugin.displayMessage(`Deleted branch ${result.branch}`);
                return;
            case "cancelled":
            case "skipped":
                return;
        }
    }

    private async canAutoSetupPushRemote(): Promise<boolean> {
        return (
            this.plugin.gitManager instanceof SimpleGit &&
            (await this.plugin.gitManager.getConfig(
                "push.autoSetupRemote",
                "all"
            )) == "true"
        );
    }

    /**
     * A pull needs an existing upstream. When Git is configured to create the
     * upstream on the first push, skip the pull and let that push establish it.
     */
    async isPullRemoteSet(): Promise<boolean> {
        if (this.plugin.settings.updateSubmodules) {
            return true;
        }
        if ((await this.plugin.gitManager.branchInfo()).tracking) {
            return true;
        }
        if (await this.canAutoSetupPushRemote()) {
            new Notice(
                "Upstream branch will be created on first push. Skipping pull.\nUse set upstream branch command to set it manually if desired."
            );
            return false;
        }
        new Notice("No upstream branch is set. Please select one.");
        const result = await this.performSetUpstreamBranch();
        this.reportSetUpstreamResult(result);
        return result.status === "updated";
    }

    /**
     * A push can proceed without an existing upstream when Git is configured
     * to create it automatically.
     */
    async isPushRemoteSet(): Promise<boolean> {
        if (
            this.plugin.settings.updateSubmodules ||
            (await this.canAutoSetupPushRemote())
        ) {
            return true;
        }
        if (!(await this.plugin.gitManager.branchInfo()).tracking) {
            new Notice("No upstream branch is set. Please select one.");
            const result = await this.performSetUpstreamBranch();
            this.reportSetUpstreamResult(result);
            return result.status === "updated";
        }
        return true;
    }

    async setUpstreamBranch(
        options?: InteractiveOptions
    ): Promise<GitActionResult<SetUpstreamResult>> {
        const actionResult = await this.runReadyGitAction<SetUpstreamResult>(
            async () => {
                return this.performSetUpstreamBranch(options);
            }
        );
        if (actionResult.status === "success") {
            this.reportSetUpstreamResult(actionResult.value);
        }
        return actionResult;
    }

    private async performSetUpstreamBranch(
        options?: InteractiveOptions
    ): Promise<SetUpstreamResult> {
        const remoteBranch = await this.selectRemoteBranch(options);

        if (remoteBranch == undefined) {
            return { status: "cancelled" };
        }
        const zh = syncLanguage() === "zh";
        await this.withProgressModal<void>(
            options,
            {
                title: zh ? "设置上游分支" : "Setting upstream branch",
                initialStep: zh
                    ? `正在关联上游分支「${remoteBranch}」…`
                    : `Linking upstream branch "${remoteBranch}"…`,
                summarizeSuccess: () => ({
                    ok: true,
                    summary: zh
                        ? `已将上游分支设置为 ${remoteBranch}`
                        : `Upstream branch set to ${remoteBranch}`,
                }),
            },
            async () => {
                await this.plugin.gitManager.updateUpstreamBranch(remoteBranch);
            }
        );
        return { status: "updated", branch: remoteBranch };
    }

    private reportSetUpstreamResult(result: SetUpstreamResult): void {
        switch (result.status) {
            case "updated":
                this.plugin.displayMessage(
                    `Set upstream branch to ${result.branch}`
                );
                return;
            case "cancelled":
                this.plugin.displayError(
                    "Aborted. No upstream-branch is set!",
                    10000
                );
                return;
            case "skipped":
                return;
        }
    }

    async discardFile(
        file: FileStatusResult
    ): Promise<GitActionResult<DiscardActionResult>> {
        const actionResult = await this.runReadyGitAction<DiscardActionResult>(
            async () => {
                const deleteFile = file.workingDir === "U";
                const selection = await new DiscardModal({
                    app: this.plugin.app,
                    filesToDeleteCount: deleteFile ? 1 : 0,
                    filesToDiscardCount: deleteFile ? 0 : 1,
                    path: file.vaultPath,
                }).openAndGetResult();
                if (selection === false) {
                    return { status: "cancelled" };
                }

                if (selection === "delete") {
                    const tFile = this.plugin.app.vault.getAbstractFileByPath(
                        file.vaultPath
                    );
                    if (tFile) {
                        await this.plugin.app.fileManager.trashFile(tFile);
                    } else {
                        await this.plugin.app.vault.adapter.remove(
                            file.vaultPath
                        );
                    }
                } else {
                    await this.plugin.gitManager.discard(file.path);
                }
                this.plugin.app.workspace.trigger("obsidian-git:refresh");
                return { status: "discarded", target: "file" };
            }
        );
        if (actionResult.status === "success") {
            this.reportDiscardResult(actionResult.value, false);
        }
        return actionResult;
    }

    async discardAll(
        path?: string,
        options?: InteractiveOptions
    ): Promise<GitActionResult<DiscardActionResult>> {
        const zh = syncLanguage() === "zh";
        const actionResult = await this.runReadyGitAction<DiscardActionResult>(
            async () => {
                const status = await this.plugin.gitManager.status({ path });
                const mergeInProgress =
                    !path && (await this.plugin.gitManager.isMergeInProgress());
                let filesToDeleteCount = 0;
                const trackedPaths = new Set<string>();
                for (const file of status.changed) {
                    if (file.workingDir == "U") {
                        filesToDeleteCount++;
                    } else {
                        trackedPaths.add(file.path);
                    }
                }
                for (const file of status.staged) {
                    trackedPaths.add(file.path);
                }
                for (const filePath of status.conflicted) {
                    trackedPaths.add(filePath);
                }
                let filesToDiscardCount = trackedPaths.size;
                if (filesToDiscardCount === 0 && mergeInProgress) {
                    filesToDiscardCount = 1;
                }
                if (filesToDeleteCount + filesToDiscardCount === 0) {
                    return { status: "skipped", reason: "no-changes" };
                }

                const selection = await new DiscardModal({
                    app: this.plugin.app,
                    filesToDeleteCount,
                    filesToDiscardCount,
                    path: path ?? "",
                }).openAndGetResult();
                if (selection === false) {
                    return { status: "cancelled" };
                }

                await this.withProgressModal<void>(
                    options,
                    {
                        title: zh ? "放弃更改" : "Discard changes",
                        initialStep: zh
                            ? "正在恢复工作区并清理合并状态…"
                            : "Restoring files and resetting index…",
                        summarizeSuccess: () => ({
                            ok: true,
                            summary:
                                selection === "delete"
                                    ? zh
                                        ? "已丢弃并删除所有本地未提交改动"
                                        : "Discarded all files and changes"
                                    : zh
                                      ? "已放弃所有已跟踪文件的本地改动"
                                      : "Discarded all tracked changes",
                        }),
                    },
                    async (modal) => {
                        await this.plugin.gitManager.discardAll({
                            dir: path,
                            status,
                        });
                        if (selection === "delete") {
                            modal?.setStep(
                                zh
                                    ? "正在删除未跟踪文件…"
                                    : "Deleting untracked files…"
                            );
                            const untrackedPaths =
                                await this.plugin.gitManager.getUntrackedPaths({
                                    path,
                                });
                            for (const file of untrackedPaths) {
                                const vaultPath =
                                    this.plugin.gitManager.getRelativeVaultPath(
                                        file
                                    );
                                const tFile =
                                    this.plugin.app.vault.getAbstractFileByPath(
                                        vaultPath
                                    );

                                if (tFile) {
                                    await this.plugin.app.fileManager.trashFile(
                                        tFile
                                    );
                                } else if (file.endsWith("/")) {
                                    await this.plugin.app.vault.adapter.rmdir(
                                        vaultPath,
                                        true
                                    );
                                } else {
                                    await this.plugin.app.vault.adapter.remove(
                                        vaultPath
                                    );
                                }
                            }
                        }
                        if (!path) {
                            this.plugin.setPluginState({
                                mergeInProgress: false,
                            });
                            this.plugin.syncSupervisor?.clearConflictProblem();
                        }
                        await this.plugin.updateCachedStatus();
                        this.plugin.app.workspace.trigger(
                            "obsidian-git:refresh"
                        );
                    }
                );
                return {
                    status: "discarded",
                    target: selection === "delete" ? "all" : "tracked",
                };
            }
        );
        if (actionResult.status === "success") {
            this.reportDiscardResult(actionResult.value, path === undefined);
        }
        return actionResult;
    }

    private reportDiscardResult(
        result: DiscardActionResult,
        showSuccess: boolean
    ): void {
        switch (result.status) {
            case "discarded":
                if (!showSuccess || result.target === "file") return;
                this.plugin.displayMessage(
                    result.target === "all"
                        ? "Discarded all files."
                        : "Discarded all changes in tracked files."
                );
                return;
            case "cancelled":
            case "skipped":
                return;
        }
    }

    async editRemotes(): Promise<GitActionResult<EditRemoteResult>> {
        const actionResult = await this.runReadyGitAction<EditRemoteResult>(
            async () => {
                return this.performEditRemotes();
            }
        );
        if (actionResult.status === "success") {
            this.reportEditRemoteResult(actionResult.value);
        }
        return actionResult;
    }

    private async performEditRemotes(): Promise<EditRemoteResult> {
        const remotes = await this.plugin.gitManager.getRemotes();
        const remoteName = await new GeneralModal(this.plugin, {
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        }).openAndGetResult();
        if (!remoteName) {
            return { status: "cancelled" };
        }

        const oldUrl = await this.plugin.gitManager.getRemoteUrl(remoteName);
        const remoteURL = await new GeneralModal(this.plugin, {
            initialValue: oldUrl,
            placeholder: "Enter remote URL",
        }).openAndGetResult();
        if (!remoteURL) {
            return { status: "cancelled" };
        }

        await this.plugin.gitManager.setRemote(
            remoteName,
            formatRemoteUrl(remoteURL)
        );
        return { status: "updated", remote: remoteName };
    }

    private reportEditRemoteResult(result: EditRemoteResult): void {
        switch (result.status) {
            case "updated":
            case "cancelled":
            case "skipped":
                return;
        }
    }

    private async selectRemoteBranch(
        options?: InteractiveOptions
    ): Promise<string | undefined> {
        let remotes = await this.plugin.gitManager.getRemotes();
        let selectedRemote: string | undefined;
        if (remotes.length === 0) {
            const editResult = await this.performEditRemotes();
            if (editResult.status === "updated") {
                selectedRemote = editResult.remote;
            }
            if (selectedRemote == undefined) {
                remotes = await this.plugin.gitManager.getRemotes();
            }
        }

        const nameModal = new GeneralModal(this.plugin, {
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        });
        const remoteName =
            selectedRemote ?? (await nameModal.openAndGetResult());

        if (remoteName) {
            const zh = syncLanguage() === "zh";
            this.plugin.displayMessage("Fetching remote branches");
            let fetchModal: OperationProgressModal | undefined;
            try {
                await this.withProgressModal<void>(
                    options,
                    {
                        title: zh
                            ? "获取远端分支列表"
                            : "Fetching remote branches",
                        initialStep: zh
                            ? `正在从「${remoteName}」拉取分支引用…`
                            : `Fetching branch refs from "${remoteName}"…`,
                        closeOnSuccess: true,
                        modalRef: (m) => {
                            fetchModal = m;
                        },
                    },
                    async () => {
                        await this.plugin.gitManager.fetch(remoteName);
                    }
                );
            } catch (error) {
                const cached =
                    await this.plugin.gitManager.getRemoteBranches(remoteName);
                if (cached.length === 0) {
                    throw error;
                }
                fetchModal?.close();
                this.plugin.log(
                    "Fetching remote branches failed; using cached refs:",
                    error
                );
                this.plugin.displayMessage(
                    zh
                        ? "无法刷新远端分支列表，已使用本地缓存分支"
                        : "Could not reach remote; showing cached branches"
                );
            }

            const rawBranches =
                await this.plugin.gitManager.getRemoteBranches(remoteName);
            let currentBranch: string | undefined;
            try {
                currentBranch = (await this.plugin.gitManager.branchInfo())
                    .current;
            } catch {
                currentBranch = undefined;
            }
            const priority = new Map<string, number>([
                [`${remoteName}/main`, 0],
                [`${remoteName}/master`, 1],
            ]);
            if (currentBranch) {
                priority.set(`${remoteName}/${currentBranch}`, 2);
            }
            const branches = [...new Set(rawBranches)]
                .filter((b) => !b.endsWith("/HEAD"))
                .sort((a, b) => {
                    const pa = priority.get(a) ?? 10;
                    const pb = priority.get(b) ?? 10;
                    if (pa !== pb) return pa - pb;
                    return a.localeCompare(b);
                });

            const branchModal = new GeneralModal(this.plugin, {
                options: branches,
                placeholder:
                    "Select or create a new remote branch by typing its name and selecting it",
            });
            let branch = await branchModal.openAndGetResult();
            if (branch == undefined) return undefined;
            branch = branch.trim();
            if (!branch) return undefined;
            if (branch.startsWith("refs/remotes/")) {
                branch = branch.slice("refs/remotes/".length);
            } else if (branch.startsWith("remotes/")) {
                branch = branch.slice("remotes/".length);
            }
            if (!branch.startsWith(remoteName + "/")) {
                // If the branch does not start with the remote name, prepend it
                return `${remoteName}/${branch}`;
            }
            return branch; // Already in the correct format
        }
        return undefined;
    }

    async removeRemote(): Promise<GitActionResult<RemoveRemoteResult>> {
        const actionResult = await this.runReadyGitAction<RemoveRemoteResult>(
            async () => {
                const remotes = await this.plugin.gitManager.getRemotes();
                const remoteName = await new GeneralModal(this.plugin, {
                    options: remotes,
                    placeholder: "Select a remote",
                }).openAndGetResult();
                if (!remoteName) {
                    return { status: "cancelled" };
                }

                await this.plugin.gitManager.removeRemote(remoteName);
                return { status: "removed", remote: remoteName };
            }
        );
        if (actionResult.status === "success") {
            this.reportRemoveRemoteResult(actionResult.value);
        }
        return actionResult;
    }

    private reportRemoveRemoteResult(result: RemoveRemoteResult): void {
        switch (result.status) {
            case "removed":
            case "cancelled":
            case "skipped":
                return;
        }
    }
}
