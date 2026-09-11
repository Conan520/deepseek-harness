// Stage the bundled backend runtime for the Tauri installer:
// - one pinned upstream Node.js executable, SHASUMS256-verified
// - one production install of the published @deepseek-ai/dsh at this
//   checkout's root version, inside an isolated single-project pnpm workspace
//   with a hoisted node_modules (no symlinks, so it can ship as installer
//   resources)
// Run from apps/tauri: node scripts/prepare-runtime.mjs

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_ROOT = join(APP_ROOT, '.tauri-build')
const DOWNLOADS = join(BUILD_ROOT, 'downloads')
const NODE_VERSION = '24.17.0'
const DEFAULT_RELEASE_ROOT = 'https://nodejs.org/download/release'

/** Reject non-http(s) schemes and loopback, private, or reserved hosts. */
function assertPublicHttpUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`prepare-runtime: only http/https URLs are allowed, got ${raw}`)
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const rejectedHosts = new Set(['localhost', '0.0.0.0', '::1'])
  if (rejectedHosts.has(host)) {
    throw new Error(`prepare-runtime: refusing loopback/reserved host ${host}`)
  }
  const octets = host.split('.').map(Number)
  if (octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first, second] = octets
    const privateRanges = first === 10
      || (first === 127)
      || (first === 192 && second === 168)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 169 && second === 254)
    if (privateRanges) {
      throw new Error(`prepare-runtime: refusing private/loopback address ${host}`)
    }
  }
}

async function download(url, destination) {
  assertPublicHttpUrl(url)
  process.stdout.write(`prepare-runtime: downloading ${url}\n`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`prepare-runtime: ${url} returned HTTP ${String(response.status)}`)
  writeFileSync(destination, new Uint8Array(await response.arrayBuffer()))
}

/** Place the pinned Node.js executable at .tauri-build/bin/node.exe. */
async function prepareNode(releaseRoot) {
  const archiveName = `node-v${NODE_VERSION}-win-x64.zip`
  const archive = join(DOWNLOADS, archiveName)
  const sums = join(DOWNLOADS, `node-v${NODE_VERSION}-SHASUMS256.txt`)
  mkdirSync(DOWNLOADS, { recursive: true })
  if (!existsSync(archive)) await download(`${releaseRoot}/v${NODE_VERSION}/${archiveName}`, archive)
  if (!existsSync(sums)) await download(`${releaseRoot}/v${NODE_VERSION}/SHASUMS256.txt`, sums)
  const line = readFileSync(sums, 'utf8').split(/\r?\n/u)
    .find(candidate => candidate.endsWith(`  ${archiveName}`))
  if (line === undefined) throw new Error(`prepare-runtime: ${archiveName} is absent from the Node.js SHASUMS256.txt`)
  const expected = line.split(/\s+/u)[0]
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== expected) throw new Error(`prepare-runtime: checksum mismatch for ${archiveName}`)

  const extraction = join(BUILD_ROOT, 'node-extract')
  rmSync(extraction, { recursive: true, force: true })
  mkdirSync(extraction, { recursive: true })
  // Windows 10+ ships bsdtar as System32\tar.exe, which reads zip archives
  // and, unlike an MSYS GNU tar on PATH, accepts drive-letter paths.
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const tar = existsSync(systemTar) ? systemTar : 'tar'
  const extract = spawnSync(tar, ['-xf', archive, '-C', extraction], { stdio: 'inherit' })
  if (extract.status !== 0) throw new Error(`prepare-runtime: tar could not extract ${archiveName}`)
  const binDir = join(BUILD_ROOT, 'bin')
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  // Tauri's externalBin convention: the sidecar source carries the target
  // triple suffix; the shell resolves it at runtime via `sidecar("node")`.
  copyFileSync(
    join(extraction, `node-v${NODE_VERSION}-win-x64`, 'node.exe'),
    join(binDir, 'node-x86_64-pc-windows-msvc.exe'),
  )
  rmSync(extraction, { recursive: true, force: true })
}

/** Resolve the runtime's dsh version: an explicit override, else the published `latest` dist-tag. */
function resolveDshVersion() {
  const override = process.env.DSH_TAURI_DSH_VERSION?.trim()
  if (override !== undefined && override !== '') return override
  const view = spawnSync('pnpm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const latest = view.stdout?.trim()
  if (view.status !== 0 || latest === undefined || latest === '') {
    throw new Error('prepare-runtime: could not resolve the @deepseek-ai/dsh latest dist-tag; set DSH_TAURI_DSH_VERSION')
  }
  return latest
}

/** Install the published dsh runtime into an isolated hoisted workspace. */
function prepareDshRuntime(version) {
  const runtimeDir = join(BUILD_ROOT, 'runtime')
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(join(runtimeDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-tauri-runtime',
    version: '0.0.0',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': version,
    },
  }, undefined, 2)}\n`)
  // This file also makes the directory its own pnpm workspace root, so the
  // install never sees the repository workspace above it. A hoisted linker
  // keeps node_modules free of symlinks for installer resources, and the
  // allowed builds mirror the repository's reviewed native-dep scripts.
  writeFileSync(join(runtimeDir, 'pnpm-workspace.yaml'), [
    '# Isolated staging workspace for the Tauri bundled runtime.',
    'nodeLinker: hoisted',
    'allowBuilds:',
    '  node-pty: true',
    '  koffi: true',
    "  '@deepseek-ai/dsh-subprocess-local': true",
    '  node-addon-require-builtin: false',
    '  protobufjs: false',
    '  msgpackr-extract: false',
    "  '@google/genai': false",
    '',
  ].join('\n'))
  const install = spawnSync('pnpm', ['install', '--prod'], {
    cwd: runtimeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (install.status !== 0) throw new Error('prepare-runtime: pnpm install of the dsh runtime failed')
  const bin = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`prepare-runtime: @deepseek-ai/dsh@${version} installed without lib/bin.js`)
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('prepare-runtime: the installer target is win-x64 only for now')
  }
  const version = resolveDshVersion()
  const releaseRoot = process.env.DSH_TAURI_NODE_MIRROR?.trim() || DEFAULT_RELEASE_ROOT
  await prepareNode(releaseRoot)
  prepareDshRuntime(version)
  process.stdout.write(`prepare-runtime: staged Node.js ${NODE_VERSION} and @deepseek-ai/dsh@${version} under ${BUILD_ROOT}\n`)
}

await main()
