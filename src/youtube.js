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
 * The queue is two-lane: play-time lookups (priority 'high', the default)
 * always jump ahead of queued prefetch lookups ('low') — a song somebody
 * is waiting to hear never sits behind background warming. A lookup that
 * is already running is never preempted, but it is timeout-bounded.
 */
const streamWaiters = [];
let streamRunning = false;

function pumpStreamQueue() {
  if (streamRunning) return;
  const idx = streamWaiters.findIndex((w) => w.priority === 'high');
  const next = idx >= 0 ? streamWaiters.splice(idx, 1)[0] : streamWaiters.shift();
  if (!next) return;
  streamRunning = true;
  Promise.resolve()
    .then(next.fn)
    .then(next.resolve, next.reject)
    .finally(() => { streamRunning = false; pumpStreamQueue(); });
}

function withStreamLock(fn, priority = 'high') {
  return new Promise((resolve, reject) => {
    streamWaiters.push({ fn, priority, resolve, reject });
    pumpStreamQueue();
  });
}

/** The most informative one-liner from a yt-dlp / fetch failure, for logs. */
export function errReason(err) {
  const stderr = String(err?.stderr || '').trim();
  const errLine = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
    .find((l) => /^ERROR/i.test(l)) || stderr.split('\n').filter((l) => l.trim()).pop();
  const raw = errLine || String(err?.message || err || 'unknown error').split('\n')[0];
  return raw.replace(/^ERROR:\s*/i, '').slice(0, 160);
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
 * Resolve a plain-text /play query (a song name, not a link) to ONE track.
 * SoundCloud's own API goes first: it answers in about a second and its
 * tracks stream natively, while a yt-dlp YouTube search from a datacenter
 * IP dies on the bot wall (429/403, "failed to extract any player
 * response") before the playback cascade ever gets a track — that was
 * the /play front door failing while the player behind it was fine.
 * Backups, in order: the yt-dlp SoundCloud search, then ONE no-retry
 * YouTube search with a short cap. Throws a plain "no results" error.
 */
export async function resolveTextQuery(query) {
  const q = query.trim();
  const sc = q.match(/^(?:sc:|soundcloud:)\s*(.+)/i);
  const text = sc ? sc[1] : q;
  if (!sc) {
    const viaApi = await searchOnSoundCloudApi(text, '', { timeoutMs: 6_000 }).catch(() => []);
    if (viaApi.length) return viaApi[0];
    // Not on SoundCloud: resolve the name against YouTube's own catalog
    // through an Invidious instance (YouTube search itself is walled
    // from this host; the instance is not). The returned track carries
    // the real video id, and the player streams it via Invidious too.
    const viaInv = await searchOnInvidious(text).catch(() => []);
    if (viaInv.length) return viaInv[0];
  }
  const viaScSearch = await searchOnSoundCloud(text, '', { timeoutMs: 10_000, retry: false }).catch(() => []);
  if (viaScSearch.length) return viaScSearch[0];
  const viaYt = await searchOnYouTube(text, '', { timeoutMs: 10_000, retry: false }).catch(() => []);
  if (viaYt.length) return viaYt[0];
  throw new Error(`No results found for "${text}".`);
}

/**
 * Find the best YouTube match for a { title, artist } pair.
 * Used to play Spotify / Deezer links, whose audio comes from YouTube.
 */
/** Extract a YouTube video id from any YouTube URL form, or null. */
export function youtubeVideoId(url) {
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? m[1] : null;
}

/** One video's metadata via a public Invidious instance. Null on failure. */
export async function getVideoOnInvidious(videoId, opts = {}) {
  const hosts = await invidiousHosts();
  const timeoutMs = opts.timeoutMs || 6_000;
  for (const host of hosts.slice(0, 2)) {
    try {
      const res = await fetch(
        `https://${host}/api/v1/videos/${encodeURIComponent(videoId)}?fields=videoId,title,author,lengthSeconds,videoThumbnails`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) continue;
      const v = await res.json();
      if (!v?.videoId || !v?.title) continue;
      const thumbs = Array.isArray(v.videoThumbnails) ? v.videoThumbnails : [];
      const thumb = thumbs.find((t) => t.quality === 'maxres') || thumbs[0];
      const track = {
        id: v.videoId,
        title: String(v.title).replace(/\s+/g, ' ').trim(),
        duration: Number(v.lengthSeconds) || 0,
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
      };
      if (v.author) track.uploader = String(v.author).replace(/\s+/g, ' ').trim();
      if (thumb?.url) track.thumbnail = thumb.url.startsWith('http') ? thumb.url : `https://${host}${thumb.url}`;
      return track;
    } catch { /* try the next instance */ }
  }
  return null;
}

/**
 * Resolve a pasted YouTube link WITHOUT yt-dlp first: from a datacenter
 * IP, yt-dlp's own extraction is walled (429/403, "failed to extract any
 * player response") and grinds through client retries for the better
 * part of a minute before throwing — that was a pasted link dying at
 * the /play front door even after the playback chain behind it worked.
 * The video's identity comes from an Invidious instance instead (fast,
 * unwalled); the playback cascade in the player does the rest. oEmbed
 * is the second door; yt-dlp stays only as the last resort.
 */
export async function resolveYouTubeUrl(url) {
  const id = youtubeVideoId(url);
  if (!id) return resolveTrack(url);
  const viaInv = await getVideoOnInvidious(id).catch(() => null);
  if (viaInv) return viaInv;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.title) {
        return await resolveTextQuery(`${data.title} ${data.author_name || ''}`.trim());
      }
    }
  } catch { /* fall through to the yt-dlp last resort */ }
  return resolveTrack(url);
}

