#!/usr/bin/env node
// Runs the real Model.js and the real WorldData.js under plain node.
//
//   node tools/test-model.mjs
//
// Both files are QML JS resources, which means two lines node cannot parse:
// `.pragma library` and `.import`. Stripping exactly those and evaluating the
// rest is what lets the shipped code — not a copy of it — be tested here.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function load(file, scope = {}) {
  const src = readFileSync(join(ROOT, file), "utf8")
    .replace(/^\s*\.pragma\s+library\s*$/gm, "")
    .replace(/^\s*\.import\s+.*$/gm, "")
  const names = Object.keys(scope)
  const exported = `; return { ${collectNames(src).join(", ")} }`
  return new Function(...names, src + exported)(...names.map((n) => scope[n]))
}

// Everything declared at the top level of the file, so the harness exports the
// same surface QML sees rather than a hand-maintained list that drifts.
function collectNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  return [...names]
}

const World = load("WorldData.js")
const Model = load("Model.js", { World })

// ------------------------------------------------------------------ harness

let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) { passed++; return }
  failures.push(detail ? `${name}\n      ${detail}` : name)
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// The panel's own numbers, so the thresholds under test are the ones that ship.
const MAP_WIDTH_PX = 560
const MAX_ZOOM = 8

// Where a city is on the map, so the tests can ask questions in the units a
// person thinks in.
function at(lon, lat) {
  const [x, y] = Model.project(lon, lat)
  return Model.hitTest(x, y, 0)
}

function codeAt(lon, lat) {
  const hit = at(lon, lat)
  return hit ? hit.c : null
}

// -------------------------------------------------------------- the dataset

const members = World.COUNTRIES.filter((c) => c.un)
eq("exactly 195 UN countries", members.length, 195)
eq("UN_TOTAL agrees", World.UN_TOTAL, 195)

const codes = World.COUNTRIES.map((c) => c.c)
eq("codes are unique", new Set(codes).size, codes.length)
ok("every code is three uppercase letters", codes.every((c) => /^[A-Z]{3}$/.test(c)))
ok("no country is both a UN member and a dependency",
  World.COUNTRIES.every((c) => !(c.un && c.sov)),
  World.COUNTRIES.filter((c) => c.un && c.sov).map((c) => c.c).join(" "))
ok("every country has geometry or a dot anchor",
  World.COUNTRIES.every((c) => c.p.length > 0 || Number.isFinite(c.r[0])))
ok("every ring is a closed, even-length coordinate list",
  World.COUNTRIES.every((c) => c.p.every((poly) => poly.every((r) => r.length >= 8 && r.length % 2 === 0))))
ok("no coordinate is outside the frame",
  World.COUNTRIES.every((c) => c.b[0] >= 0 && c.b[2] <= World.GRID && c.b[1] >= 0 && c.b[3] <= World.GRID / World.ASPECT + 1))

// The three the map cannot draw at any zoom, because they are smaller than one
// grid unit. They must still be reachable, which is what the dots are for.
for (const code of ["VAT", "MCO", "TUV"]) {
  const entry = Model.byCode(code)
  ok(`${code} exists`, !!entry)
  ok(`${code} is dot-only`, entry && entry.p.length === 0)
  ok(`${code} is one of the 195`, entry && entry.un)
}

// ------------------------------------------------------------- hit testing

eq("Stockholm is in Sweden", codeAt(18.07, 59.33), "SWE")
eq("Rome is in Italy", codeAt(12.5, 41.9), "ITA")
eq("Kaliningrad is in Russia", codeAt(20.51, 54.71), "RUS")
eq("Ushuaia is in Argentina", codeAt(-68.3, -54.8), "ARG")
eq("Anchorage is in the United States", codeAt(-149.9, 61.22), "USA")
eq("Nuuk is in Greenland", codeAt(-51.72, 64.18), "GRL")
eq("Perth is in Australia", codeAt(115.86, -31.95), "AUS")
eq("Cape Town is in South Africa", codeAt(18.42, -33.92), "ZAF")

