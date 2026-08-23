// The theme's own colours, and which of them a map can actually be drawn in.
//
// Omarchy's Color singleton keeps only the four foundational roles —
// foreground, background, accent, urgent. That is four swatches, one of which
// is the background, which is not a palette to choose from. The whole thing
// lives in the theme's colors.toml, so this reads the same file the shell
// reads and filters it down to what is worth offering.
//
// Kept free of Qt so it can be run and tested under plain node — see
// tools/test-palette.mjs, which strips the line below and imports the rest.

.pragma library

// Contrast against the surface the map is drawn on, below which a filled
// country is not visibly filled. This is nowhere near a text contrast — nobody
// reads the map — but 2:1 is enough that a country reads as coloured at a
// glance, which is the entire job. In practice it drops a theme's background
// shades and its two or three muddiest colours and keeps everything else.
var MIN_CONTRAST = 2.0

// ------------------------------------------------------------------- parsing

var _ENTRY = /^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/

// "#rrggbb" in a known case, or "" for anything that is not one. Everything
// downstream compares hex strings, so they have to agree on spelling.
function normalize(value) {
  var match = String(value === undefined || value === null ? "" : value).match(/^\s*#([0-9A-Fa-f]{6})\s*$/)
  return match ? "#" + match[1].toUpperCase() : ""
}

// "bright_cyan" -> "Bright cyan". The keys are the names the theme author
// chose; there is nothing better to call these than what they are called.
function label(key) {
  var words = String(key || "").replace(/[_-]+/g, " ").replace(/^\s+|\s+$/g, "")
  if (!words) return ""
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// Every `key = "#rrggbb"` in a colors.toml, in file order. Non-colour keys
// (`mode = "dark"`) simply do not match.
function parse(raw) {
  var out = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(_ENTRY)
    if (!match) continue
    out.push({ key: match[1], name: label(match[1]), hex: normalize(match[2]) })
  }
  return out
}

// -------------------------------------------------------------------- colour

// Accepts "#rrggbb" or anything carrying r/g/b in 0..1 — which is what a QML
// color is, so the caller can hand one straight over without unpacking it.
function _rgb(value) {
  if (value && typeof value === "object" && typeof value.r === "number")
    return [value.r, value.g, value.b]
  var hex = normalize(value)
  if (!hex) return null
  return [
    parseInt(hex.substr(1, 2), 16) / 255,
    parseInt(hex.substr(3, 2), 16) / 255,
    parseInt(hex.substr(5, 2), 16) / 255,
  ]
}

function hex(value) {
  var rgb = _rgb(value)
  if (!rgb) return ""
  var out = "#"
  for (var i = 0; i < 3; i++) {
    var channel = Math.max(0, Math.min(255, Math.round(rgb[i] * 255))).toString(16).toUpperCase()
    out += channel.length < 2 ? "0" + channel : channel
  }
  return out
}

function _linear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

// WCAG relative luminance. Unknown colours come back as 0, which makes them
// look like black and therefore low-contrast on a dark theme — the safe way to
// be wrong, since the only consequence is a swatch not offered.
function luminance(value) {
  var rgb = _rgb(value)
  if (!rgb) return 0
  return 0.2126 * _linear(rgb[0]) + 0.7152 * _linear(rgb[1]) + 0.0722 * _linear(rgb[2])
}

function contrast(a, b) {
  var la = luminance(a)
  var lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ------------------------------------------------------------------ choosing

// Drops unparseable entries, repeats (themes routinely define `blue` and
// `accent` as the same colour, and offering it twice is just a wider picker),
// and anything that would disappear against the surface it is drawn on.
function filter(entries, background, minContrast) {
  var floor = typeof minContrast === "number" ? minContrast : MIN_CONTRAST
  var seen = {}
  var out = []
  for (var i = 0; i < (entries ? entries.length : 0); i++) {
    var entry = entries[i]
    var value = normalize(entry ? entry.hex : "")
    if (!value || seen[value]) continue
    seen[value] = true
    if (contrast(value, background) < floor) continue
    out.push({ key: entry.key, name: entry.name || label(entry.key), hex: value })
  }
  return out
}

function choices(raw, background, minContrast) {
  return filter(parse(raw), background, minContrast)
}
