import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';
import playDl from 'play-dl';
import ffmpegStatic from 'ffmpeg-static';
import { streamUrlFor, streamUrlViaClientSets, youtubeVideoId, searchOnSoundCloud, searchOnSoundCloudApi, searchOnYouTube, searchOnInvidious, invidiousStreamFor, resolveTextQuery, errReason, formatDuration } from './youtube.js';
import { applyTheme } from './themes.js';

// ffmpeg choice: the host's own ffmpeg FIRST (the Dockerfile installs
// it, and it is the build that has played every verified stream —
// the johnvansickle static build sat silent on SoundCloud HLS in
// testing, producing no audio at all). ffmpeg-static is only the
// fallback for a host with no ffmpeg of its own.
import { execFileSync } from 'node:child_process';
const FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return ffmpegStatic || 'ffmpeg';
  }
})();

export const BRAND = 0x2d6a4f; // swamp green
export const BOT_NAME = 'Swamp Tunes';

const guilds = new Map(); // guildId -> state

export const LOOP_MODES = ['off', 'track', 'queue'];

/** Format a track as a markdown link when it has a URL, else plain bold. */
export function trackLabel(track) {
  return track?.url ? `**[${track.title}](${track.url})**` : `**${track?.title ?? 'Unknown'}**`;
}

/** Delete a local upload's temp file (no-op for normal tracks). */
export function cleanupLocalFile(track) {
  if (track?.localFile) {
    fs.unlink(track.localFile, () => {});
    track.localFile = null;
  }
}

function nowPlayingEmbed(track, state, guildId) {
  const embed = new EmbedBuilder()
    .setTitle('🎶 Now playing')
    .setDescription(trackLabel(track))
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Requested by', value: track.requestedBy, inline: true },
    );
  if (state.bassBoost) embed.addFields({ name: '🔊 Bass boost', value: 'ON', inline: true });
  if (state.loopMode !== 'off') embed.addFields({ name: '🔁 Loop', value: state.loopMode, inline: true });
  applyTheme(embed, guildId, { track, guildIcon: state.guildIcon });
  return embed.setFooter({ text: BOT_NAME });
}

function getState(guildId) {
  let state = guilds.get(guildId);
  if (!state) {
    const player = createAudioPlayer();
    state = {
      queue: [],
      player,
      connection: null,
      current: null,
      volume: 1,
      bassBoost: false,
      ffmpeg: null,
      textChannel: null,
      loopMode: 'off',
      forceSkip: false,
      suppressNextEnd: false,
      guildIcon: null,
    };
    player.on(AudioPlayerStatus.Idle, () => {
      handleTrackEnd(guildId);
    });
    player.on('error', (err) => {
      console.error(`[${BOT_NAME}] player error:`, err.message);
      killFfmpeg(state);
      state.textChannel?.send(`⚠️ Playback hiccup on **${state.current?.title ?? 'a track'}** — skipping.`).catch(() => {});
      cleanupLocalFile(state.current);
      state.current = null;
      state.forceSkip = false;
      void playNext(guildId);
    });
    guilds.set(guildId, state);
  }
  return state;
}

function announce(state, payload) {
  state.textChannel?.send(payload).catch(() => {});
}

function killFfmpeg(state) {
  if (state.ffmpeg) {
    try { state.ffmpeg.kill('SIGKILL'); } catch { /* already dead */ }
    state.ffmpeg = null;
  }
}

/**
 * Runs when a track finishes (or is force-skipped via player.stop()).
 * Loop rules:
 * - track loop: replay the finished track — unless it was force-skipped.
 * - queue loop: the finished track goes back on the end of the queue
 *   (a force-skipped track does too; only /remove, /clear and /stop drop it).
 * Local upload files are deleted once a track truly leaves rotation.
 */
function handleTrackEnd(guildId) {
  const state = guilds.get(guildId);
  if (!state) return;
  // /forceplay already discarded the interrupted track and queued its
  // replacement at the front — just move on to it.
  if (state.suppressNextEnd) {
    state.suppressNextEnd = false;
    void playNext(guildId);
    return;
  }
  const finished = state.current;
  const forced = state.forceSkip;
  state.forceSkip = false;
  if (!finished) { void playNext(guildId); return; }

  if (!forced && state.loopMode === 'track') {
    startTrack(state, guildId, finished);
    return;
  }
  if (state.loopMode === 'queue') {
    clearStreamCache(finished); // its prefetched URL would be stale by its next turn
    state.queue.push(finished);
  } else {
    cleanupLocalFile(finished);
  }
  state.current = null;
  void playNext(guildId);
}

/** Drop a track's cached stream info (prefetched stream URLs go stale). */
function clearStreamCache(track) {
  if (track) { track.streamUrl = null; track.streamPromise = null; }
}

/**
 * Background-resolve a track's playable URL (the full source cascade in
 * resolvePlayable, SoundCloud first) and cache it on the queue item, so
 * when its turn comes playback starts with no lookup wait. Prefetch runs
 * on a shorter budget and at 'low' priority in the stream lock, so it
 * never delays a song somebody is actively waiting for. A failed
 * prefetch clears itself and play time falls back to resolving live —
 * prefetching can never break playback.
 */
function prefetchTrack(track) {
  if (!track || track.isLocal || track.streamUrl || track.streamPromise) return;
  track.streamPromise = resolvePlayable(track, { budgetMs: PREFETCH_BUDGET_MS, priority: 'low' })
    .then((src) => {
      if (src && typeof src === 'object') {
        // A play-dl stream can't be cached — it starts flowing now.
        // Shut it down and just remember play-dl reaches this track,
        // so play time goes straight back to it.
        try { src.playDl.stream.destroy(); } catch { /* already closed */ }
        track.playDlVerified = true;
        track.streamPromise = null;
        return null;
      }
      track.streamUrl = src;
      return src;
    })
    .catch((err) => {
      console.error(`[${BOT_NAME}] prefetch failed for "${track.title}":`, errReason(err));
      track.streamPromise = null;
      return null;
    });
}

/** Prefetch the next-up track (front of the queue) for a guild, if any. */
function prefetchNext(guildId) {
  const state = guilds.get(guildId);
  if (state?.queue[0]) prefetchTrack(state.queue[0]);
}

