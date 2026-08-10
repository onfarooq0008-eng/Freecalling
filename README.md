# Video Call — WhatsApp-style 1:1 video calling

A minimal WhatsApp-style video calling app: WebRTC for the actual audio/video (peer-to-peer),
Socket.IO for signaling, Express to serve the frontend. Two people, one "Call ID" shared
between them, no accounts needed.

## How it works

- Both people open the app, enter their name and the **same Call ID** (like agreeing on a
  room name), and land in a camera-preview "lobby" — just like WhatsApp's pre-call screen.
- Whoever taps **Call** first rings the other person (a "Calling…" screen, mirroring WhatsApp).
- The other person gets a full-screen **incoming call** with Accept/Decline.
- Once accepted, both sides see a full-screen remote video with a small draggable-style
  local preview in the corner, mute/camera/switch-camera controls, a call timer, and a red
  end-call button — the familiar WhatsApp video call layout.
- The actual video/audio streams directly between the two browsers (WebRTC/peer-to-peer).
  The server only exchanges the connection handshake (SDP offers/answers and ICE candidates).

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:8000` in two different browser tabs (or two devices on the
same network, using your machine's local IP instead of localhost) and use the same Call ID
in both.

## Deploy to Koyeb

### Option A — Deploy from GitHub (recommended)

1. Push this folder to a GitHub repo.
2. In the Koyeb dashboard: **Create Service → Deploy from GitHub**, pick the repo.
3. Koyeb will detect the `Dockerfile` automatically (Builder: Dockerfile).
4. Set the **port** to `8000` (this matches `EXPOSE 8000` in the Dockerfile — Koyeb also
   sets a `PORT` env var automatically, and `server.js` reads `process.env.PORT`, so this
   works either way).
5. Deploy. Koyeb gives you a public `https://<your-app>.koyeb.app` URL.
6. Share that URL + an agreed Call ID with the other person to test a call between two
   devices/networks.

### Option B — Deploy with the Koyeb CLI

```bash
# from inside this project folder
koyeb service create video-call \
  --app video-call \
  --git github.com/<your-username>/<your-repo> \
  --git-branch main \
  --git-builder docker \
  --ports 8000:http \
  --routes /:8000
```

(Adjust the app/service names as you like. If you deploy from a local Docker image instead
of GitHub, build with `docker build -t video-call .` and push it to a registry Koyeb can
pull from, then point the service at that image.)

## Important: HTTPS is required for camera/mic access

Browsers only allow `getUserMedia` (camera/mic) on secure origins. `localhost` is exempt
for local testing, but once deployed, everyone must use the `https://` Koyeb URL — Koyeb
provides this automatically, so no extra setup is needed there.

## A note on NAT/TURN (real-world reliability)

This app uses free public **STUN** servers (Google's) for NAT traversal, which works for
most home/office networks. Some networks (strict corporate firewalls, some mobile carriers,
symmetric NAT) will fail to connect peer-to-peer without a **TURN** server, which relays
media when a direct connection isn't possible. For a production/public deployment, consider
adding a TURN server — a couple of good options:

- Run your own with [coturn](https://github.com/coturn/coturn) (self-hosted, free).
- Use a managed service (e.g. Twilio, Metered, Xirsys) — they give you TURN credentials to
  drop into the `ICE_SERVERS` array in `public/app.js`.

To add TURN, just extend the list in `public/app.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-turn-server:3478',
    username: 'your-username',
    credential: 'your-credential',
  },
];
```

## Project structure

```
.
├── server.js          # Express + Socket.IO signaling server
├── package.json
├── Dockerfile          # Koyeb builds this automatically
└── public/
    ├── index.html       # All screens: setup, lobby, ringing, incoming, active call, ended
    ├── style.css         # WhatsApp-style dark call UI + light setup screens
    └── app.js              # WebRTC + signaling client logic
```

## Limitations (by design, for a minimal build)

- 1:1 calls only (no group calls).
- No authentication — anyone with the Call ID + link can join. Fine for personal use;
  add auth if you need access control.
- No call history, chat, or screen sharing (all addable later — the signaling channel
  already exists to build on).
