# DriveParty

Watch Google Drive videos in sync with friends. Anyone in the party can play, pause or seek and everyone follows, with a toggleable chat on the side.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, paste a Drive video link, and create a party. You'll get a 6-character code and an invite link.

**The Drive file must be shared as "Anyone with the link".** Browsers play MP4 (H.264 video + AAC audio) and WebM reliably. MKV files, HEVC/H.265 video, or AC3/DTS audio often won't play; convert them with HandBrake (preset "Fast 1080p30") first.

## Letting your friend in

`localhost` only works on your own computer. Pick one:

- **Same Wi-Fi:** share `http://<your-computer's-IP>:3000/party/CODE` (find the IP with `ipconfig getifaddr en0` on a Mac).
- **Over the internet, quick:** run a free Cloudflare tunnel and share the `https://….trycloudflare.com` URL it prints:
  ```bash
  brew install cloudflared
  cloudflared tunnel --url http://localhost:3000
  ```
  Open the party from the tunnel URL yourself too, so the invite link you copy uses it.
- **Always on:** deploy to Render. This repo includes a `render.yaml`: in Render, choose **New → Blueprint**, pick this repo, and click **Apply**. Any Node host works (start command `npm start`; the app respects `PORT`). Vercel doesn't, because it can't hold the live connections the sync needs.

Video streams through whichever machine runs the server. With a tunnel on your laptop, your friend's stream uses your home upload speed, so a hosted deploy is smoother for HD movies.

## Optional: Google API key

Big files sometimes hit Drive's public download limits. For more reliable streaming, create an API key with the Google Drive API enabled (Google Cloud Console → APIs & Services) and run:

```bash
GOOGLE_API_KEY=your-key npm start
```

The key stays on the server and is never sent to browsers.

## Shortcuts

`Space`/`K` play/pause · `←`/`→` skip 10s · `C` toggle chat · `F` fullscreen

## How sync works

The server keeps each party's official playback state: paused or playing, a position, and the server time it was set. Clients measure their clock offset to the server, so everyone calculates the same "where we should be right now". When someone plays, pauses or seeks, the server broadcasts the new state. Clients also correct drift every second: they speed up or slow down slightly when off by under 2 seconds, and jump to the right spot when further off.

Parties live in memory and disappear an hour after everyone leaves (or when the server restarts).
