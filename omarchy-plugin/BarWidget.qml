import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

// One bar slot that tells you what the face is doing without opening it:
// a hollow ring at rest, a half ring while it thinks, a filled one while it
// speaks, and a cross when the bridge is down or a turn failed. Left click
// brings the face window forward (starting it if it is gone), right click
// interrupts the live turn.
BarWidget {
  id: root
  moduleName: "pierregoosen.hermes-face"

  readonly property string faceDir: Quickshell.env("HOME") + "/.config/omarchy/plugins/pierregoosen.hermes-face"
  readonly property var stateUrl: "http://127.0.0.1:9120/state"

  property string agent: "idle"
  property string mood: ""
  property string failure: ""
  property bool reachable: false

  readonly property string glyph: !reachable ? "✕"
    : failure ? "✕"
    : agent === "speaking" ? "◉"
    : agent === "thinking" ? "◐"
    : "○"

  readonly property string tip: !reachable ? "Hermes face: bridge not running — click to start, middle click to restart"
    : failure ? "Hermes face: " + failure + " — middle click to restart"
    : agent === "speaking" ? "Hermes face: speaking" + (mood ? " (" + mood + ")" : "") + " — right click stops it, middle click restarts"
    : agent === "thinking" ? "Hermes face: thinking — right click stops it, middle click restarts"
    : "Hermes face: idle — click to open, middle click restarts"

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: probe
    command: ["curl", "-s", "--max-time", "2", root.stateUrl]
    stdout: StdioCollector {
      onStreamFinished: {
        var raw = String(text || "").trim()
        if (!raw) { root.reachable = false; return }
        try {
          var s = JSON.parse(raw)
          root.reachable = true
          root.agent = String(s.agent || "idle")
          root.mood = String(s.mood || "")
          root.failure = String(s.error || "")
        } catch (e) {
          root.reachable = false
        }
      }
    }
  }

  Timer {
    interval: 1500
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!probe.running) probe.running = true
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    active: root.reachable && !root.failure && (root.agent === "speaking" || root.agent === "thinking")
    tooltipText: root.tip
    onPressed: function (b) {
      if (b === Qt.RightButton) root.bar.run(root.faceDir + "/bin/face-interrupt.sh")
      else if (b === Qt.MiddleButton) root.bar.run(root.faceDir + "/bin/face-restart.sh")
      else root.bar.run(root.faceDir + "/bin/face-focus.sh")
    }
  }
}
