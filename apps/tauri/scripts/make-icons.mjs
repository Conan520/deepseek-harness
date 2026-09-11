// Deterministic icon generation for the Tauri shell: draws the 64×64 logical
// mark once, renders PNGs by supersampling, and wraps them into ICO and ICNS
// containers with Node's built-in zlib only. Run from apps/tauri:
//   node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons')

/** Logical canvas edge; every geometry constant below is in these units. */
const LOGICAL = 64
/** Supersampling factor per axis; 4×4 samples give 16 antialiasing levels. */
const SUPERSAMPLE = 4
/** Rounded-square corner radius of the background. */
const CORNER_RADIUS = 14
const BACKGROUND = [0x4d, 0x6b, 0xfe]
const FOREGROUND = [0xff, 0xff, 0xff]

/** Shortest distance from one point to a line segment, in logical units. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** Color of one logical point: the rounded square, then the prompt glyph. */
function sample(u, v) {
  const half = LOGICAL / 2
  const inset = half - CORNER_RADIUS
  const ox = Math.max(Math.abs(u - half) - inset, 0)
  const oy = Math.max(Math.abs(v - half) - inset, 0)
  if (ox * ox + oy * oy > CORNER_RADIUS * CORNER_RADIUS) return null
  const glyphStroke = 3.5
  const chevron = Math.min(
    distanceToSegment(u, v, 19, 20, 33, 32),
    distanceToSegment(u, v, 33, 32, 19, 44),
  )
  const underscore = distanceToSegment(u, v, 38, 41, 51, 41)
  if (Math.min(chevron, underscore) <= glyphStroke) return FOREGROUND
  return BACKGROUND
}

/** Render one square PNG RGBA buffer at `size` device pixels. */
function renderRgba(size) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0
      let green = 0
      let blue = 0
      let covered = 0
      const total = SUPERSAMPLE * SUPERSAMPLE
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = ((x + (sx + 0.5) / SUPERSAMPLE) / size) * LOGICAL
          const v = ((y + (sy + 0.5) / SUPERSAMPLE) / size) * LOGICAL
          const color = sample(u, v)
          if (color !== null) {
            covered += 1
            red += color[0]
            green += color[1]
            blue += color[2]
          }
        }
      }
      const offset = (y * size + x) * 4
      if (covered === 0) {
        rgba[offset + 3] = 0
        continue
      }
      rgba[offset] = Math.round(red / covered)
      rgba[offset + 1] = Math.round(green / covered)
      rgba[offset + 2] = Math.round(blue / covered)
      rgba[offset + 3] = Math.round((covered / total) * 255)
    }
  }
  return rgba
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

/** PNG chunk CRC-32 over type and data. */
function crc32(type, data) {
  let crc = 0xffffffff
  for (const byte of Buffer.concat([Buffer.from(type, 'ascii'), data])) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One length-typed-CRC PNG chunk. */
function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'ascii')
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(crc32(type, data), 0)
  return Buffer.concat([header, data, trailer])
}

/** Encode an RGBA buffer as an 8-bit RGBA PNG with filter 0 per scanline. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Wrap square PNG entries into a Windows ICO; width 0 in an entry means 256. */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  const blobs = []
  let offset = header.length + directory.length
  entries.forEach(([size, png], index) => {
    const entry = directory.subarray(index * 16, (index + 1) * 16)
    entry[0] = size === 256 ? 0 : size
    entry[1] = size === 256 ? 0 : size
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    blobs.push(png)
    offset += png.length
  })
  return Buffer.concat([header, directory, ...blobs])
}

/** Wrap square PNG entries into a macOS ICNS. */
function encodeIcns(entries) {
  const chunks = entries.map(([type, png]) => {
    const chunk = Buffer.alloc(8)
    chunk.write(type, 0, 'ascii')
    chunk.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([chunk, png])
  })
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 8)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...chunks])
}

const pngs = new Map([16, 32, 48, 128, 256].map(size => [size, encodePng(size, size, renderRgba(size))]))
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, '32x32.png'), pngs.get(32))
writeFileSync(join(outDir, '128x128.png'), pngs.get(128))
writeFileSync(join(outDir, '128x128@2x.png'), pngs.get(256))
writeFileSync(join(outDir, 'icon.ico'), encodeIco([[16, pngs.get(16)], [32, pngs.get(32)], [48, pngs.get(48)], [256, pngs.get(256)]]))
writeFileSync(join(outDir, 'icon.icns'), encodeIcns([['ic07', pngs.get(128)], ['ic08', pngs.get(256)]]))
console.log(`make-icons: wrote icons under ${outDir}`)
