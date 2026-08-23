#!/usr/bin/env node
// Turns Natural Earth's 1:50m country polygons into WorldData.js, the vendored
// dataset Omamap draws.
//
//   node tools/build-data.mjs            regenerate from the committed source
//   node tools/build-data.mjs --fetch    re-download from the pinned URL first
//   node tools/build-data.mjs --check    validate only, write nothing
//
// No dependencies, by design — the TopoJSON-free GeoJSON walk, the Equal Earth
// projection, the Visvalingam simplifier and every check below are code in this
// repo, so there is nothing in the pipeline to compromise but the source file
// itself. That file is committed, checksummed, and only ever handed to
// JSON.parse. See tools/source/SOURCE.md.

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = join(ROOT, "tools/source/ne_50m_admin_0_countries.geojson")
const OUTPUT = join(ROOT, "WorldData.js")

const PIN = {
  tag: "v5.1.2",
  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson",
  sha256: "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
}

// ---------------------------------------------------------------- parameters

// The map is Style.space(560) wide at zoom 1 and stops at 8x, so the deepest
// zoom is ~4480px across. A 4000-unit grid is therefore about one screen pixel
// per unit at maximum zoom: the dataset carries exactly the precision the
// deepest zoom can show, and not one point more.
const GRID = 4000
const MAX_ZOOM = 8

// Effective-area threshold for Visvalingam, in grid units squared. Just under
// a pixel at full zoom, which is where detail stops being visible.
const SIMPLIFY_EPSILON = 1.5

// Islands below this drop out entirely — with the exception of a country's
// largest ring, which is always kept so nothing can be simplified out of
// existence. An archipelago nation keeps its main island no matter how small.
const MIN_RING_AREA = 3

// Antarctica is not a country, and carrying it drags the Equal Earth frame down
// into a band of white nothing can be done with. The rest are uninhabited or
// purely administrative — nobody's travel destination, and each one costs a
// clickable target that would only ever be noise.
const EXCLUDE = new Set(["ATA", "ATF", "HMD", "SGS", "KAS"])

// The 195: 193 UN member states plus the two permanent observers, the Holy See
// and Palestine. This is the one table that has to be written by hand, because
// it is a political fact rather than a geographic one — everything else in this
// file is read out of the source data.
const UN195 = `
AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN
BOL BIH BWA BRA BRN BGR BFA BDI CPV KHM CMR CAN CAF TCD CHL CHN COL COM COG COD
CRI CIV HRV CUB CYP CZE DNK DJI DMA DOM ECU EGY SLV GNQ ERI EST SWZ ETH FJI FIN
FRA GAB GMB GEO DEU GHA GRC GRD GTM GIN GNB GUY HTI HND HUN ISL IND IDN IRN IRQ
IRL ISR ITA JAM JPN JOR KAZ KEN KIR PRK KOR KWT KGZ LAO LVA LBN LSO LBR LBY LIE
LTU LUX MDG MWI MYS MDV MLI MLT MHL MRT MUS MEX FSM MDA MCO MNG MNE MAR MOZ MMR
NAM NRU NPL NLD NZL NIC NER NGA MKD NOR OMN PAK PLW PAN PNG PRY PER PHL POL PRT
QAT ROU RUS RWA KNA LCA VCT WSM SMR STP SAU SEN SRB SYC SLE SGP SVK SVN SLB SOM
ZAF SSD ESP LKA SDN SUR SWE CHE SYR TJK THA TLS TGO TON TTO TUN TUR TKM TUV UGA
UKR ARE GBR TZA USA URY UZB VUT VEN VNM YEM ZMB ZWE VAT PSE
`.trim().split(/\s+/)

// ------------------------------------------------------------- Equal Earth
//
// Šavrič, Patterson & Jenny (2018). Equal-area, which is the whole point: on
// this map a country's size on screen is proportional to its size on Earth, so
// "how much of the world have I seen" is asked and answered honestly — and it
// is what makes the land-area check further down meaningful.

