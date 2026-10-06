import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';
import { streamUrlFor, formatDuration } from './youtube.js';

export const BRAND = 0x2d6a4f; // swamp green
export const BOT_NAME = 'Swamp Tunes';

const guilds = new Map(); // guildId -> state

function nowPlayingEmbed(track) {
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle('🎶 Now playing')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Requested by', value: track.requestedBy, inline: true },
    )
    .setFooter({ text: BOT_NAME });
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
      textChannel: null,
    };
    player.on(AudioPlayerStatus.Idle, () => {
      state.current = null;
      void playNext(guildId);
    });
    player.on('error', (err) => {
      console.error(`[${BOT_NAME}] player error:`, err.message);
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

async function playNext(guildId) {
  const state = guilds.get(guildId);
  if (!state || state.player.state.status !== AudioPlayerStatus.Idle) return;
  const next = state.queue.shift();
  if (!next) return; // queue empty — stay connected until /stop or /leave
  state.current = next;
  try {
    const url = await streamUrlFor(next.id);
    const resource = createAudioResource(url, { inlineVolume: true });
    resource.volume?.setVolume(state.volume);
    state.player.play(resource);
    announce(state, { embeds: [nowPlayingEmbed(next)] });
  } catch (err) {
    console.error(`[${BOT_NAME}] stream error:`, err.message);
    announce(state, `⚠️ Couldn't load **${next.title}** — skipping.`);
    state.current = null;
    void playNext(guildId);
  }
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
        state.connection?.destroy();
        state.connection = null;
        state.queue.length = 0;
        state.current = null;
      }
    });
  } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    // User is in a different channel — move the bot to them.
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

export function skip(guildId) {
  const state = guilds.get(guildId);
  if (!state?.current) throw new Error('Nothing is playing right now.');
  const title = state.current.title;
  state.player.stop(); // Idle event advances the queue
  return title;
}

export function stopAll(guildId) {
  const state = guilds.get(guildId);
  if (!state) throw new Error('Nothing is playing right now.');
  state.queue.length = 0;
  state.current = null;
  state.player.stop();
  state.connection?.destroy();
  state.connection = null;
}

export function leave(guildId) {
  const state = guilds.get(guildId);
  if (!state?.connection) throw new Error("I'm not in a voice channel.");
  stopAll(guildId);
}

export function togglePause(guildId, pause) {
  const state = guilds.get(guildId);
  if (!state?.current) throw new Error('Nothing is playing right now.');
  if (pause) state.player.pause();
  else state.player.unpause();
  return state.current.title;
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

export function shuffleQueue(guildId) {
  const state = guilds.get(guildId);
  if (!state || state.queue.length < 2) throw new Error('Need at least 2 songs in the queue to shuffle.');
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  return state.queue.length;
}

export function queueEmbed(guildId) {
  const state = guilds.get(guildId);
  const embed = new EmbedBuilder().setColor(BRAND).setTitle(`🎧 ${BOT_NAME} queue`);
  if (!state || (!state.current && state.queue.length === 0)) {
    return embed.setDescription('The queue is empty. Use `/play` to add something.');
  }
  const lines = [];
  if (state.current) {
    lines.push(`**Now:** [${state.current.title}](${state.current.url}) \`${formatDuration(state.current.duration)}\``);
  }
  state.queue.slice(0, 15).forEach((t, i) => {
    lines.push(`**${i + 1}.** [${t.title}](${t.url}) \`${formatDuration(t.duration)}\` — ${t.requestedBy}`);
  });
  if (state.queue.length > 15) lines.push(`…and ${state.queue.length - 15} more`);
  return embed.setDescription(lines.join('\n')).setFooter({ text: BOT_NAME });
}

export function nowPlayingInfo(guildId) {
  const state = guilds.get(guildId);
  if (!state?.current) throw new Error('Nothing is playing right now.');
  return nowPlayingEmbed(state.current);
}
