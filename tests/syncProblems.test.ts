import { Errors } from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { NetworkUnavailableError } from "../src/gitManager/networkPolicy";
import {
    classifySyncError,
    problemText,
    type SyncProblemKind,
} from "../src/syncProblems";
import { GitConflictError } from "../src/types";

const visible = { online: true, hidden: false };

describe("classifySyncError", () => {
    it("tells the three network situations apart", () => {
        const dropped = new Error(
            "Request Failed. IOException unexpected end of stream on https://x:token@github.com/a/b.git"
        );
        expect(classifySyncError(dropped, visible)).toMatchObject({
            kind: "network",
            retryable: true,
            needsUser: false,
        });
        expect(
            classifySyncError(dropped, { online: true, hidden: true }).kind
        ).toBe("background-blocked");
        expect(
            classifySyncError(dropped, { online: false, hidden: false }).kind
        ).toBe("offline");
        expect(classifySyncError(dropped, visible).raw).not.toContain("token");
    });

    it("maps the errors of weak network mode", () => {
        const url = "https://github.com/a/b.git/info/refs";
        expect(
            classifySyncError(
                new NetworkUnavailableError("offline", url),
                visible
            ).kind
        ).toBe("offline");
        expect(
            classifySyncError(
                new NetworkUnavailableError("hidden-timeout", url, 12_000),
                visible
            ).kind
        ).toBe("background-blocked");
        expect(
            classifySyncError(
                new NetworkUnavailableError("timeout", url, 30_000),
                visible
            ).kind
        ).toBe("network");
    });

    it("maps HTTP status codes", () => {
        const http = (statusCode: number) =>
            new Errors.HttpError(statusCode, "status", "");
        expect(classifySyncError(http(401), visible)).toMatchObject({
            kind: "auth",
            needsUser: true,
            httpStatus: 401,
        });
        expect(classifySyncError(http(403), visible).kind).toBe("auth");
        expect(classifySyncError(http(404), visible).kind).toBe("not-found");
        expect(classifySyncError(http(503), visible).kind).toBe("network");
        expect(classifySyncError(http(429), visible).kind).toBe("network");
    });

    it("reads the files of the pull that local changes stopped (AME-1119)", () => {
        const files = [
            "AI-First时代，知识库（toAI完全公开）/比赛各种比赛，用AI打比赛/.frac.md",
            "AI-First时代，知识库（toAI完全公开）/比赛各种比赛，用AI打比赛/03、方法论：怎么打AI比赛.md",
        ];
        const problem = classifySyncError(
            new Error(
                `Cannot pull with uncommitted working tree changes: ${files.join(", ")}`
            ),
            visible
        );
        expect(problem).toMatchObject({
            kind: "local-changes",
            needsUser: true,
            retryable: false,
            files,
        });
    });

    it("keeps conflicts, rejected pushes and the rest apart", () => {
        expect(
            classifySyncError(
                new GitConflictError(["note.md"], new Error("conflict")),
                visible
            )
        ).toMatchObject({ kind: "conflict", files: ["note.md"] });
        expect(
            classifySyncError(
                new Errors.PushRejectedError("not-fast-forward"),
                visible
            ).kind
        ).toBe("push-rejected");
        expect(
            classifySyncError(
                new Error(
                    "Cannot pull because an untracked file would be overwritten: new.md"
                ),
                visible
            )
        ).toMatchObject({ kind: "untracked-collision", files: ["new.md"] });
        expect(
            classifySyncError(new Error("Something odd"), visible)
        ).toMatchObject({ kind: "other", retryable: true });
    });
});

describe("problemText", () => {
    const kinds: SyncProblemKind[] = [
        "offline",
        "background-blocked",
        "network",
        "auth",
        "not-found",
        "push-rejected",
        "local-changes",
        "untracked-collision",
        "conflict",
        "merge-in-progress",
        "config",
        "other",
    ];

    it.each(kinds)("explains %s in both languages", (kind) => {
        const problem = {
            kind,
            retryable: true,
            needsUser: false,
            files: ["a.md"],
            raw: "raw",
        };
        for (const language of ["zh", "en"] as const) {
            const text = problemText(problem, language);
            expect(text.title).not.toBe("");
            expect(text.explain).not.toBe("");
            expect(text.action).not.toBe("");
        }
    });

    it("only promises automatic retries in weak network mode", () => {
        const problem = {
            kind: "network" as const,
            retryable: true,
            needsUser: false,
            files: [],
            raw: "",
        };
        expect(problemText(problem, "zh").action).toContain("15 秒");
        expect(problemText(problem, "zh", false).action).toContain(
            "Weak network mode"
        );
    });
});
