# Chat & Video Call — a WhatsApp-style app with presence, chat, audio & video calling

A real-time chat and calling app: WebRTC for audio/video (peer-to-peer, mesh topology),
Socket.IO for presence + signaling + messaging, Express to serve the frontend. Open it,
get a random name, see who else is online, message them, or ring them for an audio or
video call — up to 8 people per call. No accounts, no passwords.

## How it works

**Identity**
- On first visit you're given a random name (e.g. "Swift Falcon 42") and a private,
  randomly generated ID, both stored in your browser (`localStorage`) — so refreshing the
  page keeps you as the same person instead of creating a stranger. You can rename yourself
  any time from the home screen.
- This is intentionally accountless: identity lives in the browser, not behind a login.
  Clearing site data or switching browsers/devices gets you a fresh identity.

**Presence**
- The home screen shows everyone currently online, live — a green dot, their name, and
  either their last message or "Online"/"Offline." It updates in real time as people come
  and go, with no need to refresh.
- People you've chatted with stay in your list (marked "Offline") even after they leave, so
  your conversation history stays reachable — the list isn't just "who's here right now."

**Chat**
- Tap anyone online to open a 1:1 chat thread. Messages send instantly and are stored on
  the server so history is there when you reopen the thread (see the note on persistence
  below). Typing indicators, unread badges, and a "last message" preview on the home list
  all work like a normal chat app.
- Messages sent to someone who's currently offline are still saved — they'll see them as
  soon as they're back online, no push notifications needed since it's all live-socket
  delivery.

**Calling**
- From a chat thread, tap the phone or video icon to *ring* that person directly — an
  incoming-call screen pops up on their end with Accept/Decline, exactly like WhatsApp.
  No more manually typing a shared call code.
- For a group call, tap the group icon on the home screen, select multiple people, and
  start an audio or video call — everyone selected gets rung individually.
- Audio calls skip the camera entirely (no video track requested at all — genuinely lower
  bandwidth, not just a hidden video feed). Video calls show the classic WhatsApp
  fullscreen + picture-in-picture layout for 1:1, switching to an even grid for 3+ people.
- A **full screen** button is available during video calls (bottom control bar) — toggles
  the whole browser into fullscreen via the Fullscreen API, syncing correctly if you exit
  with Esc.
- Outgoing calls auto-cancel after 40 seconds if nobody answers ("No answer"); incoming
  calls auto-decline after 30 seconds if you don't respond (shows as a missed call).
- For direct 1:1 calls, a short system message logs the outcome right in the chat thread
  when it ends — "📹 Video call · 4m 12s", "📵 Call declined", "📵 No answer" — the same way
  WhatsApp logs calls into your conversation. (Group calls aren't tied to a single chat
  thread, so they're not logged this way.)
- Extra controls during a call: mute mic, mute what *you* hear (speaker toggle, local-only
  — doesn't affect what others hear), camera on/off + switch camera (video calls), and a
  live connection-quality indicator (Good/Fair/Weak, from real round-trip-time stats).

**Under the hood**, audio/video streams go directly between browsers (WebRTC mesh —
everyone connects to everyone in a call). The server only relays presence, chat text, and
the WebRTC connection handshake (SDP offers/answers, ICE candidates) — it never touches or
stores your actual audio/video.

## Built for quality at low data usage

- **Codec preference**: each connection prefers AV1, then VP9, then VP8/H264 (whichever the
  browser actually supports, in that order) — meaningfully better video quality per kilobit
  than the codecs most demos default to.
- **Adaptive per-connection bitrate**: video bitrate is capped and scaled by call size —
  full quality (~2.5 Mbps) for a 1:1 call, stepping down as more people join (down to
  ~400 Kbps for a full 8-person room), so total upload bandwidth stays manageable instead of
  every connection fighting for the same pipe uncapped.
- **Efficient audio**: Opus with DTX enabled (stops sending packets during silence) capped
  at 32 Kbps — already high quality for speech, a fraction of the data video would cost.
- **720p/30fps capture** for video calls — enough detail for a clear picture without paying
  for resolution the network can't actually deliver.
- **`degradationPreference: balanced`** on outgoing video, so a shaky connection trades off
  resolution/frame rate gracefully instead of quality collapsing.

None of this needs a TURN/media relay server to run — it's standard WebRTC sender
parameters and SDP tuning, so it deploys exactly like a plain signaling server, nothing
extra to run on Koyeb.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:8000` in two different browser tabs/profiles (or two devices on the
same network using your machine's local IP) to test chat and calling between two identities.

## Deploy to Koyeb

Same as before — nothing about this upgrade changes the deployment shape.

1. Push this folder to a GitHub repo.
2. In the Koyeb dashboard: **Create Service → Deploy from GitHub**, pick the repo. Koyeb
   detects the included `Dockerfile` automatically.
3. Set the port to `8000`.
4. Deploy — you get a public `https://<your-app>.koyeb.app` URL. Camera/mic access requires
   HTTPS, which Koyeb provides automatically.

## Architecture notes & limitations (read before relying on this in production)

- **Everything is in-memory** — online users, chat history, active calls — all live in the
  Node process's RAM. A redeploy or restart wipes it all. For real persistence you'd add a
  database (Redis for presence/ephemeral state, Postgres for chat history) — the code is
  structured so that's a swap-in, not a rewrite (all the state lives in a few `Map`s at the
  top of `server.js`).
- **No reconnect-into-call recovery** — if your network drops mid-call, you'll need to
  redial; the app doesn't attempt to silently rejoin an in-progress call. Presence and chat
  *do* reconnect automatically (Socket.IO's default behavior), just not an active call.
- **Mesh calling caps at 8 people** — every participant uploads directly to every other
  participant, so cost grows with room size. For real scale (dozens+), you'd want an SFU
  (e.g. mediasoup, LiveKit) so each person uploads once and the server fans it out — a
  meaningfully bigger piece of infrastructure (needs open UDP port ranges, which many
  simple PaaS setups don't expose) and out of scope here, but the signaling structure
  (rooms, presence, per-peer relay) would carry over directly if you outgrow mesh.
- **No authentication** — identity is a random ID stored in the browser, not a verified
  account. Anyone who opens the link becomes a new "user." Fine for casual/personal use;
  add real auth if you need to control who can join.
- **iOS Safari fullscreen**: the Fullscreen API has limited support on iOS Safari for
  arbitrary elements. The button works reliably on desktop Chrome/Firefox/Edge and Android
  Chrome; iOS Safari support may vary.
- **Message size cap**: 2000 characters per message; each 1:1 conversation keeps its most
  recent 200 messages in memory (older ones roll off) to bound memory growth.

## Project structure

```
.
├── server.js          # Express + Socket.IO: presence, chat, call-invite/ring layer,
│                       # and the mesh call-room signaling relay
├── package.json
├── Dockerfile           # Koyeb builds this automatically
└── public/
    ├── index.html         # All screens: setup, home (presence list), chat, outgoing/
    │                       # incoming call, active call (audio or video), ended
    ├── style.css           # Light WhatsApp-style chat/home UI + dark call UI
    └── app.js                # Identity, presence, chat, call-invite layer, and the
                                # mesh WebRTC engine (codec prefs, bitrate scaling, grid)
```
