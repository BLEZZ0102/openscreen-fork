import { open } from "node:fs/promises";
import type { CursorRecordingData } from "../../src/native/contracts";
import {
	type Box,
	boxType,
	childBox,
	childBoxes,
	fullBoxBody,
	readAt,
	walkTopLevel,
} from "./mp4BoxIndex";

type TimeAnchor = { captureMs: number; playbackMs: number };
const MAX_INDEX_BOX_BYTES = 16 * 1024 * 1024;

const children = (buffer: Buffer, box: Box) =>
	childBoxes(buffer, box.start + box.headerSize, box.start + box.size);

function readTrack(moov: Buffer, root: Box) {
	for (const trak of children(moov, root).filter((box) => box.type === "trak")) {
		const tkhd = childBox(moov, trak, "tkhd");
		const mdia = childBox(moov, trak, "mdia");
		if (!tkhd || !mdia) continue;
		const hdlr = childBox(moov, mdia, "hdlr");
		const mdhd = childBox(moov, mdia, "mdhd");
		if (!hdlr || !mdhd || boxType(moov, fullBoxBody(hdlr) + 4) !== "vide") continue;
		const field = (box: Box) =>
			fullBoxBody(box) + (moov[box.start + box.headerSize] === 1 ? 16 : 8);
		return { id: moov.readUInt32BE(field(tkhd)), timescale: moov.readUInt32BE(field(mdhd)) };
	}
	return null;
}

function readRandomAccessEntries(buffer: Buffer, box: Box) {
	const body = fullBoxBody(box);
	const widths = buffer.readUInt32BE(body + 4);
	const trafWidth = ((widths >> 4) & 3) + 1;
	const trunWidth = ((widths >> 2) & 3) + 1;
	const sampleWidth = (widths & 3) + 1;
	const wide = buffer[box.start + box.headerSize] === 1;
	const word = wide ? 8 : 4;
	const entrySize = word * 2 + trafWidth + trunWidth + sampleWidth;
	const count = buffer.readUInt32BE(body + 8);
	const start = body + 12;
	if (count * entrySize > box.start + box.size - start) throw new Error("Truncated tfra");
	const read = (offset: number) =>
		wide ? Number(buffer.readBigUInt64BE(offset)) : buffer.readUInt32BE(offset);
	return Array.from({ length: count }, (_, i) => {
		const offset = start + i * entrySize;
		const numbers = offset + word * 2;
		return {
			time: read(offset),
			moofOffset: read(offset + word),
			traf: buffer.readUIntBE(numbers, trafWidth),
			trun: buffer.readUIntBE(numbers + trafWidth, trunWidth),
			sample: buffer.readUIntBE(numbers + trafWidth + trunWidth, sampleWidth),
		};
	});
}

function readSampleDurations(buffer: Buffer, box: Box) {
	const flags = buffer.readUInt32BE(box.start + box.headerSize) & 0xffffff;
	// The Windows sink supplies explicit durations. A different layout can keep its original timing.
	if (!(flags & 0x100)) throw new Error("Missing explicit fragment sample durations");
	const body = fullBoxBody(box);
	const count = buffer.readUInt32BE(body);
	const start = body + 4 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
	const width = 4 + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
	if (count * width > box.start + box.size - start) throw new Error("Truncated trun");
	return Array.from({ length: count }, (_, i) => {
		const offset = start + i * width;
		if (flags & 0x800 && buffer.readInt32BE(offset + width - 4) !== 0) {
			throw new Error("Unsupported reordered fragment samples");
		}
		return buffer.readUInt32BE(offset);
	});
}

/**
 * Media Foundation's fragmented sink can replace the last duration of each
 * fragment with a nominal frame interval. Its random-access index (tfra) still
 * records the original time of each keyframe. Match those entries to the same
 * samples in the playable timeline, without reading or rewriting any media.
 */
