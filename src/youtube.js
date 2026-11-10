import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Node IS present wherever this bot runs (the Docker image is Node 20), and
// YouTube extraction needs a JS runtime for its player challenges — without
// this yt-dlp warns "No supported JavaScript runtime could be found" and
// stream extraction fails far more often. Passed on every yt-dlp call.
const JS_RUNTIME_ARGS = ['--js-runtimes', 'node'];

function yt(args, { timeout = 45000 } = {}) {
  return execFileAsync('yt-dlp', [...JS_RUNTIME_ARGS, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimited(err) {
  return /HTTP Error 429|Too Many Requests/i.test(`${err?.stderr || ''} ${err?.message || ''}`);
}

/**
 * yt() for metadata / search / resolve calls, with backoff on HTTP 429.
 * YouTube rate-limits datacenter IPs in bursts; firing parallel lookups
 * into a 429 used to fail the whole batch instantly. Two retries
 * (1.5s, then 4s) ride out most bursts. Non-429 errors throw at once.
 */
async function ytMeta(args, opts) {
  const BACKOFF = [1500, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await yt(args, opts);
    } catch (err) {
      if (!isRateLimited(err) || attempt >= BACKOFF.length) throw err;
      await sleep(BACKOFF[attempt]);
    }
  }
}

/**
 * Stream extractions are serialized: at most ONE runs at a time, process
 * wide. Parallel -g lookups from one IP are exactly what trips YouTube's
 * 429 wall; a queue costs a little latency and buys a lot of reliability.
 * Prefetch and play-time resolution both pass through this lock.
 */
let streamChain = Promise.resolve();
function withStreamLock(fn) {
  const run = streamChain.then(fn, fn);
  streamChain = run.then(() => {}, () => {});
  return run;
}

/** Returns yt-dlp version string, or null if the binary is missing. */
export async function checkYtDlp() {
  try {
    const { stdout } = await yt(['--version']);
    return stdout.trim().split('\n').pop();
  } catch {
    return null;
  }
}

const PRINT = '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s\t%(webpage_url)s';

function parseTrackLine(line) {
  const [id, title, dur, uploader, thumbnail, webpageUrl] = line.trim().split('\t');
  if (!id) throw new Error('Could not resolve that track.');
  const track = {
    id,
    title: (title || 'Unknown title').replace(/\s+/g, ' ').trim(),
    duration: Number(dur) || 0,
    // Keep the track's real page URL: YouTube results point at their watch
    // page (same URL we used to construct), and SoundCloud tracks keep
    // their soundcloud.com URL, which the player needs in order to stream
    // them (see streamUrlFor).
    url: webpageUrl && webpageUrl.startsWith('http')
      ? webpageUrl
      : `https://www.youtube.com/watch?v=${id}`,
  };
  // Extra metadata for /lyrics and embed thumbnails — 'NA' when yt-dlp lacks it.
  if (uploader && uploader !== 'NA') track.uploader = uploader.replace(/\s+/g, ' ').trim();
  if (thumbnail && thumbnail.startsWith('http')) track.thumbnail = thumbnail;
  return track;
}

function searchFirstLine(stdout) {
  const line = stdout.split('\n').find((l) => l.trim());
  if (!line) throw new Error('No results found.');
  return parseTrackLine(line);
}

/**
 * Resolve a search query or a media URL to a single track.
 * - Plain text searches YouTube (prefix with "sc:" to search SoundCloud instead).
 * - URLs go straight to yt-dlp, which handles YouTube, SoundCloud, and many
 *   other sites. Playlist URLs are forced to a single video (--no-playlist);
 *   whole-playlist queueing lives in resolvePlaylistTracks below, and /play
 *   routes playlist links there. /forceplay uses this on purpose: a playlist
 *   link forceplays just its first track.
 */
export async function resolveTrack(query) {
  const q = query.trim();
  if (/^https?:\/\//i.test(q)) {
    const { stdout } = await ytMeta(['--no-playlist', '--skip-download', '--print', PRINT, q]);
    return searchFirstLine(stdout);
  }
  const sc = q.match(/^(?:sc:|soundcloud:)\s*(.+)/i);
  const target = sc ? sc[1] : q;
  const prefix = sc ? 'scsearch1:' : 'ytsearch1:';
  const { stdout } = await ytMeta([
    '--no-playlist',
    '--skip-download',
    '--print',
    PRINT,
    `${prefix}${target}`,
  ]);
  return searchFirstLine(stdout);
}

/**
 * Find the best YouTube match for a { title, artist } pair.
 * Used to play Spotify / Deezer links, whose audio comes from YouTube.
 */
export async function findOnYouTube(title, artist) {
  const q = `${title} ${artist || ''}`.trim();
  const { stdout } = await ytMeta([
    '--no-playlist',
    '--skip-download',
    '--print',
    PRINT,
    `ytsearch1:${q}`,
  ]);
  try {
    return searchFirstLine(stdout);
  } catch {
    throw new Error(`No YouTube match for "${q}"`);
  }
}

/** Strip the decorations YouTube titles carry, for search queries. */
function cleanTitleForSearch(title) {
  return String(title || '')
    .replace(/\s*[\(\[][^)\]]*(official|music video|lyric|audio|visualizer|hd|4k)[^)\]]*[\)\]]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Run a yt-dlp search (ytsearch / scsearch) and parse up to n tracks. */
