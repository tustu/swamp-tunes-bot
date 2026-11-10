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
import { streamUrlFor, searchOnSoundCloud, searchOnYouTube, formatDuration } from './youtube.js';
import { applyTheme } from './themes.js';

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
 * Background-resolve a track's stream URL and cache it on the queue item,
 * so when its turn comes playback starts with no lookup wait.
 * A failed prefetch clears itself and startTrack falls back to resolving
 * at play time — prefetching can never break playback.
 */
function prefetchTrack(track) {
  if (!track || track.isLocal || track.streamUrl || track.streamPromise) return;
  track.streamPromise = streamUrlFor(track.id, track.url)
    .then((url) => { track.streamUrl = url; return url; })
    .catch((err) => {
      console.error(`[${BOT_NAME}] prefetch failed for "${track.title}":`, err.message);
      track.streamPromise = null;
      return null;
    });
}

/** Prefetch the next-up track (front of the queue) for a guild, if any. */
function prefetchNext(guildId) {
  const state = guilds.get(guildId);
  if (state?.queue[0]) prefetchTrack(state.queue[0]);
}

function createResource(url, bassBoost, state) {
  if (!bassBoost) return createAudioResource(url, { inlineVolume: true });
  // Route audio through ffmpeg with a bass boost filter.
  const ff = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-analyzeduration', '0', '-loglevel', '0',
    '-i', url,
    '-vn', '-af', 'bass=g=15:f=110',
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  state.ffmpeg = ff;
  ff.on('error', () => {});
  return createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
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
  if (!artistWords.length) return true;
  if (artistWords.some((w) => candTokens.has(w))) return true;
  const candUploaderWords = [...normTokens(candidate.uploader || '')]
    .filter((w) => !ARTIST_STOPWORDS.has(w));
  return candUploaderWords.some((w) => reqTokens.has(w));
}

/**
 * Resolve the URL a track will actually play from, at stream-start time.
 * Order: local file → prefetched URL (instant) → in-flight prefetch →
 * fresh extraction. If YouTube extraction fails outright (its bot wall
 * rejects datacenter IPs no matter which player client asks), the SAME
 * song is hunted down elsewhere, in order:
 * 1. SoundCloud — searched by title + artist, and a candidate only
 *    plays if it passes isSameSong against the requested track.
 * 2. YouTube again via plain search — a different upload of the same
 *    song often extracts when the linked one is walled or gone; same
 *    isSameSong gate, and never the very video that just failed.
 * Only when neither host has the exact song reachable does the track
 * skip, as before. Whichever URL wins is cached on the track, so a
 * replay or bass-boost toggle doesn't pay the lookup again. Tracks
 * that already live on SoundCloud get no fallback (there is nothing
 * behind them). The queue entry, title and now-playing flow never
 * change — only the host behind the song does.
 */
async function playableUrlFor(track) {
  if (track.isLocal) return track.localFile;
  if (track.streamUrl) return track.streamUrl; // prefetched — start instantly
  if (track.streamPromise) {
    const warmed = await track.streamPromise; // prefetch in flight
    if (warmed) return warmed;
  }
  try {
    return await streamUrlFor(track.id, track.url);
  } catch (err) {
    if (/soundcloud\.com/i.test(track.url || '')) throw err;
    const artist = track.uploader || track.artist || '';
    // 1) The same song on SoundCloud.
    try {
      const candidates = await searchOnSoundCloud(track.title, artist);
      const match = candidates.find((c) => isSameSong(track, c));
      if (match) {
        const url = await streamUrlFor(match.id, match.url);
        track.streamUrl = url;
        console.log(`[${BOT_NAME}] YouTube blocked, fell back to SoundCloud for "${track.title}"`);
        return url;
      }
    } catch { /* no reachable SoundCloud copy — try the re-search below */ }
    // 2) The same song through a fresh YouTube search (different upload).
    try {
      const candidates = await searchOnYouTube(track.title, artist);
      const match = candidates.find((c) => c.id !== track.id && isSameSong(track, c));
      if (match) {
        const url = await streamUrlFor(match.id, match.url);
        track.streamUrl = url;
        console.log(`[${BOT_NAME}] YouTube blocked "${track.title}", playing another upload of the same song found via search`);
        return url;
      }
    } catch { /* nothing reachable — the skip below is honest */ }
    throw err;
  }
}

function startTrack(state, guildId, track) {
  killFfmpeg(state);
  return (async () => {
    const url = await playableUrlFor(track);
    if (!url) throw new Error('No playable source for this track.');
    const resource = createResource(url, state.bassBoost, state);
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
  }
}

/** Join (or move to) the user's voice channel. Fails fast if they're not in one. */
export function prepareVoice(guild, member, textChannel) {
  const state = getState(guild.id);
  state.textChannel = textChannel;
  try { state.guildIcon = guild.iconURL() || null; } catch { state.guildIcon = null; }
  ensureConnection(state, guild, member);
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
