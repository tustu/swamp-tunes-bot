# 🎶 Swamp Tunes — Discord Music Bot

A Discord bot that plays music from **YouTube**, **Spotify**, **SoundCloud**, **Deezer**, and **Apple Music** in voice channels.

## How each source works

| Source | What you can `/play` | How it works |
|---|---|---|
| YouTube | Search text or any YouTube link, including playlist links | Direct audio via yt-dlp |
| SoundCloud | Any SoundCloud link (sets queue the whole set), or `sc: song name` to search | Direct audio via yt-dlp |
| Spotify | Track, album, or playlist link | Link is read from Spotify's public pages (API keys optional), audio matched on YouTube |
| Deezer | Track, album, or playlist link | Link is read via Deezer's free API, audio matched on YouTube |
| Apple Music | Track, album, or playlist link | Track/album links are read via Apple's public iTunes lookup (no key); playlist links via the web-player API Apple's own site uses. Audio matched on YouTube, like Spotify |

Playlists queue up to **50 tracks** at once, from every service: YouTube playlists, SoundCloud sets, and Spotify/Deezer/Apple Music albums & playlists.

**Playlist rules for direct links:**
- A YouTube link with a `list=` in it (a `playlist?list=…` link, or a `watch?v=…&list=…` link) queues the whole playlist — **except** when the list is an `RD…` radio/mix id YouTube attaches to a single video; that plays just the video, since the "playlist" is only an auto-generated continuation.
- A SoundCloud `/sets/…` link queues the whole set; any other SoundCloud link is a single track. (A few set tracks are streaming-locked by their uploaders — those queue with their real titles and are skipped at play time if they can't load.)
- `/forceplay` always plays **one** song: given a playlist link from any service, it plays the playlist's first track.

## Commands

| Command | What it does |
|---|---|
| `/play <song, or link>` | Play a song / add it to the queue |
| `/stop` | Stop playback and clear everything |
| `/disconnect` | Stop everything and leave the voice channel |
| `/volume <0–200>` | Set volume |
| `/bassboost` | Toggle bass boost on/off (replays current song with boosted bass) |
| `/pause` | Pause / resume playback |
| `/queue` | Show the upcoming queue (numbered — the numbers `/move` and `/remove` use) |
| `/nowplaying` | Current song with progress bar, volume, loop mode, bass boost |
| `/lyrics [query]` | Lyrics for the current song, or for `Artist - Title` you name (via lyrics.ovh) |
| `/shuffle` | Shuffle the upcoming queue (current song untouched) |
| `/loop [mode]` | Loop `off` / `track` / `queue` — with no mode it cycles to the next one |
| `/move <from> <to>` | Move a queued song to a different queue position |
| `/remove <position>` | Remove a queued song by its `/queue` number |
| `/clear` | Clear the upcoming queue (current song keeps playing) |
| `/forceplay <song, or link>` | Play a song right now, interrupting (and discarding) the current one |
| `/forceskip` | Skip the current song immediately — no vote |
| `/theme [color] [style]` | Set this server's music embed color (hex) and thumbnail style — needs Manage Server |

Queued songs are **prefetched**: the next-up song's stream is resolved in the background as soon as it becomes next-up, so songs start instantly when their turn comes.

## File uploads

Server owners, admins, members with Manage Server, or anyone with the **Swamp DJ** role (rename it with the `DJ_ROLE_NAME` env var) can drop a **.mp3** or **.wav** file (max **10 MB**) into a text channel while sitting in a voice channel — the bot queues it and plays it like any other song, and deletes the temp file afterwards.

Uploads need the **Message Content Intent**: in the developer portal open your app → **Bot** → **Privileged Gateway Intents** → turn on **Message Content Intent**. If it's off, the bot still runs fine — uploads are simply disabled and a warning is logged at startup.

## Server themes

`/theme` stores a per-server embed color and thumbnail style (`track` = song artwork, `server` = server icon, `none`) in `themes.json` next to the code. Default is swamp green `#2bff88` with track thumbnails. The theme applies to `/play`, `/queue`, `/nowplaying`, and the automatic now-playing announcements.

## Profile

The bot dresses its own Discord profile on boot: avatar from `assets/profile-avatar.png`, banner from `assets/profile-banner.jpg` (only while no banner is set), and its About Me bio. A `profile-state.json` next to the code plus a live check of the current profile keep it from re-uploading every boot, and any failure is just a warning in the logs — the bot still starts.

## Setup (one time, ~10 minutes)

### 1. Create the Discord application
1. Go to **https://discord.com/developers/applications** → **New Application** → name it **Swamp Tunes**.
2. Open **Bot** in the left menu → **Reset Token** → copy the token (keep it secret).
3. In **OAuth2 → URL Generator**, tick scopes: `bot` and `applications.commands`. Tick bot permissions: **Send Messages**, **Embed Links**, **Connect**, **Speak**.
4. Open the generated URL, pick your server, authorize. The bot joins your server.

Slash commands need no privileged intents. File uploads (below) need the **Message Content Intent** enabled under **Bot → Privileged Gateway Intents** in the same portal — the bot runs fine without it, just with uploads off.

### 2. (Optional) Spotify API keys
Spotify links need **no setup at all** — the bot reads track, album, and playlist links from Spotify's public embed pages. If you want it to use the official Spotify API instead:
1. Go to **https://developer.spotify.com/dashboard** → log in → **Create app** (any name/description, e.g. "Swamp Tunes").
2. Copy the **Client ID** and **Client secret** into your `.env` as `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (or into Render's env vars).
3. With keys set, the API is tried first and the public pages remain as an automatic fallback if the keys fail — either way, Spotify links just work.

Deezer needs no setup at all.

Apple Music needs no setup either. Track and album links are read through Apple's public iTunes lookup endpoints with no key. Playlist links are read through the same keyless web-player API the Apple Music website itself uses — public playlists work, but private library playlists (links ending in `pl.u-…`) can't be read without signing in, so those show a friendly error.

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
- **Render** — `render.yaml` is included: push this folder to GitHub, create a new **Web Service** on Render from the repo (Free plan works — the bot exposes a health endpoint on `/`). Add the `DISCORD_TOKEN` env var (Spotify keys are optional — links work without them). Note: free services sleep after 15 minutes without web traffic, so the bot goes offline when idle and wakes on the next visit — a free uptime monitor (e.g. UptimeRobot) pinging the service URL every 10 minutes keeps it awake.
- **Railway / Fly.io** — deploy the included `Dockerfile`, set `DISCORD_TOKEN`.
- **Your own PC / VPS** — run `npm start` (or `docker build -t swamp-tunes . && docker run -e DISCORD_TOKEN=... swamp-tunes`).

## Notes
- The bot stays in the voice channel while songs are queued; `/stop` clears the queue, `/disconnect` makes it leave.
- YouTube sometimes rate-limits datacenter IPs — if a track won't load, redeploying or updating yt-dlp (`pip install -U yt-dlp`) usually fixes it. The Docker image installs the latest yt-dlp at build time.
- Keep your bot token secret. If it leaks, reset it in the developer portal.
