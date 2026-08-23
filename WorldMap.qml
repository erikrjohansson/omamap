import QtQuick
import QtQuick.Shapes
import "Model.js" as Model

// The map itself: draws the world, tracks what is under the pointer, and turns
// clicks into toggles. Pans and zooms, and nothing else.
//
// Deliberately free of qs.Commons and qs.Ui — every colour is injected by
// whoever mounts it. That keeps the theming in one place (Panel.qml, which
// knows about the bar) and lets this file be run and looked at on its own with
// `qml6 dev/harness.qml`, which is how the map was built.
Item {
  id: root

  // ---- Injected palette. No defaults worth having: a map drawn in
  //      placeholder colours on a themed panel looks broken rather than
  //      unstyled, so the caller is expected to supply all of them.
  property color landColor
  property color borderColor
  property color visitedColor
  property color territoryColor
  property color hoverColor
  property color dotColor

  // { "SWE": true, ... } — owned by the caller, so the map has no state of its
  // own to keep in step.
  property var visited: ({})

  readonly property real aspect: Model.ASPECT

  // What the pointer is over, and where it is, for whoever draws the tooltip.
  // The map does not draw it itself: a tooltip that lives inside the clipped
  // viewport would be cut off at the edges, which is exactly where the small
  // countries are.
  property var hovered: null
  property point pointer: Qt.point(0, 0)

  signal toggled(string code)

  // ---- View. Pan is in map units and names the top-left corner on screen, so
  //      it can be clamped against the map's own extent without caring about
  //      the widget's size.
  property real zoom: 1
  property real panX: 0
  property real panY: 0

  readonly property real minZoom: 1
  readonly property real maxZoom: 8

  // Screen pixels per map unit. The one conversion everything else goes
  // through, in both directions.
  readonly property real pxPerUnit: (width / Model.GRID) * zoom
  readonly property real unitsPerPx: pxPerUnit > 0 ? 1 / pxPerUnit : 0

  readonly property real visibleWidth: width / pxPerUnit
  readonly property real visibleHeight: height / pxPerUnit

  implicitWidth: 400
  implicitHeight: implicitWidth / aspect
  clip: true

  // ---- Border width has to be divided by the scale to stay a constant
  //      thickness on screen — but changing strokeWidth rebuilds the stroke
  //      geometry for every ring, so binding it straight to a continuous zoom
  //      would retessellate the whole world on every wheel tick. Snapping the
  //      zoom it is computed from to a few steps costs a handful of rebuilds
  //      per gesture instead of one per frame.
  readonly property var strokeSteps: [1, 1.5, 2.5, 4, 6, 8]
  readonly property real strokeZoom: {
    var chosen = strokeSteps[0]
    for (var i = 0; i < strokeSteps.length; i++) if (zoom >= strokeSteps[i]) chosen = strokeSteps[i]
    return chosen
  }
  readonly property real borderWidth: Model.GRID / (width * strokeZoom) * 0.7

  // ---- Which countries are drawn as dots depends on the zoom, so this is the
  //      one thing that does change as you scroll.
  readonly property real dotThreshold: Model.DOT_BELOW_PX * unitsPerPx
  readonly property real dotRadius: Model.DOT_RADIUS_PX * unitsPerPx

  function reset() {
    zoom = 1
    panX = 0
    panY = 0
  }

  // Keeps the map filling the viewport: at zoom 1 it sits flush, and further in
  // it can be dragged only as far as its own edges.
  function clampPan() {
    panX = Math.max(0, Math.min(Model.GRID - visibleWidth, panX))
    var mapHeight = Model.GRID / aspect
    panY = Math.max(0, Math.min(mapHeight - visibleHeight, panY))
  }

  function zoomAt(factor, px, py) {
    // The point under the cursor stays under the cursor, which is the only
    // zoom that feels like it is being aimed rather than watched.
    var ux = panX + px * unitsPerPx
    var uy = panY + py * unitsPerPx
    var next = Math.max(minZoom, Math.min(maxZoom, zoom * factor))
    if (next === zoom) return
    zoom = next
    panX = ux - px * unitsPerPx
    panY = uy - py * unitsPerPx
    clampPan()
  }

  function entryAt(px, py) {
    return Model.hitTest(panX + px * unitsPerPx, panY + py * unitsPerPx, unitsPerPx)
  }

  onWidthChanged: clampPan()
  onHeightChanged: clampPan()

  Item {
    id: world
    transformOrigin: Item.TopLeft
    scale: root.pxPerUnit
    x: -root.panX * root.pxPerUnit
    y: -root.panY * root.pxPerUnit
    width: Model.GRID
    height: Model.GRID / root.aspect

    // One ShapePath per country, inside a single Shape.
    //
    // Grouping every country into a handful of big paths was the obvious
    // optimisation, and it had to be abandoned: given a single path of eight
    // hundred subpaths, Qt's renderers draw part of the world and silently drop
    // the rest. One path per country keeps every fill small enough to be
    // tessellated correctly, and tools/check-render.mjs holds that honest by
    // sampling the actual pixels at four zoom levels.
    //
    // It is also the simpler design. Visiting a country is now a colour
    // binding, so a click repaints instead of rebuilding a quarter-megabyte of
    // path string, and hover needs no separate overlay at all.
    Shape {
      id: shape
      anchors.fill: parent
      // CurveRenderer needs the per-country split above to work at all: handed
      // one path of eight hundred subpaths it renders Greenland and gives up on
      // the rest of the world. Given one path per country it is correct at every
      // zoom, costs about 4% more than the triangulating renderer, and is
      // visibly smoother — a map is mostly thin coastline, which is exactly what
      // analytic antialiasing is for.
      preferredRendererType: Shape.CurveRenderer
    }

    Component {
      id: countryPath

      ShapePath {
        property var entry: null

        // OddEvenFill is what punches Lesotho out of South Africa: the hole is
        // just another subpath, and the rule leaves it unfilled.
        fillRule: ShapePath.OddEvenFill
        // Compared by code rather than by object identity. Identity looks
        // like the obvious test and quietly fails the moment the hovered
        // entry arrives from a different holder of the same JS library — the
        // dev harness hits exactly that, and it would be a miserable thing to
        // debug later.
        fillColor: {
          if (!entry) return "transparent"
          if (root.hovered && root.hovered.c === entry.c) return root.hoverColor
          if (root.visited[entry.c]) return entry.un ? root.visitedColor : root.territoryColor
          return root.landColor
        }
        strokeColor: root.borderColor
        strokeWidth: root.borderWidth
        joinStyle: ShapePath.RoundJoin

        PathSvg { path: entry ? Model.pathData(entry) : "" }
      }
    }

    Component.onCompleted: {
      var paths = []
      var list = Model.all()
      for (var i = 0; i < list.length; i++) {
        if (list[i].p.length === 0) continue     // dot-only: nothing to draw
        paths.push(countryPath.createObject(shape, { entry: list[i] }))
      }
      shape.data = paths
    }

    // Dots for whatever is too small to see. Sized in map units from a pixel
    // constant, so they hold their size on screen and quietly hand over to the
    // real outline as it grows past them.
    Repeater {
      model: Model.all()

      Rectangle {
        required property var modelData

        readonly property bool isDot: Model.isDot(modelData, root.dotThreshold)
        readonly property bool isVisited: root.visited[modelData.c] === true

        width: root.dotRadius * 2
        height: width
        radius: width / 2
        x: modelData.r[0] - width / 2
        y: modelData.r[1] - height / 2

        visible: opacity > 0.01
        opacity: isDot ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 120 } }

        color: isVisited ? (modelData.un ? root.visitedColor : root.territoryColor) : "transparent"
        border.width: isVisited ? 0 : root.dotRadius * 0.55
        border.color: root.dotColor
      }
    }
  }

  // ---- Input. One MouseArea for hover, click and drag, because telling a
  //      click from a drag needs both in the same place.
  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton

    property bool dragging: false
    property real pressX: 0
    property real pressY: 0
    property real lastX: 0
    property real lastY: 0

    function refreshHover(x, y) {
      root.pointer = Qt.point(x, y)
      root.hovered = root.entryAt(x, y)
    }

    onPositionChanged: function (event) {
      if (pressed) {
        var dx = event.x - lastX
        var dy = event.y - lastY
        // A few pixels of slop, so a click with an unsteady hand is still a
        // click and not a one-pixel pan that swallows the toggle.
        if (!dragging && Math.abs(event.x - pressX) + Math.abs(event.y - pressY) > 4) dragging = true
        if (dragging) {
          root.panX -= dx * root.unitsPerPx
          root.panY -= dy * root.unitsPerPx
          root.clampPan()
          lastX = event.x
          lastY = event.y
          root.hovered = null
        }
        return
      }
      refreshHover(event.x, event.y)
    }

    onPressed: function (event) {
      dragging = false
      pressX = lastX = event.x
      pressY = lastY = event.y
    }

    onReleased: function (event) {
      if (dragging) {
        dragging = false
        refreshHover(event.x, event.y)
        return
      }
      var entry = root.entryAt(event.x, event.y)
      if (entry) root.toggled(entry.c)
      else if (root.zoom > root.minZoom) root.reset()
      refreshHover(event.x, event.y)
    }

    onExited: root.hovered = null

    // Wheel on the MouseArea, not a WheelHandler.
    //
    // This is the pattern the shell itself uses — Ui/WidgetButton.qml takes
    // every bar widget's scroll through `MouseArea.onWheel`, and those work.
    // The one WheelHandler in the whole of Omarchy is the calendar's
    // month-scroll, and that is dead here too, which is a good sign that
    // pointer handlers simply do not receive wheel events inside these
    // surfaces. Same logic, delivery route that works.
    onWheel: function (wheel) {
      // Discrete wheels report angleDelta in steps of 120. High-resolution
      // wheels and trackpads may report only pixelDelta, and the obvious guard
      // — bail when angleDelta.y is zero — throws every one of those away.
      // Only a genuinely horizontal scroll leaves both at zero.
      var steps = wheel.angleDelta.y !== 0 ? wheel.angleDelta.y / 120
        : wheel.pixelDelta.y !== 0 ? wheel.pixelDelta.y / 50
        : 0
      if (steps === 0) return
      // Clamped so one flick of a high-resolution wheel cannot cross the whole
      // zoom range in a single event.
      var factor = Math.pow(1.25, Math.max(-2, Math.min(2, steps)))
      root.zoomAt(factor, wheel.x, wheel.y)
      refreshHover(wheel.x, wheel.y)
    }

    cursorShape: dragging ? Qt.ClosedHandCursor : (root.hovered ? Qt.PointingHandCursor : Qt.ArrowCursor)

  }
}