const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796
const SQRT3 = Math.sqrt(3)

function project(lon, lat) {
  const l = (lon * Math.PI) / 180
  const p = (lat * Math.PI) / 180
  const th = Math.asin((SQRT3 / 2) * Math.sin(p))
  const t2 = th * th
  const t6 = t2 * t2 * t2
  return [
    (2 * SQRT3 * l * Math.cos(th)) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1)),
    A4 * th * t6 * t2 + A3 * th * t6 + A2 * th * t2 + A1 * th,
  ]
}

// Half-width of the full frame, at lon 180 on the equator. Taken from the
// formula rather than from the data, so the map is centred on the meridian
// instead of on whatever land happens to reach furthest east.
const X_HALF = project(180, 0)[0]

// ------------------------------------------------------------------ geometry

function ringArea(r) {
  let a = 0
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2)
    a += r[j] * r[i + 1] - r[i] * r[j + 1]
  return Math.abs(a / 2)
}

function pointInRings(rings, x, y) {
  let inside = false
  for (const r of rings)
    for (let a = 0, b = r.length - 2; a < r.length; b = a, a += 2) {
      const ax = r[a], ay = r[a + 1], bx = r[b], by = r[b + 1]
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    }
  return inside
}

// A point guaranteed to be inside a polygon, for countries where a centroid
// would fall in the sea — Norway, Croatia, the Philippines, anything crescent
// shaped or strung out across water. Sweeps a few horizontal lines, keeps the
// widest span that is actually inside, and takes its midpoint. Cheap, and it
// cannot return a point outside the shape the way a centroid can.
function interiorPoint(rings) {
  const outer = rings[0]
  let y0 = Infinity, y1 = -Infinity
  for (let i = 1; i < outer.length; i += 2) {
    if (outer[i] < y0) y0 = outer[i]
    if (outer[i] > y1) y1 = outer[i]
  }
  let best = null, bestWidth = -1
  const steps = 21
  for (let s = 1; s < steps; s++) {
    const y = y0 + ((y1 - y0) * s) / steps
    const xs = []
    for (const r of rings)
      for (let a = 0, b = r.length - 2; a < r.length; b = a, a += 2) {
        const ax = r[a], ay = r[a + 1], bx = r[b], by = r[b + 1]
        if ((ay > y) !== (by > y)) xs.push(((bx - ax) * (y - ay)) / (by - ay) + ax)
      }
    xs.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1] - xs[i]
      const mid = (xs[i] + xs[i + 1]) / 2
      if (width > bestWidth && pointInRings(rings, mid, y)) { bestWidth = width; best = [Math.round(mid), Math.round(y)] }
    }
  }
  return best
}

function triArea(ax, ay, bx, by, cx, cy) {
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
}

// Visvalingam-Whyatt, written out rather than imported. Repeatedly discards the
// point whose triangle with its two neighbours is smallest, which is to say the
// point that changes the country's area least — the property that keeps the
// land-area check below honest through simplification.
//
// A binary heap with lazy deletion keeps it near O(n log n); the naive rescan
// is O(n^2) and Russia alone would make that felt. Endpoints are pinned, so a
// closed ring keeps its seam.
function simplify(flat, eps) {
  const n = flat.length / 2
  if (n < 6) return flat

  const prev = new Int32Array(n)
  const next = new Int32Array(n)
  const area = new Float64Array(n)
  const stamp = new Int32Array(n)
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1 }

  const heap = []
  const push = (item) => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p].a <= heap[i].a) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < heap.length && heap[l].a < heap[m].a) m = l
        if (r < heap.length && heap[r].a < heap[m].a) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  const areaAt = (i) => triArea(
    flat[2 * prev[i]], flat[2 * prev[i] + 1],
    flat[2 * i], flat[2 * i + 1],
    flat[2 * next[i]], flat[2 * next[i] + 1],
  )

  for (let i = 1; i < n - 1; i++) {
    area[i] = areaAt(i)
    push({ i, a: area[i], s: 0 })
  }

  let live = n
  while (heap.length && live > 5) {
    const top = pop()
    if (top.s !== stamp[top.i]) continue      // superseded by a later update
    if (top.a >= eps) break                   // the heap is sorted: nothing smaller remains
    const i = top.i
    next[prev[i]] = next[i]
    prev[next[i]] = prev[i]
    live--
    for (const j of [prev[i], next[i]]) {
      if (j <= 0 || j >= n - 1) continue
      // Never let a recomputed area fall below the one just removed. Without
      // this, a point can become "cheap" only because its neighbour went, and
      // simplification eats through detail it already decided to keep.
      area[j] = Math.max(areaAt(j), top.a)
      stamp[j]++
      push({ i: j, a: area[j], s: stamp[j] })
    }
  }

  const out = []
  for (let i = 0; i !== n - 1; i = next[i]) out.push(flat[2 * i], flat[2 * i + 1])
  out.push(flat[2 * (n - 1)], flat[2 * (n - 1) + 1])
  return out
}