/**
 * The one resolver /play and /forceplay use for a raw query: YouTube
 * links go through the unwalled side doors, other links keep the
 * direct yt-dlp route, and plain text goes SoundCloud-first.
 */
export async function resolveAnyQuery(query) {
  const q = String(query).trim();
  if (/^https?:\/\//i.test(q)) {
    return youtubeVideoId(q) ? resolveYouTubeUrl(q) : resolveTrack(q);
  }
  return resolveTextQuery(q);
}

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

/** Run a yt-dlp search (ytsearch / scsearch) and parse up to n tracks.
 *  `-i` (--ignore-errors) matters: one DRM-protected or deleted entry in a
 *  result set otherwise makes yt-dlp exit non-zero and throws the whole
 *  batch away, including perfectly playable results (seen live with
 *  SoundCloud search, where official uploads are often DRM-flagged). */
async function searchTracks(prefix, query, n = 5, timeoutMs = 30_000, retry = true) {
  const run = retry ? ytMeta : yt;
  const { stdout } = await run([
    '-i',
    '--no-playlist',
    '--skip-download',
    '--print',
    PRINT,
    `${prefix}${n}:${query}`,
  ], { timeout: timeoutMs });
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return parseTrackLine(l); } catch { return null; } })
    .filter(Boolean);
}

/** Up to 5 YouTube search results for a { title, artist } pair.
 *  opts: { timeoutMs, retry } — the player's cascade passes retry:false
 *  so a 429 backoff can't overrun its hard per-track budget. */
export function searchOnYouTube(title, artist, opts = {}) {
  const q = `${cleanTitleForSearch(title) || title} ${artist || ''}`.trim();
  return searchTracks('ytsearch', q, 5, opts.timeoutMs, opts.retry !== false);
}

/** Up to 5 SoundCloud search results for a { title, artist } pair. */
export function searchOnSoundCloud(title, artist, opts = {}) {
  const q = `${cleanTitleForSearch(title) || title} ${artist || ''}`.trim();
  return searchTracks('scsearch', q, 5, opts.timeoutMs, opts.retry !== false);
}

/**
 * Find the first SoundCloud match for a { title, artist } pair.
 * Kept for compatibility; the player runs the fuller cascade in
 * searchOnSoundCloudApi / searchOnSoundCloud + the same-song gate.
 */
