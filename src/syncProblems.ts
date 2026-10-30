import { Errors } from "isomorphic-git";
import { getLanguage } from "obsidian";
import {
    isNetworkFailureMessage,
    NetworkUnavailableError,
    redactUrl,
} from "./gitManager/networkPolicy";
import { GitConflictError, NoNetworkError } from "./types";

/**
 * obsidian-git-Maintained: what went wrong in a sync, in terms the sync
 * supervisor can act on and a person can read on a phone.
 */
export type SyncProblemKind =
    | "offline"
    | "background-blocked"
    | "network"
    | "auth"
    | "not-found"
    | "push-rejected"
    | "local-changes"
    | "untracked-collision"
    | "conflict"
    | "merge-in-progress"
    | "config"
    | "other";

export interface SyncProblem {
    kind: SyncProblemKind;
    /** The supervisor retries on its own (with backoff). */
    retryable: boolean;
    /** Only the user can fix it. */
    needsUser: boolean;
    files: string[];
    httpStatus?: number;
    /** The error message, without credentials. */
    raw: string;
}

export interface ErrorContext {
    online: boolean;
    /** Obsidian was in the background when the error happened. */
    hidden: boolean;
}

function problem(
    kind: SyncProblemKind,
    raw: string,
    extra: Partial<SyncProblem> = {}
): SyncProblem {
    const retryable =
        kind === "offline" ||
        kind === "background-blocked" ||
        kind === "network" ||
        kind === "push-rejected" ||
        kind === "other";
    return {
        kind,
        retryable,
        needsUser: !retryable,
        files: [],
        raw,
        ...extra,
    };
}