// ------------------------------------------------------------------ pipeline

function sha256(buf) { return createHash("sha256").update(buf).digest("hex") }

async function fetchSource() {
  process.stdout.write(`fetching ${PIN.url}\n`)
  const res = await fetch(PIN.url)
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== PIN.sha256)
    throw new Error(`checksum mismatch\n  expected ${PIN.sha256}\n  got      ${got}\nrefusing to write`)
  writeFileSync(SOURCE, buf)
  process.stdout.write(`  ok, ${buf.length} bytes, sha256 verified\n`)
}

// ISO_A3 is "-99" for Norway and France — a long-standing Natural Earth quirk
// that silently drops two countries if you trust it. ISO_A3_EH fixes those;
// ADM0_A3 covers the entities that have no ISO code at all (Kosovo, Northern
// Cyprus, Somaliland).
function codeOf(p) {
  for (const key of ["ISO_A3_EH", "ISO_A3", "ADM0_A3"]) {
    const v = p[key]
    if (v && v !== "-99") return v
  }
  return null
}

function collect(geojson) {
  const byCode = new Map()
  for (const feature of geojson.features) {
    const p = feature.properties
    const code = codeOf(p)
    if (!code || EXCLUDE.has(code)) continue
    if (!feature.geometry) continue

    let entry = byCode.get(code)
    if (!entry) {
      entry = {
        c: code,
        n: p.NAME || p.ADMIN || code,
        // SOVEREIGNT differs from ADMIN exactly when the entity is administered
        // by someone else, so the whole territory -> sovereign mapping falls out
        // of the file. That is what lets a tooltip read "Greenland · Denmark"
        // without a hand-written table of dependencies.
        sov: p.SOVEREIGNT && p.SOVEREIGNT !== p.ADMIN ? p.SOVEREIGNT : null,
        // Natural Earth's own cartographer-placed label anchor. Better than any
        // centroid — a centroid puts Norway's dot in Sweden.
        label: Number.isFinite(p.LABEL_X) && Number.isFinite(p.LABEL_Y) ? [p.LABEL_X, p.LABEL_Y] : null,
        polygons: [],
      }
      byCode.set(code, entry)
    }
    const g = feature.geometry
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
    for (const poly of polys) entry.polygons.push(poly)
  }
  return byCode
}

