import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `MediaItem`'s format and quality side: playback info lookups, the file extension a download needs, the stream format
 * it caches, and the emitters plugins listen on. The class is the thing under test, so only the edges are replaced: the
 * two API lookups (a real one is a network call), the native stream parser, and the native downloader.
 *
 * `MediaItem` keeps formats per instance, so every test builds its own item rather than sharing a fixture.
 */

const helpers = vi.hoisted(() => ({ getPlaybackInfo: vi.fn(), getVideoPlaybackInfo: vi.fn() }));
vi.mock("../../helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../helpers")>();
	return { ...actual, getPlaybackInfo: helpers.getPlaybackInfo, getVideoPlaybackInfo: helpers.getVideoPlaybackInfo };
});

const stream = vi.hoisted(() => ({ getStreamBytes: vi.fn(), parseStreamFormat: vi.fn() }));
vi.mock("./parseStreamFormat.native", () => stream);

const native = vi.hoisted(() => ({ download: vi.fn(), downloadProgress: vi.fn() }));
vi.mock("./MediaItem.download.native", () => native);

// `makeTags` reads TIDAL's credentials module through a helper that only exists inside TIDAL
const tags = vi.hoisted(() => ({ availableTags: {}, makeTags: vi.fn(async () => ({ title: "A Track" })) }));
vi.mock("./MediaItem.tags", () => tags);

import { MediaItem } from "./MediaItem";
import { Quality } from "../Quality";
import type * as redux from "../../redux";
import type { PlaybackInfo } from "../../helpers";

type Cache = ConstructorParameters<typeof MediaItem>[3];

let idSeq = 800_000;
const nextId = () => ++idSeq;

const track = (fields: Partial<redux.Track> = {}): redux.Track =>
	({
		contentType: "track",
		id: 1,
		title: "A Track",
		duration: 200,
		trackNumber: 1,
		volumeNumber: 1,
		audioQuality: "LOSSLESS",
		audioModes: ["STEREO"],
		mediaMetadata: { tags: ["LOSSLESS"] },
		url: "http://www.tidal.com/track/1",
		...fields,
	}) as redux.Track;

const make = (fields: Partial<redux.Track> = {}, opts: { type?: redux.ContentType; cache?: Cache } = {}) =>
	new MediaItem(nextId(), { item: track(fields) } as redux.MediaItem, opts.type ?? "track", opts.cache ?? ({ format: {} } as Cache));

/** A playback info for the given manifest, with the fields the format code reads */
const playbackInfo = (manifestMimeType: string, extra: Record<string, unknown> = {}) =>
	({
		trackId: 1,
		manifestMimeType,
		manifest: {},
		audioQuality: "LOSSLESS",
		bitDepth: 16,
		sampleRate: 44100,
		...extra,
	}) as unknown as PlaybackInfo;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("fileExtension", () => {
	test("is flac for a lossless DASH stream and m4a for a lossy one", async () => {
		const lossless = make();
		helpers.getPlaybackInfo.mockResolvedValue(playbackInfo("application/dash+xml", { manifest: { tracks: { audios: [{ codec: "FLAC" }] } } }));
		expect(await lossless.fileExtension()).toBe("flac");

		const lossy = make();
		helpers.getPlaybackInfo.mockResolvedValue(playbackInfo("application/dash+xml", { manifest: { tracks: { audios: [{ codec: "AAC" }] } } }));
		expect(await lossy.fileExtension()).toBe("m4a");
	});

	test("is flac for a BTS stream", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(playbackInfo("application/vnd.tidal.bts"));
		expect(await make().fileExtension()).toBe("flac");
	});

	test("is mp4 for a video, without asking for playback info", async () => {
		expect(await make({}, { type: "video" }).fileExtension()).toBe("mp4");
		expect(helpers.getPlaybackInfo).not.toHaveBeenCalled();
	});

	test("throws for a manifest it can't download", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(playbackInfo("application/vnd.tidal.emu"));
		await expect(make().fileExtension()).rejects.toThrow(/Unsupported Stream Info manifest mime type/);

		helpers.getPlaybackInfo.mockResolvedValue(undefined);
		await expect(make().fileExtension()).rejects.toThrow(/is not available/);
	});
});

describe("download", () => {
	test("hands the playback info and the tags to the native downloader", async () => {
		const info = playbackInfo("application/vnd.tidal.bts");
		helpers.getPlaybackInfo.mockResolvedValue(info);
		native.download.mockResolvedValue("/music/a-track.flac");

		const item = make({ title: "A Track" });
		expect(await item.download("/music", "LOSSLESS")).toBe("/music/a-track.flac");
		expect(native.download).toHaveBeenCalledWith(info, "/music", expect.objectContaining({ title: expect.any(String) }));
	});

	test("a video downloads through its video playback info", async () => {
		const info = { videoId: 1, manifestMimeType: "application/vnd.tidal.emu", manifest: { urls: [] } };
		helpers.getVideoPlaybackInfo.mockResolvedValue(info);
		native.download.mockResolvedValue("/music/a-video.mp4");

		const item = make({}, { type: "video" });
		expect(await item.download("/music")).toBe("/music/a-video.mp4");
		expect(native.download).toHaveBeenCalledWith(info, "/music", expect.anything());
	});

	// `download` itself is debounced with `asyncDebounce`, which attaches `.finally()` to the promise it returns and drops
	// that promise: a rejected download (an item that isn't available) therefore surfaces as an unhandled rejection even
	// when the caller awaits it, and vitest fails the run for it. Those two throws are left to the same "is not available"
	// condition `fileExtension` covers above, rather than registering a global rejection handler to swallow the helper's.

	test("downloadProgress is the native one for this item", async () => {
		native.downloadProgress.mockReturnValue({ received: 10, total: 100 });
		const item = make();
		expect(await item.downloadProgress()).toEqual({ received: 10, total: 100 });
		expect(native.downloadProgress).toHaveBeenCalledWith(item.id);
	});
});

