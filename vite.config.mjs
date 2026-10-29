// Bundles src/main.ts into the single main.js that Obsidian loads (CommonJS, `module.exports` is the plugin class).
// obsidian-git-Maintained: Vite 8 (Rolldown underneath) replaces upstream's esbuild.config.mjs; the options below
// mirror what that file did.
//
//   pnpm run build -> vite build                              (production: minified, no source map)
//   pnpm run dev   -> vite build --watch --mode development   (not minified, inline source map)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// The same list upstream's esbuild.config.mjs kept out of the bundle.
const externalPackages = [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "os",
    "path",
    "moment",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
];

export default defineConfig(({ mode }) => {
    const prod = mode !== "development";
    return {
        // The plugin root is the output directory: only main.js is written, nothing else is touched.
        // Vite prints "build.outDir must not be the same directory of root" for this layout; it is expected
        // here because emptyOutDir is false, so no source file is ever deleted.
        publicDir: false,
        logLevel: "info",
        // esbuild replaced process.env.NODE_ENV for browser bundles; Vite's library mode leaves it alone, and
        // the mobile app has no `process`.
        define: {
            "process.env.NODE_ENV": JSON.stringify(
                prod ? "production" : "development"
            ),
        },
        resolve: {
            // Like esbuild's `conditions` (https://www.npmjs.com/package/esm-env): follow the build mode, not
            // NODE_ENV, which `vite build` always sets to production.
            conditions: [
                "module",
                "browser",
                prod ? "production" : "development",
            ],
        },
        plugins: [
            svelte({
                // TypeScript in <script lang="ts"> and SCSS in <style lang="scss">. svelte-check reads this
                // config too, so it checks the components exactly as they are built.
                preprocess: vitePreprocess({ script: true }),
                compilerOptions: {
                    css: "injected",
                    dev: !prod,
                    warningFilter: (warning) =>
                        !warning.code.startsWith("a11y"),
                },
            }),
        ],
        build: {
            lib: {
                entry: "src/main.ts",
                formats: ["cjs"],
                fileName: () => "main.js",
            },
            outDir: ".",
            emptyOutDir: false,
            copyPublicDir: false,
            target: "es2018",
            minify: prod,
            sourcemap: prod ? false : "inline",
            reportCompressedSize: false,
            watch: prod ? null : {},
            rolldownOptions: {
                // Provided by Obsidian or Electron at runtime; must not be bundled. Like esbuild's `external`,
                // a package name also covers its subpaths (`fs` covers `fs/promises`).
                external: (id) =>
                    id.startsWith("node:") ||
                    externalPackages.some(
                        (name) => id === name || id.startsWith(`${name}/`)
                    ),
                transform: {
                    // The mobile app has no global Buffer; isomorphic-git and the plugin get the one
                    // polyfill_buffer.js picks (esbuild's `inject` did the same).
                    inject: {
                        Buffer: [path.join(root, "polyfill_buffer.js"), "Buffer"],
                    },
                },
                output: {
                    // src/main.ts has exactly one export, the default Plugin class, so this writes
                    // `module.exports = ObsidianGit`. A named export added later fails the build.
                    exports: "default",
                    codeSplitting: false,
                    // The esbuild bundle ran in strict mode; Rolldown only emits "use strict" when a source file
                    // has it, and Obsidian does not add it, so ask for it explicitly. Like the other plugins in the
                    // HugeRepo, main.js starts with the directive (upstream's banner comment is dropped).
                    strict: true,
                },
            },
        },
    };
});
