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
import { streamUrlFor, searchOnSoundCloud, searchOnSoundCloudApi, searchOnYouTube, invidiousStreamFor, resolveTextQuery, errReason, formatDuration } from './youtube.js';
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

export function createResource(url, bassBoost, state) {
  // EVERY track plays through ffmpeg, the classic direct-player shape:
  // ffmpeg reads the stream itself with reconnect switched on (a dropped
  // connection rejoins instead of killing the song), video is disabled,
  // and clean 48kHz PCM comes out the pipe for the voice encoder. Handing
  // the bare URL to the voice library instead left playback at the mercy
  // of its probe/transcode path — and with no opus encoder installed
  // that path died on every non-Opus stream (the Nov 9 production bug:
  // songs resolved, then "Cannot find module '@discordjs/opus'").
  const ff = spawn(FFMPEG, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-analyzeduration', '0', '-loglevel', '0',
    '-i', url,
    '-vn',
    ...(bassBoost ? ['-af', 'bass=g=15:f=110'] : []),
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  state.ffmpeg = ff;
  ff.on('error', () => {});
  return createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
}

/**
 * Play a play-dl stream: the stream play-dl opened is piped into the
 * same ffmpeg stage every other source uses, so volume, bass boost and
 * the opus pipeline behave identically whatever door the song came in.
 */
export function createPlayDlResource(playDlInfo, bassBoost, state) {
  const ff = spawn(FFMPEG, [
    '-analyzeduration', '0', '-loglevel', '0',
    '-i', 'pipe:0',
    '-vn',
    ...(bassBoost ? ['-af', 'bass=g=15:f=110'] : []),
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  state.ffmpeg = ff;
  ff.on('error', () => {});
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

export function isSameSong(requested, candidate) {
  if (!requested?.title || !candidate?.title) return false;
  const reqTokens = normTokens(requested.title);
  if (!reqTokens.size) return false;
  const candTokens = normTokens(`${candidate.title} ${candidate.uploader || ''}`);
  let matched = 0;
  for (const t of reqTokens) if (candTokens.has(t)) matched++;
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
    for (const t of distinctiveTokens) if (candTokens.has(t)) matchedDistinctive++;
    const minDistinctive = distinctiveTokens.length === 1 ? 1 : 2;
    if (matchedDistinctive < minDistinctive || matchedDistinctive / distinctiveTokens.length < 0.6) {
      return false;
    }
  }

  if (!artistWords.length) return true;
  if (artistWords.some((w) => candTokens.has(w))) return true;
  const candUploaderWords = [...normTokens(candidate.uploader || '')]
    .filter((w) => !ARTIST_STOPWORDS.has(w));
  return candUploaderWords.some((w) => reqTokens.has(w));
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
const VERSION_WORDS = new Set(['fast', 'sped', 'slowed', 'remix', 'cover', 'karaoke', 'instrumental', 'nightcore', 'reverb', 'jersey']);

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
  for (const t of req) if (cand.has(t)) matched++;
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
 * The playback cascade: find ONE reachable stream for the exact song,
 * within the budget. Proven in production (Nov 2026): from the host's
 * datacenter IP, YouTube refuses EVERY player client (webpage 429, API
 * 403, "failed to extract any player response"), while SoundCloud
 * serves the same catalog fine — so sources are tried in this order:
 *
 * 1. SOUNDCLOUD. A track that lives there plays from its own page.
 *    Anything else is searched (the SoundCloud API first — fast, and
 *    its ranking puts the artist's own upload first; the yt-dlp search
 *    as backup), gated by isSameSong, best match first, up to 3
 *    candidates tried (official uploads are often SAMPLE-AES DRM and
 *    fail extraction; fan re-uploads of the same song play).
 * 2. YOUTUBE, the track's own video through the client rotation.
 * 3. INVIDIOUS for the same video (another front-end, another network),
 *    then a gated YouTube RE-SEARCH: a different upload of the same
 *    song, tried through both extraction routes.
 *
 * Every attempt logs exactly one line with its outcome, success or the
 * failure reason — no silent catches anywhere in this path. The queue
 * entry, title and now-playing flow never change; only the host behind
 * the song does.
 */
/** Strip video-title decoration ('[ Official Video ]', quotes) for search queries. */
function cleanSongQuery(title) {
  return String(title || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:official|music|lyric|audio|video|hd|4k)[^)]*\)/gi, ' ')
    .replace(/["""]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolvePlayable(track, { budgetMs = RESOLVE_BUDGET_MS, priority = 'high' } = {}) {
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  const artist = track.uploader || track.artist || '';
  const searchTitle = cleanSongQuery(track.title) || track.title;
  const isSCTrack = /soundcloud\.com/i.test(track.url || '');
  let lastErr = null;
  const noteFail = (label, err) => {
    lastErr = err;
    console.log(`[${BOT_NAME}] ${label} failed for "${track.title}": ${errReason(err)}`);
  };

  const trySoundCloudSearch = async (excludeId) => {
    let candidates = [];
    try {
      candidates = await searchOnSoundCloudApi(searchTitle, artist, {
        timeoutMs: Math.min(8_000, Math.max(1_000, remaining())),
      });
    } catch (err) { noteFail('soundcloud api search', err); }
    if (!candidates.length && remaining() > 3_000) {
      try {
        candidates = await searchOnSoundCloud(searchTitle, artist, {
          timeoutMs: Math.min(15_000, remaining()),
          retry: false,
        });
      } catch (err) { noteFail('soundcloud search', err); }
    }
    const ranked = rankedMatches(track, candidates).filter((c) => c.id !== excludeId);
    if (!ranked.length) {
      console.log(`[${BOT_NAME}] soundcloud: no exact-song match for "${track.title}"`);
      return null;
    }
    for (const cand of ranked.slice(0, 5)) {
      if (remaining() <= 1_000) break;
      try {
        const url = await streamUrlFor(cand.id, cand.url, { priority, deadline });
        console.log(`[${BOT_NAME}] soundcloud: playing "${cand.title}" by ${cand.uploader || 'unknown'} for "${track.title}"`);
        return url;
      } catch (err) { noteFail(`soundcloud candidate "${cand.title}"`, err); }
    }
    return null;
  };

  // Tier 0 — play-dl, for YouTube tracks: opens the stream directly
  // instead of asking yt-dlp to extract one, so YouTube's bot wall
  // never gets a say. Returns a live stream object, not a URL;
  // callers route it through the same ffmpeg stage as every source.
  if (!isSCTrack && track.url && remaining() > 1_000) {
    try {
      const info = await withStreamTimeout(
        playDl.stream(track.url),
        Math.min(6_000, remaining()),
        'play-dl',
      );
      console.log(`[${BOT_NAME}] play-dl: playing "${track.title}"`);
      return { playDl: info };
    } catch (err) { noteFail('play-dl', err); }
  }

  // Tier 1 — SoundCloud.
  if (isSCTrack) {
    try {
      const url = await streamUrlFor(track.id, track.url, { priority, deadline });
      console.log(`[${BOT_NAME}] soundcloud: playing "${track.title}" from its own page`);
      return url;
    } catch (err) { noteFail('soundcloud', err); }
    const viaSearch = await trySoundCloudSearch(track.id);
    if (viaSearch) return viaSearch;
  } else {
    const viaSC = await trySoundCloudSearch(null);
    if (viaSC) return viaSC;
  }

  // Tier 2 — Invidious: the same video through another front-end.
  // This door answers from the instance's network, so it goes BEFORE
  // the yt-dlp rotation: from a datacenter IP every walled rotation
  // attempt burns its full timeout, and putting rotation first starved
  // Invidious out of the budget entirely (Bizzy Banks, Nov 9 — the
  // song died with its one reachable door never tried).
  if (!isSCTrack && track.id && remaining() > 1_000) {
    try {
      const s = await invidiousStreamFor(track.id, { deadline });
      console.log(`[${BOT_NAME}] invidious: playing "${track.title}" via ${s.host} (${s.format})`);
      return s.url;
    } catch (err) { noteFail('invidious', err); }
  }

  // Tier 3 — YouTube rotation on the track's own video (last resort:
  // slow and walled from datacenter IPs).
  if (!isSCTrack && track.id && remaining() > 1_000) {
    try {
      return await streamUrlFor(track.id, track.url, { priority, deadline });
    } catch (err) { noteFail('youtube', err); }
  }

  // Tier 3b — gated re-search: another upload of the same song, through
  // yt-dlp extraction and then Invidious. Also the only YouTube route
  // for a SoundCloud-native track whose own page failed.
  if (remaining() > 3_000) {
    let candidates = [];
    try {
      candidates = await searchOnYouTube(searchTitle, artist, {
        timeoutMs: Math.min(15_000, remaining()),
        retry: false,
      });
    } catch (err) { noteFail('youtube re-search', err); }
    const ranked = rankedMatches(track, candidates).filter((c) => c.id !== track.id);
    if (!ranked.length) {
      console.log(`[${BOT_NAME}] youtube re-search: no other upload of "${track.title}"`);
    }
    for (const cand of ranked.slice(0, 2)) {
      if (remaining() <= 1_000) break;
      try {
        const url = await streamUrlFor(cand.id, cand.url, { priority, deadline });
        console.log(`[${BOT_NAME}] youtube re-search: playing another upload of "${track.title}" ("${cand.title}")`);
        return url;
      } catch (err) { noteFail(`youtube candidate "${cand.title}"`, err); }
      if (remaining() <= 1_000) break;
      try {
        const s = await invidiousStreamFor(cand.id, { deadline });
        console.log(`[${BOT_NAME}] invidious: playing "${cand.title}" via ${s.host} (${s.format}) for "${track.title}"`);
        return s.url;
      } catch (err) { noteFail(`invidious candidate "${cand.title}"`, err); }
    }
  }

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
    }
    const resource = typeof src === 'object'
      ? createPlayDlResource(src.playDl, state.bassBoost, state)
      : createResource(src, state.bassBoost, state);
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
  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    state.connection.subscribe(state.player);
    state.connection.on('stateChange', (oldS, newS) => {
      console.log(`[${BOT_NAME}] voice: ${oldS.status} -> ${newS.status}${newS.closeCode ? ` (close ${newS.closeCode})` : ''}`);
    });
    state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(state.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(state.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        killFfmpeg(state);
        state.connection?.destroy();
        state.connection = null;
        cleanupLocalFile(state.current);
        for (const t of state.queue) cleanupLocalFile(t);
        state.queue.length = 0;
        state.current = null;
      }
    });
  } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    // User is in a different channel — move the bot to them.
    killFfmpeg(state);
    state.connection.destroy();
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    state.connection.subscribe(state.player);
    state.connection.on('stateChange', (oldS, newS) => {
      console.log(`[${BOT_NAME}] voice: ${oldS.status} -> ${newS.status}${newS.closeCode ? ` (close ${newS.closeCode})` : ''}`);
    });
  }
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
