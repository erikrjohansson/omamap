import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Palette.js" as Palette

// Which countries you have been to, and the file that remembers them.
//
// Not shell.json. The clock keeps its three settings inline in the bar's own
// config because they are three scalars; a list that grows to 195 ISO codes
// does not belong in a file describing the bar's layout. This follows Omi
// instead and owns a state file of its own.
Item {
  id: root
  visible: false

  // { "SWE": true, ... }. Replaced wholesale rather than mutated, so bindings
  // on it actually re-evaluate.
  property var visited: ({})
  property bool loaded: false

  // The colour visited countries are filled in. "" means follow the theme,
  // which is what almost everyone will leave it as — storing the empty string
  // rather than today's accent is what lets the map keep tracking the theme
  // through a theme switch instead of freezing at whatever it was on the day.
  property string mapColor: ""

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || home + "/.local/state"
  readonly property string stateRoot: stateHome + "/omamap"
  readonly property string statePath: stateRoot + "/state.json"

  readonly property var stats: Model.stats(visited)

  signal changed(string code, bool nowVisited)

  function isVisited(code) { return visited[code] === true }

  function apply(code, value) {
    if (!Model.byCode(code)) return false
    if (isVisited(code) === value) return false
    var next = {}
    for (var key in visited) if (visited[key]) next[key] = true
    if (value) next[code] = true
    else delete next[code]
    visited = next
    if (loaded) saveTimer.restart()
    changed(code, value)
    return true
  }

  function toggle(code) { return apply(code, !isVisited(code)) }
  function mark(code) { return apply(code, true) }
  function unmark(code) { return apply(code, false) }

  // "" is the one thing that means "follow the theme". Anything else that is
  // not a hex triple is a mistake, and answering a mistake by quietly wiping
  // the colour the caller already had is the wrong answer to it.
  function setColor(value) {
    var text = String(value === undefined || value === null ? "" : value).trim()
    var next = text === "" ? "" : Palette.normalize(text)
    if (text !== "" && next === "") return false
    if (next === mapColor) return false
    mapColor = next
    if (loaded) saveTimer.restart()
    return true
  }

  function clear() {
    if (Object.keys(visited).length === 0) return
    visited = ({})
    if (loaded) saveTimer.restart()
    changed("", false)
  }

  // ---- Persistence.

  function loadState(text) {
    var parsed = null
    if (text && text.length) {
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        // A corrupt file is not worth losing the session over, and it is not
        // worth silently overwriting either — leave it alone and start empty.
        // The next toggle rewrites it.
        parsed = null
      }
    }
    // Unknown codes are dropped on the way in, so a map that no longer has a
    // country cannot leave an uncountable entry in the score. Model.toSet does
    // that filtering.
    visited = parsed && parsed.visited ? Model.toSet(parsed.visited) : ({})
    // Same treatment for the colour: anything that is not a hex triple is
    // dropped on the way in rather than handed to QML, which would rather
    // print a warning and paint black.
    mapColor = parsed ? Palette.normalize(parsed.color) : ""
    loaded = true
  }

  function flushState() {
    if (!loaded) return
    // Built in this order so `color` lands above the long list of codes, where
    // a person opening the file can see it.
    var payload = { version: 1 }
    if (mapColor) payload.color = mapColor
    payload.visited = Model.toList(visited)
    stateFile.setText(JSON.stringify(payload, null, 2) + "\n")
  }

  Process {
    id: ensureStateDir
    command: ["mkdir", "-p", root.stateRoot]
    running: false
    onExited: stateFile.reload()
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.loadState(text())
    onLoadFailed: root.loadState("")
  }

  // Clicking across a dozen countries in a few seconds should be one write, not
  // a dozen.
  Timer {
    id: saveTimer
    interval: 250
    repeat: false
    onTriggered: root.flushState()
  }

  Component.onCompleted: ensureStateDir.running = true
}
