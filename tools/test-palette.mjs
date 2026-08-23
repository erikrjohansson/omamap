#!/usr/bin/env node
// Runs the real Palette.js under plain node.
//
//   node tools/test-palette.mjs
//
// Same trick as tools/test-model.mjs: `.pragma library` is the one line node
// cannot parse, so it is stripped and the rest is evaluated, which means the
// shipped code is what gets tested rather than a copy of it.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function load(file) {
  const src = readFileSync(join(ROOT, file), "utf8")
    .replace(/^\s*\.pragma\s+library\s*$/gm, "")
    .replace(/^\s*\.import\s+.*$/gm, "")
  const exported = `; return { ${collectNames(src).join(", ")} }`
  return new Function(src + exported)()
}

function collectNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  return [...names]
}

const Palette = load("Palette.js")

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

function close(name, actual, expected, tolerance) {
  ok(name, Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`)
}

// A theme in the shape Omarchy ships them, with the awkward cases on purpose:
// a non-colour key, a colour repeated under two names, three background
// shades, and one genuinely muddy colour.
const THEME = `
mode = "dark"

accent = "#509475"
selection = "#32473B"
muted = "#53685B"

background = "#111c18"
dark_background = "#0c1512"
lighter_background = "#23372B"

foreground = "#C1C497"
bright_foreground = "#F7E8B2"

red = "#FF5345"
blue = "#509475"
brown = "#513925"
bright_cyan = "#8CD3CB"
`

const BACKGROUND = "#111c18"

// -------------------------------------------------------------------- naming

{
  eq("hex is normalized to upper case", Palette.normalize("#aabbcc"), "#AABBCC")
  eq("surrounding space is tolerated", Palette.normalize("  #AABBCC \n"), "#AABBCC")
  eq("three-digit hex is not a colour here", Palette.normalize("#abc"), "")
  eq("a role name is not a colour", Palette.normalize("accent"), "")
  eq("nothing is not a colour", Palette.normalize(null), "")

  eq("keys become sentence case", Palette.label("bright_cyan"), "Bright cyan")
  eq("hyphens read the same as underscores", Palette.label("dark-foreground"), "Dark foreground")
  eq("a single word survives", Palette.label("accent"), "Accent")
}

// ------------------------------------------------------------------- parsing

{
  const entries = Palette.parse(THEME)
  eq("every colour in the file is found", entries.length, 12)
  eq("the first entry is the first colour", entries[0].key, "accent")
  eq("entries carry a name", entries[0].name, "Accent")
  eq("entries carry a normalized hex", entries[7].hex, "#F7E8B2")
  ok("non-colour keys are skipped", entries.every((e) => e.key !== "mode"))
  eq("an empty file parses to nothing", Palette.parse("").length, 0)
  eq("garbage parses to nothing", Palette.parse("}{ not toml").length, 0)
}

// ------------------------------------------------------------------ contrast

{
  close("black on white is 21:1", Palette.contrast("#000000", "#FFFFFF"), 21, 0.01)
  close("white on black is the same 21:1", Palette.contrast("#FFFFFF", "#000000"), 21, 0.01)
  close("a colour against itself is 1:1", Palette.contrast("#509475", "#509475"), 1, 0.0001)
  close("white is fully luminous", Palette.luminance("#FFFFFF"), 1, 0.0001)
  eq("black has no luminance", Palette.luminance("#000000"), 0)
  eq("an unparseable colour reads as black", Palette.luminance("nonsense"), 0)

  // A QML color arrives as r/g/b in 0..1, and has to measure the same as the
  // hex string it came from.
  close("an r/g/b object measures like its hex",
    Palette.contrast({ r: 1, g: 1, b: 1 }, "#000000"), 21, 0.01)
  eq("an r/g/b object round-trips to hex", Palette.hex({ r: 1, g: 0, b: 0.5 }), "#FF0080")
  eq("a hex string round-trips to itself", Palette.hex("#8cd3cb"), "#8CD3CB")
  eq("nothing round-trips to nothing", Palette.hex(""), "")
}

// ------------------------------------------------------------------ choosing

{
  const chosen = Palette.choices(THEME, BACKGROUND)
  const keys = chosen.map((c) => c.key)

  ok("the background itself is never offered", !keys.includes("background"))
  ok("nor its darker shade", !keys.includes("dark_background"))
  ok("nor its lighter one", !keys.includes("lighter_background"))
  ok("nor a colour too close to it to see", !keys.includes("selection"))
  ok("nor a muddy brown on a dark theme", !keys.includes("brown"))

  ok("the accent is offered", keys.includes("accent"))
  ok("so is the foreground", keys.includes("foreground"))
  ok("so is a bright colour", keys.includes("bright_cyan"))
  ok("so is red", keys.includes("red"))
  ok("so is a mid-contrast muted", keys.includes("muted"))

  ok("a repeated colour is offered once, under the name it appeared first as",
    keys.includes("accent") && !keys.includes("blue"))
  eq("every offered colour is above the floor",
    chosen.filter((c) => Palette.contrast(c.hex, BACKGROUND) < Palette.MIN_CONTRAST).length, 0)
  eq("file order is kept", keys[0], "accent")

  // The same theme against its own light-mode inverse: what survives has to
  // change, or the filter is not doing anything.
  const onLight = Palette.choices(THEME, "#F7F4EC").map((c) => c.key)
  ok("a light surface rejects the bright colours", !onLight.includes("bright_foreground"))
  ok("and accepts the dark ones", onLight.includes("brown") && onLight.includes("dark_background"))

  eq("a floor of 1 keeps everything but the repeats",
    Palette.choices(THEME, BACKGROUND, 1).length, 11)
  eq("an unreadable theme offers nothing", Palette.choices("", BACKGROUND).length, 0)
}

// -------------------------------------------------------------------- report

if (failures.length) {
  process.stderr.write(`\n${failures.length} failed, ${passed} passed\n\n`)
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`)
  process.stderr.write("\n")
  process.exit(1)
}
process.stdout.write(`${passed} passed\n`)
