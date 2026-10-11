// Minimal ZIP reader for ROM archives: list entries (central directory, with
// a local-header walk as fallback) and extract one entry (stored or deflate).
// Pure apart from DecompressionStream, which every target browser has
// (Safari 16.4+); callers fall back to handing the archive to EmulatorJS.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const MAX_U32 = 0xffffffff;

export class ZipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv, at) {
  // ROMs are far below 2^53, so a plain Number is exact
  return dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 0x100000000;
}

const utf8 = new TextDecoder('utf-8');

export function isZip(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const sig = view(bytes).getUint32(0, true);
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

export function is7z(bytes) {
  return !!bytes && bytes.length >= 6 &&
    bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf && bytes[4] === 0x27 && bytes[5] === 0x1c;
}

function findEocd(dv) {
  // the EOCD record is 22 bytes plus a comment of up to 65535 bytes
  const min = Math.max(0, dv.byteLength - 22 - 0xffff);
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

// Returns { count, cdOffset } or null when there is no usable directory.
function readDirectoryInfo(dv) {
  const eocd = findEocd(dv);
  if (eocd < 0) return null;
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if ((count === 0xffff || cdOffset === MAX_U32) && eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) {
    const z64 = u64(dv, eocd - 20 + 8);
    if (z64 + 56 <= dv.byteLength && dv.getUint32(z64, true) === SIG_ZIP64_EOCD) {
      count = u64(dv, z64 + 32);
      cdOffset = u64(dv, z64 + 48);
    }
  }
  if (cdOffset >= dv.byteLength) return null;
  return { count, cdOffset };
}

// Zip64 extended information (extra field 0x0001) replaces 0xFFFFFFFF values
// in the fixed header, in this order: size, compressed size, local offset.
function applyZip64Extra(dv, start, len, entry) {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = dv.getUint16(p, true);
    const size = dv.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.size === MAX_U32 && q + 8 <= p + 4 + size) { entry.size = u64(dv, q); q += 8; }
      if (entry.compressedSize === MAX_U32 && q + 8 <= p + 4 + size) { entry.compressedSize = u64(dv, q); q += 8; }
      if (entry.offset === MAX_U32 && q + 8 <= p + 4 + size) { entry.offset = u64(dv, q); }
      return;
    }
    p += 4 + size;
  }
}

function makeEntry(name, flags, method, compressedSize, size, offset, crc) {
  return {
    name,
    method,
    flags,
    crc,
    compressedSize,
    size,
    offset,
    encrypted: (flags & 1) === 1,
    isDir: name.endsWith('/')
  };
}

function readCentralDirectory(bytes, dv, info) {
  const entries = [];
  let p = info.cdOffset;
  for (let i = 0; i < info.count; i++) {
    if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const entry = makeEntry(name, flags, method, compressedSize, size, offset, crc);
    applyZip64Extra(dv, p + 46 + nameLen, extraLen, entry);
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Fallback for archives without a readable central directory (truncated
// downloads): walk local headers until one uses a data descriptor, whose
// sizes are unknown up front.
function walkLocalHeaders(bytes, dv) {
  const entries = [];
  let p = 0;
  while (p + 30 <= dv.byteLength && dv.getUint32(p, true) === SIG_LOCAL) {
    const flags = dv.getUint16(p + 6, true);
    const method = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 14, true);
    const compressedSize = dv.getUint32(p + 18, true);
    const size = dv.getUint32(p + 22, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = utf8.decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const entry = makeEntry(name, flags, method, compressedSize, size, p, crc);
    applyZip64Extra(dv, p + 30 + nameLen, extraLen, entry);
    entries.push(entry);
    if ((flags & 8) && entry.compressedSize === 0) break;
    p += 30 + nameLen + extraLen + entry.compressedSize;
  }
  return entries;
}

// All entries in archive order. Throws ZipError('not-zip') for other data.
export function listZipEntries(bytes) {
  if (!isZip(bytes)) throw new ZipError('This file is not a ZIP archive.', 'not-zip');
  const dv = view(bytes);
  const info = readDirectoryInfo(dv);
  const entries = info ? readCentralDirectory(bytes, dv, info) : [];
  return entries.length ? entries : walkLocalHeaders(bytes, dv);
}

export function extOf(name) {
  const base = String(name || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function baseName(name) {
  return String(name || '').split(/[\\/]/).pop();
}

// First file entry whose extension the predicate accepts. Archives often
// lead with a readme or a .txt, so "first entry" alone is not enough.
export function findEntry(entries, acceptExt) {
  return entries.find((e) => !e.isDir && acceptExt(extOf(e.name))) || null;
}

function dataStart(dv, entry) {
  const p = entry.offset;
  if (p + 30 > dv.byteLength || dv.getUint32(p, true) !== SIG_LOCAL) {
    throw new ZipError('The archive is damaged.', 'corrupt');
  }
  // the local header carries its own name/extra lengths (they may differ
  // from the central directory's copy)
  return p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function canInflate() {
  try {
    if (typeof DecompressionStream !== 'function') return false;
    new DecompressionStream('deflate-raw');
    return true;
  } catch { return false; }
}

// Stops (and throws) once the output passes `limit` bytes: the entry's
// declared size, so a damaged or hostile archive can't exhaust memory.
async function inflateRaw(data, limit) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // write and read concurrently: the write only settles once it is consumed
  const written = writer.write(data).then(() => writer.close());
  written.catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new ZipError('The archive is damaged.', 'crc');
    }
    chunks.push(value);
  }
  await written;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// Extract one entry. Throws ZipError with code 'encrypted', 'unsupported'
// (compression method or no DecompressionStream), 'corrupt' or 'crc'.
export async function extractEntry(bytes, entry) {
  if (entry.encrypted) throw new ZipError('This archive is password-protected.', 'encrypted');
  const dv = view(bytes);
  const start = dataStart(dv, entry);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError('The archive is damaged.', 'corrupt');
  const raw = bytes.subarray(start, end);
  let out;
  if (entry.method === 0) {
    out = raw.slice();
  } else if (entry.method === 8) {
    if (!canInflate()) throw new ZipError('This browser can’t unpack ZIP files.', 'unsupported');
    try { out = await inflateRaw(raw, entry.size); }
    catch (e) { throw e instanceof ZipError ? e : new ZipError('The archive is damaged.', 'corrupt'); }
  } else {
    throw new ZipError('This ZIP uses a compression method that isn’t supported.', 'unsupported');
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) {
    throw new ZipError('The archive is damaged.', 'crc');
  }
  return out;
}
