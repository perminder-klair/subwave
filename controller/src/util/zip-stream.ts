// A streaming zip writer for files that are already compressed (audio): every
// entry is STORED, written as its bytes arrive, and nothing is held in memory
// past the chunk in hand plus one small central-directory record per entry.
// adm-zip (used for backups) builds the whole archive in memory, which a
// many-GB Library download cannot afford.
//
// The format choices, each one forced by streaming:
// - Sizes and CRC-32 are unknown when an entry's local header goes out, so each
//   entry sets general-purpose bit 3 and is followed by a data descriptor; the
//   central directory, which every reader trusts, carries the real values.
// - Bit 11: names are UTF-8.
// - ZIP64 where 32 bits cannot hold a value: an entry whose size is unknown or
//   4 GiB or more gets a ZIP64 local extra and an 8-byte data descriptor; a
//   central record names a size or offset past 0xFFFFFFFF in its ZIP64 extra
//   (only the overflowing fields, in the spec's order, which is how readers
//   parse it); and the archive gets a ZIP64 end record and locator when it has
//   more than 65,535 entries or its directory starts or runs past 4 GiB.
//   `forceZip64` writes every one of those structures for small archives too,
//   so tests can prove them without writing 4 GiB.
//
// The caller opens each entry's source before calling add(): a source that
// fails before its first byte never gets a header. One that fails mid-entry
// cannot be closed into a valid archive (its header is already sent), so add()
// rejects and the caller must drop the connection rather than finish().
import { crc32 } from 'node:zlib';

const MAX32 = 0xFFFFFFFF;
const MAX16 = 0xFFFF;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const FLAGS = 0x0008 | 0x0800; // data descriptor + UTF-8 names
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
// Made by: Unix (3) << 8 | spec 6.3, so the external attributes read as a mode.
const MADE_BY = (3 << 8) | 63;
const FILE_MODE = (0o100644 << 16) >>> 0;

export type ZipSink = (chunk: Buffer) => Promise<void>;

interface CentralEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
  zip64Local: boolean;
}

