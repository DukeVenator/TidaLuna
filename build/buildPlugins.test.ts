import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

/**
 * `build/buildPlugins.ts` is a build entry point, not a library: it reads the working directory's package.json and
 * plugins folder at import and then builds them, so it can only be exercised by running it. `esbuild.config.ts` imports
 * it for the real build, and this runs the same file against a throwaway project.
 *
 * What it produces is what `native/NativeModule/coreNatives.ts` reads: `<dist>/luna.natives.json`, the sha256 of the
 * native code of Luna's own plugins, which the injector runs without asking the user. Getting that list wrong is
 * security relevant, so it is worth pinning rather than trusting that the build happened to run.
 */
const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const script = path.join(repo, "build", "buildPlugins.ts");
// The build imports its helpers with `from "."`, a directory import node's ESM resolver refuses, so it runs under the
// same loader the repo's build runs under
const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");

let project: string;

/** A throwaway project shaped like this repo: a "luna" package with one plugin that has a native module */
const writeProject = async (nativeModule: string) => {
	project = await mkdtemp(path.join(os.tmpdir(), "luna-build-plugins-"));
	await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "luna", version: "1.0.0", type: "module" }));
	const plugin = path.join(project, "plugins", "demo");
	await mkdir(path.join(plugin, "src"), { recursive: true });
	await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "@test/demo", version: "1.0.0", main: "src/index.ts" }));
	await writeFile(path.join(plugin, "src", "mod.native.ts"), nativeModule);
	await writeFile(path.join(plugin, "src", "index.ts"), 'import { shout } from "./mod.native";\nexport const hello = () => shout("hi");\n');
	return project;
};

/** Runs the build entry the way the repo does: through tsx, from inside the project */
const build = () => run(process.execPath, [tsx, script], { cwd: project });

const readJson = async (...segments: string[]) => JSON.parse(await readFile(path.join(project, ...segments), "utf8"));

beforeEach(async () => {
	await writeProject("export const shout = (value: string) => value.toUpperCase();\n");
});
afterEach(async () => {
	await rm(project, { recursive: true, force: true });
});

test("builds each plugin folder and writes the store and the core natives", async () => {
	await build();

	// Named after the plugin's package name, with the @ and / taken out: "@test/demo" becomes "test.demo"
	expect((await readdir(path.join(project, "dist"))).sort()).toEqual([
		"luna.natives.json",
		"store.json",
		"test.demo.json",
		"test.demo.mjs",
		"test.demo.mjs.map",
	]);

	// The plugin's bundle, and the package it is served with
	expect((await readJson("dist", "store.json")).plugins).toEqual(["test.demo.mjs"]);
	const pluginPackage = await readJson("dist", "test.demo.json");
	expect(pluginPackage.name).toBe("@test/demo");
	expect(pluginPackage.hash).toBeTypeOf("string");

	// The list the injector trusts: one sha256 per distinct native code
	const natives = await readJson("dist", "luna.natives.json");
	expect(natives).toHaveLength(1);
	expect(natives[0]).toMatch(/^[0-9a-f]{64}$/);
});

test("the natives list is stable across builds, so a rebuild is not new code", async () => {
	await build();
	const natives = await readJson("dist", "luna.natives.json");

	await build();

	expect(await readJson("dist", "luna.natives.json")).toEqual(natives);
	// It is a digest of the bundled native code, not of the source: the two differ
	expect(createHash("sha256").update(natives[0]).digest("hex")).not.toBe(natives[0]);
});

test("a plugin that does not build leaves no natives list behind", async () => {
	// A native module no bundler can compile
	await writeProject("export const shout = ;\n");

	await expect(build()).rejects.toBeDefined();

	expect(await readdir(path.join(project, "dist")).catch(() => [])).not.toContain("luna.natives.json");
});
