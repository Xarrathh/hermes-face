# Ideas

Not committed work — things worth doing if they earn their keep.

## Face-to-face, as a transcript rather than a call

**The want:** two agents, two machines, and the local face reads out the complete dialogue
between them — every turn, both sides, in order.

**Not the want:** voice-to-voice audio streaming between the two windows. That is a WebRTC
problem with a security surface, and it buys nothing the transcript does not.

**Shape:**

- Each machine keeps its own Hermes and its own face. Bridges stay loopback-only and keep their
  per-user token; the face bridge never listens on the network.
- The two *agents* talk over a paired channel: Hermes already registers another gateway as a peer
  and messages its agent with a shared key (`hermes peer add` / `hermes peer dm`), which needs the
  remote to run the API server platform. The remote does not have to run the same OS as this one —
  only a Hermes with that platform and a key.
- The face grows one action: "talk to <peer>", which sends a prompt, waits for the reply, and
  records both sides of the exchange.
- What the face speaks is the transcript: who said what, in order, with the other side attributed.
  Reading it aloud is the same speech path a normal turn already uses — chunked, interruptible,
  and stoppable with the stop key.

**Open questions:**

- One call, one reply, or a bounded back-and-forth (N exchanges) before it reports back?
- Does the remote agent know it is talking to another agent, and should it be told to keep answers
  short so the spoken transcript stays listenable?
- Where does the transcript live — a turn in the normal history, a separate file, or both?
- Pairing: shared key in `.env` on both sides, and what does the first-run flow look like when the
  peer is on a machine you have never configured?
