import { createHash } from "crypto";
import { mkdir, rename, writeFile } from "fs/promises";
import { join } from "path";

import type { Plugin } from "esbuild";

/**
 * The sha256 of the native code of Luna's own plugins, which `native/NativeModule/coreNatives.ts` reads to run that code
 * without asking the user. Getting it wrong is a security boundary, so the hashing and the file it writes live here
 * rather than inline in the build entry, where they can be tested.
 *
 * Written next to `injector.mjs` as `luna.natives.json` after each plugin build.
 */
export const coreNativeHash = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");

export type CoreNatives = {
	/** sha256 of every native file built so far */
	natives: Set<string>;
	/** Collects what `lunaNativePlugin` reports for each native file it bundles */
	onNativeCode: (fileName: string, code: string) => void;
	/** Writes `<dist>/luna.natives.json` once a build finishes without errors */
	plugin: Plugin;
};

/** @param dist the folder the list is written to, i.e. the build output folder */
export const createCoreNatives = (dist: string): CoreNatives => {
	const natives = new Set<string>();
	const listPath = join(dist, "luna.natives.json");
	// One write at a time: plugins build in parallel and each writes the list built so far
	let writing = Promise.resolve();

	const plugin: Plugin = {
		name: "writeCoreNatives",
		setup(build) {
			build.onEnd((result) => {
				if (result.errors.length > 0) return;
				writing = writing
					.then(async () => {
						await mkdir(dist, { recursive: true });
						// Written then renamed, so the injector never reads a half-written list
						await writeFile(`${listPath}.tmp`, JSON.stringify([...natives]));
						await rename(`${listPath}.tmp`, listPath);
					})
					.catch((err) => console.error("Failed to write dist/luna.natives.json", err));
				return writing;
			});
		},
	};

	return { natives, onNativeCode: (_fileName: string, code: string) => natives.add(coreNativeHash(code)), plugin };
};
