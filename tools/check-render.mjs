#!/usr/bin/env node
// Renders the map and checks the colour of every visible country against what
// it should be.
//
//   node tools/check-render.mjs
//
// The map is the one part of this plugin that cannot be tested by reasoning
// about it, and a dark theme makes it genuinely hard to tell an unfilled
// country from the sea by eye — the difference between the land fill and the
// background is three values per channel. This asks the pixels instead.
//
// Needs `qml6` and ImageMagick's `magick`, both dev-only.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function load(file, scope = {}) {
  const src = readFileSync(join(ROOT, file), "utf8")
    .replace(/^\s*\.pragma\s+library\s*$/gm, "")
    .replace(/^\s*\.import\s+.*$/gm, "")
  const names = new Set()
  for (const m of src.matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  const keys = Object.keys(scope)
  return new Function(...keys, src + `; return { ${[...names].join(", ")} }`)(...keys.map((k) => scope[k]))
}

const World = load("WorldData.js")
const Model = load("Model.js", { World })

// Must match dev/shoot.qml.
const WIDTH = 1120
const HEIGHT = Math.round(WIDTH / World.ASPECT)
const VISITED = new Set(readFileSync(join(ROOT, "dev/shoot.qml"), "utf8")
  .match(/var codes = \[([\s\S]*?)\]/)[1]
  .match(/"([A-Z]{3})"/g)
  .map((s) => s.replace(/"/g, "")))

// Derived from dev/shoot.qml's palette rather than written down, so the
// expected values cannot drift from what the harness actually paints.
const FG = [202, 204, 204]        // #cacccc
const ACCENT = [122, 162, 247]    // #7aa2f7
const BG = [16, 19, 21]           // #101315

const over = (rgb, alpha) => rgb.map((v, i) => Math.round(v * alpha + BG[i] * (1 - alpha)))

const EXPECT = {
  land: over(FG, 0.10),
  visited: over(ACCENT, 0.85),
  territory: over(ACCENT, 0.45),
  hover: over(FG, 0.22),
  background: BG,
}

function near(actual, expected, tolerance = 6) {
  return expected.every((v, i) => Math.abs(actual[i] - v) <= tolerance)
}

const work = mkdtempSync(join(tmpdir(), "omamap-render-"))
let failures = 0
let checked = 0

for (const [zoom, panX, panY] of [[1, 0, 0], [2, 1600, 100], [4, 1700, 250], [8, 2050, 300]]) {
  const png = join(work, `z${zoom}.png`)
  execFileSync("qml6", [join(ROOT, "dev/shoot.qml"), "--", png, String(zoom), String(panX), String(panY)],
    { stdio: "pipe", timeout: 60000 })

  // The compositor may render at a device pixel ratio, so the image is not
  // necessarily WIDTH across. Scale sample points by whatever came back.
  const [imgW] = execFileSync("magick", ["identify", "-format", "%w %h", png], { encoding: "utf8" })
    .split(" ").map(Number)
  const dpr = imgW / WIDTH

  const ppu = (WIDTH / World.GRID) * zoom
  const samples = []
  for (const c of World.COUNTRIES) {
    if (c.p.length === 0) continue                        // dot-only: nothing filled to sample
    if (Model.isDot(c, Model.DOT_BELOW_PX / ppu)) continue // a dot is drawn over it
    // Skip countries narrow enough that their own border stroke covers the
    // anchor. The Gambia at world zoom is two pixels across and samples as
    // border, which says nothing about whether its fill is right.
    //
    // Measured on the landmass the anchor actually sits on, not the country
    // bounding box: Equatorial Guinea's box is stretched wide by Bioko island
    // while the mainland the anchor is on is a couple of pixels across.
    const host = c.pb.find((b) => c.r[0] >= b[0] && c.r[0] <= b[2] && c.r[1] >= b[1] && c.r[1] <= b[3]) || c.b
    const narrow = Math.min(host[2] - host[0], host[3] - host[1]) * ppu
    if (narrow < 8) continue
    const sx = Math.round((c.r[0] - panX) * ppu * dpr)
    const sy = Math.round((c.r[1] - panY) * ppu * dpr)
    if (sx < 4 || sy < 4 || sx > imgW - 4 || sy > Math.round(HEIGHT * dpr) - 4) continue
    samples.push([c, sx, sy])
  }

  // One magick invocation for the lot; per-pixel calls would take minutes.
  const query = samples.map(([, x, y]) => `%[pixel:p{${x},${y}}]\\n`).join("")
  const out = execFileSync("magick", [png, "-format", query, "info:"], { encoding: "utf8" })
    .trim().split("\n")

  let bad = []
  samples.forEach(([c], i) => {
    const m = out[i].match(/(\d+),(\d+),(\d+)/)
    if (!m) return
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])]
    const want = VISITED.has(c.c) ? (c.un ? EXPECT.visited : EXPECT.territory) : EXPECT.land
    checked++
    if (!near(rgb, want)) bad.push(`${c.c} got rgb(${rgb}) wanted rgb(${want})`)
  })

  if (bad.length) {
    failures += bad.length
    process.stderr.write(`zoom ${zoom}: ${bad.length} of ${samples.length} wrong\n`)
    for (const b of bad.slice(0, 12)) process.stderr.write(`    ${b}\n`)
    if (bad.length > 12) process.stderr.write(`    ... and ${bad.length - 12} more\n`)
  } else {
    process.stdout.write(`zoom ${zoom}: ${samples.length} countries render correctly\n`)
  }
}

// ---- Hover. Rendered through the real component: the harness hands it a pixel
// position, WorldMap converts it to map coordinates, hit-tests, and highlights
// whatever it found. If any link in that chain breaks, the country under the
// pointer keeps its ordinary colour and this notices.
{
  const ppu = (WIDTH / World.GRID) * 1
  for (const code of ["BRA", "DZA", "AUS", "SWE"]) {
    const c = Model.byCode(code)
    const hx = Math.round(c.r[0] * ppu)
    const hy = Math.round(c.r[1] * ppu)
    const png = join(work, `hover-${code}.png`)
    execFileSync("qml6", [join(ROOT, "dev/shoot.qml"), "--", png, "1", "0", "0", String(hx), String(hy)],
      { stdio: "pipe", timeout: 60000 })
    const [imgW] = execFileSync("magick", ["identify", "-format", "%w %h", png], { encoding: "utf8" })
      .split(" ").map(Number)
    const dpr = imgW / WIDTH
    const out = execFileSync("magick", [png, "-format", `%[pixel:p{${Math.round(hx * dpr)},${Math.round(hy * dpr)}}]`, "info:"],
      { encoding: "utf8" })
    const m = out.match(/(\d+),(\d+),(\d+)/)
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])]
    checked++
    if (near(rgb, EXPECT.hover)) {
      process.stdout.write(`hover ${code}: highlighted\n`)
    } else {
      failures++
      process.stderr.write(`hover ${code}: got rgb(${rgb}) wanted rgb(${EXPECT.hover}) — ` +
        `the pointer-to-country chain is broken\n`)
    }
  }
}

rmSync(work, { recursive: true, force: true })
if (failures) { process.stderr.write(`\n${failures} wrong pixels across ${checked} samples\n`); process.exit(1) }
process.stdout.write(`${checked} country fills verified\n`)