function build() {
  const raw = readFileSync(SOURCE)
  const got = sha256(raw)
  if (got !== PIN.sha256)
    throw new Error(`source checksum mismatch\n  expected ${PIN.sha256}\n  got      ${got}\n` +
                    `The vendored source has been modified. Restore it from git, or re-fetch\n` +
                    `with --fetch to compare against ${PIN.tag} upstream.`)

  const geojson = JSON.parse(raw.toString("utf8"))
  if (geojson.type !== "FeatureCollection") throw new Error("source is not a FeatureCollection")
  const byCode = collect(geojson)

  // Project everything first, so the vertical extent can be fitted to the land
  // that actually survives rather than to the poles.
  let yMin = Infinity, yMax = -Infinity
  for (const e of byCode.values())
    for (const poly of e.polygons)
      for (const ring of poly)
        for (const [lon, lat] of ring) {
          const y = project(lon, lat)[1]
          if (y < yMin) yMin = y
          if (y > yMax) yMax = y
        }

  // x spans the full theoretical frame; y uses the same scale so area is
  // preserved, offset so the northernmost land sits at 0.
  const k = GRID / (2 * X_HALF)
  const qx = (x) => Math.round((x + X_HALF) * k)
  const qy = (y) => Math.round((yMax - y) * k)
  const height = Math.round((yMax - yMin) * k)
  const aspect = GRID / height

  const un = new Set(UN195)
  const countries = []
  let ringsIn = 0, ringsOut = 0, ptsIn = 0, ptsOut = 0

  for (const e of [...byCode.values()].sort((a, b) => a.c.localeCompare(b.c))) {
    const polygons = []
    for (const poly of e.polygons) {
      const rings = []
      for (const ring of poly) {
        ringsIn++
        ptsIn += ring.length
        const flat = []
        let lx = NaN, ly = NaN
        for (const [lon, lat] of ring) {
          const [x, y] = project(lon, lat)
          const gx = qx(x), gy = qy(y)
          if (gx === lx && gy === ly) continue     // collapsed by quantisation
          flat.push(gx, gy)
          lx = gx; ly = gy
        }
        if (flat.length < 8) continue
        rings.push(simplify(flat, SIMPLIFY_EPSILON))
      }
      if (rings.length) polygons.push(rings)
    }
    // Cull specks, but never the biggest ring: an archipelago keeps its main
    // island however small, so no country can vanish from the map.
    let biggest = 0
    for (const poly of polygons) biggest = Math.max(biggest, ringArea(poly[0]))
    const kept = []
    for (const poly of polygons) {
      const outerArea = ringArea(poly[0])
      if (outerArea < MIN_RING_AREA && outerArea < biggest) continue
      kept.push(poly.filter((ring, i) => i === 0 || ringArea(ring) >= MIN_RING_AREA))
    }

    // Per-polygon bounds, not just one box for the whole country. New Zealand,
    // Russia, the USA, Fiji and Kiribati all have polygons on both sides of the
    // antimeridian, so a single country-wide box spans the entire map and
    // prefilters nothing — every pointer move would then run a full
    // point-in-polygon test against New Zealand.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0
    let widest = 0
    const bounds = []
    for (const poly of kept) {
      let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity
      for (let i = 0; i < poly.length; i++) {
        const ring = poly[i]
        ringsOut++
        ptsOut += ring.length / 2
        area += i === 0 ? ringArea(ring) : -ringArea(ring)
        for (let j = 0; j < ring.length; j += 2) {
          if (ring[j] < px0) px0 = ring[j]
          if (ring[j] > px1) px1 = ring[j]
          if (ring[j + 1] < py0) py0 = ring[j + 1]
          if (ring[j + 1] > py1) py1 = ring[j + 1]
        }
      }
      bounds.push([px0, py0, px1, py1])
      widest = Math.max(widest, Math.hypot(px1 - px0, py1 - py0))
      x0 = Math.min(x0, px0); y0 = Math.min(y0, py0)
      x1 = Math.max(x1, px1); y1 = Math.max(y1, py1)
    }

    // Vatican City, Monaco and Tuvalu are smaller than one grid unit — below
    // the precision the deepest zoom can resolve, so there is no outline to
    // draw at any zoom. They ship as dot-only entries and the map's automatic
    // dots make them clickable exactly like every other small country.
    const dotOnly = !kept.length || Math.round(area) < 1

    // Natural Earth's label anchor is the first choice — a cartographer placed
    // it, and it beats any centroid for a country like Norway. But it is placed
    // to hang a *label* on, and for island groups that means out at sea, which
    // would put São Tomé's dot in the Atlantic and New Zealand's in Cook
    // Strait. So it is used only when it actually lands on the country.
    let label = e.label
      ? [qx(project(e.label[0], e.label[1])[0]), qy(project(e.label[0], e.label[1])[1])]
      : null
    if (!dotOnly) {
      const onLand = label && kept.some((poly) => pointInRings(poly, label[0], label[1]))
      if (!onLand) {
        let widest = null, widestArea = -1
        for (const poly of kept) {
          const a = ringArea(poly[0])
          if (a > widestArea) { widestArea = a; widest = poly }
        }
        label = interiorPoint(widest) || label
      }
    }
    if (!label) throw new Error(`${e.c} has neither usable geometry nor a label anchor`)

    countries.push({
      c: e.c,
      n: e.n,
      un: un.has(e.c),
      sov: un.has(e.c) ? null : e.sov,
      p: dotOnly ? [] : kept,
      pb: dotOnly ? [] : bounds,
      b: dotOnly ? [label[0], label[1], label[0], label[1]] : [x0, y0, x1, y1],
      // The diagonal of the *largest* landmass, which is what decides whether a
      // country is big enough to draw as an outline. Measuring the whole
      // country would call New Zealand map-wide and the Maldives invisible.
      d: dotOnly ? 0 : Math.round(widest),
      r: label,
      a: dotOnly ? 0 : Math.round(area),
    })
  }

  // St-Martin and Sint Maarten share one small island and round to the same
  // grid point, which would leave whichever lost the tie permanently
  // unclickable. Nudging is enough: they are drawn as dots at every zoom, and a
  // grid unit apart is a pixel apart at the zoom where anyone would try.
  const anchors = new Map()
  for (const c of countries) {
    let key = c.r.join(",")
    let nudge = 0
    while (anchors.has(key)) {
      nudge++
      c.r = [c.r[0] + nudge, c.r[1] + (nudge % 2 ? 1 : -1)]
      key = c.r.join(",")
    }
    if (nudge) process.stdout.write(`note      ${c.c} shares an anchor with ${anchors.get(`${c.r[0] - nudge},${c.r[1] - (nudge % 2 ? 1 : -1)}`)}, nudged ${nudge}\n`)
    anchors.set(key, c.c)
  }

  return { countries, aspect, height, k, yMax, stats: { ringsIn, ringsOut, ptsIn, ptsOut } }
}

