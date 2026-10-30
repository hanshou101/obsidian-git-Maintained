import { createPatch } from "diff";
import type {
    AuthCallback,
    AuthFailureCallback,
    GitHttpRequest,
    GitHttpResponse,
    GitProgressEvent,
    HttpClient,
    MergeDriverParams,
    StatusRow,
    TreeEntry,
    Walker,
    WalkerEntry,
} from "isomorphic-git";
import git, { Errors, readBlob } from "isomorphic-git";
import { GitIndexManager } from "isomorphic-git/managers";
import { FileSystem } from "isomorphic-git/models";
import { normalizePath, Notice, requestUrl } from "obsidian";
import type ObsidianGit from "../main";
import type {
    BranchInfo,
    FileStatusResult,
    LogEntry,
    PullResult,
    PushResult,
    Status,
    UnstagedFile,
    WalkDifference,
} from "../types";
import { GitConflictError, GitOperation, type DiffFile } from "../types";
import { GeneralModal } from "../ui/modals/generalModal";
import {
    createAutoCommitPathSelector,
    type AutoCommitGlobSelection,
    type AutoCommitSelectedFiles,
} from "../autoCommitGlobs";
import { splitRemoteBranch, worthWalking } from "../utils";
import { GitManager, type PullRecovery } from "./gitManager";
import { MyAdapter } from "./myAdapter";
import { sendRequest, type NetworkEnvironment } from "./networkPolicy";
import diff3Merge from "diff3";

/**
 * obsidian-git-Maintained: written before a pull touches the working tree and
 * removed once the branch points at the pulled commit. If it is still there,
 * the pull was interrupted (Obsidian closed or killed) half-way.
 */
interface PullJournal {
    version: 1;
    branch: string;
    from: string;
    to: string;
    paths: string[];
    startedAt: string;
}

/** What `clearPullBlockers` did with the local versions in the way of a pull. */
interface PullBlockers {
    /** Local versions that already exist in the history; put back to HEAD. */
    restored: string[];
    /** Unknown local versions copied into the rescue folder, then restored. */
    rescued: { path: string; copy: string }[];
    /** Unknown local versions left alone; the pull will stop on them. */
    blocked: string[];
}

/** Commits searched for earlier versions of a file in the way of a pull. */
const KNOWN_VERSION_COMMITS = 300;

export class IsomorphicGit extends GitManager {
    private static readonly MERGE_HEAD = "MERGE_HEAD";
    private static readonly MERGE_MESSAGE = "MERGE_MSG";
    private static readonly MERGE_MODE = "MERGE_MODE";
    private static readonly ORIGINAL_HEAD = "ORIG_HEAD";
    private static readonly PULL_JOURNAL = "git-maintained-pull.json";
    private readonly FILE = 0;
    private readonly HEAD = 1;
    private readonly WORKDIR = 2;
    private readonly STAGE = 3;
    // Mapping from statusMatrix to git status codes based off git status --short
    // See: https://isomorphic-git.org/docs/en/statusMatrix
    private readonly status_mapping: Readonly<Record<string, string>> = {
        "000": "  ",
        "003": "AD",
        "020": "??",
        "022": "A ",
        "023": "AM",
        "100": "D ",
        "101": " D",
        "103": "MD",
        "110": "DA", // Technically, two files: first one is deleted "D " and second one is untracked "??"
        "111": "  ",
        "113": "MM",
        "120": "DA", // Same as "110"
        "121": " M",
        "122": "M ",
        "123": "MM",
    };
    private readonly noticeLength = 999_999;
    private readonly fs = new MyAdapter(this.app.vault, this.plugin);
    /** obsidian-git-Maintained: timeouts and retries in weak network mode. */
    network: NetworkEnvironment = {
        request: async (param) => {
            const response = await requestUrl(param);
            return {
                status: response.status,
                headers: response.headers,
                arrayBuffer: response.arrayBuffer,
            };
        },
        weakNetworkMode: () => this.plugin.settings.weakNetworkMode === true,
        isOnline: () =>
            typeof navigator === "undefined" || navigator.onLine !== false,
        isHidden: () =>
            this.plugin.syncSupervisor?.inBackground ??
            (typeof document !== "undefined" &&
                document.visibilityState === "hidden"),
        sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    };

    constructor(plugin: ObsidianGit) {
        super(plugin);
    }

    getRepo(): {
        fs: MyAdapter;
        dir: string;
        gitdir?: string;
        onAuth: AuthCallback;
        onAuthFailure: AuthFailureCallback;
        http: HttpClient;
    } {
        const network = this.network;
        return {
            fs: this.fs,
            dir: this.plugin.settings.basePath || "/",
            gitdir: this.plugin.settings.gitDir
                ? this.getGitDirPath()
                : undefined,
            onAuth: () => {
                return {
                    username:
                        this.plugin.localStorage.getUsername() ?? undefined,
                    password: this.plugin.gitServerPassword.get() ?? undefined,
                };
            },
            onAuthFailure: async () => {
                new Notice(
                    "Authentication failed. Please try with different credentials"
                );
                const username = await new GeneralModal(this.plugin, {
                    placeholder: "Specify your username",
                }).openAndGetResult();
                if (username) {
                    const password = await new GeneralModal(this.plugin, {
                        placeholder:
                            "Specify your password/personal access token",
                        obscure: true,
                    }).openAndGetResult();
                    if (password) {
                        this.plugin.localStorage.setUsername(username);
                        await this.plugin.gitServerPassword.set(password);
                        return {
                            username,
                            password,
                        };
                    }
                }
                return { cancel: true };
            },
            http: {
                async request({
                    url,
                    method,
                    headers,
                    body,
                }: GitHttpRequest): Promise<GitHttpResponse> {
                    // We can't stream yet, so collect body and set it to the ArrayBuffer
                    // because that's what requestUrl expects
                    let collectedBody: ArrayBuffer | undefined;
                    if (body) {
                        collectedBody = await asyncIteratorToArrayBuffer(body);
                    }

                    // obsidian-git-Maintained: weak network mode adds
                    // timeouts and retries (networkPolicy.ts).
                    const res = await sendRequest(network, {
                        url,
                        method,
                        // Ask the server not to compress the response. The
                        // packfile parser needs the exact raw bytes; if a
                        // server or proxy gzips the response and the platform
                        // does not transparently inflate it, the packfile is
                        // persisted corrupted and only fails later with
                        // "Packfile payload corrupted".
                        headers: { "Accept-Encoding": "identity", ...headers },
                        body: collectedBody,
                        throw: false,
                    });

                    // Defense in depth: if the response still arrived gzipped
                    // (a server/proxy ignored the request and the platform did
                    // not inflate it), inflate it ourselves. This is keyed on
                    // the gzip magic bytes rather than the `Content-Encoding`
                    // header on purpose: some platforms auto-inflate but leave
                    // the header in place, and trusting it would double-inflate
                    // and corrupt the body.
                    const responseBuffer = await inflateIfGzipped(
                        res.arrayBuffer
                    );

                    return {
                        url,
                        method,
                        headers: res.headers,
                        body: arrayBufferToAsyncIterator(responseBuffer),
                        statusCode: res.status,
                        statusMessage: res.status.toString(),
                    };
                },
            },
        };
    }

    async wrapFS<T>(call: Promise<T>): Promise<T> {
        try {
            const res = await call;
            await this.fs.saveAndClear();
            return res;
        } catch (error) {
            await this.fs.saveAndClear();
            throw error;
        }
    }

