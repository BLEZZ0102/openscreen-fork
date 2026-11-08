import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CursorRecordingData } from "../../src/native/contracts";
import {
	alignWindowsCursorTiming,
	readWindowsCursorTimeAnchors,
} from "./nativeWindowsCursorTiming";

function integers(...values: number[]) {
	const bytes = Buffer.alloc(values.length * 4);
	values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
	return bytes;
}

function box(type: string, ...body: Buffer[]) {
	const size = 8 + body.reduce((sum, value) => sum + value.length, 0);
	return Buffer.concat([integers(size), Buffer.from(type), ...body]);
}

it("matches each keyframe to its sample in the playable timeline", async () => {
	const moov = box(
		"moov",
		box(
			"trak",
			box("tkhd", integers(0, 0, 0, 1)),
			box(
				"mdia",
				box("hdlr", integers(0, 0), Buffer.from("vide")),
				box("mdhd", integers(0, 0, 0, 1000)),
			),
		),
	);
	const fragment = box(
		"moof",
		box("traf", box("tfhd", integers(0, 1)), box("trun", integers(0x100, 2, 1000, 1000))),
	);
	const mfra = box(
		"mfra",
		box(
			"tfra",
			integers(0, 1, 0, 2),
			integers(0, moov.length),
			Buffer.from([1, 1, 1]),
			integers(3400, moov.length + fragment.length),
			Buffer.from([1, 1, 2]),
		),
	);
	const directory = await mkdtemp(join(tmpdir(), "openscreen-cursor-timing-"));
	try {
		const path = join(directory, "take.mp4");
		await writeFile(path, Buffer.concat([moov, fragment, fragment, mfra]));
		const anchors = await readWindowsCursorTimeAnchors(path);
		expect(anchors).toEqual([
			{ captureMs: 0, playbackMs: 0 },
			{ captureMs: 3400, playbackMs: 3000 },
		]);
		const recording: CursorRecordingData = {
			version: 2,
			provider: "none",
			assets: [],
			samples: [
				{ timeMs: 1700, cx: 0.2, cy: 0.3, interactionType: "click" },
				{ timeMs: 3500, cx: 0.4, cy: 0.6 },
			],
		};
		expect(alignWindowsCursorTiming(recording, anchors).samples).toEqual([
			{ ...recording.samples[0], timeMs: 1500 },
			{ ...recording.samples[1], timeMs: 3100 },
		]);
		await writeFile(path, Buffer.concat([moov, fragment]));
		expect(await readWindowsCursorTimeAnchors(path)).toEqual([]);
		expect(alignWindowsCursorTiming(recording, [])).toBe(recording);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
