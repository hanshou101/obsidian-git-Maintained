import { describe, expect, it, vi } from "vitest";
import { PromiseQueue } from "../src/promiseQueue";

describe("PromiseQueue", () => {
    it("logs escaped rejections and continues with the next task", async () => {
        const error = new Error("unexpected rejection");
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const nextTask = vi.fn().mockResolvedValue(undefined);
        const completed = new Promise<void>((resolve) => {
            const queue = new PromiseQueue();
            queue.addTask(() => Promise.reject(error));
            queue.addTask(nextTask, () => resolve());
        });

        await completed;

        expect(consoleError).toHaveBeenCalledWith(
            "Unhandled PromiseQueue task rejection",
            error
        );
        expect(nextTask).toHaveBeenCalledOnce();
    });

    it("tracks busy/pending counts and drops queued tasks with onFinished(undefined)", async () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        try {
            const queue = new PromiseQueue();
            expect(queue.isBusy()).toBe(false);
            expect(queue.isRunning()).toBe(false);
            expect(queue.pendingCount()).toBe(0);

            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            const secondTask = vi.fn().mockResolvedValue("second");
            const thirdTask = vi.fn().mockResolvedValue("third");
            const onSecondFinished = vi.fn(() => {
                throw new Error("callback failure should not stop cleanup");
            });
            const onThirdFinished = vi.fn();

            queue.addTask(() => firstGate);
            queue.addTask(secondTask, onSecondFinished);
            queue.addTask(thirdTask, onThirdFinished);

            expect(queue.isRunning()).toBe(true);
            expect(queue.isBusy()).toBe(true);
            expect(queue.pendingCount()).toBe(2);

            const cleared = queue.clearPending();
            expect(cleared).toBe(2);
            expect(queue.pendingCount()).toBe(0);
            expect(queue.isRunning()).toBe(true);
            expect(onSecondFinished).toHaveBeenCalledWith(undefined);
            expect(onThirdFinished).toHaveBeenCalledWith(undefined);
            expect(secondTask).not.toHaveBeenCalled();
            expect(thirdTask).not.toHaveBeenCalled();
            expect(consoleError).toHaveBeenCalledOnce();

            releaseFirst();
            await vi.waitFor(() => {
                expect(queue.isRunning()).toBe(false);
            });
            expect(queue.isBusy()).toBe(false);
        } finally {
            consoleError.mockRestore();
        }
    });
});