export function dosDateTime(d: Date): { dosTime: number; dosDate: number } {
  // DOS dates start in 1980; anything earlier (or invalid) is clamped there.
  if (!Number.isFinite(d.getTime()) || d.getFullYear() < 1980) return { dosTime: 0, dosDate: (0 << 9) | (1 << 5) | 1 };
  const year = Math.min(d.getFullYear(), 2107);
  return {
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u64(buf: Buffer, value: number, at: number): void {
  buf.writeBigUInt64LE(BigInt(value), at);
}

export class StoreZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private busy = false;
  private done = false;

  constructor(private readonly sink: ZipSink, private readonly opts: { forceZip64?: boolean } = {}) {}

  /** Bytes written so far. */
  get bytes(): number { return this.offset; }
  get count(): number { return this.entries.length; }

  private async put(chunk: Buffer): Promise<void> {
    await this.sink(chunk);
    this.offset += chunk.length;
  }

  /**
   * Writes one stored entry. `size` is what the source announced (e.g. a
   * Content-Length), used only to choose the ZIP64 local form; the written
   * sizes are counted from the bytes themselves.
   */
  async add(
    name: string,
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    opts: { size?: number | null; mtime?: Date } = {},
  ): Promise<void> {
    if (this.done) throw new Error('zip already finished');
    if (this.busy) throw new Error('zip entries are written one at a time');
    this.busy = true;
    try {
      const nameBuf = Buffer.from(name.normalize('NFC'), 'utf8');
      if (nameBuf.length === 0 || nameBuf.length > MAX16) throw new Error('bad zip entry name');
      const size = opts.size;
      const zip64Local = !!this.opts.forceZip64 || size == null || !(size < MAX32);
      const { dosTime, dosDate } = dosDateTime(opts.mtime ?? new Date());
      const offset = this.offset;

      const extra = zip64Local ? Buffer.alloc(20) : Buffer.alloc(0);
      if (zip64Local) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(16, 2);
        // Both sizes 0 here: the data descriptor carries them.
      }
      const head = Buffer.alloc(30);
      head.writeUInt32LE(SIG_LOCAL, 0);
      head.writeUInt16LE(zip64Local ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
      head.writeUInt16LE(FLAGS, 6);
      head.writeUInt16LE(0, 8); // stored
      head.writeUInt16LE(dosTime, 10);
      head.writeUInt16LE(dosDate, 12);
      head.writeUInt32LE(0, 14); // CRC in the descriptor
      head.writeUInt32LE(zip64Local ? MAX32 : 0, 18);
      head.writeUInt32LE(zip64Local ? MAX32 : 0, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(extra.length, 28);
      await this.put(Buffer.concat([head, nameBuf, extra]));

      let crc = 0;
      let written = 0;
      for await (const part of body) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part.buffer, part.byteOffset, part.byteLength);
        if (chunk.length === 0) continue;
        crc = crc32(chunk, crc);
        written += chunk.length;
        if (!zip64Local && written >= MAX32) throw new Error('entry passed 4 GiB without a ZIP64 header');
        await this.put(chunk);
      }

      const desc = Buffer.alloc(zip64Local ? 24 : 16);
      desc.writeUInt32LE(SIG_DESCRIPTOR, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      if (zip64Local) {
        u64(desc, written, 8);
        u64(desc, written, 16);
      } else {
        desc.writeUInt32LE(written, 8);
        desc.writeUInt32LE(written, 12);
      }
      await this.put(desc);
      this.entries.push({ name: nameBuf, crc: crc >>> 0, size: written, offset, dosTime, dosDate, zip64Local });
    } finally {
      this.busy = false;
    }
  }

  /** Writes the central directory and the end records. */
  async finish(): Promise<void> {
    if (this.done) return;
    if (this.busy) throw new Error('an entry is still being written');
    this.done = true;
    const force = !!this.opts.forceZip64;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const sizes64 = force || e.zip64Local || !(e.size < MAX32);
      const offset64 = force || !(e.offset < MAX32);
      const fields: number[] = [];
      if (sizes64) fields.push(e.size, e.size); // uncompressed, then compressed
      if (offset64) fields.push(e.offset);
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((v, i) => u64(extra, v, 4 + i * 8));
      }
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(SIG_CENTRAL, 0);
      rec.writeUInt16LE(MADE_BY, 4);
      rec.writeUInt16LE(sizes64 || offset64 ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
      rec.writeUInt16LE(FLAGS, 8);
      rec.writeUInt16LE(0, 10);
      rec.writeUInt16LE(e.dosTime, 12);
      rec.writeUInt16LE(e.dosDate, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(sizes64 ? MAX32 : e.size, 20);
      rec.writeUInt32LE(sizes64 ? MAX32 : e.size, 24);
      rec.writeUInt16LE(e.name.length, 28);
      rec.writeUInt16LE(extra.length, 30);
      rec.writeUInt16LE(0, 32); // comment
      rec.writeUInt16LE(0, 34); // disk
      rec.writeUInt16LE(0, 36); // internal attributes
      rec.writeUInt32LE(FILE_MODE, 38);
      rec.writeUInt32LE(offset64 ? MAX32 : e.offset, 42);
      await this.put(Buffer.concat([rec, e.name, extra]));
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64End = force || count > MAX16 - 1 || !(cdStart < MAX32) || !(cdSize < MAX32);
    if (zip64End) {
      const end64At = this.offset;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(SIG_END64, 0);
      u64(end64, 44, 4); // size of the rest of this record
      end64.writeUInt16LE(MADE_BY, 12);
      end64.writeUInt16LE(VERSION_ZIP64, 14);
      end64.writeUInt32LE(0, 16);
      end64.writeUInt32LE(0, 20);
      u64(end64, count, 24);
      u64(end64, count, 32);
      u64(end64, cdSize, 40);
      u64(end64, cdStart, 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_LOCATOR64, 0);
      locator.writeUInt32LE(0, 4);
      u64(locator, end64At, 8);
      locator.writeUInt32LE(1, 16);
      await this.put(Buffer.concat([end64, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64End ? MAX16 : count, 8);
    end.writeUInt16LE(zip64End ? MAX16 : count, 10);
    end.writeUInt32LE(zip64End ? MAX32 : cdSize, 12);
    end.writeUInt32LE(zip64End ? MAX32 : cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this.put(end);
  }
}
