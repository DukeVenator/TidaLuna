import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `MediaItem`'s MusicBrainz side: which recording an ISRC resolves to, which release track it believes, and the titles
 * it compares to decide that. `brainzJson` is the only network call, so it is replaced here: the matching rules
 * (`matchBrainzRecording`, `baseTitle`), the release lookup and the `isrcs()` walk are the real ones.
 *
 * `Album` is replaced too, so the album-release path is driven with a release of its own shape rather than through a
 * second MusicBrainz lookup.
 */

const brainz = vi.hoisted(() => ({ brainzJson: vi.fn() }));
vi.mock("../../helpers/brainzJson", () => ({ brainzJson: brainz.brainzJson }));

const albums = vi.hoisted(() => ({ fromId: vi.fn() }));
vi.mock("../Album", () => ({ Album: { fromId: albums.fromId } }));

import { MediaItem } from "./MediaItem";
import { Quality } from "../Quality";
import { TidalApi } from "../TidalApi";
import type * as redux from "../../redux";

const track = (id: redux.ItemId, fields: Partial<redux.Track> = {}): redux.Track =>
	({
		contentType: "track",
		id,
		title: "A Track",
		duration: 200,
		trackNumber: 1,
		volumeNumber: 1,
		audioQuality: "LOSSLESS",
		mediaMetadata: { tags: ["LOSSLESS"] },
		...fields,
	}) as redux.Track;

let idSeq = 700_000;
const nextId = () => ++idSeq;
const make = (fields: Partial<redux.Track> = {}) =>
	new MediaItem(nextId(), { item: track(1, fields) } as redux.MediaItem, "track", { format: {} });

/** A MusicBrainz recording */
const recording = (id: string, title: string, length?: number, isrcs?: string[]) => ({ id, title, length, isrcs });

