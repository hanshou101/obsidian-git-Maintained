import type { RequestUrlParam } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isNetworkFailureMessage,
    NetworkUnavailableError,
    READ_RETRY_DELAYS_MS,
    REQUEST_TIMEOUT_MS,
    redactUrl,
    sendRequest,
    type NetworkEnvironment,
    type NetworkResponse,
} from "../../src/gitManager/networkPolicy";

const URL = "https://user:token@github.com/owner/repo.git";
const discovery: RequestUrlParam = {
    url: `${URL}/info/refs?service=git-upload-pack`,
    method: "GET",
};
const fetchPack: RequestUrlParam = {
    url: `${URL}/git-upload-pack`,
    method: "POST",
};
const pushPack: RequestUrlParam = {
    url: `${URL}/git-receive-pack`,
    method: "POST",
};

function response(status = 200): NetworkResponse {
    return { status, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

function environment(
    overrides: Partial<NetworkEnvironment> = {}
): NetworkEnvironment & { sleeps: number[] } {
    const sleeps: number[] = [];
    return {
        sleeps,
        request: vi.fn(() => Promise.resolve(response())),
        weakNetworkMode: () => true,
        isOnline: () => true,
        isHidden: () => false,
        sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
        },
        ...overrides,
    };
}

const never = () => new Promise<NetworkResponse>(() => {});

describe("sendRequest", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("is exactly the platform request without weak network mode", async () => {
        const failure = new Error("Request Failed. IOException timeout");
        const env = environment({
            weakNetworkMode: () => false,
            isOnline: () => false,
            request: vi.fn(() => Promise.reject(failure)),
        });

        await expect(sendRequest(env, discovery)).rejects.toBe(failure);
        expect(env.request).toHaveBeenCalledTimes(1);
        expect(env.sleeps).toEqual([]);
    });

    it("does not send anything while the device is offline", async () => {
        const env = environment({ isOnline: () => false });

        const error = await sendRequest(env, pushPack).catch(
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(NetworkUnavailableError);
        expect((error as NetworkUnavailableError).reason).toBe("offline");
        expect((error as Error).message).not.toContain("token");
        expect(env.request).not.toHaveBeenCalled();
    });

    it("gives up a push that hangs after the transfer timeout, without retrying it", async () => {
        const env = environment({ request: vi.fn(never) });

        const result = sendRequest(env, pushPack).catch(
            (caught: unknown) => caught
        );
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.transfer - 1);
        let settled = false;
        void result.then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        const error = (await result) as NetworkUnavailableError;
        expect(error).toBeInstanceOf(NetworkUnavailableError);
        expect(error.reason).toBe("timeout");
        expect(error.message).toBe(
            "No response from https://github.com/owner/repo.git/git-receive-pack within 120 s"
        );
        expect(env.request).toHaveBeenCalledTimes(1);
    });

    it("uses the short background timeout and does not retry in the background", async () => {
        const env = environment({
            request: vi.fn(never),
            isHidden: () => true,
        });

        const result = sendRequest(env, discovery).catch(
            (caught: unknown) => caught
        );
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.hidden);

        const error = (await result) as NetworkUnavailableError;
        expect(error.reason).toBe("hidden-timeout");
        expect(error.message).toContain("while Obsidian was in the background");
        expect(env.request).toHaveBeenCalledTimes(1);
    });

    it("retries a read twice after a dropout and returns the answer that came", async () => {
        const request = vi
            .fn<NetworkEnvironment["request"]>()
            .mockRejectedValueOnce(
                new Error(
                    "Request Failed. IOException unexpected end of stream on https://github.com/..."
                )
            )
            .mockResolvedValueOnce(response(503))
            .mockResolvedValueOnce(response(200));
        const env = environment({ request });

        await expect(sendRequest(env, fetchPack)).resolves.toMatchObject({
            status: 200,
        });
        expect(request).toHaveBeenCalledTimes(3);
        expect(env.sleeps).toEqual([...READ_RETRY_DELAYS_MS]);
    });

    it("hands the last 503 to isomorphic-git when every attempt got one", async () => {
        const env = environment({
            request: vi.fn(() => Promise.resolve(response(503))),
        });

        await expect(sendRequest(env, discovery)).resolves.toMatchObject({
            status: 503,
        });
        expect(env.request).toHaveBeenCalledTimes(3);
    });

    it("does not retry a push", async () => {
        const failure = new Error(
            "Request Failed. SocketException Software caused connection abort"
        );
        const env = environment({
            request: vi.fn(() => Promise.reject(failure)),
        });

        await expect(sendRequest(env, pushPack)).rejects.toBe(failure);
        expect(env.request).toHaveBeenCalledTimes(1);
    });

    it("rethrows errors that are not about the network at once", async () => {
        const failure = new Error("Invalid response body");
        const env = environment({
            request: vi.fn(() => Promise.reject(failure)),
        });

        await expect(sendRequest(env, discovery)).rejects.toBe(failure);
        expect(env.request).toHaveBeenCalledTimes(1);
    });

    it("stops retrying when the device goes offline in between", async () => {
        let online = true;
        const env = environment({
            isOnline: () => online,
            request: vi.fn(() => {
                online = false;
                return Promise.reject(
                    new Error("Request Failed. UnknownHostException github.com")
                );
            }),
        });

        await expect(sendRequest(env, discovery)).rejects.toThrow(
            /UnknownHostException/
        );
        expect(env.request).toHaveBeenCalledTimes(1);
    });
});

describe("network failure messages", () => {
    it.each([
        'Request Failed. UnknownHostException Unable to resolve host "github.com": No address associated with hostname',
        "Request Failed. IOException unexpected end of stream on https://github.com/...",
        "Software caused connection abort",
        "net::ERR_INTERNET_DISCONNECTED",
        "connect ETIMEDOUT 140.82.112.3:443",
        "Failed to fetch",
    ])("recognizes %s", (message) => {
        expect(isNetworkFailureMessage(message)).toBe(true);
    });

    it.each([
        "HTTP Error: 401 Unauthorized",
        "Cannot pull with uncommitted working tree changes: note.md",
    ])("does not take %s for a network failure", (message) => {
        expect(isNetworkFailureMessage(message)).toBe(false);
    });

    it("drops credentials and query strings from URLs", () => {
        expect(redactUrl(discovery.url)).toBe(
            "https://github.com/owner/repo.git/info/refs"
        );
    });
});
