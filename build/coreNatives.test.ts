import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { coreNativeHash, createCoreNatives } from "./coreNatives";

/**
 * The list `native/NativeModule/coreNatives.ts` reads: the sha256 of Luna's own plugins' native code, which the injector
 * runs without asking the user. It is written beside the injector after each plugin build, so both what goes in it and
 * when it is written are security boundaries rather than build cosmetics.
 */
let dist: string;

beforeEach(async () => {
	dist = await mkdtemp(path.join(os.tmpdir(), "luna-core-natives-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dist, { recursive: true, force: true });
});

/** A stand-in for the build `setup` receives, capturing the onEnd handler the plugin registers */
const setup = (plugin: ReturnType<typeof createCoreNatives>["plugin"]) => {
	let onEnd: ((result: { errors: unknown[] }) => Promise<void> | undefined) | undefined;
	plugin.setup(<never>{ onEnd: (handler: typeof onEnd) => (onEnd = handler) });
	if (onEnd === undefined) throw new Error("the plugin registered no onEnd handler");
	return (result: { errors: unknown[] }) => onEnd!(result);
};
const listPath = () => path.join(dist, "luna.natives.json");
const readList = async () => JSON.parse(await readFile(listPath(), "utf8"));

test("hashes the native code as hex sha256", () => {
	const hash = coreNativeHash("export const a = 1;");

	expect(hash).toMatch(/^[0-9a-f]{64}$/);
	// Same code, same hash; different code, different hash
	expect(coreNativeHash("export const a = 1;")).toBe(hash);
	expect(coreNativeHash("export const a = 2;")).not.toBe(hash);
});

test("writes the hashes it was given once a build finishes", async () => {
	const { onNativeCode, plugin, natives } = createCoreNatives(dist);
	const onEnd = setup(plugin);

	onNativeCode("mod.native.ts", "export const a = 1;");
	onNativeCode("other.native.ts", "export const b = 2;");
	// The same code twice is one entry: the list is a set
	onNativeCode("copy.native.ts", "export const a = 1;");
	await onEnd({ errors: [] });

	expect(natives.size).toBe(2);
	// A set, so the order depends on which build finished first; the injector only asks whether a hash is in it
	expect(await readList()).toHaveLength(2);
	expect((await readList()).sort()).toEqual([coreNativeHash("export const a = 1;"), coreNativeHash("export const b = 2;")].sort());
});

test("leaves the list alone when the build failed", async () => {
	const { onNativeCode, plugin } = createCoreNatives(dist);
	const onEnd = setup(plugin);

	onNativeCode("mod.native.ts", "export const a = 1;");
	// A build with errors has not produced the code the list would describe
	await onEnd({ errors: [new Error("it did not build")] });

	await expect(readFile(listPath(), "utf8")).rejects.toThrow();
});

test("reports a list it could not write instead of failing the build", async () => {
	// A dist path that is a file, so the folder cannot be created
	const blocked = path.join(dist, "blocked");
	await writeFile(blocked, "");
	const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
	const { onNativeCode, plugin } = createCoreNatives(blocked);
	const onEnd = setup(plugin);

	onNativeCode("mod.native.ts", "export const a = 1;");
	await onEnd({ errors: [] });
	// The next write is not held up by the failed one
	await onEnd({ errors: [] });

	expect(errorLog).toHaveBeenCalledWith("Failed to write dist/luna.natives.json", expect.anything());
});
