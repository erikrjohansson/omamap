// Everything about the map that is arithmetic rather than QML: building the
// path strings the Shape draws, working out which country is under the pointer,
// and counting the score.
//
// Kept free of Qt so it can be run and tested under plain node — see
// tools/test-model.mjs, which strips the two lines below and imports the rest.

.pragma library
.import "WorldData.js" as World

var GRID = World.GRID
var ASPECT = World.ASPECT
var UN_TOTAL = World.UN_TOTAL
var HEIGHT = GRID / ASPECT

// ---------------------------------------------------------------- projection
//
// Equal Earth, the same constants the generator used, reading the frame it
// recorded. Nothing in the plugin needs this — every interaction happens in map
// coordinates — but it keeps the dataset self-describing and lets the tests ask
// real questions like "is Stockholm in Sweden".

var _A1 = 1.340264, _A2 = -0.081106, _A3 = 0.000893, _A4 = 0.003796
var _SQRT3 = Math.sqrt(3)

function project(lon, lat) {
  var l = (lon * Math.PI) / 180
  var p = (lat * Math.PI) / 180
  var th = Math.asin((_SQRT3 / 2) * Math.sin(p))
  var t2 = th * th
  var t6 = t2 * t2 * t2
  var x = (2 * _SQRT3 * l * Math.cos(th)) / (3 * (9 * _A4 * t6 * t2 + 7 * _A3 * t6 + 3 * _A2 * t2 + _A1))
  var y = _A4 * th * t6 * t2 + _A3 * th * t6 + _A2 * th * t2 + _A1 * th
  return [(x + World.FRAME.xHalf) * World.FRAME.k, (World.FRAME.yMax - y) * World.FRAME.k]
}

// ------------------------------------------------------------------- indexes

var _byCode = null
var _byAreaAsc = null

function all() { return World.COUNTRIES }

function byCode(code) {
  if (!_byCode) {
    _byCode = {}
    for (var i = 0; i < World.COUNTRIES.length; i++)
      _byCode[World.COUNTRIES[i].c] = World.COUNTRIES[i]
  }
  return _byCode[code] || null
}

// Ascending by area, which is the order hit-testing walks: the first polygon
// that contains the point wins, so Lesotho beats the South Africa that
// surrounds it and San Marino beats Italy without any special-casing.
function byAreaAscending() {
  if (!_byAreaAsc) {
    _byAreaAsc = World.COUNTRIES.slice()
    _byAreaAsc.sort(function (a, b) { return a.a - b.a })
  }
  return _byAreaAsc
}

// --------------------------------------------------------------------- paths

// One country as SVG path data. Holes come out as further subpaths, which is
// why the ShapePath drawing this must use OddEvenFill — that is what punches
// Lesotho out of South Africa instead of painting over it.
//
// Memoised, because the grouped paths are rebuilt on every click and walking
// thirty thousand points to rebuild strings that never change would be felt.
var _pathCache = {}

function pathData(entry) {
  var cached = _pathCache[entry.c]
  if (cached !== undefined) return cached
  var out = ""
  for (var i = 0; i < entry.p.length; i++) {
    var poly = entry.p[i]
    for (var j = 0; j < poly.length; j++) {
      var r = poly[j]
      out += "M" + r[0] + " " + r[1]
      for (var k = 2; k < r.length; k += 2) out += "L" + r[k] + " " + r[k + 1]
      out += "Z"
    }
  }
  _pathCache[entry.c] = out
  return out
}

// The map is drawn as a handful of grouped paths rather than one per country —
// all the unvisited land in one, all the visited land in another — so the whole
// world costs a few Shape elements instead of nine hundred. Regrouping happens
// only when the visited set changes, never while panning or zooming.
function combinedPath(entries) {
  var out = ""
  for (var i = 0; i < entries.length; i++) out += pathData(entries[i])
  return out
}

function filter(predicate) {
  var out = []
  var list = World.COUNTRIES
  for (var i = 0; i < list.length; i++) if (predicate(list[i])) out.push(list[i])
  return out
}

// ---------------------------------------------------------------- hit testing

function _pointInPolygon(poly, x, y) {
  // Even-odd across the outer ring and every hole at once: a point inside a
  // hole crosses two boundaries and correctly counts as outside.
  var inside = false
  for (var i = 0; i < poly.length; i++) {
    var r = poly[i]
    for (var a = 0, b = r.length - 2; a < r.length; b = a, a += 2) {
      var ax = r[a], ay = r[a + 1], bx = r[b], by = r[b + 1]
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    }
  }
  return inside
}