// The enclave cases — the whole reason hit-testing walks smallest-area-first.
eq("Maseru is in Lesotho, not South Africa", codeAt(27.48, -29.31), "LSO")
eq("Mbabane is in Eswatini, not South Africa", codeAt(31.13, -26.32), "SWZ")
// Inland, not the capital: Banjul sits on the river mouth, and at this
// simplification the coastline moves by a few kilometres. Points within roughly
// 10 km of a coast can fall the wrong side of it — irrelevant for clicking a
// country, but it means a test has to aim inland to be asking about the enclave
// rather than about coastline detail.
eq("the Gambia is not Senegal", codeAt(-14.77, 13.53), "GMB")

// Ocean is not a country.
eq("the mid-Atlantic is nothing", codeAt(-30, 20), null)
eq("the South Pacific is nothing", codeAt(-140, -40), null)

// Territories resolve to themselves, not to the state that administers them.
eq("Puerto Rico is not the United States", codeAt(-66.5, 18.22), "PRI")
eq("Taipei is in Taiwan", codeAt(121.5, 25.03), "TWN")
eq("New Caledonia is not France", codeAt(165.8, -21.4), "NCL")
eq("Hong Kong is not China", codeAt(114.15, 22.35), "HKG")

// Dots. Below the threshold a country answers from its anchor, which is how the
// micro-states stay clickable at world zoom.
{
  const upp = Model.unitsPerPixel(MAP_WIDTH_PX, 1)
  const vat = Model.byCode("VAT")
  const hit = Model.hitTest(vat.r[0], vat.r[1], upp)
  eq("the Vatican answers as a dot, from inside Italy", hit && hit.c, "VAT")

  // A few pixels away it must give Italy back, or the dot would be a hole in
  // the map rather than a target on it.
  const nearby = Model.hitTest(vat.r[0] + 6 * upp, vat.r[1] + 6 * upp, upp)
  eq("just off the Vatican dot is Italy again", nearby && nearby.c, "ITA")

  // The bug this ordering exists to prevent: at world zoom a dot's reach is
  // hundreds of kilometres, and a naive nearest-dot-first would answer Denmark
  // for the middle of Sweden.
  const sweden = Model.byCode("SWE")
  const inland = Model.hitTest(sweden.r[0], sweden.r[1], upp)
  eq("the middle of Sweden is Sweden, not a neighbour's dot", inland && inland.c, "SWE")
}
{
  // With no dots enabled, a large country still answers from its outline.
  const hit = Model.hitTest(...Model.project(2.35, 48.86), 0)
  eq("Paris is in France with dots off", hit && hit.c, "FRA")
}

// Two checks on the label anchors, which between them would catch any error in
// the projection or the frame.
//
// Every anchor must sit inside its own country's bounding box. This holds
// regardless of coastline detail, so it can be asserted absolutely — and a
// projection that was off by so much as a degree would break it everywhere.
{
  const strays = World.COUNTRIES.filter((c) => {
    if (c.p.length === 0) return false
    const [x, y] = c.r
    return x < c.b[0] - 3 || x > c.b[2] + 3 || y < c.b[1] - 3 || y > c.b[3] + 3
  })
  ok("every label anchor sits inside its own country's bounds", strays.length === 0,
    strays.map((c) => c.c).join(" "))
}

// Every country that is ever drawn as an outline must be hit by its own anchor.
// This is what the generator's fallback to a guaranteed interior point buys: a
// dot is never drawn in the sea beside the country it stands for. Countries
// below the threshold are excluded here because they are never outlines at any
// zoom — they are covered by the reachability check below, which is stronger.
{
  const deepest = Model.unitsPerPixel(MAP_WIDTH_PX, MAX_ZOOM)
  const outlined = World.COUNTRIES.filter((c) => !Model.isDot(c, Model.DOT_BELOW_PX * deepest))
  const missed = outlined.filter((c) => {
    const hit = Model.hitTest(c.r[0], c.r[1], 0)
    return !hit || hit.c !== c.c
  })
  ok(`all ${outlined.length} outlined countries are hit by their own anchor`, missed.length === 0,
    missed.map((c) => `${c.c} -> ${(Model.hitTest(c.r[0], c.r[1], 0) || { c: "null" }).c}`).join(", "))
}