export function createResource(url, bassBoost, state, trackTitle = '') {
  // EVERY track plays through ffmpeg, the classic direct-player shape:
  // ffmpeg reads the stream itself, video is disabled, and clean 48kHz
  // PCM comes out the pipe for the voice encoder.
  //
  // The -reconnect flags are HTTP-protocol options, so they are passed
  // ONLY for http(s) inputs. Passed unconditionally (the old shape),
  // ffmpeg validates them against the input and, for anything that is
  // not the HTTP protocol — a local upload file above all — exits
  // instantly with "Option reconnect not found", producing ZERO bytes:
  // the song "played" for a split second in total silence. Verified
  // against the exact deployed binary (Debian bookworm ffmpeg 5.1.9):
  // file input + reconnect flags = 0 bytes out; without them the same
  // file decodes in full. (ffmpeg-static 7.0.2 also zeroed HLS inputs
  // with these flags; 5.1.9 and 8.1.2 tolerate them for http/HLS.)
  const isHttp = /^https?:\/\//i.test(String(url));
  const ff = spawn(FFMPEG, [
    ...(isHttp ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
    '-analyzeduration', '0', '-loglevel', 'error',
    '-i', url,
    '-vn',
    ...(bassBoost ? ['-af', 'bass=g=15:f=110'] : []),
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.ffmpeg = ff;
  watchFfmpeg(ff, trackTitle);
  return createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
}

/**
 * ffmpeg used to run with stderr thrown away (-loglevel 0, stdio
 * 'ignore'), so when it died — bad option, dead URL, 403 — the song
 * simply ended and NOTHING anywhere said why. Now a dying ffmpeg is
 * loud in the server log (console only, never the Discord channel):
 * keep a short stderr tail and print it, with the exit code, on close.
 */
function watchFfmpeg(ff, trackTitle) {
  let errTail = '';
  ff.stderr?.on('data', (d) => { errTail = (errTail + d.toString()).slice(-600); });
  ff.on('error', (err) => {
    console.error(`[${BOT_NAME}] ffmpeg failed to start for "${trackTitle}":`, err.message);
  });
  ff.on('close', (code) => {
    if (code) {
      const last = errTail.trim().split('\n').filter(Boolean).pop() || 'no stderr';
      console.error(`[${BOT_NAME}] ffmpeg exited ${code} for "${trackTitle}": ${last}`);
    }
  });
}

/**
 * Play a play-dl stream: the stream play-dl opened is piped into the
 * same ffmpeg stage every other source uses, so volume, bass boost and
 * the opus pipeline behave identically whatever door the song came in.
 */
export function createPlayDlResource(playDlInfo, bassBoost, state, trackTitle = '') {
  const ff = spawn(FFMPEG, [
    '-analyzeduration', '0', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    ...(bassBoost ? ['-af', 'bass=g=15:f=110'] : []),
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  state.ffmpeg = ff;
  watchFfmpeg(ff, trackTitle);
  ff.stdin.on('error', () => {});
  const input = playDlInfo.stream;
  input.on('error', () => { try { ff.stdin.destroy(); } catch { /* already gone */ } });
  input.pipe(ff.stdin);
  return createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
}

/** Race a promise against a timeout; on timeout the loser is destroyed if it ever lands. */
function withStreamTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Same-song check for fallback candidates. The fallback's job is to find
 * the EXACT song the user asked for on a reachable host — never a loose
 * namesake. Both sides are normalized (lowercased, bracketed decorations
 * and channel suffixes stripped) and compared as word tokens:
 * - at least 60% of the requested title's words must appear in the
 *   candidate's title + uploader, with at least 2 words matching
 *   (a 1-word title must match whole), and
 * - when the artist is known, the two sides must share an artist word:
 *   one of the artist's words in the candidate's title/uploader, or one
 *   of the candidate uploader's words in the requested title (covers
 *   "Artist - Title" uploads where either side credits the other
 *   artist). A shared title alone is never enough when the artist is
 *   known — an identical title by a different artist is a different
 *   song, and playing it would break the rule this check exists for.
 */
function normTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map((w) => w.trim())
      .filter((w) => w.length > 1),
  );
}

const ARTIST_STOPWORDS = new Set(['official', 'topic', 'vevo', 'music', 'records', 'recordings', 'entertainment', 'tv']);

/**
 * Droppin'-g spelling variants count as the same word: 'flashin' and
 * 'flashing', 'talkin' and 'talking'. Without this, the exact-song
 * gate rejected the only SoundCloud copy of Bizzy Banks' 'Flashin
 * Lights' because the re-upload spelled it 'Flashing' (Nov 9).
 */
function tokenVariants(t) {
  const out = [t];
  if (t.endsWith('ing') && t.length > 4) out.push(t.slice(0, -1));
  if (t.endsWith('in') && t.length > 3) out.push(`${t}g`);
  return out;
}
function tokenHit(token, set) {
  return tokenVariants(token).some((v) => set.has(v));
}

export function isSameSong(requested, candidate) {
  if (!requested?.title || !candidate?.title) return false;
  const reqTokens = normTokens(requested.title);
  if (!reqTokens.size) return false;
  const candTokens = normTokens(`${candidate.title} ${candidate.uploader || ''}`);
  let matched = 0;
  for (const t of reqTokens) if (tokenHit(t, candTokens)) matched++;
  const titleScore = matched / reqTokens.size;
  const minMatched = reqTokens.size === 1 ? 1 : 2;
  if (matched < minMatched || titleScore < 0.6) return false;
  const artistWords = [...normTokens(requested.uploader || requested.artist || '')]
    .filter((w) => !ARTIST_STOPWORDS.has(w));

  // The title score above can be fooled when the requested title embeds
  // the artist's name ("Vybz Kartel - ONSLAUGHT"): a different song by
  // the same artist matches the artist words and clears 60% without
  // matching the actual song title at all. So the NON-artist title
  // words must match on their own — the distinctive part of the title
  // is what makes it the same song.
  const distinctiveTokens = [...reqTokens].filter((t) => !artistWords.includes(t));
  if (distinctiveTokens.length) {
    let matchedDistinctive = 0;
    for (const t of distinctiveTokens) if (tokenHit(t, candTokens)) matchedDistinctive++;
    const minDistinctive = distinctiveTokens.length === 1 ? 1 : 2;
    if (matchedDistinctive < minDistinctive || matchedDistinctive / distinctiveTokens.length < 0.6) {
      return false;
    }
  }

  if (!artistWords.length) return true;
  if (artistWords.some((w) => tokenHit(w, candTokens))) return true;
  const candUploaderWords = [...normTokens(candidate.uploader || '')]
    .filter((w) => !ARTIST_STOPWORDS.has(w));
  return candUploaderWords.some((w) => tokenHit(w, reqTokens));
}

/**
 * Hard budgets for playback resolution. The old flow could grind for
 * ~4 minutes per track: five YouTube client extractions at up to 45s
 * each, serialized behind any prefetch in the stream lock, before the
 * fallback even started. Now every track gets ONE overall budget —
 * 40s at play time, 20s for prefetch — each extraction attempt is
 * capped at ~15s inside streamUrlFor, and when the budget is gone the
 * track skips with the usual message instead of hanging the queue.
 */
const RESOLVE_BUDGET_MS = 40_000;
const PREFETCH_BUDGET_MS = 20_000;

/** Coverage of the requested title's distinctive (non-artist) words, 0..1. */
const VERSION_WORDS = new Set(['fast', 'sped', 'slowed', 'remix', 'cover', 'karaoke', 'instrumental', 'nightcore', 'reverb', 'jersey', 'freestyle']);

function titleScore(requested, candidate) {
  const reqAll = normTokens(requested.title);
  if (!reqAll.size) return 0;
  const artistWords = new Set(
    [...normTokens(requested.uploader || requested.artist || '')]
      .filter((w) => !ARTIST_STOPWORDS.has(w)),
  );
  const distinctive = new Set([...reqAll].filter((t) => !artistWords.has(t)));
  const req = distinctive.size ? distinctive : reqAll;
  const cand = normTokens(`${candidate.title} ${candidate.uploader || ''}`);
  let matched = 0;
  for (const t of req) if (tokenHit(t, cand)) matched++;
  let score = matched / req.size;
  // A same-song re-upload that is a VERSION (sped-up "Fast", remix,
  // nightcore…) covers every title word and ties with the plain song at
  // 1.0. When the request never asked for a version, rank those below
  // the plain upload — versions only win when nothing plain is offered.
  const candTitle = normTokens(candidate.title);
  for (const w of candTitle) {
    if (VERSION_WORDS.has(w) && !reqAll.has(w)) score -= 0.15;
  }
  return Math.max(0, score);
}

/**
 * Gate-passing candidates, best first: the isSameSong gate decides who
 * MAY play (unchanged — exact song or nothing); this only decides the
 * ORDER they are tried in. Score order matters because the first
 * gate-passing result is not always the song (a same-artist namesake
 * can pass at 0.67 while the real track sits at 1.0 further down), and
 * because the top hit is sometimes a DRM-locked official upload whose
 * extraction fails — the next candidate gets its turn.
 */
function rankedMatches(requested, candidates) {
  return (candidates || [])
    .filter((c) => isSameSong(requested, c))
    .map((c) => ({ c, s: titleScore(requested, c) }))
    .sort((a, b) => b.s - a.s)
    .map(({ c }) => c);
}

/**
 * The playback race (v3): find ONE reachable stream for the exact song,
 * within the budget, and PROVE it flows before handing it to the voice
 * layer. Proven in production (Nov 2026): from the host's datacenter
 * IP, YouTube refuses most player clients (webpage 429, API 403,
 * "Sign in to confirm you're not a bot"), while SoundCloud serves the
 * same catalog fine — and some songs exist on NEITHER side in a
 * reachable copy, so every door has to be tried while time remains.
 *
 * v2 ran the doors as a SERIAL cascade (SoundCloud, then YouTube, then
 * Invidious, then play-dl, then re-search), and its own post-mortem
 * named the flaw: slow failing doors burned the whole 40s budget
 * before the late tiers ever ran — "LARRY FORD" died at 22:22:49 on
 * Nov 10 with Invidious and play-dl barely touched. v3 therefore runs
 * the source families CONCURRENTLY and takes the first stream that
 * passes byte-verification; the losers are abandoned mid-flight (each
 * lane checks the race state between attempts and stops spending).
 * The lanes:
 *
 * - SOUNDCLOUD — a linked SoundCloud track from its own page first,
 *   then the deep multi-candidate pool: api-v2 searches under several
 *   query formulations (title+artist, title only, feat-stripped core
 *   title, "official audio") merged and deduped, topped up by yt-dlp
 *   scsearch (n=15) when the same-song gate leaves the pool thin.
 *   Gated candidates are tried best-first, up to 12 at play time,
 *   each extracted AND byte-verified. One locked upload (SAMPLE-AES
 *   DRM officials are common) never ends the attempt.
 * - YOUTUBE — the track's own video through the multi-client sets,
 *   then the single-client rotation; then up to 3 OTHER gated uploads
 *   of the same song through the client sets. Honest note: against an
 *   active bot wall every set can still fail — no client rotation
 *   defeats a cookie gate. Production also proved the sets DO extract
 *   real streams (fmt 18) on this host, so the door is worth racing.
 * - INVIDIOUS — the same video ids (own + the other uploads) through
 *   public instances; it byte-verifies its own stream before
 *   returning, and answers from the instance's network, not ours.
 * - PLAY-DL — opens the stream itself; from most networks it answers
 *   429, but where it answers it is a door nothing else duplicates.
 *
 * The one serialization left is deliberate: yt-dlp stream EXTRACTIONS
 * still pass through the two-lane stream lock in youtube.js, because
 * parallel -g lookups from one IP are what trips YouTube's 429 wall.
 * Everything else — searches, Invidious lookups, verifications — runs
 * in parallel, so a typical song is resolved by its FASTEST door
 * instead of paying every slow door's timeout in sequence.
 *
 * A failure at any door — or any single candidate — never ends the
 * attempt; only the shared deadline or a verified stream does. Every
 * attempt logs exactly one line with its outcome — no silent catches
 * anywhere in this path. The same-song gate is unchanged: the exact
 * song or nothing, never a different artist's namesake. The queue
 * entry, title and now-playing flow never change; only the host
 * behind the song does.
 */
/** Below this many decoded bytes in the probe window, a stream is a
 *  dead door, not a quiet song: real audio through this ffmpeg stage
 *  (48kHz stereo PCM) produces orders of magnitude more. */
const FLOW_MIN_BYTES = 16_000;

/**
 * Run a stream URL through the bot's own ffmpeg and count how many
 * decoded PCM bytes come out within probeMs — the probe approach from
 * probePlayback, reused as the cascade's lie detector. Stops early if
 * ffmpeg exits (a dead URL costs the exit, not the whole window).
 * Returns the byte count; 0 on any failure.
 */
async function verifyFlows(url, trackTitle, probeMs) {
  const dummy = {};
  let ff;
  try {
    createResource(url, false, dummy, trackTitle);
    ff = dummy.ffmpeg;
  } catch { return 0; }
  if (!ff?.stdout) return 0;
  const bytes = await new Promise((resolve) => {
    let n = 0;
    const timer = setTimeout(() => resolve(n), probeMs);
    ff.stdout.on('data', (d) => {
      n += d.length;
      // A live stream proves itself fast — don't make a good door
      // pay the whole window. Only dead doors sit at zero to the end.
      if (n >= FLOW_MIN_BYTES) { clearTimeout(timer); resolve(n); }
    });
    ff.once('close', () => { clearTimeout(timer); resolve(n); });
  });
  try { ff.kill('SIGKILL'); } catch { /* already gone */ }
  return bytes;
}

/** Strip video-title decoration ('[ Official Video ]', quotes) for search queries. */
function cleanSongQuery(title) {
  return String(title || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:official|music|lyric|audio|video|hd|4k)[^)]*\)/gi, ' ')
    .replace(/["""]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * The plain-song core of a decorated title: feat./ft./featuring credits
 * stripped, whether they trail the title ("Song feat. X"), sit in
 * brackets ("Song (feat. X)"), or ride mid-title. SoundCloud's pool for
 * the decorated form is often just the locked official upload, while
 * re-uploads carry the plain title — the cascade searches both shapes.
 */
function scCoreTitle(title) {
  const core = String(title || '')
    .replace(/\((?:feat\.?|ft\.?|featuring)[^)]*\)/gi, ' ')
    .replace(/\[(?:feat\.?|ft\.?|featuring)[^\]]*\]/gi, ' ')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return core || String(title || '').trim();
}

/**
 * The SoundCloud api-v2 query formulations for one song, deduped:
 * as-is with the artist, title alone, the feat-stripped core both
 * ways, and the "official audio" variant. The API answers each in
 * about a second, so the race fires them all at once and merges the
 * pools — five cheap questions beat one perfect question when the
 * pool's ranking changes with every phrasing.
 */
function scQueryFormulations(title, artist) {
  const core = scCoreTitle(title);
  const forms = [];
  const seen = new Set();
  const add = (t, a, label) => {
    const key = `${t}||${a || ''}`;
    if (!t || seen.has(key)) return;
    seen.add(key);
    forms.push({ title: t, artist: a || '', label });
  };
  add(title, artist, 'title+artist');
  add(title, '', 'title only');
  add(core, artist, 'core title+artist');
  add(core, '', 'core title only');
  add(`${core} official audio`, artist, 'official audio');
  return forms;
}
export async function resolvePlayable(track, { budgetMs = RESOLVE_BUDGET_MS, priority = 'high' } = {}) {
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  const artist = track.uploader || track.artist || '';
  const searchTitle = cleanSongQuery(track.title) || track.title;
  const isSCTrack = /soundcloud\.com/i.test(track.url || '');
  const ytId = !isSCTrack
    ? (youtubeVideoId(track.url || '') || (/^[\w-]{11}$/.test(String(track.id || '')) ? track.id : null))
    : null;
  let lastErr = null;
  const noteFail = (label, err) => {
    lastErr = err;
    console.log(`[${BOT_NAME}] ${label} failed for "${track.title}": ${errReason(err)}`);
  };

  // Byte verification — the probe approach from probePlayback, applied
  // to every extracted URL before it is believed: run the URL through
  // the bot's own ffmpeg and count decoded PCM bytes for a short
  // window. An extraction can "succeed" and still deliver nothing
  // (a door that answers metadata but serves no media); a stream that
  // flows real bytes is the only kind the voice layer ever receives.
  const probeMs = () => Math.max(1_200, Math.min(3_000, Math.floor(remaining() * 0.35)));
  const verified = async (url, label) => {
    const ms = probeMs();
    const bytes = await verifyFlows(url, track.title, ms);
    console.log(`[${BOT_NAME}] probe: ${label} -> ${bytes} bytes in ${ms}ms`);
    if (bytes >= FLOW_MIN_BYTES) return url;
    throw new Error(`stream delivered only ${bytes} bytes in ${ms}ms (dead door)`);
  };

  // Race state: the first lane to hand back a verified source wins;
  // every other lane sees raceWon flip and stops spending between
  // attempts. alive() is also the deadline check — a lane with less
  // than a second of budget left has nothing left to start.
  let raceWon = false;
  const alive = () => !raceWon && remaining() > 900;

  // Shared discovery for the YouTube and Invidious lanes: OTHER uploads
  // of the same song — up to 3 distinct video ids, same-song gated,
  // best match first. Both search doors run at once (yt-dlp's search
  // and an Invidious instance's, whose network YouTube doesn't wall),
  // merged and deduped. Best-effort: any failure just leaves the lanes
  // with the track's own video id.
  const uploadsPromise = (async () => {
    try {
      const [ytRes, invRes] = await Promise.allSettled([
        searchOnYouTube(searchTitle, artist, {
          timeoutMs: Math.min(12_000, Math.max(2_000, remaining())),
          retry: false,
        }),
        searchOnInvidious(`${searchTitle} ${artist}`.trim(), { timeoutMs: 8_000 }),
      ]);
      if (ytRes.status === 'rejected') noteFail('youtube re-search', ytRes.reason);
      const byId = new Map();
      for (const r of [ytRes, invRes]) {
        if (r.status !== 'fulfilled') continue;
        for (const c of r.value || []) {
          if (c && c.id && !byId.has(String(c.id))) byId.set(String(c.id), c);
        }
      }
      const ranked = rankedMatches(track, [...byId.values()])
        .filter((c) => String(c.id) !== String(ytId ?? '') && String(c.id) !== String(track.id ?? ''));
      if (!ranked.length) {
        console.log(`[${BOT_NAME}] race: no other upload of "${track.title}" found for the YouTube lanes`);
      }
      return ranked.slice(0, 3);
    } catch { return []; }
  })();

  // Lane 1 — SoundCloud. A linked SoundCloud track plays from its own
  // page first; then the deep multi-candidate pool. The pool merges
  // api-v2 searches under every query formulation (fired at once),
  // topped up by yt-dlp scsearch (n=15) when the same-song gate leaves
  // it thin. Candidates are gated, best first, up to 12 tried at play
  // priority — one locked or dead upload never ends the attempt.
  const laneSoundCloud = async () => {
    if (isSCTrack) {
      try {
        const url = await streamUrlFor(track.id, track.url, { priority, deadline });
        const ok = await verified(url, `soundcloud own page "${track.title}"`);
        console.log(`[${BOT_NAME}] soundcloud: playing "${track.title}" from its own page`);
        return ok;
      } catch (err) { noteFail('soundcloud', err); }
    }
    const byId = new Map();
    const addAll = (list) => {
      for (const c of list || []) {
        if (c && c.id && !byId.has(String(c.id))) byId.set(String(c.id), c);
      }
    };
    const ownId = isSCTrack ? String(track.id ?? '') : null;
    const gatePool = () => rankedMatches(track, [...byId.values()])
      .filter((c) => String(c.id) !== ownId);
    const forms = scQueryFormulations(searchTitle, artist);
    const formResults = await Promise.allSettled(forms.map((f) => searchOnSoundCloudApi(
      f.title,
      f.artist,
      { timeoutMs: Math.min(6_000, Math.max(1_500, remaining())) },
    )));
    formResults.forEach((r, i) => {
      if (r.status === 'fulfilled') addAll(r.value);
      else noteFail(`soundcloud api search (${forms[i].label})`, r.reason);
    });
    let ranked = gatePool();
    console.log(`[${BOT_NAME}] soundcloud: pool of ${byId.size} across ${forms.length} searches, ${ranked.length} same-song for "${track.title}"`);
    // The yt-dlp scsearch is the slow door (~10s): only pay for it
    // when the API pools left the same-song gate nearly empty.
    const deepen = async (label, t, a) => {
      try {
        addAll(await searchOnSoundCloud(t, a, {
          timeoutMs: Math.min(12_000, Math.max(2_000, remaining())),
          retry: false,
          n: 15,
        }));
      } catch (err) { noteFail(label, err); }
      ranked = gatePool();
    };
    if (ranked.length < 4 && alive() && remaining() > 10_000) {
      await deepen('soundcloud search', searchTitle, artist);
    }
    if (ranked.length < 4 && alive() && remaining() > 10_000) {
      await deepen('soundcloud search (core title)', scCoreTitle(searchTitle), artist);
    }
    if (!ranked.length) {
      console.log(`[${BOT_NAME}] soundcloud: no exact-song match for "${track.title}"`);
      return null;
    }
    const cap = priority === 'low' ? 6 : 12;
    console.log(`[${BOT_NAME}] soundcloud: ${ranked.length} same-song candidate(s) for "${track.title}" — trying until one flows`);
    let tried = 0;
    for (const cand of ranked.slice(0, cap)) {
      if (!alive()) break;
      tried += 1;
      try {
        const url = await streamUrlFor(cand.id, cand.url, { priority, deadline });
        const ok = await verified(url, `soundcloud candidate "${cand.title}"`);
        console.log(`[${BOT_NAME}] soundcloud: playing "${cand.title}" by ${cand.uploader || 'unknown'} for "${track.title}" (candidate ${tried})`);
        return ok;
      } catch (err) { noteFail(`soundcloud candidate "${cand.title}"`, err); }
    }
    return null;
  };

  // Lane 2 — YouTube. The track's own video first: multi-client sets,
  // then the single-client rotation (v2's tiers 3-4, now one lane).
  // Then up to 3 other gated uploads of the same song, each through
  // the client sets (v2's tier 7, promoted into the race).
  const laneYouTube = async () => {
    const ids = [];
    if (ytId) ids.push({ id: ytId, own: true, title: track.title });
    for (const c of await uploadsPromise) ids.push({ id: c.id, own: false, title: c.title });
    for (const entry of ids) {
      if (!alive()) break;
      try {
        const url = await streamUrlViaClientSets(entry.id, { priority, deadline });
        const ok = await verified(url, `youtube client sets "${entry.title}"`);
        console.log(entry.own
          ? `[${BOT_NAME}] youtube: playing "${track.title}" via client-set rotation`
          : `[${BOT_NAME}] youtube: playing another upload of "${track.title}" ("${entry.title}") via client sets`);
        return ok;
      } catch (err) { noteFail(entry.own ? 'youtube client sets' : `youtube candidate "${entry.title}"`, err); }
      if (entry.own) {
        if (!alive()) break;
        try {
          const url = await streamUrlFor(entry.id, track.url, { priority, deadline });
          const ok = await verified(url, `youtube rotation "${track.title}"`);
          console.log(`[${BOT_NAME}] youtube: playing "${track.title}" via client rotation`);
          return ok;
        } catch (err) { noteFail('youtube', err); }
      }
    }
    return null;
  };

  // Lane 3 — Invidious: the same video ids (own first, then the other
  // uploads) through public instances. This door answers from the
  // instance's network and byte-verifies its own stream before
  // returning it (inside invidiousStreamFor).
  const laneInvidious = async () => {
    const ids = [];
    if (ytId) ids.push(ytId);
    for (const c of await uploadsPromise) ids.push(c.id);
    for (const id of ids) {
      if (!alive()) break;
      try {
        const s = await invidiousStreamFor(id, { deadline });
        console.log(`[${BOT_NAME}] invidious: playing "${track.title}" via ${s.host} (${s.format})`);
        return s.url;
      } catch (err) { noteFail('invidious', err); }
    }
    return null;
  };

  // Lane 4 — play-dl, which opens the stream itself instead of asking
  // yt-dlp to extract one. From every network tested on Nov 9 it
  // answered 429 and only added its timeout; it stays because on a
  // network where it does answer, it is a door nothing else
  // duplicates. Returns a live stream object, not a URL; callers
  // route it through the same ffmpeg stage as every source.
  const lanePlayDl = async () => {
    if (isSCTrack || !track.url) return null;
    try {
      const info = await withStreamTimeout(
        playDl.stream(track.url),
        Math.min(6_000, Math.max(1_000, remaining())),
        'play-dl',
      );
      console.log(`[${BOT_NAME}] play-dl: playing "${track.title}"`);
      return { playDl: info };
    } catch (err) { noteFail('play-dl', err); return null; }
  };

  const lanes = [laneSoundCloud(), laneYouTube(), laneInvidious(), lanePlayDl()];
  console.log(`[${BOT_NAME}] race: ${lanes.length} doors in parallel for "${track.title}" — first verified stream wins`);
  const winner = await new Promise((resolve) => {
    let pending = lanes.length;
    let done = false;
    for (const p of lanes) {
      Promise.resolve(p).then(
        (v) => {
          if (done) return;
          if (v != null) { done = true; raceWon = true; resolve(v); }
          else if (--pending === 0) resolve(null);
        },
        () => { if (!done && --pending === 0) resolve(null); },
      );
    }
  });
  if (winner) return winner;

  throw lastErr || new Error(`No reachable source for "${track.title}"`);
}

/**
 * Resolve the URL a track will actually play from, at stream-start time:
 * local file → prefetched URL (instant) → in-flight prefetch (given a
 * short head start only — play time never queues behind background
 * warming) → the live cascade in resolvePlayable. Whichever URL wins is
 * cached on the track, so a replay or bass-boost toggle doesn't pay the
 * lookup again.
 */
export async function playableUrlFor(track) {
  if (track.isLocal) return track.localFile;
  if (track.streamUrl) return track.streamUrl; // prefetched — start instantly
  if (track.streamPromise) {
    const warmed = await Promise.race([
      track.streamPromise,
      new Promise((r) => setTimeout(() => r(null), 4_000)),
    ]);
    if (warmed) return warmed;
    if (track.streamUrl) return track.streamUrl;
  }
  const src = await resolvePlayable(track, { budgetMs: RESOLVE_BUDGET_MS, priority: 'high' });
  if (typeof src === 'string') track.streamUrl = src; // play-dl streams can't be cached
  return src;
}

// ---------------------------------------------------------------------------
// HOST SELF-PROBE (diagnostic, added Nov 9 late): triggered over HTTP by
// an operator holding PROBE_KEY — never by Discord users. It answers,
// FROM THE HOST ITSELF, the two questions the Nov 9 outage turned on:
// (1) can this host complete a UDP round trip at all (Discord voice
// media is UDP; the signalling that reports "ready" is not), and
// (2) does real audio data actually flow through the full pipeline
// (resolve a track, run it through ffmpeg, count the bytes) — per song.
// ---------------------------------------------------------------------------
import dgram from 'node:dgram';

function probeUdp() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const txid = Buffer.alloc(12, 7);
    const req = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]),
      txid,
    ]);
    const done = (v) => { try { sock.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => done(false), 3_500);
    sock.once('message', () => { clearTimeout(timer); done(true); });
    sock.once('error', () => { clearTimeout(timer); done(false); });
    sock.send(req, 19302, 'stun.l.google.com', (err) => { if (err) { clearTimeout(timer); done(false); } });
  });
}

function countBytes(stream, ms) {
  return new Promise((resolve) => {
    let bytes = 0;
    const onData = (d) => { bytes += d.length; };
    stream.on('data', onData);
    setTimeout(() => { stream.off('data', onData); resolve(bytes); }, ms);
  });
}

export async function probePlayback() {
  const out = { udpRoundTrip: await probeUdp(), tracks: [] };
  console.log(`[${BOT_NAME}] probe: UDP round trip ${out.udpRoundTrip ? 'OK' : 'FAILED'}`);
  const probes = [
    { id: 'VHES-ZW8AZM', url: 'https://www.youtube.com/watch?v=VHES-ZW8AZM', title: 'Bizzy Banks - "Flashin Lights" [ Official Video ]', uploader: 'Bizzy Banks' },
    await resolveTextQuery('5500 degrees est gee').catch(() => null),
  ];
  for (const track of probes) {
    if (!track) continue;
    const entry = { title: track.title };
    try {
      const t0 = Date.now();
      const src = await resolvePlayable({ ...track }, { budgetMs: 35_000, priority: 'high' });
      entry.resolveMs = Date.now() - t0;
      if (typeof src === 'object') {
        entry.source = 'play-dl stream';
        entry.bytesIn5s = await countBytes(src.playDl.stream, 5_000);
        try { src.playDl.stream.destroy(); } catch { /* done */ }
      } else {
        entry.source = `url: ${new URL(src).host}`;
        const dummy = {};
        createResource(src, false, dummy);
        entry.bytesIn5s = await countBytes(dummy.ffmpeg.stdout, 5_000);
        try { dummy.ffmpeg.kill(); } catch { /* done */ }
      }
    } catch (err) {
      entry.error = errReason(err);
    }
    console.log(`[${BOT_NAME}] probe: "${entry.title}" -> ${entry.source || 'FAILED'} | ${entry.bytesIn5s ?? 0} bytes in 5s${entry.error ? ` | ${entry.error}` : ''}`);
    out.tracks.push(entry);
  }
  return out;
}

/** One-line host check for the boot log: can this host do UDP at all?
 *  Discord voice MEDIA is UDP; the signalling that reports "ready" is
 *  not. A host without UDP egress joins voice, looks healthy, and
 *  plays silence forever — this line makes that diagnosable at boot. */
export async function hostDiagnostics() {
  const ok = await probeUdp();
  console.log(`[${BOT_NAME}] host check: outbound UDP round trip ${ok ? 'OK' : 'FAILED — Discord voice media is UDP; on a host without UDP egress the bot joins voice and plays silence'}`);
  return ok;
}

function startTrack(state, guildId, track) {
  killFfmpeg(state);
  return (async () => {
    const src = await playableUrlFor(track);
    if (!src) throw new Error('No playable source for this track.');
    // Join only once the song is actually in hand — search and stream
    // first, then join, then play. Joining first left the bot sitting
    // silent in voice while the lookup ground on, and Discord dropped
    // the idle connection (close 4014, Nov 9).
    if (state.guild && state.pendingMember) {
      ensureConnection(state, state.guild, state.pendingMember);
      // Never play into a connection that has not finished its voice
      // handshake. Playing the moment joinVoiceChannel returns leaves
      // the song riding a media path that may never come up. Wait for
      // Ready; if it never comes, rejoin ONCE; if it still never
      // comes, this track fails (loudly in the log) instead of
      // "playing" a whole song of silence at the channel.
      if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Ready) {
        try {
          await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
        } catch {
          console.error(`[${BOT_NAME}] voice connection never became Ready for "${track.title}" — rejoining once`);
          try { state.connection.destroy(); } catch { /* already gone */ }
          state.connection = null;
          ensureConnection(state, state.guild, state.pendingMember);
          await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
        }
      }
    }
    const resource = typeof src === 'object'
      ? createPlayDlResource(src.playDl, state.bassBoost, state, track.title)
      : createResource(src, state.bassBoost, state, track.title);
    resource.volume?.setVolume(state.volume);
    state.player.play(resource);
    announce(state, { embeds: [nowPlayingEmbed(track, state, guildId)] });
  })().catch((err) => {
    console.error(`[${BOT_NAME}] stream error:`, err.message);
    killFfmpeg(state);
    announce(state, `⚠️ Couldn't load **${track.title}** — skipping.`);
    cleanupLocalFile(track);
    if (state.current === track) state.current = null;
    state.forceSkip = false;
    void playNext(guildId);
  });
}

async function playNext(guildId) {
  const state = guilds.get(guildId);
  if (!state || state.player.state.status !== AudioPlayerStatus.Idle) return;
  const next = state.queue.shift();
  if (!next) { killFfmpeg(state); return; } // queue empty — stay connected until /stop or /disconnect
  state.current = next;
  startTrack(state, guildId, next);
  prefetchNext(guildId); // warm up whatever is next after the new current
}

function ensureConnection(state, guild, member) {
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) throw new Error('Join a voice channel first, then run the command again.');
  const perms = voiceChannel.permissionsFor(guild.members.me);
  if (!perms?.has('Connect') || !perms?.has('Speak')) {
    throw new Error(`I need **Connect** and **Speak** permissions in ${voiceChannel}.`);
  }
  const joinAndWire = () => {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    state.connection.subscribe(state.player);
    wireConnection(state);
  };
  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    joinAndWire();
  } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    // User is in a different channel — move the bot to them.
    killFfmpeg(state);
    state.connection.destroy();
    joinAndWire();
  }
}

/**
 * Every listener a voice connection needs, attached on EVERY join —
 * first join and channel moves alike. The move path used to attach
 * only the logging listener, so after a move the disconnect recovery
 * below silently stopped existing and a dropped connection left the
 * player performing into the void.
 *
 * The networking half is the @discordjs/voice self-heal for the
 * "connection says Ready, nobody hears anything" failure: on
 * datacenter hosts the connection's UDP networking layer can die
 * underneath a connection that still reports Ready, and its keep-alive
 * interval keeps firing on the dead socket. On every networking state
 * change, clear the stale interval and log the transition — the
 * documented community workaround for voice 0.19, and the log line
 * makes a silent failure diagnosable from the server log alone.
 */
function wireConnection(state) {
  const connection = state.connection;
  const onNetworkingStateChange = (_oldN, newN) => {
    const udp = newN ? Reflect.get(newN, 'udp') : null;
    if (udp?.keepAliveInterval) clearInterval(udp.keepAliveInterval);
    console.log(`[${BOT_NAME}] voice networking: -> ${newN?.status ?? 'gone'}`);
  };
  // Attach to the networking object that exists at join time, then
  // follow it whenever the connection swaps in a fresh one.
  Reflect.get(connection.state, 'networking')?.on('stateChange', onNetworkingStateChange);
  connection.on('stateChange', (oldS, newS) => {
    console.log(`[${BOT_NAME}] voice: ${oldS.status} -> ${newS.status}${newS.closeCode ? ` (close ${newS.closeCode})` : ''}`);
    const oldNetworking = Reflect.get(oldS, 'networking');
    const newNetworking = Reflect.get(newS, 'networking');
    if (oldNetworking !== newNetworking) {
      oldNetworking?.off('stateChange', onNetworkingStateChange);
      newNetworking?.on('stateChange', onNetworkingStateChange);
    }
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      killFfmpeg(state);
      connection.destroy();
      if (state.connection === connection) state.connection = null;
      cleanupLocalFile(state.current);
      for (const t of state.queue) cleanupLocalFile(t);
      state.queue.length = 0;
      state.current = null;
    }
  });
}

/** Fail fast unless the user is in a voice channel the bot may speak in. */
function validateVoice(guild, member) {
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) throw new Error('Join a voice channel first, then run the command again.');
  const perms = voiceChannel.permissionsFor(guild.members.me);
  if (!perms?.has('Connect') || !perms?.has('Speak')) {
    throw new Error(`I need **Connect** and **Speak** permissions in ${voiceChannel}.`);
  }
}

/**
 * Record where playback will happen and validate the user's channel —
 * but do NOT join yet. The join happens in startTrack, after the song
 * has resolved, so the bot never sits silent in voice waiting on a
 * lookup.
 */
export function prepareVoice(guild, member, textChannel) {
  const state = getState(guild.id);
  state.textChannel = textChannel;
  state.guild = guild;
  state.pendingMember = member;
  try { state.guildIcon = guild.iconURL() || null; } catch { state.guildIcon = null; }
  validateVoice(guild, member);
  return state;
}

/** Add a track; returns { position } and starts playback if idle. */
export function enqueue(guild, member, textChannel, track) {
  prepareVoice(guild, member, textChannel);
  const state = getState(guild.id);
  state.queue.push({ ...track, requestedBy: member.user.tag });
  const position = state.queue.length + (state.current ? 0 : 1);
  if (!state.current && state.player.state.status === AudioPlayerStatus.Idle) {
    void playNext(guild.id);
  }
  prefetchNext(guild.id);
  return { position, state };
}

/** Add many tracks at once (Spotify/Deezer playlists & albums). Returns count added. */
export function enqueueMany(guild, member, textChannel, tracks) {
  prepareVoice(guild, member, textChannel);
  const state = getState(guild.id);
  for (const track of tracks) {
    state.queue.push({ ...track, requestedBy: member.user.tag });
  }
  if (!state.current && state.player.state.status === AudioPlayerStatus.Idle) {
    void playNext(guild.id);
  }
  prefetchNext(guild.id);
  return tracks.length;
}

export function stopAll(guildId) {
  const state = guilds.get(guildId);
  if (!state) throw new Error('Nothing is playing right now.');
  cleanupLocalFile(state.current);
  for (const t of state.queue) cleanupLocalFile(t);
  state.queue.length = 0;
  state.current = null;
  state.forceSkip = false;
  killFfmpeg(state);
  state.player.stop();
}

export function disconnect(guildId) {
  const state = guilds.get(guildId);
  if (!state?.connection) throw new Error("I'm not in a voice channel.");
  stopAll(guildId);
  state.connection?.destroy();
  state.connection = null;
}

/** Toggle pause/resume. Returns { paused, title }. */
export function togglePause(guildId) {
  const state = guilds.get(guildId);
  if (!state?.current) throw new Error('Nothing is playing right now.');
  const isPaused = state.player.state.status === AudioPlayerStatus.Paused;
  if (isPaused) state.player.unpause();
  else state.player.pause();
  return { paused: !isPaused, title: state.current.title };
}

export function setVolume(guildId, level) {
  const state = guilds.get(guildId);
  if (!state) throw new Error('Nothing is playing right now.');
  if (level < 0 || level > 200) throw new Error('Volume must be between 0 and 200.');
  state.volume = level / 100;
  const resource = state.player.state.resource;
  resource?.volume?.setVolume(state.volume);
  return level;
}

/**
 * Toggle bass boost. Takes effect immediately — the current track replays
 * from the start with the bass filter applied (or removed).
 */
export function toggleBassBoost(guildId) {
  const state = guilds.get(guildId);
  if (!state) throw new Error('Nothing is playing right now. Join a voice channel and /play something first.');
  state.bassBoost = !state.bassBoost;
  if (state.current) startTrack(state, guildId, state.current);
  return { enabled: state.bassBoost, title: state.current?.title };
}

/** Snapshot of what's playing and what's queued (positions are 1-based). */
export function getQueueSnapshot(guildId) {
  const state = guilds.get(guildId);
  if (!state) return { current: null, queue: [], loopMode: 'off', volume: 1, bassBoost: false };
  return {
    current: state.current,
    queue: [...state.queue],
    loopMode: state.loopMode,
    volume: state.volume,
    bassBoost: state.bassBoost,
    guildIcon: state.guildIcon,
  };
}

/** Everything /nowplaying needs, including the playback position in seconds. */
export function getNowPlaying(guildId) {
  const state = guilds.get(guildId);
  if (!state?.current) return null;
  const resource = state.player.state.resource;
  const elapsed = resource?.playbackDuration ? resource.playbackDuration / 1000 : 0;
  return {
    track: state.current,
    elapsed,
    volume: state.volume,
    bassBoost: state.bassBoost,
    loopMode: state.loopMode,
    paused: state.player.state.status === AudioPlayerStatus.Paused,
    queueLength: state.queue.length,
    guildIcon: state.guildIcon,
  };
}

/** The currently playing track (or null). */
export function getCurrentTrack(guildId) {
  return guilds.get(guildId)?.current ?? null;
}

/** Shuffle the upcoming queue only (Fisher–Yates). Returns the queue size. */
export function shuffleQueue(guildId) {
  const state = guilds.get(guildId);
  if (!state || state.queue.length < 2) {
    throw new Error('Need at least 2 songs in the queue to shuffle.');
  }
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  prefetchNext(guildId); // a different track is next up now
  return state.queue.length;
}

/**
 * Set the loop mode, or cycle off -> track -> queue -> off when no mode
 * is given. Returns the new mode.
 */
export function setLoopMode(guildId, mode) {
  const state = guilds.get(guildId);
  if (!state) throw new Error('Nothing is playing right now.');
  if (mode) {
    if (!LOOP_MODES.includes(mode)) throw new Error('Loop mode must be off, track, or queue.');
    state.loopMode = mode;
  } else {
    const idx = LOOP_MODES.indexOf(state.loopMode);
    state.loopMode = LOOP_MODES[(idx + 1) % LOOP_MODES.length];
  }
  return state.loopMode;
}

function checkPosition(state, position, label) {
  if (!state || !state.queue.length) throw new Error('The queue is empty.');
  if (!Number.isInteger(position) || position < 1 || position > state.queue.length) {
    throw new Error(`${label} must be between 1 and ${state.queue.length} (see /queue).`);
  }
}

/** Move a queued track from one 1-based position to another. */
export function moveTrack(guildId, from, to) {
  const state = guilds.get(guildId);
  checkPosition(state, from, 'From position');
  checkPosition(state, to, 'To position');
  if (from === to) throw new Error('That song is already at that position.');
  const [track] = state.queue.splice(from - 1, 1);
  state.queue.splice(to - 1, 0, track);
  prefetchNext(guildId);
  return { track, position: to };
}

/** Remove a queued track by its 1-based position. Returns the track. */
export function removeTrack(guildId, position) {
  const state = guilds.get(guildId);
  checkPosition(state, position, 'Position');
  const [track] = state.queue.splice(position - 1, 1);
  cleanupLocalFile(track);
  prefetchNext(guildId); // whatever slid into the front warms up now
  return track;
}

/** Clear the upcoming queue (current track keeps playing). Returns count removed. */
export function clearQueue(guildId) {
  const state = guilds.get(guildId);
  if (!state || !state.queue.length) throw new Error('The queue is already empty.');
  const count = state.queue.length;
  for (const t of state.queue) cleanupLocalFile(t);
  state.queue.length = 0;
  return count;
}

/**
 * Force-skip the current track. No vote — it just skips.
 * Track loop does NOT replay a force-skipped track; under queue loop it
 * is re-queued at the end (same as a natural finish). If the queue is
 * empty, playback simply stops (the bot stays in the channel).
 */
export function forceSkip(guildId) {
  const state = guilds.get(guildId);
  if (!state?.current) throw new Error('Nothing is playing right now.');
  const skipped = state.current;
  const upNext = state.queue[0]?.title ?? null;
  state.forceSkip = true;
  killFfmpeg(state);
  state.player.stop();
  return { skipped: skipped.title, upNext, queueLength: state.queue.length };
}

/**
 * Play a track right now, interrupting whatever is playing.
 * The interrupted track is discarded (never re-queued, whatever the
 * loop mode is), and the new track goes on next.
 */
export function forcePlay(guild, member, textChannel, track) {
  prepareVoice(guild, member, textChannel);
  const state = getState(guild.id);
  const interrupted = state.current;
  state.queue.unshift({ ...track, requestedBy: member.user.tag });
  prefetchNext(guild.id); // the forced track itself — resolve while we interrupt
  if (interrupted) {
    cleanupLocalFile(interrupted);
    state.current = null;
    state.forceSkip = false;
    // Swallow the Idle event player.stop() is about to fire so the
    // interrupted track can't loop or re-queue itself; handleTrackEnd
    // sees the flag and moves straight to the replacement track.
    state.suppressNextEnd = true;
    killFfmpeg(state);
    state.player.stop(true);
    // Belt and braces: if that Idle event never fired (already idle),
    // consume the flag ourselves and start the replacement.
    if (state.suppressNextEnd && state.player.state.status === AudioPlayerStatus.Idle) {
      state.suppressNextEnd = false;
      void playNext(guild.id);
    }
  } else if (state.player.state.status === AudioPlayerStatus.Idle) {
    void playNext(guild.id);
  }
  return { interrupted: interrupted?.title ?? null };
}