// ---------------------------------------------------------------- validation
//
// The source is trusted for nothing. A checksum only proves the file is the one
// that was fetched, so these check the geometry itself means what it should.
// Wrong coordinates are the only payload a JSON coordinate file can carry, and
// they would have to survive every one of these.

const EARTH_RADIUS_KM = 6371.0088
// Land excluding Antarctica, and excluding the inland seas and great lakes that
// Natural Earth cuts out of its country polygons.
const EXPECTED_LAND_KM2 = 134_000_000
const LAND_TOLERANCE = 0.03

// The nine largest, as a set. Order is deliberately not asserted, and the tenth
// place is deliberately left out: China and the USA swap depending on whether
// inland water counts, and Algeria and DR Congo land 0.4% apart here, so either
// check would be a tripwire on nothing. Ninth to tenth is a 16% gap, which is a
// real invariant.
const LARGEST_NINE = ["RUS", "CAN", "CHN", "USA", "BRA", "AUS", "IND", "ARG", "KAZ"]

// Spot checks spanning four orders of magnitude, so an error in the projection,
// the scale or a single country's geometry has nowhere to hide. Deliberately
// picks countries Natural Earth does not lump together with anything — FRA, for
// instance, carries the overseas departments and would not mean what it looks
// like it means. Tolerance is wide enough for simplification and for the inland
// water Natural Earth cuts out, and far too tight for tampering.
const AREA_SPOT_CHECKS = {
  RUS: 17_098_246,
  BRA: 8_515_767,
  IND: 3_287_263,
  DEU: 357_022,
  JPN: 377_975,
  ISL: 103_000,
  LUX: 2_586,
}
const AREA_TOLERANCE = 0.12

