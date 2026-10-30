import type { RequestUrlParam } from "obsidian";

/**
 * obsidian-git-Maintained: how the mobile backend sends its HTTP requests in
 * weak network mode.
 *
 * Obsidian's `requestUrl` has no timeout. On Android a request made without a
 * network, or after the system has cut off a background app, can stay pending
 * for minutes (measured: 149 s in airplane mode before it failed), and the
 * plugin's promise queue waits behind it. In weak network mode a request:
 * - fails at once when the device reports that it is offline;
 * - is given up after a timeout (shorter while Obsidian is in the
 *   background, where Android blocks the network of non-exempt apps);
 * - is retried twice, a few seconds apart, when it only reads from the server
 *   (ref discovery and fetch), so a short dropout does not fail a sync.
 *   Pushes are not retried here: the sync is retried as a whole instead.
 *
 * A request that was given up keeps running in the platform, and its late
 * result is ignored. That is safe for Git's smart HTTP: a late fetch
 * response is discarded, and a late push either already moved the remote
 * branch (the next push finds it up to date) or is rejected as stale.
 */

export interface NetworkResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
}

export interface NetworkEnvironment {
    request(param: RequestUrlParam): Promise<NetworkResponse>;
    weakNetworkMode(): boolean;
    isOnline(): boolean;
    isHidden(): boolean;
    sleep(ms: number): Promise<void>;
}

export type NetworkUnavailableReason = "offline" | "timeout" | "hidden-timeout";

/** A request that was not attempted or did not finish in time. */
export class NetworkUnavailableError extends Error {
    constructor(
        readonly reason: NetworkUnavailableReason,
        readonly url: string,
        readonly timeoutMs?: number
    ) {
        super(
            reason === "offline"
                ? `No network connection (request to ${redactUrl(url)} not sent)`
                : `No response from ${redactUrl(url)} within ${Math.round(
                      (timeoutMs ?? 0) / 1000
                  )} s${reason === "hidden-timeout" ? " while Obsidian was in the background" : ""}`
        );
        this.name = "NetworkUnavailableError";
    }
}

export const REQUEST_TIMEOUT_MS = {
    /** Ref discovery (`GET …/info/refs`). */
    discovery: 30_000,
    /** Fetch and push bodies (`POST …/git-upload-pack`, `…/git-receive-pack`). */
    transfer: 120_000,
    /** Any request while Obsidian is in the background. */
    hidden: 12_000,
} as const;

/** Delays before the second and third attempt of a read-only request. */
export const READ_RETRY_DELAYS_MS = [1_500, 4_000] as const;

const TRANSIENT_STATUS = new Set([502, 503, 504]);

/**
 * Whether an error thrown by a request (not an HTTP status) means the network
 * failed. The Android messages come from `requestUrl` (for example
 * "Request Failed. IOException unexpected end of stream on …",
 * "Request Failed. UnknownHostException Unable to resolve host …",
 * "Software caused connection abort").
 */
export function isNetworkFailureMessage(message: string): boolean {
    return /Request Failed\.|IOException|SocketTimeout|SocketException|ConnectException|UnknownHost|Unable to resolve host|SSL|handshake|connection abort|Connection (reset|refused|closed)|unexpected end of stream|timed? ?out|ECONN(RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|net::ERR_|Network request failed|Failed to fetch|NetworkError|The network connection was lost|The Internet connection appears to be offline/i.test(
        message
    );
}

function isReadOnly(param: RequestUrlParam): boolean {
    const method = (param.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") return true;
    return /\/git-upload-pack(\?|$)/.test(param.url);
}

function timeoutFor(param: RequestUrlParam, hidden: boolean): number {
    if (hidden) return REQUEST_TIMEOUT_MS.hidden;
    const method = (param.method ?? "GET").toUpperCase();
    return method === "GET" || method === "HEAD"
        ? REQUEST_TIMEOUT_MS.discovery
        : REQUEST_TIMEOUT_MS.transfer;
}

function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    onTimeout: () => Error
): Promise<T> {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(onTimeout()), ms);
    });
    return Promise.race([promise, timeout]).finally(() =>
        window.clearTimeout(timer)
    );
}

/** Removes credentials and query strings from a URL for messages and logs. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        return parsed.toString();
    } catch {
        return url.replace(/\/\/[^@/]*@/, "//").replace(/\?.*$/, "");
    }
}

/**
 * Sends one request. Without weak network mode this is exactly
 * `env.request(param)`, as in upstream.
 */
export async function sendRequest(
    env: NetworkEnvironment,
    param: RequestUrlParam
): Promise<NetworkResponse> {
    if (!env.weakNetworkMode()) {
        return env.request(param);
    }
    const attempts = isReadOnly(param) ? READ_RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 1; ; attempt++) {
        if (!env.isOnline()) {
            throw new NetworkUnavailableError("offline", param.url);
        }
        const hidden = env.isHidden();
        const ms = timeoutFor(param, hidden);
        let failure: unknown;
        try {
            const response = await withTimeout(
                env.request(param),
                ms,
                () =>
                    new NetworkUnavailableError(
                        hidden ? "hidden-timeout" : "timeout",
                        param.url,
                        ms
                    )
            );
            if (!TRANSIENT_STATUS.has(response.status)) {
                return response;
            }
            failure = response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (
                !(error instanceof NetworkUnavailableError) &&
                !isNetworkFailureMessage(message)
            ) {
                throw error;
            }
            failure = error;
        }
        // Retrying in the background only waits for the same block again.
        if (attempt >= attempts || env.isHidden() || !env.isOnline()) {
            if (failure instanceof Error) throw failure;
            return failure as NetworkResponse;
        }
        await env.sleep(READ_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }
}
