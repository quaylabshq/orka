import type { SessionTranscriptRange } from "../types.js";

export const TRANSCRIPT_BLOCK_BYTES = 4 * 1024;
export const TRANSCRIPT_READ_BYTES = 16 * 1024;
const MAX_BLOCK_LINES = 96;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export interface TranscriptBlock {
  offset: number;
  end: number;
  lineCount: number;
  characters: number;
}

/** Split on UTF-8 and prefer a nearby line boundary. Every byte remains available. */
export function transcriptBlocks(range: SessionTranscriptRange) {
  const bytes = encoder.encode(range.text);
  const blocks: Array<{ block: TranscriptBlock; text: string }> = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + TRANSCRIPT_BLOCK_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    let lines = 0;
    let lineEnd = start;
    for (let i = start; i < end; i++) {
      if (bytes[i] !== 10) continue;
      lineEnd = i + 1;
      if (++lines === MAX_BLOCK_LINES) {
        end = lineEnd;
        break;
      }
    }
    if (end < bytes.length && lineEnd >= start + TRANSCRIPT_BLOCK_BYTES / 2)
      end = lineEnd;
    const text = decoder.decode(bytes.subarray(start, end));
    blocks.push({
      block: {
        offset: range.offset + start,
        end: range.offset + end,
        lineCount: lines + 1,
        characters: text.length,
      },
      text,
    });
    start = end;
  }
  return blocks;
}

/** Refill evicted text with its original block boundaries and keys. */
export function restoreTranscriptBlocks(
  range: SessionTranscriptRange,
  blocks: TranscriptBlock[],
) {
  const bytes = encoder.encode(range.text);
  return blocks.map((block) => ({
    block,
    text: decoder.decode(
      bytes.subarray(block.offset - range.offset, block.end - range.offset),
    ),
  }));
}