// How small an outline has to get on screen before the map gives up on it and
// draws a dot instead, and how big a target that dot presents. All in screen
// pixels, converted to map units by the current scale — so the dots stay the
// same size on screen however far in you are zoomed, and the seven countries
// smaller than a grid unit are reachable at world zoom exactly like the rest.
var DOT_BELOW_PX = 6     // outlines smaller than this are drawn as a dot
var DOT_RADIUS_PX = 2.5  // and this is how big the dot itself is drawn
var DOT_HIT_PX = 2.5     // a dot beats the country underneath it within this
var DOT_REACH_PX = 9     // and beats open ocean within this

// DOT_HIT_PX deliberately equals the drawn radius rather than being generous.
// At world zoom one screen pixel is about 60km, so a 4px grab radius reaches
// 250km — enough for Slovenia's dot to take the middle of Austria and San
// Marino's to take the middle of Italy. A dot may only win where it is actually
// drawn; anything more and the small countries eat their neighbours.

// Map units per screen pixel, given the width the map is drawn at and the
// current zoom. Everything that converts between the two goes through here.
function unitsPerPixel(widthPx, zoom) { return GRID / (widthPx * zoom) }

// A country is drawn as a dot whenever its largest landmass would be too small
// to see — which, for the seven that are smaller than a single grid unit, is
// always. Measured on the biggest polygon rather than the whole country, so New
// Zealand is not called map-wide by its antimeridian split and the Maldives is
// not called invisible by its spread.
function isDot(entry, dotThreshold) {
  return entry.p.length === 0 || entry.d < dotThreshold
}

function _nearestDot(x, y, dotThreshold, radius) {
  var list = byAreaAscending()
  var best = null
  var bestDist = radius * radius
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (!isDot(entry, dotThreshold)) continue
    var dx = entry.r[0] - x, dy = entry.r[1] - y
    var d2 = dx * dx + dy * dy
    if (d2 < bestDist) { bestDist = d2; best = entry }
  }
  return best
}

function _polygonAt(x, y) {
  // Ascending by area, so the first polygon that contains the point is the
  // smallest one that does: Lesotho beats the South Africa around it, and San
  // Marino beats Italy, with no special-casing anywhere.
  var list = byAreaAscending()
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (entry.p.length === 0) continue
    if (x < entry.b[0] || x > entry.b[2] || y < entry.b[1] || y > entry.b[3]) continue
    for (var j = 0; j < entry.p.length; j++) {
      var b = entry.pb[j]
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue
      if (_pointInPolygon(entry.p[j], x, y)) return entry
    }
  }
  return null
}

// What is under the pointer. x and y are map units; upp is map units per screen
// pixel, which is what turns the pixel constants above into distances on the
// map. Pass 0 to ask about outlines alone.
//
// Three passes, in this order, and the order is the whole design:
//
//   1. A dot right under the pointer wins outright — otherwise the Vatican,
//      whose dot sits inside Italy, could never be clicked at all.
//   2. Otherwise whatever country the pointer is actually inside. Without this
//      pass coming second, a dot's grab radius at world zoom is some 500km
//      wide, and hovering central Sweden would answer "Denmark".
//   3. Only over open ocean does a dot get a generous reach, so aiming at a
//      speck in the Pacific does not demand pixel precision.
function hitTest(x, y, upp) {
  var threshold = DOT_BELOW_PX * upp
  var near = _nearestDot(x, y, threshold, DOT_HIT_PX * upp)
  if (near) return near

  var country = _polygonAt(x, y)
  if (country) return country

  return _nearestDot(x, y, threshold, DOT_REACH_PX * upp)
}

// ---------------------------------------------------------------------- score

function label(entry) {
  if (!entry) return ""
  return entry.sov ? entry.n + " · " + entry.sov : entry.n
}

// Territories are counted, but separately. Greenland is a real place you can
// have been to; it is not one of the 195, and quietly folding it in would make
// the headline number mean something other than what it says.
function stats(visited) {
  var countries = 0
  var territories = 0
  for (var code in visited) {
    if (!visited[code]) continue
    var entry = byCode(code)
    if (!entry) continue
    if (entry.un) countries++
    else territories++
  }
  return {
    countries: countries,
    territories: territories,
    total: UN_TOTAL,
    // Clamped, because the panel states it as a fact — "140 to go" — and there
    // is no honest way to say that a negative number of countries remain.
    remaining: Math.max(0, UN_TOTAL - countries),
    percent: Math.round((countries / UN_TOTAL) * 100),
    fraction: countries / UN_TOTAL,
  }
}

// State is stored as a plain array so the JSON on disk stays readable and
// diffable; everything in memory wants a set.
function toSet(list) {
  var set = {}
  if (!list) return set
  for (var i = 0; i < list.length; i++) if (byCode(list[i])) set[list[i]] = true
  return set
}

function toList(set) {
  var out = []
  for (var code in set) if (set[code]) out.push(code)
  out.sort()
  return out
}