async function searchTracks(prefix, query, n = 5) {
  const { stdout } = await ytMeta([
    '--no-playlist',
    '--skip-download',
    '--print',
    PRINT,
    `${prefix}${n}:${query}`,
  ]);
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return parseTrackLine(l); } catch { return null; } })
    .filter(Boolean);
}

/** Up to 5 YouTube search results for a { title, artist } pair. */
export function searchOnYouTube(title, artist) {
  const q = `${cleanTitleForSearch(title) || title} ${artist || ''}`.trim();
  return searchTracks('ytsearch', q);
}

/** Up to 5 SoundCloud search results for a { title, artist } pair. */
export function searchOnSoundCloud(title, artist) {
  const q = `${cleanTitleForSearch(title) || title} ${artist || ''}`.trim();
  return searchTracks('scsearch', q);
}

/**
 * Find the best SoundCloud match for a { title, artist } pair.
 * The player's safety net: when YouTube bot-walls this host entirely,
 * the same song is streamed from soundcloud.com instead — SoundCloud
 * does not bot-wall datacenter IPs.
 */
export async function findOnSoundCloud(title, artist) {
  const results = await searchOnSoundCloud(title, artist);
  if (!results.length) {
    throw new Error(`No SoundCloud match for "${`${title} ${artist || ''}`.trim()}"`);
  }
  return results[0];
}

/**
 * One stream extraction attempt for a page URL, quality-first: the
 * format selector takes the best audio the response offers (bestaudio),
 * and the format sort ranks by bitrate with Opus preferred — Opus also
 * matters downstream, because an Opus/WebM stream passes through the
 * voice layer without a re-encode, while anything else is transcoded.
 * Returns { url, formatId, audioOnly, abr } — abr in kbps, null when
 * the source doesn't report one.
 */
async function extractStream(target, extraArgs = []) {
  const { stdout } = await yt([
    '--no-playlist',
    '-f',
    'bestaudio/best',
    '--format-sort',
    'abr,acodec:opus',
    ...extraArgs,
    '--print',
    '%(format_id)s\t%(vcodec)s\t%(abr)s\t%(url)s',
    target,
  ]);
  const line = stdout.trim().split('\n')[0] || '';
  const [formatId, vcodec, abrRaw, url] = line.split('\t');
  if (!url || !url.startsWith('http')) throw new Error('Could not get an audio stream.');
  return {
    url,
    formatId: formatId || '?',
    audioOnly: vcodec === 'none',
    abr: Number(abrRaw) > 0 ? Number(abrRaw) : null,
  };
}

// YouTube player clients tried, in order, for stream extraction. The
// default web client is the one YouTube bot-walls on datacenter IPs
// ("Sign in to confirm you're not a bot" / HTTP 429); the app and TV
// clients are challenged far less, so they go first. One attempt each.
const YT_PLAYER_CLIENTS = ['android', 'ios', 'tv', 'web_embedded', 'web'];

/** Is candidate stream `a` strictly better than `b`? Audio-only beats
 *  muxed (its audio bitrate is almost always higher, and it avoids a
 *  video download); then higher bitrate wins. */
function streamBeats(a, b) {
  if (a.audioOnly !== b.audioOnly) return a.audioOnly;
  return (a.abr || 0) > (b.abr || 0);
}

function describeStream(s) {
  return `fmt ${s.formatId}${s.abr ? ` ~${Math.round(s.abr)}kbps` : ''}${s.audioOnly ? '' : ' (muxed)'}`;
}