export async function findOnSoundCloud(title, artist) {
  const results = await searchOnSoundCloud(title, artist);
  if (!results.length) {
    throw new Error(`No SoundCloud match for "${`${title} ${artist || ''}`.trim()}"`);
  }
  return results[0];
}

/**
 * Search SoundCloud through its own web API (api-v2), keyless — the same
 * ships-in-the-page client id the set resolver scrapes. This is the
 * player's PRIMARY search: it is fast (~1s vs ~10s+ for a yt-dlp
 * search), and its ranking puts the artist's own upload first, where
 * yt-dlp's scsearch often surfaces remixes and misses the song entirely
 * (verified live: all three of a test batch were found here first try,
 * two of them invisible to scsearch). Returns track-shaped results
 * (same shape as parseTrackLine / scTrackShape). Returns [] on any
 * failure — callers fall back to the yt-dlp search.
 * Note the API also lists tracks whose only streams are SAMPLE-AES
 * (FairPlay) DRM — those come back streamable here but fail extraction;
 * the player iterates candidates until one actually extracts.
 */
export async function searchOnSoundCloudApi(title, artist, opts = {}) {
  const q = `${cleanTitleForSearch(title) || title} ${artist || ''}`.trim();
  const timeoutMs = opts.timeoutMs || 8_000;
  let clientId = await getSoundCloudClientId().catch(() => null);
  if (!clientId) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${clientId}&limit=10`,
      { headers: { 'User-Agent': SC_UA }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      scClientId = null; // rotated id — re-scrape and retry once
      clientId = await getSoundCloudClientId().catch(() => null);
      if (!clientId) return [];
      continue;
    }
    if (!res.ok) return [];
    const data = await res.json();
    return (data.collection || [])
      .filter((t) => t && t.streamable !== false && t.title && t.permalink_url)
      .map(scTrackShape);
  }
  return [];
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
async function extractStream(target, extraArgs = [], timeoutMs = 15_000) {
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
  ], { timeout: timeoutMs });
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
 * the best result overall wins.
 *
 * Budgets (opts): every attempt is capped at opts.attemptMs (default
 * 15s) and the whole call gives up once opts.deadline (epoch ms) passes —
 * a walled host must fail in seconds, not grind for minutes. All
 * extractions are serialized through the two-lane stream lock (see
 * above): opts.priority 'high' (play time, default) jumps queued
 * prefetch ('low') lookups.
 */
export async function streamUrlFor(videoId, pageUrl, opts = {}) {
  const target = pageUrl && /^https?:\/\//i.test(pageUrl)
    ? pageUrl
    : `https://www.youtube.com/watch?v=${videoId}`;
  const priority = opts.priority || 'high';
  const attemptMs = opts.attemptMs || 15_000;
  const deadline = opts.deadline || null;
  const attemptTimeout = () => {
    const cap = deadline ? deadline - Date.now() : attemptMs;
    return Math.max(1_500, Math.min(attemptMs, cap));
  };
  return withStreamLock(async () => {
    if (!/(^|\.)youtube\.com|(^|\.)youtu\.be/i.test(new URL(target).hostname)) {
      const s = await extractStream(target, [], attemptTimeout());
      return s.url;
    }
    let best = null;
    let lastErr = null;
    for (const client of YT_PLAYER_CLIENTS) {
      if (deadline && Date.now() >= deadline) {
        lastErr = lastErr || new Error('Stream lookup ran out of time');
        break;
      }
      let s;
      try {
        s = await extractStream(target, [
          '--extractor-args', `youtube:player_client=${client}`,
        ], attemptTimeout());
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
  }, priority);
}

// --- Invidious (a second front-end for the same YouTube videos) -----------

// Public Invidious instances serve YouTube's own streams through their
// API, from THEIR network — so a video YouTube refuses to hand this host
// directly can still play, bit-for-bit the same upload. The instance
// pool is small and churns, so hosts are discovered at runtime from the
// official instance list (only instances that report their API enabled),
// cached for an hour, with the last instance verified live (Nov 2026) as
// the seed. At most 2 instances are tried per lookup, on tight timeouts.
const INVIDIOUS_SEED = ['yt.chocolatemoo53.com'];
let invidiousCache = { at: 0, hosts: INVIDIOUS_SEED };

async function invidiousHosts() {
  if (Date.now() - invidiousCache.at < 3_600_000 && invidiousCache.hosts.length) {
    return invidiousCache.hosts;
  }
  try {
    const res = await fetch('https://api.invidious.io/instances.json', {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const hosts = list
      .filter(([, info]) => info && info.type === 'https' && info.api === true)
      .map(([host]) => host);
    // Seed first (it is the verified one), then any other API instances.
    const ordered = [...INVIDIOUS_SEED, ...hosts.filter((h) => !INVIDIOUS_SEED.includes(h))];
    if (ordered.length) invidiousCache = { at: Date.now(), hosts: ordered };
  } catch { /* keep the seed / previous cache */ }
  return invidiousCache.hosts;
}

/**
 * Search YouTube's catalog through a public Invidious instance's API —
 * the same side door invidiousStreamFor streams through. YouTube's own
 * search is walled from datacenter IPs, but an instance answers from
 * its network, so a typed song name can still resolve to the actual
 * YouTube video. Returns track-shaped results; [] on any failure.
 */
export async function searchOnInvidious(query, opts = {}) {
  const hosts = await invidiousHosts();
  const timeoutMs = opts.timeoutMs || 6_000;
  for (const host of hosts.slice(0, 2)) {
    try {
      const res = await fetch(
        `https://${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const tracks = (Array.isArray(data) ? data : [])
        .filter((v) => v && v.videoId && v.title)
        .map((v) => {
          const thumbs = Array.isArray(v.videoThumbnails) ? v.videoThumbnails : [];
          const thumb = thumbs.find((t) => t.quality === 'maxres') || thumbs[0];
          const track = {
            id: v.videoId,
            title: String(v.title).replace(/\s+/g, ' ').trim(),
            duration: Number(v.lengthSeconds) || 0,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          };
          if (v.author) track.uploader = String(v.author).replace(/\s+/g, ' ').trim();
          if (thumb?.url) track.thumbnail = thumb.url.startsWith('http') ? thumb.url : `https://${host}${thumb.url}`;
          return track;
        });
      if (tracks.length) return tracks;
    } catch { /* try the next instance */ }
  }
  return [];
}

/**
 * Best audio stream for a YouTube video id, via a public Invidious
 * instance. Returns { url, host, format }. Throws if no tried instance
 * can serve the video.
 */
export async function invidiousStreamFor(videoId, opts = {}) {
  const deadline = opts.deadline || null;
  const hosts = await invidiousHosts();
  let lastErr = null;
  for (const host of hosts.slice(0, 2)) {
    const budget = deadline ? deadline - Date.now() : (opts.timeoutMs || 10_000);
    if (budget <= 500) { lastErr = lastErr || new Error('Invidious lookup ran out of time'); break; }
    try {
      const res = await fetch(`https://${host}/api/v1/videos/${encodeURIComponent(videoId)}`, {
        signal: AbortSignal.timeout(Math.min(opts.timeoutMs || 10_000, budget)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const audio = (data.adaptiveFormats || [])
        .filter((f) => f && f.url && String(f.type || '').startsWith('audio'))
        .sort((a, b) => ((/opus/i.test(b.type) ? 1 : 0) - (/opus/i.test(a.type) ? 1 : 0))
          || ((b.bitrate || 0) - (a.bitrate || 0)));
      if (!audio.length) throw new Error('no audio formats');
      const best = audio[0];
      return {
        url: best.url,
        host,
        format: `${String(best.type).split(';')[0]} ~${Math.round((best.bitrate || 0) / 1000)}kbps`,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No Invidious instance could serve that video.');
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

async function getSoundCloudClientId(pageUrl = 'https://soundcloud.com/') {
  if (scClientId) return scClientId;
  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': SC_UA },
    signal: AbortSignal.timeout(8_000),
  });
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