    async status(opts?: { path?: string }): Promise<Status> {
        if (opts?.path == undefined) {
            return this.statusOf(undefined, () => true);
        }
        const path = opts.path.replace(/\/$/, "");
        return this.statusOf(
            [`${opts.path}/`],
            (file) => file === path || file.startsWith(`${path}/`)
        );
    }

    /**
     * obsidian-git-Maintained: the status of these repository paths (files or
     * folders) and nothing else. Automatic commits with include globs use it,
     * so they do not walk the whole working tree (2A-META: about 2,800 files,
     * 2 to 4 s per walk on a phone).
     */
    async scopedStatus(paths: string[]): Promise<Status> {
        const scopes = paths.map((path) => path.replace(/\/+$/, ""));
        return this.statusOf(scopes, (file) =>
            scopes.some(
                (scope) => file === scope || file.startsWith(`${scope}/`)
            )
        );
    }

    private async statusOf(
        filepaths: string[] | undefined,
        inScope: (file: string) => boolean
    ): Promise<Status> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            const statusOpts = { ...this.getRepo() } as Parameters<
                typeof git.statusMatrix
            >[0];
            if (filepaths != undefined) {
                statusOpts.filepaths = filepaths;
            }
            const status = (
                await this.wrapFS(git.statusMatrix(statusOpts))
            ).map((row) => this.getFileStatusResult(row));

            const conflicted = (await this.getConflictedFiles()).filter(
                inScope
            );

