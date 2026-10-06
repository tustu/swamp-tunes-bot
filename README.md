# 🎶 Swamp Tunes — Discord Music Bot

A Discord bot that plays music from **YouTube**, **Spotify**, **SoundCloud**, and **Deezer** in voice channels.

## How each source works

| Source | What you can `/play` | How it works |
|---|---|---|
| YouTube | Search text or any YouTube link | Direct audio via yt-dlp |
| SoundCloud | Any SoundCloud link, or `sc: song name` to search | Direct audio via yt-dlp |
| Spotify | Track, album, or playlist link | Link is read via the Spotify API, audio matched on YouTube |
| Deezer | Track, album, or playlist link | Link is read via Deezer's free API, audio matched on YouTube |

Spotify/Deezer playlists and albums queue up to 50 tracks at once.

## Commands

| Command | What it does |
|---|---|
| `/play <song, or link>` | Play a song / add it to the queue |
| `/stop` | Stop playback and clear the queue |
| `/disconnect` | Stop everything and leave the voice channel |
| `/volume <0–200>` | Set volume |
| `/bassboost` | Toggle bass boost on/off (replays current song with boosted bass) |
| `/pause` | Pause / resume playback |

## Setup (one time, ~10 minutes)

### 1. Create the Discord application
1. Go to **https://discord.com/developers/applications** → **New Application** → name it **Swamp Tunes**.
2. Open **Bot** in the left menu → **Reset Token** → copy the token (keep it secret).
3. In **OAuth2 → URL Generator**, tick scopes: `bot` and `applications.commands`. Tick bot permissions: **Send Messages**, **Embed Links**, **Connect**, **Speak**.
4. Open the generated URL, pick your server, authorize. The bot joins your server.

No privileged intents are needed — the bot only uses slash commands.

### 2. (Optional) Enable Spotify links
Spotify links need free API credentials — 2 minutes:
1. Go to **https://developer.spotify.com/dashboard** → log in → **Create app** (any name/description, e.g. "Swamp Tunes").
2. Copy the **Client ID** and **Client secret** into your `.env` as `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (or into Render's env vars).
3. Without these, Spotify links show an error — YouTube, SoundCloud, and Deezer keep working.

Deezer needs no setup at all.

### 3. Run it locally
Requirements: Node 20+, `ffmpeg`, and `yt-dlp` (`pip install yt-dlp`).

```bash
cd discord-music-bot
cp .env.example .env        # then paste your token (and Spotify keys) into .env
npm install
npm start
```

Tip: add your server's ID as `GUILD_ID` in `.env` (Server Settings → enable Developer Mode → right-click server → Copy Server ID) and slash commands appear instantly. Without it, global commands can take up to an hour to show up.

### 4. Keep it online 24/7 (pick one)
- **Render** — `render.yaml` is included: push this folder to GitHub, create a new **Background Worker** on Render from the repo, add the `DISCORD_TOKEN` env var (plus Spotify keys if you want Spotify links). Free tier works.
- **Railway / Fly.io** — deploy the included `Dockerfile`, set `DISCORD_TOKEN`.
- **Your own PC / VPS** — run `npm start` (or `docker build -t swamp-tunes . && docker run -e DISCORD_TOKEN=... swamp-tunes`).

## Notes
- The bot stays in the voice channel while songs are queued; `/stop` clears the queue, `/disconnect` makes it leave.
- YouTube sometimes rate-limits datacenter IPs — if a track won't load, redeploying or updating yt-dlp (`pip install -U yt-dlp`) usually fixes it. The Docker image installs the latest yt-dlp at build time.
- Keep your bot token secret. If it leaks, reset it in the developer portal.