function validate({ countries, k }) {
  const problems = []
  const check = (ok, msg) => { if (!ok) problems.push(msg) }

  const seen = new Set()
  for (const c of countries) {
    check(!seen.has(c.c), `duplicate code ${c.c}`)
    seen.add(c.c)
    check(/^[A-Z]{3}$/.test(c.c), `malformed code ${c.c}`)
    // A country with no rings is dot-only: smaller than one grid unit, so there
    // is no outline to draw at any zoom. It must still have somewhere to put
    // its dot.
    check(c.p.length > 0 || (c.r && Number.isFinite(c.r[0])), `${c.c} has neither geometry nor a dot`)
    check(c.p.length ? c.a > 0 : c.a === 0, `${c.c} has an inconsistent area ${c.a}`)
    for (const poly of c.p) for (const ring of poly) {
      check(ring.length >= 8 && ring.length % 2 === 0, `${c.c} has a malformed ring`)
      for (const v of ring) check(Number.isInteger(v), `${c.c} has a non-integer coordinate`)
    }
    check(c.b[0] >= 0 && c.b[2] <= GRID && c.b[1] >= 0, `${c.c} bbox outside the frame`)
    check(c.r[0] >= 0 && c.r[0] <= GRID, `${c.c} label anchor outside the frame`)
  }

  const members = countries.filter((c) => c.un).map((c) => c.c)
  check(members.length === 195, `expected 195 UN countries, got ${members.length}`)
  for (const code of UN195) check(seen.has(code), `UN member ${code} is missing from the map`)
  check(new Set(UN195).size === 195, `the UN195 table itself is not 195 unique codes`)
  for (const c of countries) check(!(c.un && c.sov), `${c.c} is both a UN member and a dependency`)

  // Equal-area projection, so projected area maps to real area by a constant.
  const perUnit = (EARTH_RADIUS_KM * EARTH_RADIUS_KM) / (k * k)
  const landKm2 = countries.reduce((sum, c) => sum + c.a, 0) * perUnit
  const drift = Math.abs(landKm2 - EXPECTED_LAND_KM2) / EXPECTED_LAND_KM2
  check(drift <= LAND_TOLERANCE,
    `total land area ${(landKm2 / 1e6).toFixed(2)}M km² is ${(drift * 100).toFixed(1)}% off ` +
    `the expected ${(EXPECTED_LAND_KM2 / 1e6).toFixed(2)}M km²`)

  const ranked = [...countries].sort((a, b) => b.a - a.a)
  const biggest = ranked.slice(0, 9).map((c) => c.c)
  check([...biggest].sort().join(" ") === [...LARGEST_NINE].sort().join(" "),
    `the nine largest countries came out as ${biggest.join(" ")}, expected the set ${LARGEST_NINE.join(" ")}`)
  check(biggest[0] === "RUS", `the largest country came out as ${biggest[0]}, expected RUS`)

  for (const [code, km2] of Object.entries(AREA_SPOT_CHECKS)) {
    const c = countries.find((x) => x.c === code)
    if (!c) { check(false, `spot check ${code} is missing`); continue }
    const got = c.a * perUnit
    const off = Math.abs(got - km2) / km2
    check(off <= AREA_TOLERANCE,
      `${code} came out at ${Math.round(got).toLocaleString("en")} km², ` +
      `${(off * 100).toFixed(1)}% off the expected ${km2.toLocaleString("en")} km²`)
  }

  return { problems, landKm2, biggest }
}

// -------------------------------------------------------------------- output

