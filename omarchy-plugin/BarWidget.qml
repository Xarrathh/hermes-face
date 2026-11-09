import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui


// One bar slot that tells you what the face is doing without opening it:
// a hollow ring at rest, a half ring while it thinks, a filled one while it
// speaks, and a cross when the bridge is down or a turn failed. Left click
// brings the face window forward (starting it if it is gone), right click opens
// a menu with every action — a laptop touchpad has no middle button — and a
// middle click still restarts the bridge for anyone with a mouse.
BarWidget {
  id: root
  moduleName: "pierregoosen.hermes-face"

  readonly property string faceDir: Quickshell.env("HOME") + "/.config/omarchy/plugins/pierregoosen.hermes-face"
  readonly property var stateUrl: "http://127.0.0.1:9120/state"

  property string agent: "idle"
  property string mood: ""
  property string failure: ""
  property bool reachable: false
  property bool themeSync: true
  property bool noAgent: false
  // Who this face can talk to. Filled from the sidecar, so the bar says "Suzie is here"
  // without opening anything -- discovery is only useful if it is visible.
  property var peers: []
  readonly property string peerNames: peers.length ? peers.map(function (p) { return p.name }).join(", ") : ""

  readonly property string glyph: !reachable ? "✕"
    : noAgent ? "✕"
    : failure ? "✕"
    : agent === "speaking" ? "◉"
    : agent === "thinking" ? "◐"
    : "○"

  readonly property string tip: (!reachable ? "Hermes face: bridge not running — click to start, right click for the menu"
    : noAgent ? "Hermes face: the Hermes agent is not installed — install it or set HERMES_BIN, then restart"
    : failure ? "Hermes face: " + failure + " — right click for the menu"
    : agent === "speaking" ? "Hermes face: speaking" + (mood ? " (" + mood + ")" : "") + " — right click for the menu"
    : agent === "thinking" ? "Hermes face: thinking — right click for the menu"
    : "Hermes face: idle — click to open, right click for the menu")
    + (peerNames ? " · with " + peerNames : "")
    + (themeSync ? "" : " · theme sync off")

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: probe
    command: ["bash", root.faceDir + "/bin/face-state.sh"]
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
          root.themeSync = s.theme_sync !== false
          root.noAgent = s.agent_cli === false
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

  Process {
    id: peerProbe
    command: [root.faceDir + "/bin/face-peers.sh"]
    stdout: StdioCollector {
      onStreamFinished: {
        var raw = String(text || "").trim()
        if (!raw) { root.peers = []; return }
        var out = []
        raw.split("\n").forEach(function (line) {
          var f = line.split("\t")
          if (f.length < 3 || f[2] !== "present") return
          out.push({ name: f[0], where: f[1] })
        })
        root.peers = out
      }
    }
  }

  Timer {
    // Peers move slowly; half a minute is cheap next to the state probe and plenty for a
    // laptop that joins the network while the bar is already running.
    interval: 30000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!peerProbe.running) peerProbe.running = true
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    active: root.reachable && !root.failure && (root.agent === "speaking" || root.agent === "thinking")
    tooltipText: root.tip
    onPressed: function (b) {
      // A laptop touchpad has no middle button, so nothing important may live only there.
      // Left opens the face, right opens the Hermes menu through Omarchy's own menu plugin
      // (a real menu, keyboard-navigable, not a widget popup), middle still restarts.
      // The button number is logged because a click that does nothing is otherwise invisible:
      // it tells us whether the press reached the widget at all and which button it was.
      console.log("hermes-face: pressed button=" + b)
      if (b === Qt.RightButton) root.bar.run(root.faceDir + "/bin/face-menu.sh")
      else if (b === Qt.MiddleButton) root.bar.run(root.faceDir + "/bin/face-restart.sh")
      else root.bar.run(root.faceDir + "/bin/face-focus.sh")
    }
  }
}
