import { spawnSync } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { withCleanup } from "../helpers/cleanup";
import { createRepoWithOrigin, type TestRepo } from "../helpers/gitRepo";

// obsidian-git-Maintained: the mobile backend pushes with isomorphic-git. Its
// stock push walked to the root commit after a merge and re-sent the whole
// history (isomorphic-git PR #2458). The patch lives in
// patches/isomorphic-git@1.44.3.patch; these tests push through a real
// `git http-backend` and count the objects in the uploaded pack.

type IsomorphicGitModule = typeof import("isomorphic-git");
type HttpClient = import("isomorphic-git").HttpClient;

const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve("isomorphic-git"));

// The first test builds 40 commits with the Git CLI and serves them over HTTP;
// it has taken 4.8 s on a busy machine, too close to the default 5 s timeout.
const TEST_TIMEOUT_MS = 30_000;

// The plugin bundle (a Vite client build) uses index.js; Node uses index.cjs.
const builds: [string, () => Promise<IsomorphicGitModule>][] = [
    [
        "index.cjs",
        () =>
            Promise.resolve(
                require(
                    path.join(packageDir, "index.cjs")
                ) as IsomorphicGitModule
            ),
    ],
    [
        "index.js",
        async () =>
            (
                (await import(
                    pathToFileURL(path.join(packageDir, "index.js")).href
                )) as {
                    default: IsomorphicGitModule;
                }
            ).default,
    ],
];

const author = { name: "Phone", email: "phone@example.com" };

/** The response body isomorphic-git expects: an async iterator of chunks. */
function asyncChunks(
    ...chunks: Uint8Array[]
): AsyncIterableIterator<Uint8Array> {
    return {
        next: () => {
            const value = chunks.shift();
            return Promise.resolve(
                value === undefined
                    ? { done: true, value: undefined }
                    : { done: false, value }
            );
        },
        [Symbol.asyncIterator]() {
            return this;
        },
    };
}

/** isomorphic-git HTTP client that hands every request to `git http-backend`. */
function createHttpBackend(projectRoot: string) {
    const pushedObjectCounts: number[] = [];
    const client: HttpClient = {
        async request({ url, method = "GET", headers = {}, body }) {
            const chunks: Uint8Array[] = [];
            if (body) {
                for await (const chunk of body) chunks.push(chunk);
            }
            const input = Buffer.concat(chunks);
            const { pathname, search } = new URL(url);
            if (method === "POST" && pathname.endsWith("/git-receive-pack")) {
                const start = input.indexOf("PACK");
                pushedObjectCounts.push(
                    start >= 0 ? input.readUInt32BE(start + 8) : 0
                );
            }
            const result = spawnSync("git", ["http-backend"], {
                input,
                maxBuffer: 1 << 30,
                env: {
                    PATH: process.env.PATH,
                    GIT_PROJECT_ROOT: projectRoot,
                    GIT_HTTP_EXPORT_ALL: "1",
                    PATH_INFO: pathname,
                    QUERY_STRING: search.replace(/^\?/, ""),
                    REQUEST_METHOD: method,
                    CONTENT_TYPE: headers["content-type"] ?? "",
                    CONTENT_LENGTH: String(input.length),
                    REMOTE_USER: "test",
                    REMOTE_ADDR: "127.0.0.1",
                },
            });
            if (result.error) throw result.error;
            const out = result.stdout;
            let separator = out.indexOf("\r\n\r\n");
            let skip = 4;
            if (separator < 0) {
                separator = out.indexOf("\n\n");
                skip = 2;
            }
            let statusCode = 200;
            let statusMessage = "OK";
            const responseHeaders: Record<string, string> = {};
            for (const line of out
                .subarray(0, separator)
                .toString("latin1")
                .split(/\r?\n/)) {
                const colon = line.indexOf(":");
                if (colon < 0) continue;
                const key = line.slice(0, colon).trim().toLowerCase();
                const value = line.slice(colon + 1).trim();
                if (key === "status") {
                    statusCode = parseInt(value, 10);
                    statusMessage = value.slice(4);
                } else {
                    responseHeaders[key] = value;
                }
            }
            const responseBody = new Uint8Array(out.subarray(separator + skip));
            return {
                url,
                method,
                statusCode,
                statusMessage,
                headers: responseHeaders,
                body: asyncChunks(responseBody),
            };
        },
    };
    return { client, pushedObjectCounts };
}

