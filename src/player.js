import { spawn } from 'node:child_process';
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
import { streamUrlFor, formatDuration } from './youtube.js';

export const BRAND = 0x2d6a4f; // swamp green
export const BOT_NAME = 'Swamp Tunes';

const guilds = new Map(); // guildId -> state

function nowPlayingEmbed(track, bassBoost) {
  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle('🎶 Now playing')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Requested by', value: track.requestedBy, inline: true },
    );
  if (bassBoost) embed.addFields({ name: '🔊 Bass boost', value: 'ON', inline: true });
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
    };
    player.on(AudioPlayerStatus.Idle, () => {
      state.current = null;
      void playNext(guildId);
    });
    player.on('error', (err) => {
      console.error(`[${BOT_NAME}] player error:`, err.message);
      killFfmpeg(state);
      state.textChannel?.send(`⚠️ Playback hiccup on **${state.current?.title ?? 'a track'}** — skipping.`).catch(() => {});
      state.current = null;
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

function startTrack(state, guildId, track) {
  killFfmpeg(state);
  return (async () => {
    const url = await streamUrlFor(track.id);
    const resource = createResource(url, state.bassBoost, state);
    resource.volume?.setVolume(state.volume);
    state.player.play(resource);
    announce(state, { embeds: [nowPlayingEmbed(track, state.bassBoost)] });
  })().catch((err) => {
    console.error(`[${BOT_NAME}] stream error:`, err.message);
    killFfmpeg(state);
    announce(state, `⚠️ Couldn't load **${track.title}** — skipping.`);
    state.current = null;
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
  return tracks.length;
}

export function stopAll(guildId) {
  const state = guilds.get(guildId);
  if (!state) throw new Error('Nothing is playing right now.');
  state.queue.length = 0;
  state.current = null;
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