export async function readWindowsCursorTimeAnchors(filePath: string): Promise<TimeAnchor[]> {
	try {
		const handle = await open(filePath, "r");
		try {
			const { size } = await handle.stat();
			const { boxes, validBytes } = await walkTopLevel(handle, size);
			if (validBytes !== size) return [];
			const indexBox = async (box: Box) => {
				if (box.size > MAX_INDEX_BOX_BYTES) throw new Error("Oversized MP4 index box");
				return readAt(handle, box.start, box.size);
			};
			const moov = boxes.find((box) => box.type === "moov");
			const mfra = boxes.find((box) => box.type === "mfra");
			if (!moov || !mfra) return [];
			const track = readTrack(await indexBox(moov), { ...moov, start: 0 });
			if (!track?.timescale) return [];
			const randomAccess = await indexBox(mfra);
			const tfra = children(randomAccess, { ...mfra, start: 0 }).find(
				(box) => box.type === "tfra" && randomAccess.readUInt32BE(fullBoxBody(box)) === track.id,
			);
			if (!tfra) return [];
			const entries = readRandomAccessEntries(randomAccess, tfra);
			let playbackTime = 0;
			let entryIndex = 0;
			const anchors: TimeAnchor[] = [];
			for (const moof of boxes.filter((box) => box.type === "moof")) {
				const buffer = await indexBox(moof);
				const fragments = children(buffer, { ...moof, start: 0 }).filter(
					(box) => box.type === "traf",
				);
				for (const [trafIndex, traf] of fragments.entries()) {
					const tfhd = childBox(buffer, traf, "tfhd");
					if (!tfhd || buffer.readUInt32BE(fullBoxBody(tfhd)) !== track.id) continue;
					// Explicit decode times already place each fragment on its own timeline.
					if (childBox(buffer, traf, "tfdt")) return [];
					const runs = children(buffer, traf).filter((box) => box.type === "trun");
					for (const [runIndex, run] of runs.entries()) {
						const durations = readSampleDurations(buffer, run);
						for (const [sampleIndex, duration] of durations.entries()) {
							const entry = entries[entryIndex];
							if (
								entry?.moofOffset === moof.start &&
								entry.traf === trafIndex + 1 &&
								entry.trun === runIndex + 1 &&
								entry.sample === sampleIndex + 1
							) {
								anchors.push({
									captureMs: (entry.time * 1000) / track.timescale,
									playbackMs: (playbackTime * 1000) / track.timescale,
								});
								entryIndex += 1;
							}
							playbackTime += duration;
						}
					}
				}
			}
			return entryIndex === entries.length ? anchors : [];
		} finally {
			await handle.close();
		}
	} catch {
		// A missing or unsupported index must never stop the recording from being saved.
		return [];
	}
}

export function alignWindowsCursorTiming(
	recording: CursorRecordingData,
	anchors: readonly TimeAnchor[],
): CursorRecordingData {
	if (
		anchors.length < 2 ||
		anchors[0].captureMs !== 0 ||
		anchors[0].playbackMs !== 0 ||
		!anchors.some((anchor) => Math.abs(anchor.captureMs - anchor.playbackMs) > 2) ||
		anchors.some(
			(anchor, i) =>
				i > 0 &&
				(anchor.captureMs <= anchors[i - 1].captureMs ||
					anchor.playbackMs <= anchors[i - 1].playbackMs),
		)
	) {
		return recording;
	}
	let next = 1;
	const samples = recording.samples.map((sample) => {
		while (next < anchors.length - 1 && sample.timeMs > anchors[next].captureMs) next += 1;
		const a = anchors[next - 1];
		const b = anchors[next];
		const timeMs =
			sample.timeMs >= b.captureMs
				? b.playbackMs + sample.timeMs - b.captureMs
				: a.playbackMs +
					((sample.timeMs - a.captureMs) * (b.playbackMs - a.playbackMs)) /
						(b.captureMs - a.captureMs);
		return { ...sample, timeMs };
	});
	return { ...recording, samples };
}