/** Commits `count` notes so the remote has a history worth re-sending. */
async function growHistory(repo: TestRepo, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await repo.writeAndCommit(
            `history/note-${i}.md`,
            `note ${i}\n${"x".repeat(200)}\n`,
            `history ${i}`
        );
    }
    await repo.git.push(["--quiet", "origin", "main"]);
}

/** Clones the remote with the Git CLI and points it at the HTTP backend. */
function clonePhone(repo: TestRepo): string {
    const phoneDir = path.join(repo.dir, "phone");
    run(["clone", "--quiet", repo.remotePath, phoneDir]);
    run([
        "-C",
        phoneDir,
        "remote",
        "set-url",
        "origin",
        `http://localhost/${path.basename(repo.remotePath)}`,
    ]);
    return phoneDir;
}

function run(args: string[]): string {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

async function phoneCommit(
    git: IsomorphicGitModule,
    phoneDir: string,
    filepath: string
): Promise<void> {
    fs.mkdirSync(path.dirname(path.join(phoneDir, filepath)), {
        recursive: true,
    });
    fs.writeFileSync(path.join(phoneDir, filepath), `# ${filepath}\n`);
    await git.add({ fs, dir: phoneDir, filepath });
    await git.commit({
        fs,
        dir: phoneDir,
        message: `phone ${filepath}`,
        author,
    });
}

/** The mobile pull: fetch, then merge `origin/main` into `main`. */
async function pull(
    git: IsomorphicGitModule,
    http: HttpClient,
    phoneDir: string
) {
    await git.fetch({
        fs,
        http,
        dir: phoneDir,
        remote: "origin",
        ref: "main",
        singleBranch: true,
    });
    return git.merge({
        fs,
        dir: phoneDir,
        ours: "main",
        theirs: "origin/main",
        author,
        message: "Merge branch 'origin/main' into main",
        abortOnConflict: true,
    });
}

describe.each(builds)(
    "isomorphic-git push after a merge (%s)",
    (_build, load) => {
        it("sends only the commits the remote is missing", async () => {
            const git = await load();
            const repo = withCleanup(await createRepoWithOrigin());
            await growHistory(repo, 40);
            const phoneDir = clonePhone(repo);
            const backend = createHttpBackend(path.dirname(repo.remotePath));

            await phoneCommit(git, phoneDir, "inbox/phone.md");
            await repo.writeAndCommit("desk.md", "desk\n", "desktop change");
            await repo.git.push(["--quiet", "origin", "main"]);

            const merge = await pull(git, backend.client, phoneDir);
            expect(merge.mergeCommit).toBe(true);

            const result = await git.push({
                fs,
                http: backend.client,
                dir: phoneDir,
                remote: "origin",
                ref: "main",
            });
            expect(result.ok).toBe(true);

            // The phone commit (commit, two trees, blob) plus the merge
            // commit and its root tree. Stock 1.44.3 re-sends all 41
            // commits with their trees and blobs.
            expect(backend.pushedObjectCounts).toEqual([6]);
            expect(run(["-C", repo.remotePath, "rev-parse", "main"])).toBe(
                run(["-C", phoneDir, "rev-parse", "main"])
            );
            run(["-C", repo.remotePath, "fsck", "--no-dangling"]);
        });

        it("still sends everything the remote is missing when the remote is behind", async () => {
            const git = await load();
            const repo = withCleanup(await createRepoWithOrigin());
            await growHistory(repo, 5);
            const phoneDir = clonePhone(repo);
            const backend = createHttpBackend(path.dirname(repo.remotePath));

            for (let i = 0; i < 3; i++) {
                await phoneCommit(git, phoneDir, `inbox/phone-${i}.md`);
            }
            await git.push({
                fs,
                http: backend.client,
                dir: phoneDir,
                remote: "origin",
                ref: "main",
            });

            // Three commits, each with a new root tree, inbox tree and blob.
            expect(backend.pushedObjectCounts).toEqual([12]);
            expect(run(["-C", repo.remotePath, "rev-parse", "main"])).toBe(
                run(["-C", phoneDir, "rev-parse", "main"])
            );
            run(["-C", repo.remotePath, "fsck", "--no-dangling"]);
        });
    },
    TEST_TIMEOUT_MS
);
