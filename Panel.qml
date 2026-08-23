import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "Palette.js" as Palette

// The popup: a count, a progress rail, and the map.
//
// Built to sit beside the calendar — same width cap, same hero-over-rail-over-
// content composition, same spacing scale and small-caps labels. The map is the
// grid's counterpart: the thing you actually came to look at, under a headline
// that tells you where you are.
//
// BarWidget.qml owns the bar glyph and hands this panel the button to anchor
// against.
Panel {
  id: root
  moduleName: "io.github.ejuro.omamap"
  ipcTarget: "io.github.ejuro.omamap"
  manageIpc: false

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot, not this nested panel, so
  // everything the bar identifies a panel by has to be that widget.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Injected by BarWidget so the bar glyph and the panel read the same state.
  property var state: null

  readonly property var stats: state ? state.stats : ({ countries: 0, territories: 0, total: Model.UN_TOTAL, remaining: Model.UN_TOTAL, percent: 0, fraction: 0 })

  // Guarded so the widget renders before the bar is injected (the bar-widget
  // contract instantiates it bare).
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property int mapWidth: Style.space(560)

  // ---- The colour the map is drawn in.
  //
  // What it is with nothing chosen: the same token every selected thing in the
  // shell uses, so an untouched Omamap matches the panel it sits beside.
  readonly property color themeFill: Style.selectedStateColor(root.contentForeground, Color.accent)
  readonly property color mapFill: (root.state && root.state.mapColor) ? root.state.mapColor : root.themeFill

  // The theme's whole palette, which Omarchy's Color singleton does not carry —
  // it keeps four foundational roles, one of which is the background. So read
  // the theme's colors.toml, the same file and the same path the shell reads,
  // including its assumption that the state directory is ~/.local/state.
  // Color.qml does not honour XDG_STATE_HOME here either, and reading a
  // different file than the shell would be worse than reading the same wrong
  // one. Nothing else on the machine is touched.
  readonly property string omarchyStateRoot: (Quickshell.env("HOME") || "") + "/.local/state/omarchy/current"
  readonly property string themePalettePath: root.omarchyStateRoot + "/theme/colors.toml"
  property string themePaletteText: ""

  // Which theme that palette came from.
  //
  // `omarchy-theme-set` builds the new theme in a staging directory and then
  // `mv`s it over `current/theme` — the whole directory is replaced, so
  // colors.toml is a different file afterwards and a watch on it is left
  // holding a deleted inode. `current/theme.name` is the one thing that stays
  // put and gets rewritten, and the script writes it after the swap and before
  // it hands the new palette to the shell. So it is both a reliable signal and
  // a correctly ordered one: by the time this fires, the file next to it is
  // already the new theme's.
  readonly property string themeNamePath: root.omarchyStateRoot + "/theme.name"
  property string activeTheme: ""

  function noteTheme(name) {
    var next = String(name || "").trim()
    if (next === "" || next === root.activeTheme) return
    // The first read is not a switch, it is finding out where we started — and
    // treating it as one would throw away a chosen colour on every login.
    var switched = root.activeTheme !== ""
    root.activeTheme = next
    // Re-read whether or not anything is overridden: with the panel open, the
    // picker is still showing the previous theme's swatches until this lands.
    themePalette.reload()
    // A colour taken from one theme's palette means nothing under the next
    // one's, so a switch puts the map back on the theme rather than leaving it
    // wearing a shade of the theme you just left.
    if (switched && root.state) root.state.setColor("")
  }

  // If colors.toml cannot be read, the four roles Color does expose are still a
  // palette — a thin one, but better than a picker with one swatch in it.
  readonly property var roleSwatches: [
    { key: "accent", name: "Accent", hex: Palette.hex(Color.accent) },
    { key: "foreground", name: "Foreground", hex: Palette.hex(Color.foreground) },
    { key: "muted", name: "Muted", hex: Palette.hex(Color.muted) },
    { key: "urgent", name: "Urgent", hex: Palette.hex(Color.urgent) }
  ]

  // Filtered against the surface the map is actually drawn on, because a
  // country filled in the theme's own background colour is a country you have
  // marked and cannot see.
  readonly property var swatches: {
    var offered = Palette.choices(root.themePaletteText, Color.popups.background)
    return offered.length > 0 ? offered : Palette.filter(root.roleSwatches, Color.popups.background)
  }

  // The theme's own colour leads, and picking it stores nothing — that is what
  // keeps the map following the theme instead of freezing at today's accent.
  // Any palette entry that already is that colour is dropped rather than
  // offered twice.
  readonly property var colorChoices: {
    var list = [{ key: "", name: "Theme", hex: Palette.hex(root.themeFill) }]
    for (var i = 0; i < root.swatches.length; i++)
      if (root.swatches[i].hex !== list[0].hex) list.push(root.swatches[i])
    return list
  }

  readonly property string selectedHex: (root.state && root.state.mapColor) ? root.state.mapColor : Palette.hex(root.themeFill)
  readonly property string selectedName: {
    for (var i = 0; i < root.colorChoices.length; i++)
      if (root.colorChoices[i].hex === root.selectedHex) return root.colorChoices[i].name
    // A colour chosen under a theme that has since been swapped out. It is
    // still the colour on the map; there is just no longer a name for it.
    return "Custom"
  }

  property bool pickerOpen: false
  property string hoveredSwatch: ""
  property bool resetConfirmOpen: false

  function chooseColor(entry) {
    if (root.state) root.state.setColor(entry.key === "" ? "" : entry.hex)
    root.pickerOpen = false
    root.hoveredSwatch = ""
  }

  // ---- Clearing the map. The confirmation is not politeness: this is years of
  //      clicking, it lives one button away from the zoom controls, and there
  //      is no undo.
  readonly property string resetMessage: {
    var parts = root.stats.countries + (root.stats.countries === 1 ? " country" : " countries")
    if (root.stats.territories > 0)
      parts += " and " + root.stats.territories + (root.stats.territories === 1 ? " territory" : " territories")
    return "Clear " + parts + " from the map?"
  }

  function askReset() {
    if (root.stats.countries + root.stats.territories === 0) return
    root.pickerOpen = false
    // Cancel, not Clear. The dialog opens on the button that changes nothing.
    resetConfirm.selectedIndex = 0
    root.resetConfirmOpen = true
  }

  function cancelReset() { root.resetConfirmOpen = false }

  function confirmReset() {
    root.resetConfirmOpen = false
    if (root.state) root.state.clear()
  }

  function open() {
    map.reset()
    root.pickerOpen = false
    root.resetConfirmOpen = false
    root.hoveredSwatch = ""
    // Switches are caught by the theme.name watch; this catches the other case,
    // a colors.toml edited in place — which is what anyone building a theme is
    // doing all afternoon. One small file read per summon.
    themePalette.reload()
    root.controller.show()
    Qt.callLater(function () {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    root.pickerOpen = false
    root.resetConfirmOpen = false
    setCenterHoverRevealSuppressed(false)
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Summoning by hotkey moves no pointer, so a hover the bar was still holding
  // must not keep the center indicators revealed behind the panel.
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  FileView {
    id: themePalette
    path: root.themePalettePath
    watchChanges: false
    printErrors: false
    onLoaded: root.themePaletteText = text()
    onLoadFailed: root.themePaletteText = ""
  }

  FileView {
    id: themeName
    path: root.themeNamePath
    watchChanges: true
    printErrors: false
    // `text()` is still the old contents inside the change signal, so both
    // paths go through reload -> onLoaded rather than reading it here.
    onFileChanged: reload()
    onLoaded: root.noteTheme(text())
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(root.mapWidth)
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      // Every branch here asks about the confirmation first. Routing the keys
      // rather than blocking the catcher and handing focus to the dialog keeps
      // the dispatch in one readable place — and PanelKeyCatcher's `blocked`
      // only forwards to whatever descendant already has focus, which inside a
      // layer-shell surface is a thing worth not betting on.
      onMoveRequested: function (dx, dy) {
        if (root.resetConfirmOpen) {
          if (dx !== 0) resetConfirm.selectedIndex = resetConfirm.selectedIndex === 0 ? 1 : 0
          return
        }
        // A tenth of the visible span per press: enough to cross the map in a
        // held keypress, small enough to aim with.
        map.panX += dx * map.visibleWidth * 0.1
        map.panY += dy * map.visibleHeight * 0.1
        map.clampPan()
      }
      onReturnRequested: {
        if (!root.resetConfirmOpen) return
        if (resetConfirm.selectedIndex === 0) root.cancelReset()
        else root.confirmReset()
      }
      // Esc unwinds one layer at a time: the dialog, then the picker, then the
      // panel. Closing the whole thing out from under a question would be a
      // strange answer to it.
      onCloseRequested: {
        if (root.resetConfirmOpen) root.cancelReset()
        else if (root.pickerOpen) root.pickerOpen = false
        else root.close()
      }
      onTabRequested: function (direction) {
        if (root.resetConfirmOpen) {
          resetConfirm.selectedIndex = resetConfirm.selectedIndex === 0 ? 1 : 0
          return
        }
        root.switchPanel(direction)
      }
      // `x` is what deletes things everywhere else in the shell, and it lands
      // on the confirmation like the button does.
      onDeleteRequested: root.askReset()
      onTextKey: function (t) {
        if (root.resetConfirmOpen) return
        if (t === "+" || t === "=") map.zoomAt(1.4, map.width / 2, map.height / 2)
        else if (t === "-" || t === "_") map.zoomAt(1 / 1.4, map.width / 2, map.height / 2)
        else if (t === "0") map.reset()
        else if (t === "c" || t === "C") root.pickerOpen = !root.pickerOpen
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(8)

        // ---- Hero: the number you came for.
        Item {
          width: parent.width
          height: heroColumn.height

          Column {
            id: heroColumn
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(2)

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: root.stats.countries
              color: root.contentForeground
              font.family: root.contentFontFamily
              // Outside the Style.font scale on purpose, exactly as the
              // calendar's date is: this is the one thing on the panel that
              // should be readable from across the room.
              font.pixelSize: 52
              font.bold: true
            }

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: root.stats.countries === 1 ? "COUNTRY VISITED" : "COUNTRIES VISITED"
              color: Qt.darker(root.contentForeground, 1.5)
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1
              font.bold: true
            }
          }
        }

        // ---- The rail. Lifted from the calendar's year bar, down to the
        //      track alpha and the easing, so the two panels read as siblings.
        //      The left label is where the size of the world gets stated.
        Item {
          width: parent.width
          height: Math.max(totalLabel.implicitHeight, Style.space(12))

          Text {
            id: totalLabel
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: Model.UN_TOTAL + " IN THE WORLD"
            color: Qt.darker(root.contentForeground, 1.5)
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
            font.letterSpacing: 1
          }

          Text {
            id: percentLabel
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.stats.percent + "%"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Rectangle {
            id: track
            anchors.left: totalLabel.right
            anchors.right: percentLabel.left
            anchors.leftMargin: Style.space(12)
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            height: Style.space(6)
            radius: Style.cornerRadius > 0 ? height / 2 : 0
            color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)

            Rectangle {
              width: Math.round(parent.width * root.stats.fraction)
              height: parent.height
              radius: parent.radius
              // The rail is the same countries as the map, so it is the same
              // colour as the map — including when that colour was chosen.
              color: root.mapFill

              Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
            }
          }
        }

        // ---- Under the rail: what is left on the left, and territories on the
        //      right once there are any.
        //
        //      The rail says how far along you are; this says how far there is
        //      to go, which is the same fact and a completely different feeling.
        //      It sits under the "195 IN THE WORLD" label because that is the
        //      number it is counting down from.
        //
        //      Territories — Greenland, Puerto Rico — are real places you can
        //      have been to; they are not among the 195, and folding them into
        //      the headline would make it mean something other than what it
        //      says, so they get the far end of this line instead.
        Item {
          width: parent.width
          // Asking the labels whether they are visible would be a cycle: QML
          // mirrors `visible` from parent down to child, so a parent whose
          // height is measured from a child's visibility can never become
          // visible in the first place. It settles silently at zero and the
          // whole row simply never appears. Test the same conditions the labels
          // test instead.
          height: Math.max(root.stats.remaining > 0 ? remainingLabel.implicitHeight : 0,
                           root.stats.territories > 0 ? territoryLabel.implicitHeight : 0)
          visible: height > 0

          Text {
            id: remainingLabel
            anchors.left: parent.left
            anchors.top: parent.top
            // Nothing to say once there is nothing left: the hero already reads
            // 195 and the rail already reads 100%, and "0 TO GO" would be the
            // one sour note in the moment the whole panel exists for.
            visible: root.stats.remaining > 0
            text: root.stats.remaining + " TO GO"
            color: Qt.darker(root.contentForeground, 1.9)
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            font.letterSpacing: 1
          }

          Text {
            id: territoryLabel
            anchors.right: parent.right
            anchors.top: parent.top
            visible: root.stats.territories > 0
            text: "+" + root.stats.territories + (root.stats.territories === 1 ? " territory" : " territories")
            color: Qt.darker(root.contentForeground, 1.9)
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }
        }

        // ---- The map.
        Item {
          width: parent.width
          height: Math.round(width / map.aspect)

          WorldMap {
            id: map
            anchors.fill: parent

            visited: root.state ? root.state.visited : ({})

            // The ocean is left transparent so the popup's own surface shows
            // through it — one fewer colour to keep in step with the theme.
            landColor: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.10)
            borderColor: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.35)
            visitedColor: Qt.rgba(fill.r, fill.g, fill.b, 0.85)
            // Filled, but visibly not part of the score.
            territoryColor: Qt.rgba(fill.r, fill.g, fill.b, 0.45)
            // Hover stays on the theme rather than following the chosen colour:
            // a hover tint in the fill colour would read as "already visited",
            // which is the one thing it must not say.
            hoverColor: Style.hoverFillFor(root.contentForeground, Color.accent)
            dotColor: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.55)

            readonly property color fill: root.mapFill

            onToggled: function (code) { if (root.state) root.state.toggle(code) }
          }

          // ---- Zoom controls. These live here rather than in WorldMap.qml
          //      because that file deliberately imports no qs.* — every colour
          //      is injected — which is what lets it be rendered headlessly by
          //      tools/check-render.mjs. A PanelActionButton in there would
          //      drag qs.Ui in and take the render checks down with it.
          //
          //      Always visible, not revealed on hover: not being able to find
          //      the zoom is the exact problem these are here to solve, and a
          //      control you have to already know about does not solve it.
          // Backing first, so it sits above the map and below the buttons.
          // Anchored to the Row rather than sizing a wrapper from it: a parent
          // sized off a child that anchors back into that parent is a cycle,
          // and QML resolves it by silently collapsing the parent to nothing —
          // the buttons keep drawing and only the backing disappears, which is
          // a genuinely confusing way to lose an hour.
          Rectangle {
            anchors.fill: zoomRow
            anchors.margins: -Style.space(5)
            radius: Style.cornerRadius > 0 ? Style.cornerRadius : 0
            // Coastlines are busy, and an unbacked glyph on top of one is both
            // hard to see and hard to aim at. Enough of the popup's own surface
            // to lift the controls off the map, and no more — over open ocean
            // it is invisible, which is the point.
            color: Qt.rgba(Color.popups.background.r, Color.popups.background.g, Color.popups.background.b, 0.85)
          }

          Row {
            id: zoomRow
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.margins: Style.space(11)
            spacing: Style.space(2)

            Text {
              // No anchors in here: Row is a positioner, and anchoring a child
              // inside one is illegal. Match the buttons' height and align in
              // it instead.
              height: zoomIn.height
              verticalAlignment: Text.AlignVCenter
              rightPadding: Style.space(6)
              // Silent at world zoom. Once you are in, it says where you are
              // and implies there is somewhere to get back to.
              visible: map.zoom > 1.001
              text: map.zoom.toFixed(1) + "×"
              color: Qt.darker(root.contentForeground, 1.5)
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }

            PanelActionButton {
              iconText: "󰍊"
              tooltipText: "Zoom out · -"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              enabled: map.zoom > map.minZoom
              opacity: enabled ? 1 : 0.35
              onClicked: map.zoomAt(1 / 1.4, map.width / 2, map.height / 2)
            }

            PanelActionButton {
              id: zoomIn
              iconText: "󰍋"
              tooltipText: "Zoom in · +"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              enabled: map.zoom < map.maxZoom
              opacity: enabled ? 1 : 0.35
              onClicked: map.zoomAt(1.4, map.width / 2, map.height / 2)
            }

            PanelActionButton {
              visible: map.zoom > 1.001
              // The same earth the bar wears. In a row of magnifiers it reads
              // as "show me the whole world", which is exactly what it does.
              iconText: "󰇧"
              tooltipText: "Whole world · 0"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: map.reset()
            }
          }

          // Drawn outside the map so it survives at the edges — which is
          // exactly where the small countries are. Follows the pointer rather
          // than sitting in a fixed corner, because on a map this dense the
          // name has to be next to the thing it names.
          Item {
            visible: map.hovered !== null
            x: Math.max(0, Math.min(parent.width - tooltip.width, map.pointer.x + Style.space(14)))
            y: Math.max(0, map.pointer.y - tooltip.height - Style.space(10))
            width: tooltip.width
            height: tooltip.height

            BorderSurface {
              id: tooltip
              width: tooltipText.implicitWidth + Style.spacing.controlPaddingX * 2
              height: tooltipText.implicitHeight + Style.spacing.controlPaddingY * 2
              color: Color.tooltip.background
              borderSpec: Border.surfaceSpec("tooltip", "border", Color.tooltip.border, Style.normalBorderWidth)
              radius: Style.cornerRadius

              Text {
                id: tooltipText
                anchors.centerIn: parent
                text: Model.label(map.hovered)
                color: Color.tooltip.text
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
        }
      }

      // ---- The corner controls. Anchored to the panel rather than dropped
      //      into the Column, because the top-right corner of the panel is
      //      where they belong and the Column's job is the hero, which is
      //      centred. Being siblings of the Column is also what lets the
      //      picker's dismissal layer sit cleanly between the two: stacking
      //      order is decided among siblings, so a `z` set inside the Column
      //      could never lift a popover above an overlay outside it.

      // Catches the click that closes the picker. Below the corner controls,
      // above everything else, and completely absent when the picker is shut —
      // an always-on overlay here would eat every click on the map.
      MouseArea {
        anchors.fill: parent
        z: 10
        visible: root.pickerOpen
        enabled: root.pickerOpen
        onPressed: root.pickerOpen = false
      }

      Row {
        id: cornerRow
        anchors.top: parent.top
        anchors.right: parent.right
        z: 11
        spacing: Style.space(2)

        PanelActionButton {
          iconText: "󰏘"
          tooltipText: "Map colour · c"
          // Drawn in the colour it sets, so the current choice is on the panel
          // rather than one click inside a popover.
          foreground: root.mapFill
          fontFamily: root.contentFontFamily
          onClicked: root.pickerOpen = !root.pickerOpen
        }

        PanelActionButton {
          iconText: "󰆴"
          tooltipText: "Clear the map · x"
          foreground: root.contentForeground
          // The shell's urgent mode for this button: destructive actions go red
          // under the pointer, the same way forget-network and unpair-device do.
          hoverColor: Color.urgent
          fontFamily: root.contentFontFamily
          enabled: root.stats.countries + root.stats.territories > 0
          opacity: enabled ? 1 : 0.35
          onClicked: root.askReset()
        }
      }

      // ---- The picker. The theme's palette and nothing else: this is a map
      //      that is meant to look like the desktop it is on, so an arbitrary
      //      colour wheel would only offer new ways to clash with it.
      BorderSurface {
        id: picker
        z: 11
        visible: root.pickerOpen
        anchors.top: cornerRow.bottom
        anchors.right: parent.right
        anchors.topMargin: Style.space(4)
        // Sized from the grid, which is positioned by inset rather than
        // anchored back into this surface — a parent sized off a child that
        // anchors into it is a cycle, and QML resolves those by silently
        // collapsing the parent to nothing.
        //
        // The floor is for a theme that offers only a swatch or two: a full row
        // is wider than it anyway, so it only ever applies where the grid alone
        // would leave the name below it elided to nothing.
        readonly property real contentWidth: Math.max(swatchGrid.width, Style.space(120))
        width: picker.contentWidth + picker.contentLeftInset + picker.contentRightInset
        height: swatchGrid.height + Style.space(8) + swatchName.implicitHeight
          + picker.contentTopInset + picker.contentBottomInset
        color: Color.popups.background
        borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Style.normalBorderWidth)
        radius: Style.cornerRadius
        padding: Style.space(10)

        Grid {
          id: swatchGrid
          x: picker.contentLeftInset
          y: picker.contentTopInset
          columns: 6
          spacing: Style.space(6)

          Repeater {
            model: root.colorChoices

            // Circle, not a square: a round swatch on a map reads as a place
            // rather than as a colour chip, which is what it is going to be.
            Rectangle {
              id: swatch
              required property var modelData

              readonly property bool current: modelData.hex === root.selectedHex

              width: Style.space(22)
              height: width
              radius: width / 2
              color: "transparent"
              // The ring around the current choice is the panel's foreground,
              // not the colour itself — a ring in the same colour as the fill
              // it surrounds is not a ring.
              border.width: current ? Math.max(1, Style.space(2)) : 0
              border.color: root.contentForeground

              Rectangle {
                anchors.fill: parent
                anchors.margins: swatch.current ? Math.max(2, Style.space(4)) : 0
                radius: width / 2
                color: swatch.modelData.hex
                border.width: swatchMouse.containsMouse && !swatch.current ? Math.max(1, Style.space(1)) : 0
                border.color: root.contentForeground
              }

              MouseArea {
                id: swatchMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onEntered: root.hoveredSwatch = swatch.modelData.name
                // Only clear the name if it is still ours: moving between two
                // swatches delivers the leave after the enter, and the obvious
                // unconditional clear blanks the label you just arrived at.
                onExited: if (root.hoveredSwatch === swatch.modelData.name) root.hoveredSwatch = ""
                onClicked: root.chooseColor(swatch.modelData)
              }
            }
          }
        }

        // One line, saying what is under the pointer — or what is chosen, when
        // the pointer is not on anything. Same idea as the map's own tooltip:
        // the name goes next to the thing, not in a legend somewhere.
        Text {
          id: swatchName
          x: picker.contentLeftInset
          y: swatchGrid.y + swatchGrid.height + Style.space(8)
          width: picker.contentWidth
          text: root.hoveredSwatch !== "" ? root.hoveredSwatch : root.selectedName
          color: Qt.darker(root.contentForeground, 1.5)
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
          elide: Text.ElideRight
        }
      }

      ConfirmDialog {
        id: resetConfirm
        anchors.fill: parent
        z: 20
        opened: root.resetConfirmOpen
        message: root.resetMessage
        confirmText: "Clear"
        background: Color.popups.background
        foreground: root.contentForeground
        // The bar's foreground can be overridden away from the theme's
        // (`omarchy-bar-text-color`), and the dialog's default selection fill
        // is mixed from Color.foreground. Take it from the same colour the rest
        // of this panel is drawn in, or the two disagree on those setups.
        selectedBackground: Util.alpha(root.contentForeground, 0.08)
        fontFamily: root.contentFontFamily
        onCanceled: root.cancelReset()
        onConfirmed: root.confirmReset()
      }
    }
  }
}