function emit({ countries, aspect, yMax, k }) {
  const lines = []
  lines.push("// Generated by tools/build-data.mjs — do not edit by hand.")
  lines.push("//")
  lines.push("// Natural Earth 1:50m Admin 0 Countries, public domain, vendored and checksummed")
  lines.push("// in tools/source/. Projected with Equal Earth onto a " + GRID + "-unit grid, then")
  lines.push("// simplified to the precision " + MAX_ZOOM + "x zoom can actually show.")
  lines.push("//")
  lines.push("//   c    ISO 3166-1 alpha-3 (or Natural Earth's ADM0_A3 where no ISO code exists)")
  lines.push("//   n    display name")
  lines.push("//   un   true for the 195: 193 UN members plus the Holy See and Palestine")
  lines.push("//   sov  administering state, for dependencies and territories only")
  lines.push("//   p    polygons: [ [outerRing, ...holes], ... ], each ring a flat [x,y,x,y,...]")
  lines.push("//   pb   per-polygon bounding boxes, parallel to p — the hit-test prefilter")
  lines.push("//   b    bounding box of the whole country [x0, y0, x1, y1]")
  lines.push("//   d    diagonal of the largest landmass; under a few pixels, draw a dot instead")
  lines.push("//   r    label anchor [x, y] — where the dot goes when the outline is too small")
  lines.push("//   a    projected area in grid units, used to order hit-testing so enclaves win")
  lines.push(".pragma library")
  lines.push("")
  lines.push(`var GRID = ${GRID}`)
  lines.push(`var ASPECT = ${aspect.toFixed(6)}`)
  lines.push(`var UN_TOTAL = 195`)
  lines.push("")
  lines.push("// Enough of the projection to turn a longitude and latitude into map")
  lines.push("// coordinates, so the dataset is self-describing: Model.project() uses it, and")
  lines.push("// so do the tests, instead of keeping a second copy of the maths in step.")
  lines.push(`var FRAME = { xHalf: ${X_HALF}, yMax: ${yMax}, k: ${k} }`)
  lines.push("")
  lines.push("var COUNTRIES = [")
  for (const c of countries) {
    const head = `{ c: ${JSON.stringify(c.c)}, n: ${JSON.stringify(c.n)}, un: ${c.un}` +
      (c.sov ? `, sov: ${JSON.stringify(c.sov)}` : "") +
      `, b: [${c.b.join(",")}], d: ${c.d}, r: [${c.r.join(",")}], a: ${c.a},`
    lines.push("  " + head)
    lines.push("    pb: [" + c.pb.map((b) => "[" + b.join(",") + "]").join(",") + "],")
    lines.push("    p: [" + c.p.map((poly) => "[" + poly.map((r) => "[" + r.join(",") + "]").join(",") + "]").join(",") + "] },")
  }
  lines.push("]")
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------- main

const args = new Set(process.argv.slice(2))
if (args.has("--fetch")) await fetchSource()

const result = build()
const { problems, landKm2, biggest } = validate(result)

const s = result.stats
process.stdout.write([
  `source    ${PIN.tag}, sha256 verified`,
  `grid      ${GRID} x ${result.height}  (aspect ${result.aspect.toFixed(3)})`,
  `rings     ${s.ringsIn} in -> ${s.ringsOut} out`,
  `points    ${s.ptsIn} in -> ${s.ptsOut} out  (${((1 - s.ptsOut / s.ptsIn) * 100).toFixed(1)}% dropped)`,
  `countries ${result.countries.length}  (${result.countries.filter((c) => c.un).length} UN, ` +
    `${result.countries.filter((c) => !c.un).length} territories)`,
  `land      ${(landKm2 / 1e6).toFixed(2)}M km²`,
  `largest   ${biggest.join(" ")}`,
  "",
].join("\n"))

if (problems.length) {
  process.stderr.write("VALIDATION FAILED — nothing written\n")
  for (const p of problems.slice(0, 20)) process.stderr.write(`  - ${p}\n`)
  if (problems.length > 20) process.stderr.write(`  ... and ${problems.length - 20} more\n`)
  process.exit(1)
}

if (args.has("--check")) {
  process.stdout.write("validation passed (--check: nothing written)\n")
} else {
  const text = emit(result)
  writeFileSync(OUTPUT, text)
  process.stdout.write(`wrote ${OUTPUT}  (${(text.length / 1024).toFixed(0)} KB)\n`)
}