/** A MusicBrainz release whose first medium holds the given tracks */
const release = (tracks: { title: string; recording?: unknown }[], language = "eng") => ({
	id: "release-1",
	title: "A Release",
	"text-representation": { language },
	media: [{ "track-count": tracks.length, tracks }],
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("isrc lookup", () => {
	test("resolves the ISRC to the recording whose title matches the track", async () => {
		// Two recordings share the ISRC; only one is this track
		brainz.brainzJson
			.mockResolvedValueOnce({ recordings: [recording("other", "Something Else", 60_000), recording("mine", "A Track", 200_000)] })
			.mockResolvedValueOnce({ title: "A Track", releases: [release([{ title: "A Track" }])] });

		const mediaItem = make({ isrc: "ISRC1" });
		const item = await mediaItem.brainzItem();

		expect(item?.recording?.id).toBe("mine");
		expect(await mediaItem.brainzId()).toBe("mine");
		expect(brainz.brainzJson).toHaveBeenCalledWith(expect.stringContaining("/isrc/ISRC1"));
	});

	test("picks the recording closest in length when no title matches, within the tolerance", async () => {
		// The track is 200s: 201s is inside the 5s tolerance, 260s is not
		brainz.brainzJson
			.mockResolvedValueOnce({ recordings: [recording("near", "Unrelated", 201_000), recording("far", "Also Unrelated", 260_000)] })
			.mockResolvedValueOnce({ title: "Unrelated", releases: [release([{ title: "Unrelated" }])] });

		expect((await make({ isrc: "ISRC2" }).brainzItem())?.recording?.id).toBe("near");
	});

	test("picks nothing when no recording is titled or close enough", async () => {
		brainz.brainzJson.mockResolvedValueOnce({ recordings: [recording("far", "Unrelated", 400_000)] });

		// Nothing to believe, and no album to fall back to
		expect(await make({ isrc: "ISRC3" }).brainzItem()).toBeUndefined();
	});

	test("ignores the brackets, dash style and case of a title when comparing", async () => {
		// TIDAL says "Song (Remastered)", MusicBrainz "SONG – Remastered": same title either side
		brainz.brainzJson
			.mockResolvedValueOnce({ recordings: [recording("match", "song – remastered", 200_000)] })
			.mockResolvedValueOnce({ title: "song – remastered", releases: [release([{ title: "song – remastered" }])] });

		expect((await make({ title: "Song (Remastered)", isrc: "ISRC4" }).brainzItem())?.recording?.id).toBe("match");
	});

	test("takes a 404 as MusicBrainz not knowing the ISRC, and falls back to the album", async () => {
		brainz.brainzJson.mockRejectedValueOnce(new Error("404 Not Found"));
		albums.fromId.mockResolvedValue({ brainzRelease: async () => release([{ title: "A Track" }]) });

		const item = await make({ isrc: "ISRC5", album: { id: 999 } as unknown as redux.Album }).brainzItem();

		expect(item?.title).toBe("A Track");
	});
});

describe("album release fallback", () => {
	/** A track that names an album, which is what makes `album()` and so the release lookup run */
	const albumTrack = (fields: Partial<redux.Track> = {}) => make({ album: { id: 999 } as unknown as redux.Album, ...fields });

	test("takes the track at the album's volume and track number", async () => {
		albums.fromId.mockResolvedValue({ brainzRelease: async () => release([{ title: "First" }, { title: "Second" }]) });

		// TIDAL numbers tracks and volumes from 1, MusicBrainz's media arrays from 0
		expect((await albumTrack({ trackNumber: 2 }).brainzItem())?.title).toBe("Second");
	});

	test("is undefined without an album release", async () => {
		albums.fromId.mockResolvedValue(undefined);
		expect(await albumTrack().brainzItem()).toBeUndefined();
	});

	test("looks the recording up when the release is not english", async () => {
		albums.fromId.mockResolvedValue({
			brainzRelease: async () => release([{ title: "Ein Titel", recording: recording("rec-de", "Ein Titel", 200_000) }], "ger"),
		});
		// The english release of the same recording is believed instead
		brainz.brainzJson.mockResolvedValueOnce({ title: "A Title", releases: [release([{ title: "A Title" }], "eng")] });

		expect((await albumTrack().brainzItem())?.title).toBe("A Title");
	});
});

describe("isrcs", () => {
	test("yields TIDAL's ISRC and then the ones MusicBrainz knows, without repeating one", async () => {
		brainz.brainzJson
			.mockResolvedValueOnce({ recordings: [recording("rec", "A Track", 200_000, ["ISRC1", "ISRC9"])] })
			.mockResolvedValueOnce({ title: "A Track", releases: [release([{ title: "A Track" }])] });

		const seen: string[] = [];
		for await (const isrc of make({ isrc: "ISRC1" }).isrcs()) seen.push(isrc);

		expect(seen).toEqual(["ISRC1", "ISRC9"]);
	});

	test("a video has no ISRCs to walk", async () => {
		const video = new MediaItem(nextId(), { item: track(1) } as redux.MediaItem, "video", { format: {} });
		const seen: string[] = [];
		for await (const isrc of video.isrcs()) seen.push(isrc);

		expect(seen).toEqual([]);
	});
});

describe("fromIsrc", () => {
	test("returns the highest quality track the ISRC names", async () => {
		const low = nextId();
		const high = nextId();
		vi.spyOn(TidalApi, "isrc").mockImplementation(async function* () {
			yield { id: low, attributes: { mediaTags: [] } } as never;
			yield { id: high, attributes: { mediaTags: ["HIRES_LOSSLESS"] } } as never;
		});
		// Only the high quality one is reachable, the low one not being better than nothing
		const seeded = new MediaItem(low, { item: track(low) } as redux.MediaItem, "track", { format: {} });
		vi
			.spyOn(MediaItem, "fromId")
			.mockImplementation(async (id?: redux.ItemId) =>
				id === high
					? new MediaItem(high, { item: track(high, { mediaMetadata: { tags: ["HIRES_LOSSLESS"] } }) } as redux.MediaItem, "track", { format: {} })
					: id === low
						? seeded
						: undefined,
			);

		const best = await MediaItem.fromIsrc("ISRC-BEST");

		expect(best?.id).toBe(high);
		expect(best?.bestQuality).toBe(Quality.Max);
	});

	test("returns the best one even when it isn't the highest quality there is", async () => {
		const only = nextId();
		vi.spyOn(TidalApi, "isrc").mockImplementation(async function* () {
			yield { id: only, attributes: { mediaTags: ["LOSSLESS"] } } as never;
		});
		vi
			.spyOn(MediaItem, "fromId")
			.mockResolvedValue(
				new MediaItem(only, { item: track(only, { mediaMetadata: { tags: ["LOSSLESS"] } }) } as redux.MediaItem, "track", { format: {} }),
			);

		// Nothing is HiRes here, so the walk ends and hands back what it found
		expect((await MediaItem.fromIsrc("ISRC-HIGH"))?.id).toBe(only);
	});
});

describe("max", () => {
	test("is the better item the ISRCs lead to", async () => {
		const betterId = nextId();
		const better = new MediaItem(
			betterId,
			{ item: track(betterId, { mediaMetadata: { tags: ["HIRES_LOSSLESS"] } }) } as redux.MediaItem,
			"track",
			{ format: {} },
		);
		vi.spyOn(MediaItem, "fromIsrc").mockResolvedValue(better);

		// This one is Lossless, so a HiRes copy of the same recording is worth returning
		expect((await make({ isrc: "ISRC-MAX" }).max())?.id).toBe(betterId);
	});

	test("is nothing when no other copy is better", async () => {
		// MusicBrainz knowing the ISRC would add ISRCs to walk; an empty answer leaves the one TIDAL has
		brainz.brainzJson.mockResolvedValue({ recordings: [] });
		vi.spyOn(MediaItem, "fromIsrc").mockResolvedValue(undefined);

		// Only itself to find, which isn't an upgrade
		expect(await make({ isrc: "ISRC-SAME" }).max()).toBeUndefined();
	});
});