            const changed: FileStatusResult[] = [];
            const staged: FileStatusResult[] = [];
            const all: FileStatusResult[] = [];
            const conflictedPaths = new Set(conflicted);
            for (const file of status) {
                if (
                    file.workingDir !== " " &&
                    !conflictedPaths.has(file.path)
                ) {
                    changed.push(file);
                }
                if (
                    file.index !== " " &&
                    file.index !== "U" &&
                    !conflictedPaths.has(file.path)
                ) {
                    staged.push(file);
                }
                if (file.index != " " || file.workingDir != " ") {
                    all.push(file);
                }
            }
            window.clearTimeout(timeout);
            notice?.hide();
            return {
                all,
                changed,
                staged,
                conflicted,
                stagedOutsideVault: 0,
                conflictedOutsideVault: 0,
            };
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            throw error;
        }
    }

    async commitAll({
        message,
        status,
        unstagedFiles,
        selection,
        amend,
    }: {
        message: string;
        status?: Status;
        unstagedFiles?: FileStatusResult[];
        selection?: AutoCommitGlobSelection;
        amend?: boolean;
    }): Promise<number> {
        await this.checkAuthorInfo();
        await this.stageAll({ status, unstagedFiles, selection });
        return this.commit({ message, amend });
    }

    selectAutoCommitFiles(
        status: Status,
        selection: AutoCommitGlobSelection
    ): Promise<AutoCommitSelectedFiles> {
        const isSelected = createAutoCommitPathSelector(selection);
        return Promise.resolve({
            files: status.changed.filter((file) => isSelected(file.path)),
            selection,
        });
    }

    async commit({
        message,
        amend,
    }: {
        message: string;
        amend?: boolean;
    }): Promise<number> {
        return this.withGitOperation(GitOperation.commit, async () => {
            try {
                await this.checkAuthorInfo();
                const formatMessage = await this.formatCommitMessage(message);
                const mergeHeads = await this.getMergeHeads();
                let parent: string[] | undefined = undefined;

                if (mergeHeads.length > 0) {
                    parent = [await this.resolveRef("HEAD"), ...mergeHeads];
                }

                const oid = await this.wrapFS(
                    git.commit({
                        ...this.getRepo(),
                        message: formatMessage,
                        amend,
                        parent: parent,
                    })
                );
                const committedFiles = await this.getCommittedFilesCount(oid);
                await this.clearMergeState();
                this.plugin.setPluginState({ mergeInProgress: false });
                return committedFiles;
            } catch (error) {
                if (error instanceof Errors.UnmergedPathsError) {
                    throw new GitConflictError(error.data.filepaths, error);
                }
                throw error;
            }
        });
    }

    async stage(filepath: string, relativeToVault: boolean): Promise<void> {
        const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
        let vaultPath: string;
        if (relativeToVault) {
            vaultPath = filepath;
        } else {
            vaultPath = this.getRelativeVaultPath(filepath);
        }
        if (await this.app.vault.adapter.exists(vaultPath)) {
            await this.wrapFS(
                git.add({ ...this.getRepo(), filepath: gitPath })
            );
        } else {
            await this.wrapFS(
                git.remove({ ...this.getRepo(), filepath: gitPath })
            );
        }
    }

    async stageAll({
        dir,
        status,
        unstagedFiles,
        selection,
    }: {
        dir?: string;
        status?: Status;
        unstagedFiles?: FileStatusResult[];
        selection?: AutoCommitGlobSelection;
    }): Promise<void> {
        const statusFiles = unstagedFiles ?? status?.changed;
        const files = statusFiles
            ? statusFiles.map((file) => ({
                  path: file.path,
                  deleted: file.workingDir === "D",
              }))
            : (await this.getUnstagedFiles(dir ?? ".")).map(
                  ({ path, type }) => ({ path, deleted: type === "D" })
              );
        const isSelected = selection
            ? createAutoCommitPathSelector(selection)
            : () => true;
        await this.stageFiles(files.filter((file) => isSelected(file.path)));
    }

    private async stageFiles(
        files: { path: string; deleted: boolean }[]
    ): Promise<void> {
        const results = await this.wrapFS(
            Promise.allSettled(
                files.map((file) =>
                    file.deleted
                        ? git.remove({
                              ...this.getRepo(),
                              filepath: file.path,
                          })
                        : git.add({
                              ...this.getRepo(),
                              filepath: file.path,
                          })
                )
            )
        );

        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }

    async unstage(filepath: string, relativeToVault: boolean): Promise<void> {
        filepath = this.getRelativeRepoPath(filepath, relativeToVault);
        await this.wrapFS(
            git.resetIndex({ ...this.getRepo(), filepath: filepath })
        );
    }

    async unstageAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        let staged: string[];
        if (status) {
            staged = status.staged.map((file) => file.path);
        } else {
            const res = await this.getStagedFiles(dir ?? ".");
            staged = res.map(({ path }) => path);
        }
        await this.wrapFS(
            Promise.all(
                staged.map((file) =>
                    git.resetIndex({ ...this.getRepo(), filepath: file })
                )
            )
        );
    }

    async discard(filepath: string): Promise<void> {
        await this.wrapFS(
            git.checkout({
                ...this.getRepo(),
                filepaths: [filepath],
                force: true,
            })
        );
    }

    async discardAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        let files: string[];
        if (status) {
            if (dir != undefined) {
                files = status.changed
                    .filter(
                        (file) =>
                            file.workingDir != "U" && file.path.startsWith(dir)
                    )
                    .map((file) => file.path);
            } else {
                files = status.changed
                    .filter((file) => file.workingDir != "U")
                    .map((file) => file.path);
            }
        } else {
            files = (await this.getUnstagedFiles(dir))
                .filter((file) => file.type != "A")
                .map(({ path }) => path);
        }

        await this.wrapFS(
            git.checkout({
                ...this.getRepo(),
                filepaths: files,
                force: true,
            })
        );
    }

    async getUntrackedPaths(opts: {
        path?: string;
        status?: Status;
    }): Promise<string[]> {
        const untrackedPaths: string[] = [];
        if (opts.status) {
            for (const file of opts.status.changed) {
                if (
                    file.index == "U" &&
                    file.workingDir === "U" &&
                    file.path.startsWith(
                        opts.path != undefined ? `${opts.path}/` : ""
                    )
                ) {
                    untrackedPaths.push(file.path);
                }
            }
        } else {
            const status = await this.status({ path: opts?.path });
            for (const file of status.changed) {
                if (file.index === "U" && file.workingDir === "U") {
                    untrackedPaths.push(file.path);
                }
            }
        }
        return untrackedPaths;
    }

    getProgressText(action: string, event: GitProgressEvent): string {
        let out = `${action} progress:`;
        if (event.phase) {
            out = `${out} ${event.phase}:`;
        }
        if (event.loaded) {
            out = `${out} ${event.loaded}`;
            if (event.total) {
                out = `${out} of ${event.total}`;
            }
        }
        return out;
    }

    resolveRef(ref: string): Promise<string> {
        return this.wrapFS(git.resolveRef({ ...this.getRepo(), ref }));
    }

    async pull(): Promise<PullResult> {
        return this.withGitOperation(GitOperation.pull, async () => {
            let mergeState:
                { ours: string; theirs: string; message: string } | undefined;
            try {
                if (await this.isMergeInProgress()) {
                    throw new Error(
                        "Cannot pull because a merge is still in progress. Commit or abort it first."
                    );
                }
                // obsidian-git-Maintained: finish a pull that was cut off.
                await this.recoverInterruptedPull();
                const branchInfo = await this.branchInfo();
                if (!branchInfo.current) {
                    throw new Error("No current branch found. Cannot pull.");
                }

                const localCommit = await this.resolveRef(branchInfo.current);

                if (!branchInfo.tracking) {
                    this.plugin.log("No tracking branch found. Ignoring pull.");
                    return { status: "skipped", reason: "no-upstream" };
                }

                await this.fetch();

                const theirs = await this.resolveRef(branchInfo.tracking);
                if (localCommit === theirs) {
                    return { status: "up-to-date" };
                }

                await this.checkAuthorInfo();

                mergeState = {
                    ours: localCommit,
                    theirs,
                    message: `Merge branch '${branchInfo.tracking}' into ${branchInfo.current}`,
                };

                const mergeOptions: Parameters<typeof git.merge>[0] = {
                    ...this.getRepo(),
                    ours: branchInfo.current,
                    theirs: branchInfo.tracking,
                    message: mergeState.message,
                    // Keep HEAD at the old commit until checkout succeeds.
                    noUpdateBranch: true,
                    mergeDriver:
                        this.plugin.settings.mergeStrategy !== "none"
                            ? this.mergeDriver.bind(this)
                            : undefined,
                };
                let mergeRes;
                try {
                    // This leaves the index and worktree untouched on conflict.
                    mergeRes = await this.wrapFS(
                        git.merge({ ...mergeOptions, abortOnConflict: true })
                    );
                } catch (error) {
                    if (!(error instanceof Errors.MergeConflictError)) {
                        throw error;
                    }
                    // Conflict materialization writes the whole tentative tree,
                    // so it can only run when no local work would be lost.
                    this.reportPullBlockers(
                        await this.clearPullBlockers({
                            from: localCommit,
                            theirs,
                            target: theirs,
                        })
                    );
                    await this.ensureCleanPullWorktree(localCommit, true);
                    const incoming = await this.getFileChangesCount(
                        localCommit,
                        theirs
                    );
                    await this.ensureNoIncomingFileCollisions(incoming);
                    this.plugin.syncSupervisor?.expectWrites(
                        incoming.map((file) => file.path)
                    );

                    // A `Errors.MergeConflictError` is expected here
                    await this.wrapFS(
                        git.merge({ ...mergeOptions, abortOnConflict: false })
                    );
                    // eslint-disable-next-line preserve-caught-error -- Error.cause is unavailable with the project's ES2021 target.
                    throw new Error("Merge conflict was not reproduced.");
                }
                if (mergeRes.alreadyMerged) {
                    return { status: "up-to-date" };
                }
                if (!mergeRes.oid) {
                    throw new Error(
                        "Pull did not produce a commit to check out."
                    );
                }

                const changedFiles = await this.getFileChangesCount(
                    localCommit,
                    mergeRes.oid
                );
                if (changedFiles.length > 0) {
                    const filepaths = changedFiles.map((file) => file.path);
                    // obsidian-git-Maintained: local versions of these files
                    // that already exist in the history (left by a pull that
                    // was cut off) go back to HEAD; unknown ones are copied to
                    // the rescue folder first, if one is set.
                    this.reportPullBlockers(
                        await this.clearPullBlockers({
                            from: localCommit,
                            theirs,
                            target: mergeRes.oid,
                            paths: filepaths,
                            incoming: changedFiles,
                        })
                    );
                    await this.ensureNoIncomingFileCollisions(changedFiles);
                    // A merge commit exists, but its result has not yet been
                    // installed in the index or working tree.
                    await this.ensureCleanPullWorktree(
                        localCommit,
                        true,
                        filepaths
                    );
                    await this.writePullJournal({
                        version: 1,
                        branch: branchInfo.current,
                        from: localCommit,
                        to: mergeRes.oid,
                        paths: filepaths,
                        startedAt: new Date().toISOString(),
                    });
                    this.plugin.syncSupervisor?.expectWrites(filepaths);
                    await this.wrapFS(
                        git.checkout({
                            ...this.getRepo(),
                            ref: mergeRes.oid,
                            noUpdateHead: true,
                            force: !!mergeRes.mergeCommit,
                            filepaths,
                        })
                    );
                }
                await this.wrapFS(
                    git.writeRef({
                        ...this.getRepo(),
                        ref: `refs/heads/${branchInfo.current}`,
                        value: mergeRes.oid,
                        force: true,
                    })
                );
                await this.clearPullJournal();

                return {
                    status: "updated",
                    outsideVault: 0,
                    files: changedFiles.map<FileStatusResult>((file) => ({
                        path: file.path,
                        workingDir: "P",
                        index: "P",
                        vaultPath: this.getRelativeVaultPath(file.path),
                    })),
                };
            } catch (error) {
                if (error instanceof Errors.MergeConflictError) {
                    if (mergeState !== undefined) {
                        await this.writeMergeState(mergeState);
                    }
                    throw new GitConflictError(error.data.filepaths, error);
                }
                throw error;
            }
        });
    }

    private mergeDriver({ contents }: MergeDriverParams): {
        cleanMerge: boolean;
        mergedText: string;
    } {
        const baseContent = contents[0]!;
        const ourContent = contents[1]!;
        const theirContent = contents[2]!;

        const LINEBREAKS = /^.*(\r?\n|$)/gm;
        const ours = ourContent.match(LINEBREAKS) ?? [];
        const base = baseContent.match(LINEBREAKS) ?? [];
        const theirs = theirContent.match(LINEBREAKS) ?? [];
        const result = diff3Merge(ours, base, theirs);
        let mergedText = "";
        for (const item of result) {
            if (item.ok) {
                mergedText += item.ok.join("");
            }
            if (item.conflict) {
                mergedText +=
                    this.plugin.settings.mergeStrategy === "ours"
                        ? item.conflict.a.join("")
                        : item.conflict.b.join("");
            }
        }
        return { cleanMerge: true, mergedText };
    }

    private async ensureCleanPullWorktree(
        ref: string,
        checkIndex = false,
        filepaths?: string[]
    ): Promise<void> {
        const status = await this.wrapFS(
            git.statusMatrix({ ...this.getRepo(), ref, filepaths })
        );
        const changed = status
            .filter(
                ([, head, workdir, stage]) =>
                    head !== workdir || (checkIndex && head !== stage)
            )
            .map(([filepath]) => filepath);
        if (changed.length > 0) {
            throw new Error(
                `Cannot pull with uncommitted working tree changes: ${changed.join(", ")}`
            );
        }
    }

    private async ensureNoIncomingFileCollisions(
        files: WalkDifference[]
    ): Promise<void> {
        // Ignored untracked files may be absent from statusMatrix.
        for (const file of files) {
            if (
                file.type === "A" &&
                (await this.app.vault.adapter.exists(
                    this.getRelativeVaultPath(file.path)
                ))
            ) {
                throw new Error(
                    `Cannot pull because an untracked file would be overwritten: ${file.path}`
                );
            }
        }
    }

    // region: obsidian-git-Maintained — pulls cut off half-way

    /**
     * Finishes a pull that was cut off after it began writing the working
     * tree (Obsidian killed, force-closed, or out of time in the background).
     * The journal names the commit the branch was moving to and the files
     * involved. Runs before every pull and every commit, so the half-written
     * files are neither committed back nor left in the way of later pulls.
     */
    override async recoverInterruptedPull(): Promise<PullRecovery | undefined> {
        const journal = await this.readPullJournal();
        if (journal === undefined) return undefined;
        const current = await git.currentBranch(this.getRepo());
        const head = current
            ? await this.resolveRef(current).catch(() => undefined)
            : undefined;
        let targetExists = true;
        try {
            await this.wrapFS(
                git.readCommit({ ...this.getRepo(), oid: journal.to })
            );
        } catch {
            targetExists = false;
        }
        if (
            current !== journal.branch ||
            head !== journal.from ||
            !targetExists
        ) {
            // Finished (HEAD is already at `to`) or overtaken by other work;
            // the checks of the next pull handle what is left on disk.
            await this.clearPullJournal();
            return undefined;
        }
        const incoming = await this.getFileChangesCount(
            journal.from,
            journal.to
        );
        const filepaths = incoming.map((file) => file.path);
        // The forced checkout below rewrites these files, so known versions
        // need no restore; unknown ones are rescued or stop the recovery.
        const blockers = await this.clearPullBlockers({
            from: journal.from,
            theirs: journal.to,
            target: journal.to,
            paths: filepaths,
            incoming,
            restore: false,
        });
        if (blockers.blocked.length > 0) {
            throw new Error(
                `Cannot pull with uncommitted working tree changes: ${blockers.blocked.join(", ")}`
            );
        }
        if (filepaths.length > 0) {
            this.plugin.syncSupervisor?.expectWrites(filepaths);
            await this.wrapFS(
                git.checkout({
                    ...this.getRepo(),
                    ref: journal.to,
                    noUpdateHead: true,
                    force: true,
                    filepaths,
                })
            );
        }
        await this.wrapFS(
            git.writeRef({
                ...this.getRepo(),
                ref: `refs/heads/${journal.branch}`,
                value: journal.to,
                force: true,
            })
        );
        await this.clearPullJournal();
        const recovery: PullRecovery = {
            resumed: true,
            files: filepaths.length,
            restored: blockers.restored,
            rescued: blockers.rescued,
        };
        this.plugin.syncSupervisor?.recordPullRecovery(recovery);
        return recovery;
    }

    /**
     * Deals with the local versions of `paths` that would stop a pull from
     * `from` to `target`: modified, deleted, or untracked files, and staged
     * changes.
     * - A local version that already exists in the history the pull brings in
     *   is not local work. It is what a pull cut off half-way wrote (the
     *   index and the branch were not updated yet). It goes back to the
     *   version in `from`, so the pull can apply its changes again.
     * - An unknown local version is copied into the rescue folder (setting
     *   `rescueFolder`) and then treated the same way. Without a rescue
     *   folder it is left alone, and the usual checks stop the pull.
     */
    private async clearPullBlockers({
        from,
        theirs,
        target,
        paths,
        incoming = [],
        restore = true,
    }: {
        from: string;
        theirs: string;
        target: string;
        paths?: string[];
        incoming?: WalkDifference[];
        restore?: boolean;
    }): Promise<PullBlockers> {
        const result: PullBlockers = { restored: [], rescued: [], blocked: [] };
        if (paths?.length === 0) return result;
        const rows = await this.wrapFS(
            git.statusMatrix({ ...this.getRepo(), ref: from, filepaths: paths })
        );
        const local = new Map<string, number>();
        for (const [path, head, workdir, stage] of rows) {
            if (head !== workdir || head !== stage) local.set(path, workdir);
        }
        // Files the pull adds that exist here but are ignored, so the status
        // matrix does not list them.
        for (const file of incoming) {
            if (
                file.type === "A" &&
                !local.has(file.path) &&
                (await this.app.vault.adapter.exists(
                    this.getRelativeVaultPath(file.path)
                ))
            ) {
                local.set(file.path, 2);
            }
        }
        if (local.size === 0) return result;

        const candidates = [...local.keys()];
        const known = await this.knownVersions(candidates, {
            from,
            theirs,
            target,
        });
        const handled: string[] = [];
        for (const path of candidates) {
            const versions = known.get(path)!;
            const workdir = local.get(path)!;
            let bytes: Uint8Array | undefined;
            let oid: string | null;
            if (workdir === 0) {
                oid = null;
            } else if (workdir === 1) {
                // Same as HEAD; only the index differs.
                oid = versions[0] ?? null;
            } else {
                bytes = new Uint8Array(
                    await this.app.vault.adapter.readBinary(
                        this.getRelativeVaultPath(path)
                    )
                );
                oid = (await git.hashBlob({ object: bytes })).oid;
            }
            if (versions.includes(oid)) {
                result.restored.push(path);
                handled.push(path);
                continue;
            }
            const copy = await this.rescueLocalVersion(path, bytes);
            if (copy !== undefined) {
                result.rescued.push({ path, copy });
                handled.push(path);
                continue;
            }
            result.blocked.push(path);
        }
        if (restore && handled.length > 0) {
            await this.restoreToCommit(from, handled, known);
        }
        return result;
    }

    private reportPullBlockers(blockers: PullBlockers): void {
        if (blockers.restored.length > 0 || blockers.rescued.length > 0) {
            this.plugin.syncSupervisor?.recordPullRecovery({
                resumed: false,
                files: 0,
                restored: blockers.restored,
                rescued: blockers.rescued,
            });
        }
    }

    /**
     * The versions of `paths` (blob ids, `null` for "absent") in `from`, in
     * the commit the pull installs, and in every commit the pull brings in
     * (the commits the remote has and `from` lacks, at most
     * {@link KNOWN_VERSION_COMMITS}). The first element is always the
     * version in `from`.
     */
    private async knownVersions(
        paths: string[],
        {
            from,
            theirs,
            target,
        }: { from: string; theirs: string; target: string }
    ): Promise<Map<string, (string | null)[]>> {
        const repo = { ...this.getRepo(), cache: {} };
        const trees = new Map<string, string>();
        const treeOf = async (oid: string) => {
            let tree = trees.get(oid);
            if (tree === undefined) {
                const { commit } = await this.wrapFS(
                    git.readCommit({ ...repo, oid })
                );
                tree = commit.tree;
                trees.set(oid, tree);
            }
            return tree;
        };
        // What the remote has and `from` does not: the commits the pull
        // brings in.
        const incoming = await this.commitsOnlyIn(
            [theirs],
            [from],
            KNOWN_VERSION_COMMITS
        );
        const commits = [
            ...new Set([from, target, theirs, ...incoming.commits]),
        ];

        const entries = new Map<string, TreeEntry[]>();
        const blobAt = async (
            tree: string,
            path: string
        ): Promise<string | null> => {
            let current = tree;
            const segments = path.split("/");
            for (let i = 0; i < segments.length; i++) {
                let list = entries.get(current);
                if (list === undefined) {
                    list = (
                        await this.wrapFS(
                            git.readTree({ ...repo, oid: current })
                        )
                    ).tree;
                    entries.set(current, list);
                }
                const entry = list.find((item) => item.path === segments[i]);
                if (entry === undefined) return null;
                if (i === segments.length - 1) {
                    return entry.type === "blob" ? entry.oid : null;
                }
                if (entry.type !== "tree") return null;
                current = entry.oid;
            }
            return null;
        };

        const result = new Map<string, (string | null)[]>();
        for (const path of paths) {
            const versions: (string | null)[] = [];
            for (const commit of commits) {
                versions.push(await blobAt(await treeOf(commit), path));
            }
            result.set(path, versions);
        }
        return result;
    }

    /** Puts `paths` back to their version in `commit`, in the index too. */
    private async restoreToCommit(
        commit: string,
        paths: string[],
        known: Map<string, (string | null)[]>
    ): Promise<void> {
        const present = paths.filter((path) => known.get(path)?.[0]);
        const absent = paths.filter((path) => !known.get(path)?.[0]);
        this.plugin.syncSupervisor?.expectWrites(paths);
        if (present.length > 0) {
            await this.wrapFS(
                git.checkout({
                    ...this.getRepo(),
                    ref: commit,
                    noUpdateHead: true,
                    force: true,
                    filepaths: present,
                })
            );
        }
        for (const path of absent) {
            const vaultPath = this.getRelativeVaultPath(path);
            if (await this.app.vault.adapter.exists(vaultPath)) {
                await this.fs.unlink(vaultPath);
            }
            await this.wrapFS(
                git.remove({ ...this.getRepo(), filepath: path })
            );
        }
    }

    /**
     * Copies a local version that is in no commit into the rescue folder.
     * Returns the vault path of the copy ("" for a local deletion, which has
     * nothing to copy), or `undefined` when no rescue folder is set.
     */
    private async rescueLocalVersion(
        path: string,
        bytes: Uint8Array | undefined
    ): Promise<string | undefined> {
        const folder = normalizePath(this.plugin.settings.rescueFolder ?? "")
            .replace(/^\/+|\/+$/g, "")
            .trim();
        if (folder === "" || folder === "/") return undefined;
        if (bytes === undefined) return "";
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, "0");
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const copy = normalizePath(`${folder}/${stamp}/${path}`);
        const segments = copy.split("/");
        for (let i = 1; i < segments.length; i++) {
            const dir = segments.slice(0, i).join("/");
            if (!(await this.app.vault.adapter.exists(dir))) {
                await this.fs.mkdir(dir);
            }
        }
        await this.fs.writeFile(copy, bytes);
        return copy;
    }

    private async readPullJournal(): Promise<PullJournal | undefined> {
        const path = this.getMergeStatePath(IsomorphicGit.PULL_JOURNAL);
        if (!(await this.app.vault.adapter.exists(path))) return undefined;
        try {
            const value = JSON.parse(
                await this.app.vault.adapter.read(path)
            ) as Partial<PullJournal>;
            if (
                value.version === 1 &&
                typeof value.branch === "string" &&
                typeof value.from === "string" &&
                typeof value.to === "string" &&
                Array.isArray(value.paths)
            ) {
                return value as PullJournal;
            }
        } catch {
            // An unreadable journal is dropped below.
        }
        await this.clearPullJournal();
        return undefined;
    }

    private async writePullJournal(journal: PullJournal): Promise<void> {
        await this.app.vault.adapter.write(
            this.getMergeStatePath(IsomorphicGit.PULL_JOURNAL),
            JSON.stringify(journal)
        );
    }

    private async clearPullJournal(): Promise<void> {
        const path = this.getMergeStatePath(IsomorphicGit.PULL_JOURNAL);
        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
        }
    }

    // endregion

    async push(): Promise<PushResult> {
        const progressNotice = this.showNotice("Initializing push");
        return this.withGitOperation(GitOperation.push, async () => {
            try {
                const status = await this.branchInfo();
                const trackingBranch = status.tracking;
                const currentBranch = status.current;
                if (!currentBranch) {
                    progressNotice?.hide();
                    return { status: "blocked", reason: "no-branch" };
                }
                if (!trackingBranch) {
                    progressNotice?.hide();
                    this.plugin.log("No tracking branch found. Ignoring push.");
                    return { status: "skipped", reason: "no-upstream" };
                }
                const numChangedFiles = (
                    await this.getFileChangesCount(
                        currentBranch,
                        trackingBranch
                    )
                ).length;

                const remote = await this.getCurrentRemote();

                await this.wrapFS(
                    git.push({
                        ...this.getRepo(),
                        remote,
                        onProgress: (progress) => {
                            if (progressNotice !== undefined) {
                                progressNotice.setMessage(
                                    this.getProgressText("Pushing", progress)
                                );
                            }
                        },
                    })
                );
                progressNotice?.hide();
                return numChangedFiles === 0
                    ? { status: "up-to-date" }
                    : { status: "pushed", files: numChangedFiles };
            } catch (error) {
                progressNotice?.hide();
                throw error;
            }
        });
    }

    async getUnpushedCommits(): Promise<number> {
        const status = await this.branchInfo();
        const trackingBranch = status.tracking;
        const currentBranch = status.current;

        if (trackingBranch == null || currentBranch == null) {
            return 0;
        }

        const localCommit = await this.resolveRef(currentBranch);
        const upstreamCommit = await this.resolveRef(trackingBranch);

        const changedFiles = await this.getFileChangesCount(
            localCommit,
            upstreamCommit
        );

        return changedFiles.length;
    }

    /** obsidian-git-Maintained: local commits the remote-tracking branch lacks. */
    override async commitsAhead(): Promise<number | undefined> {
        const { current, tracking } = await this.branchInfo();
        if (!current || !tracking) return undefined;
        const local = await this.resolveRef(current);
        let remote: string;
        try {
            remote = await this.resolveRef(tracking);
        } catch {
            return undefined;
        }
        if (local === remote) return 0;
        const { commits, complete } = await this.commitsOnlyIn(
            [local],
            [remote],
            2000
        );
        return complete ? commits.length : undefined;
    }

    /**
     * obsidian-git-Maintained: the commits reachable from `include` but not
     * from `exclude`, like `git rev-list <include> ^<exclude>`. Both sides
     * are walked newest first by commit date, as Git does, so the walk stops
     * soon after the histories meet. `complete` is false when it stopped at
     * `limit` commits; `commits` then holds what was found so far.
     */
    private async commitsOnlyIn(
        include: string[],
        exclude: string[],
        limit: number
    ): Promise<{ commits: string[]; complete: boolean }> {
        const repo = { ...this.getRepo(), cache: {} };
        const INCLUDE = 1;
        const EXCLUDE = 2;
        const flags = new Map<string, number>();
        const info = new Map<string, { parents: string[]; date: number }>();
        const queue = new Set<string>();
        const mark = async (oid: string, flag: number) => {
            const before = flags.get(oid) ?? 0;
            if ((before | flag) === before) return;
            flags.set(oid, before | flag);
            if (!info.has(oid)) {
                const { commit } = await this.wrapFS(
                    git.readCommit({ ...repo, oid })
                );
                info.set(oid, {
                    parents: commit.parent,
                    date: commit.committer.timestamp,
                });
            }
            queue.add(oid);
        };
        for (const oid of exclude) await mark(oid, EXCLUDE);
        for (const oid of include) await mark(oid, INCLUDE);
        // Like Git, go on a few steps after only excluded commits are left,
        // in case a commit date is off.
        let slop = 5;
        let visited = 0;
        let complete = true;
        while (queue.size > 0) {
            if ([...queue].every((oid) => flags.get(oid)! & EXCLUDE)) {
                if (--slop < 0) break;
            } else {
                slop = 5;
            }
            if (++visited > limit) {
                complete = false;
                break;
            }
            let newest: string | undefined;
            for (const oid of queue) {
                if (
                    newest === undefined ||
                    info.get(oid)!.date > info.get(newest)!.date
                ) {
                    newest = oid;
                }
            }
            queue.delete(newest!);
            const flag = flags.get(newest!)!;
            for (const parent of info.get(newest!)!.parents) {
                await mark(parent, flag);
            }
        }
        const commits = [...flags]
            .filter(([, flag]) => flag === INCLUDE)
            .map(([oid]) => oid)
            .sort((a, b) => info.get(b)!.date - info.get(a)!.date);
        return { commits, complete };
    }

    async canPush(): Promise<boolean> {
        const status = await this.branchInfo();
        const trackingBranch = status.tracking;
        const currentBranch = status.current;

        if (!currentBranch) {
            this.plugin.log("During canPush check, no current branch found.");
            return false;
        }
        if (!trackingBranch) {
            return false;
        }

        const current = await this.resolveRef(currentBranch);
        const tracking = await this.resolveRef(trackingBranch);

        return current != tracking;
    }

    async checkRequirements(): Promise<"valid" | "missing-repo"> {
        const headExists = await this.plugin.app.vault.adapter.exists(
            normalizePath(`${this.getGitDirPath()}/HEAD`)
        );

        return headExists ? "valid" : "missing-repo";
    }

    async branchInfo(): Promise<BranchInfo & { remote: string }> {
        const current = await git.currentBranch(this.getRepo());

        const branches = await git.listBranches(this.getRepo());

        const remote =
            (current && (await this.getConfig(`branch.${current}.remote`))) ??
            "origin";

        const trackingBranch = current
            ? (await this.getConfig(`branch.${current}.merge`))?.split(
                  "refs/heads"
              )[1]
            : undefined;

        const tracking = trackingBranch ? remote + trackingBranch : undefined;

        return {
            current: current || undefined,
            tracking: tracking,
            branches: branches,
            remote: remote,
        };
    }

    async getCurrentRemote(): Promise<string> {
        const current = (await git.currentBranch(this.getRepo())) || "";

        const remote =
            (await this.getConfig(`branch.${current}.remote`)) ?? "origin";
        return remote;
    }

    async checkout(branch: string, remote?: string): Promise<void> {
        return this.withGitOperation(GitOperation.checkout, () =>
            this.wrapFS(
                git.checkout({
                    ...this.getRepo(),
                    ref: branch,
                    force: !!remote,
                    remote,
                })
            )
        );
    }

    async createBranch(branch: string): Promise<void> {
        await this.wrapFS(
            git.branch({ ...this.getRepo(), ref: branch, checkout: true })
        );
    }

    async deleteBranch(branch: string): Promise<void> {
        await this.wrapFS(git.deleteBranch({ ...this.getRepo(), ref: branch }));
    }

    branchIsMerged(_: string): Promise<boolean> {
        return Promise.resolve(true);
    }

    async init(): Promise<void> {
        await this.wrapFS(git.init(this.getRepo()));
    }

    async clone(url: string, dir: string, depth?: number): Promise<void> {
        const progressNotice = this.showNotice("Initializing clone");
        try {
            await this.wrapFS(
                git.clone({
                    ...this.getRepo(),
                    dir: dir,
                    url: url,
                    depth: depth,
                    onProgress: (progress) => {
                        if (progressNotice !== undefined) {
                            progressNotice.setMessage(
                                this.getProgressText("Cloning", progress)
                            );
                        }
                    },
                })
            );
        } finally {
            progressNotice?.hide();
        }
    }

    async setConfig(
        path: string,
        value: string | number | boolean | undefined
    ): Promise<void> {
        return this.wrapFS(
            git.setConfig({
                ...this.getRepo(),
                path: path,
                value: value,
            })
        );
    }

    async getConfig(path: string): Promise<string | undefined> {
        return this.wrapFS(
            git.getConfig({
                ...this.getRepo(),
                path: path,
            }) as Promise<string | undefined>
        );
    }

    async fetch(remote?: string): Promise<void> {
        const progressNotice = this.showNotice("Initializing fetch");

        try {
            const args = {
                ...this.getRepo(),
                onProgress: (progress: GitProgressEvent) => {
                    if (progressNotice !== undefined) {
                        progressNotice.setMessage(
                            this.getProgressText("Fetching", progress)
                        );
                    }
                },
                remote: remote ?? (await this.getCurrentRemote()),
            };

            await this.wrapFS(git.fetch(args));
            progressNotice?.hide();
        } catch (error) {
            progressNotice?.hide();
            throw error;
        }
    }

    async setRemote(name: string, url: string): Promise<void> {
        await this.wrapFS(
            git.addRemote({
                ...this.getRepo(),
                remote: name,
                url: url,
                force: true,
            })
        );
    }

    async getRemoteBranches(remote: string): Promise<string[]> {
        let remoteBranches = [];
        remoteBranches.push(
            ...(await this.wrapFS(
                git.listBranches({ ...this.getRepo(), remote: remote })
            ))
        );

        remoteBranches.remove("HEAD");

        //Align with simple-git
        remoteBranches = remoteBranches.map((e) => `${remote}/${e}`);
        return remoteBranches;
    }

    async getRemotes(): Promise<string[]> {
        return (await this.wrapFS(git.listRemotes({ ...this.getRepo() }))).map(
            (remoteUrl) => remoteUrl.remote
        );
    }

    async removeRemote(remoteName: string): Promise<void> {
        await this.wrapFS(
            git.deleteRemote({ ...this.getRepo(), remote: remoteName })
        );
    }

    async getRemoteUrl(remote: string): Promise<string | undefined> {
        return (
            await this.wrapFS(git.listRemotes({ ...this.getRepo() }))
        ).filter((item) => item.remote == remote)[0]?.url;
    }

    async log(
        _?: string,
        __ = true,
        limit?: number,
        ref?: string
    ): Promise<LogEntry[]> {
        const logs = await this.wrapFS(
            git.log({ ...this.getRepo(), depth: limit, ref: ref })
        );

        return Promise.all(
            logs.map(async (log) => {
                const completeMessage = log.commit.message.split("\n\n");

                return {
                    message: completeMessage[0] ?? "",
                    author: {
                        name: log.commit.author.name,
                        email: log.commit.author.email,
                    },
                    body: completeMessage.slice(1).join("\n\n"),
                    date: new Date(
                        log.commit.committer.timestamp
                    ).toDateString(),
                    diff: {
                        changed: 0,
                        files: (
                            await this.getFileChangesCount(
                                log.commit.parent.first()!,
                                log.oid
                            )
                        ).map<DiffFile>((item) => {
                            return {
                                path: item.path,
                                status: item.type,
                                vaultPath: this.getRelativeVaultPath(item.path),
                                hash: log.oid,
                            };
                        }),
                    },
                    hash: log.oid,
                    refs: [],
                };
            })
        );
    }

    updateBasePath(basePath: string): Promise<void> {
        this.getRepo().dir = basePath;
        return Promise.resolve();
    }

    private getGitDirPath(): string {
        return normalizePath(
            this.getRelativeVaultPath(this.plugin.settings.gitDir || ".git")
        );
    }

    private async getConflictedFiles(): Promise<string[]> {
        const result = GitIndexManager.acquire(
            {
                fs: new FileSystem(this.fs),
                gitdir: this.getGitDirPath(),
                cache: {},
            },
            (index) => index.unmergedPaths as unknown
        ) as Promise<unknown>;
        const conflicted = await this.wrapFS(result);
        if (
            !Array.isArray(conflicted) ||
            !conflicted.every((path: unknown) => typeof path === "string")
        ) {
            throw new TypeError(
                "isomorphic-git returned invalid unmerged paths"
            );
        }
        return conflicted;
    }

    private getMergeStatePath(filename: string): string {
        return normalizePath(`${this.getGitDirPath()}/${filename}`);
    }

    async isMergeInProgress(): Promise<boolean> {
        return this.app.vault.adapter.exists(
            this.getMergeStatePath(IsomorphicGit.MERGE_HEAD)
        );
    }

    private async getMergeHeads(): Promise<string[]> {
        const path = this.getMergeStatePath(IsomorphicGit.MERGE_HEAD);
        if (!(await this.app.vault.adapter.exists(path))) {
            return [];
        }

        return (await this.app.vault.adapter.read(path))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    }

    private async writeMergeState({
        ours,
        theirs,
        message,
    }: {
        ours: string;
        theirs: string;
        message: string;
    }): Promise<void> {
        const adapter = this.app.vault.adapter;
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.ORIGINAL_HEAD),
            `${ours}\n`
        );
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.MERGE_MESSAGE),
            `${message}\n`
        );
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.MERGE_MODE),
            ""
        );
        // MERGE_HEAD is written last because its presence marks the merge as active.
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.MERGE_HEAD),
            `${theirs}\n`
        );
    }

    private async clearMergeState(): Promise<void> {
        const adapter = this.app.vault.adapter;
        for (const filename of [
            IsomorphicGit.MERGE_HEAD,
            IsomorphicGit.MERGE_MESSAGE,
            IsomorphicGit.MERGE_MODE,
        ]) {
            const path = this.getMergeStatePath(filename);
            if (await adapter.exists(path)) {
                await adapter.remove(path);
            }
        }
    }

    async updateUpstreamBranch(remoteBranch: string): Promise<void> {
        const [remote, branch] = splitRemoteBranch(remoteBranch);
        const branchInfo = await this.branchInfo();

        await this.wrapFS(
            git.push({
                ...this.getRepo(),
                remote: remote,
                remoteRef: branch,
            })
        );

        await this.setConfig(
            `branch.${branchInfo.current}.merge`,
            `refs/heads/${branch}`
        );
    }

    updateGitPath(_: string): Promise<void> {
        // isomorphic-git library has its own git client
        return Promise.resolve();
    }

    private async getCommittedFilesCount(oid: string): Promise<number> {
        const { commit } = await this.wrapFS(
            git.readCommit({ ...this.getRepo(), oid })
        );
        const parent = commit.parent[0];

        if (!parent) {
            return (
                await this.wrapFS(
                    git.listFiles({ ...this.getRepo(), ref: oid })
                )
            ).length;
        }

        return (await this.getFileChangesCount(parent, oid)).length;
    }

    async getFileChangesCount(
        commitHash1: string,
        commitHash2: string
    ): Promise<WalkDifference[]> {
        return this.walkDifference({
            walkers: [
                git.TREE({ ref: commitHash1 }),
                git.TREE({ ref: commitHash2 }),
            ],
        });
    }

    async walkDifference({
        walkers,
        dir: base,
    }: {
        walkers: Walker[];
        dir?: string;
    }): Promise<WalkDifference[]> {
        return this.wrapFS(
            typedWalk<WalkDifference>({
                ...this.getRepo(),
                trees: walkers,
                map: async function (
                    filepath,
                    [A, B]
                ): Promise<WalkDifference | null | undefined> {
                    if (!worthWalking(filepath, base)) {
                        return null;
                    }

                    const Atype = await A?.type();
                    const Btype = await B?.type();
                    if (Atype === "tree" || Btype === "tree") {
                        // Skip identical subtrees; the root must stay so walk returns an array.
                        if (filepath !== "." && Atype === Btype) {
                            const Aoid = await A?.oid();
                            if (
                                Aoid !== undefined &&
                                Aoid === (await B?.oid())
                            ) {
                                return null;
                            }
                        }
                        return;
                    }

                    // generate ids
                    const [Aoid, Boid, Amode, Bmode] = await Promise.all([
                        A?.oid(),
                        B?.oid(),
                        A?.mode(),
                        B?.mode(),
                    ]);

                    // determine modification type
                    let type: WalkDifference["type"] | "equal" = "equal";
                    if (Aoid !== Boid || Amode !== Bmode) {
                        type = "M";
                    }
                    if (Aoid === undefined) {
                        type = "A";
                    }
                    if (Boid === undefined) {
                        type = "D";
                    }

                    if (Aoid === undefined && Boid === undefined) {
                        console.log("Something weird happened:");
                        console.log(A);
                        console.log(B);
                    }
                    if (type === "equal") {
                        return;
                    }

                    return {
                        path: filepath,
                        type: type,
                    };
                },
            })
        );
    }

    protected override async getStagedForMessage(): Promise<
        Pick<Status, "staged" | "stagedOutsideVault">
    > {
        try {
            await this.resolveRef("HEAD");
        } catch (error) {
            // Without HEAD (first commit) there is no tree to compare with.
            if (error instanceof Errors.NotFoundError) {
                return super.getStagedForMessage();
            }
            throw error;
        }
        // Compare HEAD with the index only, skipping the full working tree walk.
        const staged = await this.getStagedFiles();
        return {
            staged: staged.map(({ path, vaultPath, type }) => ({
                path,
                vaultPath,
                index: type,
                workingDir: " ",
            })),
            stagedOutsideVault: 0,
        };
    }

    async getStagedFiles(
        dir = "."
    ): Promise<(WalkDifference & { vaultPath: string })[]> {
        const res = await this.walkDifference({
            walkers: [git.TREE({ ref: "HEAD" }), git.STAGE()],
            dir,
        });
        return res.map((file) => {
            return {
                vaultPath: this.getRelativeVaultPath(file.path),
                path: file.path,
                type: file.type,
            };
        });
    }

    async getUnstagedFiles(base = "."): Promise<UnstagedFile[]> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            const repo = this.getRepo();
            const res = await this.wrapFS(
                //Modified from `git.statusMatrix`
                typedWalk<UnstagedFile>({
                    ...repo,
                    trees: [git.WORKDIR(), git.STAGE()],
                    map: async function (
                        filepath,
                        [workdir, stage]
                    ): Promise<UnstagedFile | null | undefined> {
                        // Ignore ignored files, but only if they are not already tracked.
                        if (!stage && workdir) {
                            const isIgnored = await git.isIgnored({
                                ...repo,
                                filepath,
                            });
                            if (isIgnored) {
                                return null;
                            }
                        }
                        // match against base path
                        if (!worthWalking(filepath, base)) {
                            return null;
                        }
                        // Late filter against file names
                        // if (filter) {
                        //     if (!filter(filepath)) return;
                        // }

                        const [workdirType, stageType] = await Promise.all([
                            workdir && workdir.type(),
                            stage && stage.type(),
                        ]);

                        const isBlob = [workdirType, stageType].includes(
                            "blob"
                        );

                        // For now, bail on directories unless the file is also a blob in another tree
                        if (
                            (workdirType === "tree" ||
                                workdirType === "special") &&
                            !isBlob
                        )
                            return;

                        if (stageType === "commit") return null;
                        if (
                            (stageType === "tree" || stageType === "special") &&
                            !isBlob
                        )
                            return;

                        // Figure out the oids for files, using the staged oid for the working dir oid if the stats match.
                        const stageOid =
                            stageType === "blob"
                                ? await stage!.oid()
                                : undefined;
                        let workdirOid;
                        if (workdirType === "blob" && stageType !== "blob") {
                            // We don't actually NEED the sha. Any sha will do
                            workdirOid = "42";
                        } else if (workdirType === "blob") {
                            workdirOid = await workdir!.oid();
                        }
                        if (!workdirOid) {
                            return {
                                path: filepath,
                                type: "D",
                            };
                        }
                        if (!stageOid) {
                            return {
                                path: filepath,
                                type: "A",
                            };
                        }

                        if (workdirOid !== stageOid) {
                            return {
                                path: filepath,
                                type: "M",
                            };
                        }
                        return null;
                        // const entry = [undefined, headOid, workdirOid, stageOid];
                        // const result = entry.map(value => entry.indexOf(value));
                        // result.shift(); // remove leading undefined entry
                        // return [filepath, ...result];
                    },
                })
            );
            window.clearTimeout(timeout);
            notice?.hide();
            return res;
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            throw error;
        }
    }

    async getDiffString(
        filePath: string,
        stagedChanges = false,
        hash?: string
    ): Promise<string> {
        const vaultPath = this.getRelativeVaultPath(filePath);

        const map: TypedWalkerMap<Uint8Array> = async (file, [A]) => {
            if (filePath == file) {
                const oid = await A!.oid();
                const contents = await git.readBlob({
                    ...this.getRepo(),
                    oid: oid,
                });
                return contents.blob;
            }
            return undefined;
        };
        if (hash) {
            const commitContent = await readBlob({
                ...this.getRepo(),
                filepath: filePath,
                oid: hash,
            })
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });
            const commit = await git.readCommit({
                ...this.getRepo(),
                oid: hash,
            });

            const parentOid = commit.commit.parent.first();
            let previousContent: string | undefined;
            if (parentOid) {
                previousContent = await readBlob({
                    ...this.getRepo(),
                    filepath: filePath,
                    oid: parentOid,
                })
                    .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                    .catch((err) => {
                        if (err instanceof git.Errors.NotFoundError)
                            return undefined;
                        throw err;
                    });
            }

            const diff = createPatch(
                vaultPath,
                previousContent ?? "",
                commitContent ?? ""
            );
            return diff;
        }

        const stagedBlob = (
            await typedWalk<Uint8Array>({
                ...this.getRepo(),
                trees: [git.STAGE()],
                map,
            })
        ).first();
        const stagedContent = new TextDecoder().decode(stagedBlob);

        if (stagedChanges) {
            const headContent = await this.resolveRef("HEAD")
                .then((oid) =>
                    readBlob({
                        ...this.getRepo(),
                        filepath: filePath,
                        oid: oid,
                    })
                )
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });

            const diff = createPatch(
                vaultPath,
                headContent ?? "",
                stagedContent
            );
            return diff;
        } else {
            let workdirContent: string;
            if (await this.app.vault.adapter.exists(vaultPath)) {
                workdirContent = await this.app.vault.adapter.read(vaultPath);
            } else {
                workdirContent = "";
            }

            const diff = createPatch(vaultPath, stagedContent, workdirContent);
            return diff;
        }
    }

    async show(
        commitHash: string,
        file: string,
        relativeToVault = true
    ): Promise<string> {
        const filepath = this.getRelativeRepoPath(file, relativeToVault);
        const { blob } = await readBlob({
            ...this.getRepo(),
            oid: commitHash,
            filepath,
        });
        return new TextDecoder().decode(blob);
    }

    async getLastCommitTime(): Promise<Date | undefined> {
        const repo = this.getRepo();
        const oid = await this.resolveRef("HEAD");
        const commit = await git.readCommit({ ...repo, oid: oid });
        const date = commit.commit.committer.timestamp;
        return new Date(date * 1000);
    }

    private getFileStatusResult(row: StatusRow): FileStatusResult {
        const statusKey = `${row[this.HEAD]}${row[this.WORKDIR]}${row[this.STAGE]}`;
        const status = this.status_mapping[statusKey];
        if (status === undefined) {
            throw new Error(`Unsupported status matrix row: ${statusKey}`);
        }
        // status will always be two characters
        return {
            index: status[0] == "?" ? "U" : (status[0] ?? " "),
            workingDir: status[1] == "?" ? "U" : (status[1] ?? " "),
            path: row[this.FILE],
            vaultPath: this.getRelativeVaultPath(row[this.FILE]),
        };
    }

    private async checkAuthorInfo(): Promise<void> {
        const name = await this.getConfig("user.name");
        const email = await this.getConfig("user.email");
        if (!name || !email) {
            throw Error(
                "Git author name and email are not set. Please set both fields in the settings."
            );
        }
    }

    private showNotice(message: string, infinity = true): Notice | undefined {
        if (!this.plugin.settings.disablePopups) {
            return new Notice(
                message,
                infinity ? this.noticeLength : undefined
            );
        }
        return undefined;
    }
}

