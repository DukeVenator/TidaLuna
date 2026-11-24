import { type BuildOptions } from "esbuild";

import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { listen, pluginBuildOptions } from ".";
import { createCoreNatives } from "./coreNatives";

const pkg = JSON.parse(await readFile(join(process.cwd(), "./package.json"), "utf8"));

// Luna's own build: sha256 of the core plugins' native code, the injector runs exactly this code without trust prompts (see native/NativeModule/coreNatives.ts)
const { onNativeCode, plugin: writeCoreNatives } = createCoreNatives(join(process.cwd(), "./dist"));

const pluginFolders = await readdir(join(process.cwd(), "./plugins"));
const buildConfigs: BuildOptions[] = await Promise.all(
	pluginFolders.map((name) =>
		pkg.name === "luna"
			? pluginBuildOptions(`./plugins/${name}`, { plugins: [writeCoreNatives] }, onNativeCode)
			: pluginBuildOptions(`./plugins/${name}`),
	),
);

listen(buildConfigs);

// Quick export of plugins for store functionality
pkg.plugins ??= buildConfigs.map((config) => config.outfile?.replace("./dist/", ""));
await mkdir(join(process.cwd(), "./dist"), { recursive: true });
await writeFile(join(process.cwd(), "./dist/store.json"), JSON.stringify(pkg));
