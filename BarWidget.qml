import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "io.github.ejuro.omamap"

  // Shape contract for the shell's summon/hide/toggle routing:
  // Bar.findPanelWidget requires open/close/opened on the bar-widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    if (!panelLoader.item) return
    panelLoader.item.bar = root.bar
    panelLoader.item.settings = root.settings
    panelLoader.item.anchorItem = button
    panelLoader.item.hostWidget = root
    panelLoader.item.state = mapState
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  readonly property var stats: mapState.stats
  readonly property string barLabel: setting("barLabel", "icon")

  MapState {
    id: mapState
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Leave this file out of any qmllint run. Current qmllint aborts with exit
  // 255 and no diagnostic on any file declaring an IpcHandler, down to a
  // four-line one, so a failure here says nothing about this file.
  IpcHandler {
    target: "io.github.ejuro.omamap"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }

    // Scripting hooks. `clear` is the same wipe the panel's button performs,
    // without the confirmation the button puts in front of it — a script that
    // asked for it has already made up its mind.
    function mark(code: string): bool { return mapState.mark(code.toUpperCase()) }
    function unmark(code: string): bool { return mapState.unmark(code.toUpperCase()) }
    function visited(): string { return Model.toList(mapState.visited).join(" ") }
    function clear(): void { mapState.clear() }

    // The fill colour, so a script that switches themes can move the map with
    // it. An empty string means "follow the theme", which is both what you get
    // back when nothing is chosen and what you pass to go back to it.
    function color(): string { return mapState.mapColor }
    function setColor(hex: string): bool { return mapState.setColor(hex) }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // MDI earth. Just the glyph by default — the bar is not a scoreboard and
    // the number is one click away — but a count or a percentage is a setting
    // away for anyone who wants it out front. Same single-string approach the
    // weather widget uses for its icon and temperature.
    text: "󰇧" + (root.barLabel === "count" ? "  " + root.stats.countries
      : root.barLabel === "percent" ? "  " + root.stats.percent + "%"
      : "")
    tooltipText: "Omamap · " + root.stats.countries + " / " + root.stats.total + " countries · " + root.stats.percent + "%"
      + (root.stats.territories > 0 ? " · +" + root.stats.territories : "")
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }
}
