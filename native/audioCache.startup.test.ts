import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { setUserDataDir } from "../test/harness/electron";

/**
 * What `native/audioCache.ts` keeps from the folder it inherits at startup.
 *
 * The scan runs once, when electron is ready, and only complete files with a valid `<id>.json` sidecar naming their own
 * audio file are kept: everything else in the folder is deleted. Both are module level, so the folder is filled in
 * before the import below and this file is the only place the scan can be observed.
 */
const scratch = await mkdtemp(path.join(os.tmpdir(), "luna-audio-cache-startup-"));
setUserDataDir(scratch);
/** Created by native/audioCache.ts once electron is ready */
const cacheDir = path.join(scratch, "luna-audio-cache");

const audioBytes = Buffer.from("kept-audio");

await mkdir(cacheDir, { recursive: true });
const write = (name: string, contents: string | Buffer) => writeFile(path.join(cacheDir, name), contents);

// Kept: a complete file with a sidecar naming it
await write("kept.flac", audioBytes);
await write("kept-id.json", JSON.stringify({ file: "kept.flac", size: audioBytes.length, type: "audio/flac" }));
// Deleted: a sidecar naming a file that is not there
await write("missing-id.json", JSON.stringify({ file: "missing.flac", size: 10 }));
// Deleted: a sidecar naming a path outside the folder
await write("escape-id.json", JSON.stringify({ file: "../escape.flac", size: 10 }));
// Deleted: a sidecar whose file is empty
await write("empty.flac", "");
await write("empty-id.json", JSON.stringify({ file: "empty.flac", size: 0 }));
// Deleted: not readable as a sidecar at all
await write("broken-id.json", "{ not json");
// Deleted: a file no sidecar names
await write("orphan.flac", "orphan-bytes");

const { audioCachePersist, audioCacheStats } = await import("./audioCache");

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

test("keeps only the complete file its sidecar names, and deletes the rest", async () => {
	// Persisting waits for the scan, so this runs after it decided what to keep
	await audioCachePersist("https://example.com/not-audio.flac");

	const stats = await audioCacheStats();
	expect(stats.files).toBe(1);
	expect(stats.usage).toBe(audioBytes.length);

	expect((await readdir(cacheDir)).sort()).toEqual(["kept-id.json", "kept.flac"]);
});