/**
 * Direct audio stream URL for a track (the URL itself expires after a few
 * hours — fine for a queue). YouTube tracks stream from their watch page;
 * other services (SoundCloud) stream from the track's own page URL, which
 * yt-dlp also knows how to read — pass it as pageUrl when the track has one.
 *
 * YouTube targets rotate through YT_PLAYER_CLIENTS, quality-first: a
 * proper audio-only stream at a good bitrate is accepted on the spot,
 * but a client that only offers a low or muxed format doesn't end the
 * search — the remaining clients still get their one attempt each, and
 * the best result overall wins. Attempts stay bounded (one per client).
 * All extractions are serialized through withStreamLock (see above) so
 * prefetch and play-time lookups never stampede YouTube in parallel.
 */
export async function streamUrlFor(videoId, pageUrl) {
  const target = pageUrl && /^https?:\/\//i.test(pageUrl)
    ? pageUrl
    : `https://www.youtube.com/watch?v=${videoId}`;
  return withStreamLock(async () => {
    if (!/(^|\.)youtube\.com|(^|\.)youtu\.be/i.test(new URL(target).hostname)) {
      const s = await extractStream(target);
      return s.url;
    }
    let best = null;
    let lastErr = null;
    for (const client of YT_PLAYER_CLIENTS) {
      let s;
      try {
        s = await extractStream(target, [
          '--extractor-args', `youtube:player_client=${client}`,
        ]);
      } catch (err) {
        lastErr = err;
        continue;
      }
      const candidate = { ...s, client };
      if (candidate.audioOnly && (candidate.abr === null || candidate.abr >= 96)) {
        console.log(`[Swamp Tunes] stream extracted via youtube client "${client}" (${describeStream(candidate)})`);
        return candidate.url;
      }
      if (!best || streamBeats(candidate, best)) best = candidate;
    }
    if (best) {
      console.log(`[Swamp Tunes] stream extracted via youtube client "${best.client}" (${describeStream(best)})`);
      return best.url;
    }
    throw lastErr || new Error('Could not get an audio stream.');
  });
}

// --- Playlists (YouTube playlists and SoundCloud sets) ---------------------

export const PLAYLIST_CAP = 50;

/**
 * Does this direct link mean "queue the whole playlist"?
 * Returns { service: 'YouTube' | 'SoundCloud', listId? , url } or null.
 *
 * YouTube rule: any youtube.com / music.youtube.com / youtu.be link carrying
 * a list= parameter is a playlist — with one exception. A watch link whose
 * list is an RD… id is a radio/mix continuation YouTube tacks onto a single
 * video, not a playlist somebody made, so that plays just the video. (A bare
 * playlist?list=RD… link has no video to fall back on and is still treated
 * as a playlist.) WL/LL lists are private and fail at read time.
 * SoundCloud rule: /sets/ links are playlists (sets). Everything else on
 * SoundCloud is a single track.
 */