// The promise the dot mechanism exists to keep: at the zoom the panel opens on,
// every country too small to have a visible outline is still clickable, on its
// dot. Including the Vatican, Monaco and Tuvalu, which have no outline at any
// zoom at all.
//
// Note this is asserted for the dots specifically, not for every country at its
// anchor. On a 560px world map roughly a pixel is 60km, so the dot drawn for
// San Marino genuinely does sit on top of the middle of Italy — that is what
// the map shows, so it is also what a click there should mean. Zooming in is
// what separates them, which is the whole idea behind auto-dots.
{
  const upp = Model.unitsPerPixel(MAP_WIDTH_PX, 1)
  const dots = World.COUNTRIES.filter((c) => Model.isDot(c, Model.DOT_BELOW_PX * upp))
  const unreachable = dots.filter((c) => {
    const hit = Model.hitTest(c.r[0], c.r[1], upp)
    return !hit || hit.c !== c.c
  })
  ok(`all ${dots.length} countries drawn as dots at world zoom are clickable`,
    unreachable.length === 0, unreachable.map((c) => c.c).join(" "))
}

// And every country, dot or outline, is reachable once zoomed in — the fallback
// promise for anything a neighbour's dot obscures at world scale.
{
  const upp = Model.unitsPerPixel(MAP_WIDTH_PX, MAX_ZOOM)
  const unreachable = World.COUNTRIES.filter((c) => {
    const hit = Model.hitTest(c.r[0], c.r[1], upp)
    return !hit || hit.c !== c.c
  })
  ok(`all ${World.COUNTRIES.length} countries are reachable at full zoom`,
    unreachable.length === 0, unreachable.map((c) => c.c).join(" "))
}

// ------------------------------------------------------------------- scoring

{
  const visited = Model.toSet(["SWE", "NOR", "GRL", "PRI", "NOPE"])
  const s = Model.stats(visited)
  eq("unknown codes are dropped on load", Object.keys(visited).length, 4)
  eq("counts the UN members", s.countries, 2)
  eq("counts territories separately", s.territories, 2)
  eq("percent is of 195", s.percent, Math.round((2 / 195) * 100))
  eq("what is left to go is of 195 too", s.remaining, 193)
  eq("round-trips to a sorted list", Model.toList(visited).join(","), "GRL,NOR,PRI,SWE")
}

{
  const everything = Model.toSet(World.COUNTRIES.filter((c) => c.un).map((c) => c.c))
  const s = Model.stats(everything)
  eq("a full map is 195", s.countries, 195)
  eq("a full map is 100%", s.percent, 100)
  eq("a full map has nothing left to go", s.remaining, 0)
}

// --------------------------------------------------------------------- paths

{
  const zaf = Model.byCode("ZAF")
  const d = Model.pathData(zaf)
  eq("South Africa draws two subpaths — itself and the Lesotho hole",
    (d.match(/M/g) || []).length, 2)
  ok("path data is only moves, lines and closes", /^[MLZ0-9 .-]+$/.test(d))
  eq("a dot-only country draws nothing", Model.pathData(Model.byCode("VAT")), "")
}

{
  const land = Model.combinedPath(World.COUNTRIES)
  ok("the combined path covers every ring",
    (land.match(/Z/g) || []).length === World.COUNTRIES.reduce(
      (n, c) => n + c.p.reduce((m, poly) => m + poly.length, 0), 0))
}

// -------------------------------------------------------------------- report

if (failures.length) {
  process.stderr.write(`\n${failures.length} failed, ${passed} passed\n\n`)
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`)
  process.stderr.write("\n")
  process.exit(1)
}
process.stdout.write(`${passed} passed\n`)
