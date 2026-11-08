import type { FileHandle } from "node:fs/promises";

export type Box = { type: string; start: number; headerSize: number; size: number };

export function boxType(buffer: Buffer, offset: number) {
	return buffer.toString("latin1", offset, offset + 4);
}

function isPrintableType(type: string) {
	return /^[\x20-\x7e]{4}$/.test(type);
}

/** Complete child boxes of `[start, end)` inside an in-memory box. */
export function childBoxes(buffer: Buffer, start: number, end: number): Box[] {
	const boxes: Box[] = [];
	let position = start;
	while (position + 8 <= end) {
		let size = buffer.readUInt32BE(position);
		const type = boxType(buffer, position + 4);
		let headerSize = 8;
		if (size === 1) {
			if (position + 16 > end) {
				break;
			}
			size = Number(buffer.readBigUInt64BE(position + 8));
			headerSize = 16;
		} else if (size === 0) {
			size = end - position;
		}
		if (size < headerSize || position + size > end) {
			break;
		}
		boxes.push({ type, start: position, headerSize, size });
		position += size;
	}
	return boxes;
}

export function childBox(buffer: Buffer, parent: Box, type: string) {
	return childBoxes(buffer, parent.start + parent.headerSize, parent.start + parent.size).find(
		(box) => box.type === type,
	);
}

/** Offset of the first byte after a full box's version and flags. */
export function fullBoxBody(box: Box) {
	return box.start + box.headerSize + 4;
}

export async function readAt(handle: FileHandle, position: number, length: number) {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

type TopLevel = { boxes: Box[]; validBytes: number };

/**
 * Walks the top-level boxes by their own offsets. A final `mdat` may run past the end
 * of the file — that is the fragment still being written — but any other box that
 * does, a header cut short, or bytes that are not a box header end the readable part
 * where they start.
 */
export async function walkTopLevel(handle: FileHandle, fileBytes: number): Promise<TopLevel> {
	const boxes: Box[] = [];
	let position = 0;
	while (position < fileBytes) {
		if (fileBytes - position < 8) {
			return { boxes, validBytes: position };
		}
		const header = await readAt(handle, position, 16);
		const type = boxType(header, 4);
		if (!isPrintableType(type)) {
			return { boxes, validBytes: position };
		}
		let size = header.readUInt32BE(0);
		let headerSize = 8;
		if (size === 1) {
			if (header.length < 16) {
				return { boxes, validBytes: position };
			}
			size = Number(header.readBigUInt64BE(8));
			headerSize = 16;
		} else if (size === 0) {
			size = fileBytes - position;
		}
		if (size < headerSize) {
			return { boxes, validBytes: position };
		}
		if (position + size > fileBytes) {
			if (type !== "mdat") {
				return { boxes, validBytes: position };
			}
			boxes.push({ type, start: position, headerSize, size: fileBytes - position });
			return { boxes, validBytes: fileBytes };
		}
		boxes.push({ type, start: position, headerSize, size });
		position += size;
	}
	return { boxes, validBytes: position };
}