function redact(message: string): string {
    return message.replace(/https?:\/\/[^\s"')]+/g, (url) => redactUrl(url));
}

function networkKind(context: ErrorContext): SyncProblemKind {
    if (!context.online) return "offline";
    return context.hidden ? "background-blocked" : "network";
}

export function classifySyncError(
    error: unknown,
    context: ErrorContext
): SyncProblem {
    const raw = redact(
        error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : (JSON.stringify(error) ?? "")
    );
    if (error instanceof NetworkUnavailableError) {
        if (error.reason === "offline") return problem("offline", raw);
        if (error.reason === "hidden-timeout") {
            return problem("background-blocked", raw);
        }
        return problem(networkKind(context), raw);
    }
    if (error instanceof NoNetworkError) {
        return problem(networkKind(context), redact(error.originalError));
    }
    if (error instanceof GitConflictError) {
        return problem("conflict", raw, { files: error.files });
    }
    if (error instanceof Errors.PushRejectedError) {
        return problem("push-rejected", raw);
    }
    if (error instanceof Errors.HttpError) {
        const status = error.data.statusCode;
        if (status === 401 || status === 403) {
            return problem("auth", raw, { httpStatus: status });
        }
        if (status === 404) {
            return problem("not-found", raw, { httpStatus: status });
        }
        if (status === 408 || status === 429 || status >= 500) {
            return problem(networkKind(context), raw, { httpStatus: status });
        }
        return problem("other", raw, { httpStatus: status });
    }
    let match =
        /Cannot pull with uncommitted working tree changes: (.+)$/s.exec(raw);
    if (match) {
        return problem("local-changes", raw, {
            files: match[1]!.split(", "),
        });
    }
    match = /untracked file would be overwritten: (.+)$/s.exec(raw);
    if (match) {
        return problem("untracked-collision", raw, { files: [match[1]!] });
    }
    if (/merge is still in progress|unresolved conflicts/i.test(raw)) {
        return problem("merge-in-progress", raw);
    }
    if (
        /author name and email are not set|No current branch|no tracking branch|no upstream/i.test(
            raw
        )
    ) {
        return problem("config", raw);
    }
    if (isNetworkFailureMessage(raw)) {
        return problem(networkKind(context), raw);
    }
    return problem("other", raw);
}

/** Network problems that weak network mode keeps out of pop-ups. */
export function isNetworkProblem(kind: SyncProblemKind): boolean {
    return (
        kind === "offline" ||
        kind === "background-blocked" ||
        kind === "network"
    );
}

// region: texts

export type Language = "zh" | "en";

export function syncLanguage(): Language {
    try {
        return getLanguage().toLowerCase().startsWith("zh") ? "zh" : "en";
    } catch {
        return "en";
    }
}

export interface ProblemText {
    title: string;
    explain: string;
    action: string;
}

const BATTERY_HINT_ZH =
    "想让锁屏或切到后台以后也能上传：系统设置 → 应用 → Obsidian → 电池（应用的电池用量）→ 选「不受限制」。小米、华为、OPPO、vivo 等手机还要在手机管家里允许 Obsidian 后台运行。";
const BATTERY_HINT_EN =
    "To let uploads finish while the screen is locked or Obsidian is in the background: Android settings → Apps → Obsidian → Battery (App battery usage) → Unrestricted. Some phone brands also need background activity allowed in their own battery manager.";

/**
 * @param autoRetry whether failed syncs are retried on their own (weak
 * network mode), which changes what the network problems tell to do.
 */
export function problemText(
    p: SyncProblem,
    language: Language,
    autoRetry = true
): ProblemText {
    const files = p.files.length;
    if (language === "zh") {
        switch (p.kind) {
            case "offline":
                return {
                    title: "手机现在没有网络",
                    explain:
                        "连不上任何网络。改动已经在手机上提交好了，不会丢。",
                    action: autoRetry
                        ? "网络一恢复就会自动上传，不用管它。"
                        : "网络恢复后，下一次同步时上传。打开 Weak network mode 后网络一恢复就会自动上传。",
                };
            case "background-blocked":
                return {
                    title: "锁屏或切到后台后，系统断开了 Obsidian 的网络",
                    explain:
                        "安卓会在 Obsidian 进入后台或锁屏后切断它的网络；开着省电模式时是立刻切断。改动已经在手机上提交好了，不会丢。",
                    action: `回到 Obsidian 时会马上上传。${BATTERY_HINT_ZH}`,
                };
            case "network":
                return {
                    title: "连 GitHub 不稳定",
                    explain: `这次没连上 GitHub${p.httpStatus ? `（GitHub 返回 ${p.httpStatus}）` : ""}。改动已经在手机上提交好了，不会丢。`,
                    action: autoRetry
                        ? "会自动重试：15 秒、30 秒、1 分钟、2 分钟后各一次，之后每 5 分钟一次；网络恢复或回到 Obsidian 时马上再试。"
                        : "下一次同步时再试。打开 Git (Maintained) 设置 → Phone sync → Weak network mode 后会自动重试。",
                };
            case "auth":
                return {
                    title: "GitHub 拒绝了登录（令牌可能过期了）",
                    explain: `GitHub 返回 ${p.httpStatus ?? 401}：用户名或令牌不对，或者令牌过期了、没有这个仓库的写权限。`,
                    action: "到 Git (Maintained) 设置 → Identity → Git server password or access token，换一个新令牌，然后点「立即同步」。",
                };
            case "not-found":
                return {
                    title: "GitHub 上找不到这个仓库",
                    explain:
                        "GitHub 返回 404：仓库地址不对，或者令牌看不到这个仓库。",
                    action: "检查仓库地址，以及令牌能不能访问这个仓库。",
                };
            case "push-rejected":
                return {
                    title: "推送被拒绝：GitHub 上有新的提交",
                    explain: "推送时，GitHub 上已经有别处推上来的新提交。",
                    action: "会先拉取、再推送，自动重试。",
                };
            case "local-changes":
                return {
                    title: `手机上有 ${files} 个文件的改动挡住了拉取`,
                    explain:
                        "这些文件在手机上被改过，改动不在任何提交里，也不是历史上出现过的版本；GitHub 上又改了它们。直接拉取会盖掉手机上的改动，所以这次没有拉。",
                    action: "在 Git (Maintained) 设置 → Phone sync 里填好「Rescue folder」（例如 00、手机收件箱/_冲突备份），插件会先把这些改动另存过去、再拉取，另存的文件会随下一次同步上传。不想要这些改动的话，也可以在 Source Control 里对它们点放弃（Discard）。",
                };
            case "untracked-collision":
                return {
                    title: "手机上有同名的新文件挡住了拉取",
                    explain:
                        "GitHub 上新加的文件，手机上也有一个同名但内容不同、没提交过的文件。直接拉取会盖掉它，所以这次没有拉。",
                    action: "在 Git (Maintained) 设置 → Phone sync 里填好「Rescue folder」，插件会先把手机上的文件另存过去、再拉取。也可以自己把它改名或移到收件箱里。",
                };
            case "conflict":
                return {
                    title: `两边改了同一个地方（冲突，${files} 个文件）`,
                    explain:
                        "这些文件在手机和 GitHub 上都改了同一处，Git 没法自动合并。",
                    action: "打开这些文件，留下要的内容、删掉 <<<<<<< ======= >>>>>>> 这些冲突标记，然后执行「Commit-and-sync」。",
                };
            case "merge-in-progress":
                return {
                    title: "有一次合并还没处理完",
                    explain: "上一次拉取遇到冲突，合并还没完成。",
                    action: "处理完冲突并提交以后，同步才会继续。",
                };
            case "config":
                return {
                    title: "Git 的设置不完整",
                    explain: p.raw,
                    action: "到 Git (Maintained) 设置里补上，例如 Identity 里的作者名字和邮箱。",
                };
            case "other":
                return {
                    title: "同步出错",
                    explain: p.raw,
                    action: "会在下一次同步时再试。一直出现的话，点「复制详情」把内容发给维护者。",
                };
        }
    }
    switch (p.kind) {
        case "offline":
            return {
                title: "This device is offline",
                explain:
                    "There is no network. Your changes are committed on this device and are safe.",
                action: autoRetry
                    ? "They are uploaded as soon as the network is back."
                    : "They are uploaded with the next sync once the network is back; Weak network mode uploads them as soon as it is.",
            };
        case "background-blocked":
            return {
                title: "Android cut off Obsidian's network in the background",
                explain:
                    "Android blocks the network of apps in the background or behind the lock screen, at once when battery saver is on. Your changes are committed on this device and are safe.",
                action: `They are uploaded as soon as Obsidian is back in the foreground. ${BATTERY_HINT_EN}`,
            };
        case "network":
            return {
                title: "The connection to the Git server is unstable",
                explain: `The server could not be reached${p.httpStatus ? ` (status ${p.httpStatus})` : ""}. Your changes are committed on this device and are safe.`,
                action: autoRetry
                    ? "Retrying after 15 s, 30 s, 1 min and 2 min, then every 5 min, and at once when the network or Obsidian comes back."
                    : "The next sync tries again. With Weak network mode (Settings → Git (Maintained) → Phone sync) failed syncs are retried on their own.",
            };
        case "auth":
            return {
                title: "The Git server refused the login",
                explain: `Status ${p.httpStatus ?? 401}: the username or token is wrong, expired, or has no write access to the repository.`,
                action: "Settings → Git (Maintained) → Identity → Git server password or access token: set a new token, then tap Sync now.",
            };
        case "not-found":
            return {
                title: "Repository not found",
                explain:
                    "Status 404: the remote URL is wrong, or the token cannot see the repository.",
                action: "Check the remote URL and the token's repository access.",
            };
        case "push-rejected":
            return {
                title: "Push rejected: the remote has new commits",
                explain: "Someone pushed new commits before this push.",
                action: "Pulling, then pushing again automatically.",
            };
        case "local-changes":
            return {
                title: `${files} local ${files === 1 ? "change blocks" : "changes block"} the pull`,
                explain:
                    "These files were changed on this device, the changes are in no commit and in no earlier version, and the remote changed them too. Pulling would overwrite them, so the pull stopped.",
                action: "Set a Rescue folder (Settings → Git (Maintained) → Phone sync) to copy such changes there and go on pulling; the copies are committed with the next sync. Or discard the changes in Source Control.",
            };
        case "untracked-collision":
            return {
                title: "A local file with the same name blocks the pull",
                explain:
                    "The remote added a file that also exists here, uncommitted and with other content. Pulling would overwrite it, so the pull stopped.",
                action: "Set a Rescue folder (Settings → Git (Maintained) → Phone sync), or rename or move the local file.",
            };
        case "conflict":
            return {
                title: `Merge conflict in ${files} ${files === 1 ? "file" : "files"}`,
                explain:
                    "Both sides changed the same lines, so Git cannot merge them.",
                action: "Edit the files, keep what you want, remove the <<<<<<< ======= >>>>>>> markers, then run Commit-and-sync.",
            };
        case "merge-in-progress":
            return {
                title: "A merge is not finished",
                explain: "The last pull stopped on a conflict.",
                action: "Resolve the conflict and commit; syncing then continues.",
            };
        case "config":
            return {
                title: "Git is not fully set up",
                explain: p.raw,
                action: "Complete the settings, for example the author name and email under Identity.",
            };
        case "other":
            return {
                title: "Sync failed",
                explain: p.raw,
                action: "The next sync tries again. If it keeps happening, tap Copy details and send them to the maintainer.",
            };
    }
}

export const BATTERY_HINT = { zh: BATTERY_HINT_ZH, en: BATTERY_HINT_EN };