export function parsePlaylistLink(query) {
  const q = (query || '').trim();
  if (!/^https?:\/\//i.test(q)) return null;
  let u;
  try { u = new URL(q); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();

  if (host === 'soundcloud.com' || host === 'm.soundcloud.com') {
    return /\/sets\//i.test(u.pathname) ? { service: 'SoundCloud', url: q } : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    const list = u.searchParams.get('list');
    if (!list) return null;
    const videoId = host === 'youtu.be'
      ? u.pathname.split('/').filter(Boolean)[0]
      : u.searchParams.get('v');
    if (videoId && /^RD/i.test(list)) return null; // radio/mix — play the video
    return { service: 'YouTube', listId: list };
  }
  return null;
}

/** Resolve a playlist link to full playable tracks (resolveTrack's shape). Caps at 50. */
export async function resolvePlaylistTracks(query) {
  const info = parsePlaylistLink(query);
  if (!info) throw new Error('That is not a playlist link I can read.');
  return info.service === 'YouTube'
    ? resolveYouTubePlaylist(info.listId)
    : resolveSoundCloudSet(info.url);
}

async function resolveYouTubePlaylist(listId) {
  let data;
  try {
    // --flat-playlist: entries come back with id/title/duration/uploader in
    // one fast pass instead of a full extraction per video.
    const { stdout } = await ytMeta([
      '--flat-playlist',
      '-J',
      '--playlist-end', String(PLAYLIST_CAP),
      '--no-warnings',
      `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
    ], { timeout: 90_000 });
    data = JSON.parse(stdout);
  } catch {
    throw new Error('Could not read that YouTube playlist (it may be private or unavailable).');
  }
  const tracks = (data.entries || [])
    .filter((e) => e && e.id && e.title && !/^\[(Private|Deleted) video\]$/i.test(e.title.trim()))
    .slice(0, PLAYLIST_CAP)
    .map((e) => {
      const track = {
        id: e.id,
        title: String(e.title).replace(/\s+/g, ' ').trim(),
        duration: Number(e.duration) || 0,
        url: e.url && e.url.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      };
      const uploader = e.uploader || e.channel;
      if (uploader) track.uploader = String(uploader).replace(/\s+/g, ' ').trim();
      const thumb = (e.thumbnails || []).find((t) => t.url)?.url;
      if (thumb) track.thumbnail = thumb;
      return track;
    });
  if (!tracks.length) throw new Error('That YouTube playlist has no playable videos (it may be private).');
  return tracks;
}

const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function resolveSoundCloudSet(url) {
  // Keyless, via SoundCloud's own public API: a set's page carries the web
  // player's (rotating) API client id in its hydration data — the same
  // ships-in-the-page pattern the Apple Music resolver uses. With it, the
  // API resolves the set: its track list arrives as a few full track
  // objects plus id-only stubs, and one batch call fills the stubs in.
  try {
    const tracks = await soundCloudApiResolve(url);
    if (tracks.length) return tracks;
  } catch { /* fall through to the yt-dlp path */ }

  // Fallback: yt-dlp lists the set's track URLs (its flat entries carry no
  // titles), then each track is resolved for metadata like a single play.
  let entries;
  try {
    const { stdout } = await ytMeta([
      '--flat-playlist',
      '-J',
      '--playlist-end', String(PLAYLIST_CAP),
      '--no-warnings',
      url,
    ], { timeout: 90_000 });
    entries = (JSON.parse(stdout).entries || []).filter((e) => e && e.url);
  } catch {
    throw new Error('Could not read that SoundCloud set (it may be private or unavailable).');
  }
  if (!entries.length) throw new Error('That SoundCloud set has no playable tracks (it may be private).');
  const tracks = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((e) => resolveTrack(e.url)));
    for (const r of results) {
      if (r.status === 'fulfilled') tracks.push(r.value);
    }
  }
  if (!tracks.length) throw new Error('That SoundCloud set has no playable tracks (it may be private).');
  return tracks.slice(0, PLAYLIST_CAP);
}

/**
 * The web player's API client id, scraped from the set page's own
 * hydration data (the "apiClient" entry — the same ships-in-the-page
 * pattern the Apple Music resolver uses). SoundCloud rotates these ids,
 * so it is cached per process and re-scraped whenever the API rejects it.
 */
let scClientId = null;

async function getSoundCloudClientId(setUrl) {
  if (scClientId) return scClientId;
  const res = await fetch(setUrl, { headers: { 'User-Agent': SC_UA } });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/window\.__sc_hydration = (\[[\s\S]*?\]);<\/script>/);
  if (!m) return null;
  const items = JSON.parse(m[1]);
  const id = items.find((i) => i.hydratable === 'apiClient')?.data?.id;
  if (id) scClientId = id;
  return scClientId;
}

const scTrackShape = (t) => {
  const track = {
    id: String(t.id),
    title: String(t.title).replace(/\s+/g, ' ').trim(),
    duration: t.duration ? Math.round(t.duration / 1000) : 0,
    url: t.permalink_url,
  };
  if (t.user?.username) track.uploader = t.user.username;
  return track;
};

/**
 * Resolve a set through SoundCloud's public API (api-v2): resolve the set
 * URL, then batch-fill the id-only stub tracks via the tracks endpoint so
 * every entry comes back with full metadata, in set order.
 */
async function soundCloudApiResolve(setUrl) {
  const clientId = await getSoundCloudClientId(setUrl).catch(() => null);
  if (!clientId) return [];
  const api = (path) => fetch(`https://api-v2.soundcloud.com${path}`, {
    headers: { 'User-Agent': SC_UA },
  });
  const res = await api(`/resolve?url=${encodeURIComponent(setUrl)}&client_id=${clientId}`);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) scClientId = null; // rotated id — re-scrape next time
    return [];
  }
  const data = await res.json();
  const listed = (data.tracks || []).slice(0, PLAYLIST_CAP);
  const stubIds = listed.filter((t) => t && !(t.title && t.permalink_url)).map((t) => t.id);
  const filled = new Map();
  if (stubIds.length) {
    const tres = await api(`/tracks?ids=${stubIds.join(',')}&client_id=${clientId}`);
    if (tres.ok) {
      for (const t of await tres.json()) {
        if (t && t.id) filled.set(t.id, t);
      }
    }
  }
  return listed
    .map((t) => (t && t.title && t.permalink_url ? t : filled.get(t?.id)))
    .filter((t) => t && t.id && t.title && t.permalink_url)
    .map(scTrackShape);
}

export function formatDuration(sec) {
  if (!sec || sec <= 0) return 'LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