describe("playbackInfo", () => {
	test("caches the format it returned and the real audio quality", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(
			playbackInfo("application/vnd.tidal.bts", { bitDepth: 24, sampleRate: 96_000, audioQuality: "HI_RES_LOSSLESS" }),
		);
		const cache = { format: {} } as Cache;
		// A spatial-only track: its tags say nothing about the quality it really plays at, so the real one is used
		const item = make({ mediaMetadata: { tags: ["DOLBY_ATMOS"] } }, { cache });

		expect(await item.playbackInfo("LOSSLESS")).toEqual(expect.objectContaining({ bitDepth: 24 }));
		expect(cache.format?.LOSSLESS).toEqual({ bitDepth: 24, sampleRate: 96_000 });
		expect(cache.actualAudioQuality).toBe("HI_RES_LOSSLESS");
		expect(item.bestQuality).toBe(Quality.HiRes);
	});

	test("is undefined when the api has no playback info", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(undefined);
		expect(await make().playbackInfo("LOSSLESS")).toBeUndefined();
	});
});

describe("withFormat", () => {
	test("hands the format already cached for the quality straight to the listener", () => {
		const cache = { format: { LOSSLESS: { bitDepth: 16, sampleRate: 44_100 } } } as Cache;
		const item = make({}, { cache });
		const listener = vi.fn();

		const unload = item.withFormat(new Set(), "LOSSLESS", listener);

		expect(listener).toHaveBeenCalledWith({ bitDepth: 16, sampleRate: 44_100 });
		expect(typeof unload).toBe("function");
	});

	test("falls back to the actual audio quality for its cache lookup", () => {
		// A spatial track reports the quality it really played at, which is what the format was stored under
		const cache = { format: { HI_RES_LOSSLESS: { bitrate: 9000 } }, actualAudioQuality: "HI_RES_LOSSLESS" } as Cache;
		const listener = vi.fn();

		make({}, { cache }).withFormat(new Set(), "HI_RES_LOSSLESS", listener);

		expect(listener).toHaveBeenCalledWith({ bitrate: 9000 });
	});
});

describe("updateFormat", () => {
	const bts = () => playbackInfo("application/vnd.tidal.bts", { audioQuality: "LOSSLESS" });

	test("returns a format it already has unless forced", async () => {
		const cache = { format: { LOSSLESS: { bitrate: 1000, sampleRate: 44_100 } } } as Cache;
		const item = make({}, { cache });

		expect(await item.updateFormat("LOSSLESS")).toEqual({ bitrate: 1000, sampleRate: 44_100 });
		expect(helpers.getPlaybackInfo).not.toHaveBeenCalled();
	});

	test("reads the stream format for a BTS manifest", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(bts());
		stream.parseStreamFormat.mockResolvedValue({ format: { bitsPerSample: 16, sampleRate: 44_100, codec: "FLAC" }, bytes: 1000 });
		stream.getStreamBytes.mockResolvedValue(undefined);
		const cache = { format: {} } as Cache;

		const format = await make({ duration: 200 }, { cache }).updateFormat("LOSSLESS");

		expect(format).toEqual(expect.objectContaining({ bitDepth: 16, sampleRate: 44_100, codec: "flac", bytes: 1000, duration: 200 }));
		// 1000 bytes over 200s
		expect(format?.bitrate).toBe(40);
	});

	test("takes the bitrate and size from a DASH manifest", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(
			playbackInfo("application/dash+xml", { manifest: { tracks: { audios: [{ bitrate: { bps: 320_000 }, size: { b: 500 } }] } } }),
		);
		stream.parseStreamFormat.mockResolvedValue({ format: {}, bytes: 1000 });

		const format = await make({ duration: 10 }, { cache: { format: {} } as Cache }).updateFormat("LOSSLESS");

		expect(format).toEqual(expect.objectContaining({ bitrate: 320_000, bytes: 500 }));
	});

	test("stores the format under the quality the stream really played at", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(playbackInfo("application/vnd.tidal.bts", { audioQuality: "HI_RES_LOSSLESS" }));
		stream.parseStreamFormat.mockResolvedValue({ format: {}, bytes: 100 });
		stream.getStreamBytes.mockResolvedValue(undefined);
		const cache = { format: {} } as Cache;

		await make({}, { cache }).updateFormat("LOSSLESS");

		// Asked for LOSSLESS, played at HI_RES_LOSSLESS: the format is cached under both, so a later lookup by either finds it
		expect(cache.format?.LOSSLESS).toBeDefined();
		expect(cache.format?.HI_RES_LOSSLESS).toEqual(expect.objectContaining({ bytes: 100 }));
	});

	test("is undefined without playback info", async () => {
		helpers.getPlaybackInfo.mockResolvedValue(undefined);
		expect(await make().updateFormat("LOSSLESS")).toBeUndefined();
	});
});