type TypedWalkerMap<T> = (
    filename: string,
    entries: Array<WalkerEntry | null>
) => Promise<T | null | undefined>;

type TypedWalkOptions<T> = Omit<Parameters<typeof git.walk>[0], "map"> & {
    map: TypedWalkerMap<T>;
};

async function typedWalk<T>(options: TypedWalkOptions<T>): Promise<T[]> {
    const result: unknown = await git.walk(options);
    if (!Array.isArray(result)) {
        throw new TypeError("isomorphic-git walk returned a non-array result");
    }
    return result as T[];
}

function arrayBufferToAsyncIterator(
    buffer: ArrayBuffer
): AsyncIterableIterator<Uint8Array> {
    const iterator = [new Uint8Array(buffer)].values();
    return {
        next: () => Promise.resolve(iterator.next()),
        [Symbol.asyncIterator]() {
            return this;
        },
    };
}

async function asyncIteratorToArrayBuffer(
    iterator: AsyncIterableIterator<Uint8Array>
): Promise<ArrayBuffer> {
    const stream = new ReadableStream({
        async start(controller) {
            for await (const chunk of iterator) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });

    const response = new Response(stream);
    return await response.arrayBuffer();
}

// If `buffer` starts with the gzip magic bytes (0x1f 0x8b), inflate it and
// return the decompressed bytes; otherwise return it unchanged. A valid git
// smart-HTTP response body never starts with those bytes (it begins with an
// ASCII pkt-line length or "PACK"), so this check is unambiguous. Keyed on the
// content rather than the `Content-Encoding` header because some platforms
// transparently inflate the body while leaving the header in place.
async function inflateIfGzipped(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return buffer;
    }
    try {
        const stream = new Blob([buffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    } catch {
        // If decompression is unavailable or fails, fall back to the original
        // bytes so behavior is no worse than before.
        return buffer;
    }
}
