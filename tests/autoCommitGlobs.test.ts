import { describe, expect, it } from "vitest";
import { includeGlobScope } from "../src/autoCommitGlobs";

describe("includeGlobScope", () => {
    it("is the literal folders the include globs start with", () => {
        expect(includeGlobScope(["00、手机收件箱/**"])).toEqual([
            "00、手机收件箱",
        ]);
        expect(includeGlobScope(["notes/daily/*.md", "inbox/"])).toEqual([
            "notes/daily",
            "inbox",
        ]);
        expect(includeGlobScope(["README.md"])).toEqual(["README.md"]);
    });

    it("unescapes wildcards that are literal", () => {
        expect(includeGlobScope(["a\\*b/**"])).toEqual(["a*b"]);
    });

    it("is undefined when a glob can match anywhere", () => {
        expect(includeGlobScope(["**/*.md"])).toBeUndefined();
        expect(includeGlobScope(["inbox/**", "*.md"])).toBeUndefined();
        expect(includeGlobScope(["[ab]/**"])).toBeUndefined();
        expect(includeGlobScope([])).toBeUndefined();
    });
});
