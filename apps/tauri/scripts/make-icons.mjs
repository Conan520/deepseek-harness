// Deterministic icon generation for the Tauri shell: composes the DeepSeek
// whale silhouette over the rounded-square background, renders PNGs by
// supersampling the SVG path geometry, and wraps them into ICO and ICNS
// containers with Node's built-ins only. Run from apps/tauri:
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
/** Side of the centered box the whale glyph fits into. */
const WHALE_BOX = 44
/** Cubic-bézier segments per curve when flattening the path. */
const CURVE_STEPS = 24
const BACKGROUND = [0x4d, 0x6b, 0xfe]
const FOREGROUND = [0xff, 0xff, 0xff]

/** Whale path data, copied from apps/web/public/favicon.svg (viewBox 0 0 50 50, fill-rule nonzero). */
const WHALE_PATH_D = 'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0366 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0449 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3916 23.0161 26.8633 23.0161C26.666 23.0161 26.4844 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0522 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'

/** Split one path-data string into command letters and numbers. */
function tokenizePath(d) {
  return d.match(/[MCLZ]|[-+]?(?:\d*\.\d+|\d+\.?)/gu) ?? []
}

/** One flattened cubic-bézier curve appended to the current subpath. */
function flattenCubic(subpath, x0, y0, x1, y1, x2, y2, x3, y3) {
  for (let step = 1; step <= CURVE_STEPS; step += 1) {
    const t = step / CURVE_STEPS
    const inverse = 1 - t
    subpath.push({
      x: inverse ** 3 * x0 + 3 * inverse ** 2 * t * x1 + 3 * inverse * t ** 2 * x2 + t ** 3 * x3,
      y: inverse ** 3 * y0 + 3 * inverse ** 2 * t * y1 + 3 * inverse * t ** 2 * y2 + t ** 3 * y3,
    })
  }
}

/** Flatten one path-data string into closed polygon subpaths. */
function parseSubpaths(d) {
  const tokens = tokenizePath(d)
  const subpaths = []
  let current = null
  let command = null
  let cursorX = 0
  let cursorY = 0
  let startX = 0
  let startY = 0
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    if (token === 'M' || token === 'L' || token === 'C' || token === 'Z') {
      command = token
      index += 1
      if (token === 'Z') {
        if (current !== null && current.length > 1) current.push({ x: startX, y: startY })
        current = null
        command = null
      }
      continue
    }
    if (command === 'M') {
      const x = Number(tokens[index])
      const y = Number(tokens[index + 1])
      index += 2
      current = [{ x, y }]
      subpaths.push(current)
      cursorX = x
      cursorY = y
      startX = x
      startY = y
      // Further coordinate pairs after an M are implicit lineto segments.
      command = 'L'
    } else if (command === 'L') {
      const x = Number(tokens[index])
      const y = Number(tokens[index + 1])
      index += 2
      current.push({ x, y })
      cursorX = x
      cursorY = y
    } else if (command === 'C') {
      const numbers = tokens.slice(index, index + 6).map(Number)
      index += 6
      flattenCubic(current, cursorX, cursorY, ...numbers)
      cursorX = numbers[4]
      cursorY = numbers[5]
    } else {
      throw new Error(`make-icons: unsupported path state at token ${token}`)
    }
  }
  return subpaths
}

/**
 * Fit the whale subpaths into the centered WHALE_BOX of the logical canvas
 * and expose a nonzero-winding containment test over the flattened edges.
 */
function prepareWhale(d) {
  const subpaths = parseSubpaths(d)
  const bounds = subpaths.flat().reduce((box, point) => ({
    minX: Math.min(box.minX, point.x),
    minY: Math.min(box.minY, point.y),
    maxX: Math.max(box.maxX, point.x),
    maxY: Math.max(box.maxY, point.y),
  }), { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY })
  const scale = WHALE_BOX / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  const offsetX = (LOGICAL - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale
  const offsetY = (LOGICAL - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale
  const edges = []
  for (const subpath of subpaths) {
    for (let index = 0; index < subpath.length; index += 1) {
      const from = subpath[index]
      const to = subpath[(index + 1) % subpath.length]
      edges.push([from.x * scale + offsetX, from.y * scale + offsetY, to.x * scale + offsetX, to.y * scale + offsetY])
    }
  }
  return {
    contains(x, y) {
      let winding = 0
      for (const [ax, ay, bx, by] of edges) {
        if ((ay > y) === (by > y)) continue
        const crossingX = ax + ((y - ay) * (bx - ax)) / (by - ay)
        if (crossingX > x) winding += by > ay ? 1 : -1
      }
      return winding !== 0
    },
  }
}

const whale = prepareWhale(WHALE_PATH_D)

/** Color of one logical point: the rounded square, then the whale glyph. */
function sample(u, v) {
  const half = LOGICAL / 2
  const inset = half - CORNER_RADIUS
  const ox = Math.max(Math.abs(u - half) - inset, 0)
  const oy = Math.max(Math.abs(v - half) - inset, 0)
  if (ox * ox + oy * oy > CORNER_RADIUS * CORNER_RADIUS) return null
  if (whale.contains(u, v)) return FOREGROUND
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
