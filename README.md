# DriveParty

Watch Google Drive videos in sync with friends. Anyone in the party can play, pause or seek and everyone follows, with a toggleable chat on the side.

Everyone signs in with their own Google account and streams the video **directly from Google Drive**. The video never passes through the DriveParty server, which only relays play/pause/seek and chat messages (a few KB), so hosting bandwidth stays near zero. The file only needs to be shared with your friends' Google accounts, not made public.

## How a party works

1. Share the video in Google Drive with your friend's Google account.
2. On DriveParty, sign in with Google, click **Choose a video from Google Drive**, and pick it.
3. Send your friend the invite link. They sign in with their Google account. The first time, they click **Open it from Google Drive** and select the video in Google's picker, which gives DriveParty permission to open that one file for them.
4. Anyone can play, pause or seek, and everyone follows.

DriveParty only asks for access to **the files each person picks**, not their whole Drive.

Browsers play MP4 (H.264 video + AAC audio), WebM and HLS streams reliably. MKV files, HEVC/H.265 video, or AC3/DTS audio often won't play; convert them with HandBrake (preset "Fast 1080p30") first.

## HLS streams (.m3u8)

**HLS links.** Paste an `.m3u8` link when creating a party or changing the video. It plays with [hls.js](https://github.com/video-dev/hls.js) (or Safari's built-in HLS), and each viewer loads it straight from the host, so no sign-in is needed and no bandwidth goes through DriveParty. The host has to allow playback from other websites (CORS); most streaming CDNs do. Signed links that expire will stop working for guests who join later.

**HLS in Google Drive.** Upload the playlist and all of its files into **one Drive folder**, share the folder with your friends, then choose the `.m3u8` file in the picker (it's under **All files**). DriveParty finds each file the playlist mentions by name in that folder, so:

- Keep every file (variant playlists, segments, keys, `init.mp4`) directly in that folder, with unique names. Subfolders in playlist paths are fine as long as the file names don't repeat.
- Because DriveParty only gets access to files each person selects, everyone is asked once to **select all the stream's files** in the picker: click the first file, then Shift-click the last.

Hundreds of segment files make that selection slow. For Drive, a single MP4 is simplest; if you need HLS, fewer, longer segments (e.g. 10 seconds) help.

## Google setup (one time, ~10 minutes)

DriveParty needs its own Google Cloud project for sign-in. All free.

1. Go to https://console.cloud.google.com and create a project (e.g. "DriveParty").
2. **APIs & Services → Library:** enable **Google Drive API** and **Google Picker API**.
3. **Google Auth Platform** (called "OAuth consent screen" in some consoles):
   - Click **Get started**. Enter an app name and your email, choose **External** audience, and finish.
   - **Data access → Add or remove scopes:** add `.../auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app").
   - **Audience:** click **Publish app** so friends can sign in. Because `drive.file` isn't a sensitive scope, Google doesn't require a review. (If you stay in "Testing" instead, you must add each friend under Test users, and sign-ins expire after 7 days.)
4. **Clients → Create client → Web application:**
   - Under **Authorized JavaScript origins**, add `http://localhost:3000` and your deployed URL (e.g. `https://driveparty-xxxx.onrender.com`). No redirect URIs are needed.
   - Copy the **Client ID** and **Client secret**.
5. **APIs & Services → Credentials → Create credentials → API key.** Edit the key:
   - Application restrictions: **Websites**, add `http://localhost:3000/*` and `https://driveparty-xxxx.onrender.com/*`.
   - API restrictions: **Google Picker API** only.
6. Find your **project number** on the Cloud console home page (Project info card), or under IAM & Admin → Settings.

## Run it locally

```bash
npm install
cp .env.example .env   # then fill in the values from Google setup
npm start
```

For `SESSION_SECRET`, use any long random string, e.g. the output of `openssl rand -hex 32`. Open http://localhost:3000.

## Deploy to Render

This repo includes a `render.yaml`. In Render, choose **New → Blueprint**, pick this repo, and click **Apply**. Render will ask for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_API_KEY` and `GOOGLE_PROJECT_NUMBER`; it generates `SESSION_SECRET` for you. Then add the Render URL to the OAuth client's JavaScript origins and the API key's website restrictions (steps 4–5 above).

Any Node host works (start command `npm start`; the app respects `PORT`). Vercel doesn't, because it can't hold the live connections the sync needs.

Video streaming requires a secure address: `https://` or `localhost`. Plain `http://192.168.x.x` LAN addresses won't stream. For quick testing with a friend without deploying, use a tunnel and add its URL to your Google origins:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

## Shortcuts

`Space`/`K` play/pause · `←`/`→` skip 10s · `C` toggle chat · `F` fullscreen

## How it works

**Streaming.** A `<video>` element can't attach a Google access token to its requests, so the page installs a service worker (`public/sw.js`). The video loads `/media/drive/<file id>`; the worker catches those requests and re-sends them to the Drive API with the viewer's token and the requested byte range. That's how seeking works without downloading the whole file. Google hides the `Content-Range` header from browsers, so the worker rebuilds it from the file size.

**HLS from Drive.** The worker also serves `/media/drive-hls/<playlist id>/<file name>`. It lists the files in the playlist's folder that the viewer has opened with DriveParty, matches the name, and streams that file, so hls.js can follow the playlist's relative paths as if it were a normal web folder.

**Sign-in.** Google's sign-in popup returns a one-time code. The server exchanges it for a refresh token, encrypts it with `SESSION_SECRET`, and stores it in the viewer's own cookie; the server keeps no user database. The worker asks `/api/token` for a fresh hour-long access token whenever it needs one, so long movies keep playing.

**Sync.** The server keeps each party's official playback state: paused or playing, a position, and the server time it was set. Clients measure their clock offset to the server, so everyone calculates the same "where we should be right now". When someone plays, pauses or seeks, the server broadcasts the new state. Clients also correct drift every second: they speed up or slow down slightly when off by under 2 seconds, and jump to the right spot when further off.

Parties live in memory and disappear an hour after everyone leaves (or when the server restarts).
