import 'dotenv/config';
import http from 'node:http';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { commands } from './commands.js';
import { checkYtDlp, resolveTrack, resolveTextQuery, resolveAnyQuery, resolvePlaylistTracks, parsePlaylistLink, findOnYouTube, formatDuration } from './youtube.js';
import { isSpotifyUrl, resolveSpotify } from './spotify.js';
import { isDeezerUrl, resolveDeezer } from './deezer.js';
import { isAppleMusicUrl, resolveAppleMusic } from './applemusic.js';
import {
  BOT_NAME,
  BRAND,
  enqueue,
  enqueueMany,
  prepareVoice,
  stopAll,
  disconnect,
  togglePause,
  toggleBassBoost,
  setVolume,
  getQueueSnapshot,
  getNowPlaying,
  getCurrentTrack,
  shuffleQueue,
  setLoopMode,
  moveTrack,
  removeTrack,
  clearQueue,
  forceSkip,
  forcePlay,
  trackLabel,
} from './player.js';
import { setTheme, parseHexColor, formatHexColor, applyTheme } from './themes.js';
import { applyProfile } from './profile.js';
import { lyricsForTrack, lyricsForQuery } from './lyrics.js';
import {
  MAX_UPLOAD_BYTES,
  PLAYABLE_EXTS,
  UNSUPPORTED_AUDIO_EXTS,
  canUpload,
  djRoleName,
  extOf,
  downloadAsTrack,
  removeTempFile,
} from './uploads.js';

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN || TOKEN === 'paste-your-bot-token-here') {
  console.error('❌ Set DISCORD_TOKEN in your .env file (see .env.example).');
  process.exit(1);
}

function errEmbed(message) {
  return new EmbedBuilder().setColor(0xb00020).setDescription(`❌ ${message}`).setFooter({ text: BOT_NAME });
}

function okEmbed(text) {
  return new EmbedBuilder().setColor(BRAND).setDescription(text).setFooter({ text: BOT_NAME });
}

/**
 * What a command error may say in the channel. The bot's own errors are
 * written for members ("Join a voice channel first…") and pass through;
 * anything carrying tool output (a raw yt-dlp failure dumps the whole
 * command and its stderr) becomes one clean line — the full error still
 * goes to the server log, never into the chat.
 */
function publicErrorMessage(err) {
  const msg = String(err?.message || '');
  const technical = /command failed|yt-dlp|http error|error: \[|warning: \[|failed to extract|killed with|etimedout|econnreset/i;
  if (!msg || msg.length > 180 || technical.test(msg)) {
    return 'Something went wrong with that one — try again, or try a direct link.';
  }
  return msg;
}

function guildIcon(guild) {
  try { return guild?.iconURL() || null; } catch { return null; }
}

function progressBar(elapsed, duration) {
  if (!duration || duration <= 0) return '🔘 LIVE';
  const total = 12;
  const filled = Math.max(0, Math.min(total, Math.round((elapsed / duration) * total)));
  return '▰'.repeat(filled) + '▱'.repeat(total - filled);
}

/**
 * Resolve a query to ONE track (Spotify/Deezer/Apple Music links: their first
 * track). This backs /forceplay, whose contract is a single song — so a
 * YouTube/SoundCloud playlist link also lands here and forceplays just its
 * first track via resolveTrack. Whole playlists are /play's job.
 */
async function resolveLinkedTrack(query) {
  const isSp = isSpotifyUrl(query);
  const isDz = isDeezerUrl(query);
  const isAm = isAppleMusicUrl(query);
  if (!isSp && !isDz && !isAm) {
    // Plain song names AND YouTube links resolve through the unwalled
    // doors (SoundCloud/Invidious); other direct links keep yt-dlp.
    return resolveAnyQuery(query);
  }
  const sourceName = isSp ? 'Spotify' : isDz ? 'Deezer' : 'Apple Music';
  const metas = isSp
    ? await resolveSpotify(query)
    : isDz
      ? await resolveDeezer(query)
      : await resolveAppleMusic(query);
  if (!metas.length) throw new Error(`That ${sourceName} link has no playable tracks.`);
  return findOnYouTube(metas[0].title, metas[0].artist);
}

function attachInteractionHandler(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    const guildId = interaction.guildId;

    try {
      if (commandName === 'play') {
        await interaction.deferReply();
        const query = interaction.options.getString('query', true);

        // Spotify / Deezer / Apple Music links: resolve to track list, then match each on YouTube.
        const isSp = isSpotifyUrl(query);
        const isDz = isDeezerUrl(query);
        const isAm = isAppleMusicUrl(query);
        if (isSp || isDz || isAm) {
          const sourceName = isSp ? 'Spotify' : isDz ? 'Deezer' : 'Apple Music';
          // Fail fast if the user isn't in a voice channel before the slow lookups.
          prepareVoice(interaction.guild, interaction.member, interaction.channel);
          await interaction.editReply(`🔍 Reading ${sourceName} link…`);
          const metas = isSp
            ? await resolveSpotify(query)
            : isDz
              ? await resolveDeezer(query)
              : await resolveAppleMusic(query);
          const tracks = [];
          const CONCURRENCY = 6;
          for (let i = 0; i < metas.length; i += CONCURRENCY) {
            const batch = metas.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
              batch.map((m) => findOnYouTube(m.title, m.artist)),
            );
            for (const r of results) {
              if (r.status === 'fulfilled') tracks.push(r.value);
            }
            await interaction.editReply(
              `🔍 ${sourceName}: matched ${tracks.length}/${metas.length} on YouTube…`,
            );
          }
          if (!tracks.length) throw new Error(`Couldn't match any tracks from that ${sourceName} link on YouTube.`);
          const added = enqueueMany(interaction.guild, interaction.member, interaction.channel, tracks);
          const preview = tracks.slice(0, 5).map((t, i) => `**${i + 1}.** ${t.title}`).join('\n');
          const embed = new EmbedBuilder()
            .setTitle(`➕ Added ${added} song${added === 1 ? '' : 's'} from ${sourceName}`)
            .setDescription(preview + (added > 5 ? `\n…and ${added - 5} more` : ''))
            .setFooter({ text: BOT_NAME });
          applyTheme(embed, guildId, { track: tracks[0], guildIcon: guildIcon(interaction.guild) });
          await interaction.editReply({ content: '', embeds: [embed] });
          return;
        }

        // YouTube playlist / SoundCloud set links: queue the whole list.
        const playlist = parsePlaylistLink(query);
        if (playlist) {
          prepareVoice(interaction.guild, interaction.member, interaction.channel);
          await interaction.editReply(`🔍 Reading ${playlist.service} playlist…`);
          const tracks = await resolvePlaylistTracks(query);
          const added = enqueueMany(interaction.guild, interaction.member, interaction.channel, tracks);
          const preview = tracks.slice(0, 5).map((t, i) => `**${i + 1}.** ${t.title}`).join('\n');
          const embed = new EmbedBuilder()
            .setTitle(`➕ Added ${added} song${added === 1 ? '' : 's'} from ${playlist.service}`)
            .setDescription(preview + (added > 5 ? `\n…and ${added - 5} more` : ''))
            .setFooter({ text: BOT_NAME });
          applyTheme(embed, guildId, { track: tracks[0], guildIcon: guildIcon(interaction.guild) });
          await interaction.editReply({ content: '', embeds: [embed] });
          return;
        }

        const track = await resolveAnyQuery(query);
        const { position } = enqueue(interaction.guild, interaction.member, interaction.channel, track);
        const embed = new EmbedBuilder()
          .setTitle('➕ Added to queue')
          .setDescription(trackLabel(track))
          .addFields(
            { name: 'Duration', value: formatDuration(track.duration), inline: true },
            { name: 'Position', value: position === 1 ? 'Up next' : `#${position}`, inline: true },
          )
          .setFooter({ text: BOT_NAME });
        applyTheme(embed, guildId, { track, guildIcon: guildIcon(interaction.guild) });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      switch (commandName) {
        case 'stop':
          stopAll(guildId);
          await interaction.reply({ embeds: [okEmbed('⏹️ Stopped and cleared the queue.')] });
          break;
        case 'disconnect':
          disconnect(guildId);
          await interaction.reply({ embeds: [okEmbed('👋 Disconnected from the voice channel.')] });
          break;
        case 'volume': {
          const level = setVolume(guildId, interaction.options.getInteger('level', true));
          await interaction.reply({ embeds: [okEmbed(`🔊 Volume set to **${level}%**`)] });
          break;
        }
        case 'bassboost': {
          const { enabled, title } = toggleBassBoost(guildId);
          await interaction.reply({
            embeds: [okEmbed(enabled
              ? `🔊 **Bass boost ON**${title ? ` — replaying **${title}** with extra bass` : ''}`
              : '🔊 **Bass boost OFF**')],
          });
          break;
        }
        case 'pause': {
          const { paused, title } = togglePause(guildId);
          await interaction.reply({ embeds: [okEmbed(paused ? `⏸️ Paused **${title}**` : `▶️ Resumed **${title}**`)] });
          break;
        }
        case 'queue': {
          const snap = getQueueSnapshot(guildId);
          if (!snap.current && !snap.queue.length) {
            await interaction.reply({ embeds: [okEmbed('🎶 Nothing is playing and the queue is empty.')] });
            break;
          }
          const totalSec = snap.queue.reduce((sum, t) => sum + (t.duration || 0), 0);
          const SHOW = 15;
          const lines = snap.queue.slice(0, SHOW).map((t, i) =>
            `**${i + 1}.** ${t.title} — ${formatDuration(t.duration)}`);
          if (snap.queue.length > SHOW) lines.push(`…and ${snap.queue.length - SHOW} more`);
          const embed = new EmbedBuilder()
            .setTitle('🎶 Queue')
            .setFooter({ text: BOT_NAME });
          if (snap.current) {
            embed.addFields({ name: 'Now playing', value: `${snap.current.title} — ${formatDuration(snap.current.duration)}` });
          }
          embed.setDescription(lines.length ? lines.join('\n') : '_Nothing queued up._')
            .addFields(
              { name: 'Songs queued', value: String(snap.queue.length), inline: true },
              { name: 'Queue length', value: formatDuration(totalSec), inline: true },
              { name: '🔁 Loop', value: snap.loopMode, inline: true },
            );
          applyTheme(embed, guildId, { track: snap.current || snap.queue[0], guildIcon: guildIcon(interaction.guild) });
          await interaction.reply({ embeds: [embed] });
          break;
        }
        case 'nowplaying': {
          const np = getNowPlaying(guildId);
          if (!np) {
            await interaction.reply({ embeds: [okEmbed('🎶 Nothing is playing right now.')] });
            break;
          }
          const embed = new EmbedBuilder()
            .setTitle(np.paused ? '⏸️ Now playing (paused)' : '🎶 Now playing')
            .setDescription(trackLabel(np.track))
            .addFields(
              { name: 'Progress', value: `${progressBar(np.elapsed, np.track.duration)}\n${formatDuration(Math.floor(np.elapsed))} / ${formatDuration(np.track.duration)}` },
              { name: '🔊 Volume', value: `${Math.round(np.volume * 100)}%`, inline: true },
              { name: '🔁 Loop', value: np.loopMode, inline: true },
              { name: '🔊 Bass boost', value: np.bassBoost ? 'ON' : 'OFF', inline: true },
              { name: 'Requested by', value: np.track.requestedBy || '—', inline: true },
              { name: 'Up next', value: np.queueLength ? `${np.queueLength} song${np.queueLength === 1 ? '' : 's'}` : 'Nothing', inline: true },
            )
            .setFooter({ text: BOT_NAME });
          applyTheme(embed, guildId, { track: np.track, guildIcon: guildIcon(interaction.guild) });
          await interaction.reply({ embeds: [embed] });
          break;
        }
        case 'lyrics': {
          await interaction.deferReply();
          const query = interaction.options.getString('query');
          let result = null;
          let label = '';
          if (query) {
            result = await lyricsForQuery(query);
            label = query;
          } else {
            const current = getCurrentTrack(guildId);
            if (!current) throw new Error('Nothing is playing right now — or name a song: /lyrics query.');
            result = await lyricsForTrack(current);
            label = current.title;
          }
          if (!result) {
            await interaction.editReply({ embeds: [okEmbed(`🎤 No lyrics found for **${label}**.`)] });
            break;
          }
          let text = result.lyrics;
          if (text.length > 3900) text = `${text.slice(0, 3900)}\n\n…(trimmed)`;
          const title = result.artist ? `${result.artist} — ${result.title}` : result.title;
          const embed = new EmbedBuilder()
            .setColor(BRAND)
            .setTitle(`🎤 ${title}`.slice(0, 256))
            .setDescription(text)
            .setFooter({ text: `${BOT_NAME} • lyrics via lyrics.ovh` });
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        case 'shuffle': {
          const count = shuffleQueue(guildId);
          await interaction.reply({ embeds: [okEmbed(`🔀 Shuffled **${count}** queued song${count === 1 ? '' : 's'}.`)] });
          break;
        }
        case 'loop': {
          const mode = setLoopMode(guildId, interaction.options.getString('mode'));
          const text = mode === 'off' ? '🔁 Loop **off**'
            : mode === 'track' ? '🔂 Looping the **current track**'
            : '🔁 Looping the **whole queue**';
          await interaction.reply({ embeds: [okEmbed(text)] });
          break;
        }
        case 'move': {
          const from = interaction.options.getInteger('from', true);
          const to = interaction.options.getInteger('to', true);
          const { track, position } = moveTrack(guildId, from, to);
          await interaction.reply({ embeds: [okEmbed(`↕️ Moved **${track.title}** to position **#${position}**.`)] });
          break;
        }
        case 'remove': {
          const track = removeTrack(guildId, interaction.options.getInteger('position', true));
          await interaction.reply({ embeds: [okEmbed(`🗑️ Removed **${track.title}** from the queue.`)] });
          break;
        }
        case 'clear': {
          const count = clearQueue(guildId);
          await interaction.reply({ embeds: [okEmbed(`🧹 Cleared **${count}** queued song${count === 1 ? '' : 's'} — the current one keeps playing.`)] });
          break;
        }
        case 'forceskip': {
          const { skipped, upNext } = forceSkip(guildId);
          await interaction.reply({
            embeds: [okEmbed(`⏭️ Skipped **${skipped}**${upNext ? ` — up next: **${upNext}**` : ' — nothing else queued, playback stopped.'}`)],
          });
          break;
        }
        case 'forceplay': {
          await interaction.deferReply();
          const query = interaction.options.getString('query', true);
          prepareVoice(interaction.guild, interaction.member, interaction.channel);
          const track = await resolveLinkedTrack(query);
          const { interrupted } = forcePlay(interaction.guild, interaction.member, interaction.channel, track);
          const embed = new EmbedBuilder()
            .setTitle('⏩ Force playing')
            .setDescription(trackLabel(track))
            .addFields({ name: 'Duration', value: formatDuration(track.duration), inline: true })
            .setFooter({ text: BOT_NAME });
          if (interrupted) embed.addFields({ name: 'Interrupted', value: interrupted, inline: true });
          applyTheme(embed, guildId, { track, guildIcon: guildIcon(interaction.guild) });
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        case 'theme': {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ embeds: [errEmbed('You need the **Manage Server** permission to set the theme.')], flags: MessageFlags.Ephemeral });
            break;
          }
          const colorInput = interaction.options.getString('color');
          const style = interaction.options.getString('style');
          if (!colorInput && !style) {
            await interaction.reply({
              embeds: [errEmbed('Give me a color (like #2bff88) and/or a thumbnail style to set.')],
              flags: MessageFlags.Ephemeral,
            });
            break;
          }
          const patch = {};
          if (colorInput) {
            const parsed = parseHexColor(colorInput);
            if (parsed === null) throw new Error(`"${colorInput}" isn't a hex color — try something like #2bff88.`);
            patch.color = parsed;
          }
          if (style) patch.style = style;
          const theme = setTheme(guildId, patch);
          const styleLabels = { track: 'Track thumbnail', server: 'Server icon', none: 'None' };
          const embed = new EmbedBuilder()
            .setColor(theme.color)
            .setTitle('🎨 Music theme updated')
            .addFields(
              { name: 'Color', value: formatHexColor(theme.color), inline: true },
              { name: 'Thumbnails', value: styleLabels[theme.style] || theme.style, inline: true },
            )
            .setFooter({ text: BOT_NAME });
          await interaction.reply({ embeds: [embed] });
          break;
        }
        default:
          await interaction.reply({ embeds: [errEmbed('Unknown command.')] });
      }
    } catch (err) {
      console.error(`[${BOT_NAME}] command error:`, err?.stack || err?.message || err);
      const payload = { embeds: [errEmbed(publicErrorMessage(err))] };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload)
          .catch(() => interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {}));
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

/**
 * Local file uploads: a permitted user drops a .mp3 / .wav in a text
 * channel and it gets queued. Anything else stays silent, except a
 * permitted user dropping an unsupported audio file gets one short note.
 */
function attachUploadHandler(client) {
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author.bot || !message.attachments?.size) return;
      const atts = [...message.attachments.values()];
      const playable = atts.filter((a) => PLAYABLE_EXTS.includes(extOf(a.name)));
      const unsupported = atts.filter((a) => UNSUPPORTED_AUDIO_EXTS.includes(extOf(a.name)));
      if (!playable.length && !unsupported.length) return; // ordinary chat — no noise

      const member = message.member
        ?? await message.guild.members.fetch(message.author.id).catch(() => null);
      if (!canUpload(member, message.guild)) {
        if (playable.length) {
          await message.reply(
            `🎧 Only the server owner, admins, members with Manage Server, or the **${djRoleName()}** role can upload songs.`,
          ).catch(() => {});
        }
        return;
      }
      if (!playable.length) {
        await message.reply('🎧 I can only play **.mp3** and **.wav** uploads.').catch(() => {});
        return;
      }
      if (!member.voice?.channel) {
        await message.reply('🎧 Join a voice channel first, then drop the file again.').catch(() => {});
        return;
      }
      for (const att of playable) {
        if (att.size > MAX_UPLOAD_BYTES) {
          await message.reply(`🎧 **${att.name}** is too big — uploads are capped at 10 MB.`).catch(() => {});
          continue;
        }
        let file = null;
        try {
          const got = await downloadAsTrack(att);
          file = got.file;
          const { position } = enqueue(message.guild, member, message.channel, got.track);
          await message.reply(
            `🎧 Added **${att.name}** — ${position <= 1 ? 'up first' : `queue position #${position}`}.`,
          ).catch(() => {});
        } catch (err) {
          removeTempFile(file);
          console.error(`[${BOT_NAME}] upload error:`, err.message);
          await message.reply(`🎧 Couldn't use **${att.name}** — the download or the file didn't work out.`).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[${BOT_NAME}] upload handler error:`, err.message);
    }
  });
}

function buildClient(withMessageIntents) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
  if (withMessageIntents) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const client = new Client({ intents });
  // A failed interaction reply must never take the process down: an
  // unhandled 'error' event on the Client throws and kills the bot
  // (that turned one failed /play into a full crash + restart).
  client.on('error', (err) => console.error(`[${BOT_NAME}] client error:`, err?.message || err));

  client.once('clientReady', async () => {
    console.log(`✅ ${BOT_NAME} is online as ${client.user.tag}`);

    const ytdlp = await checkYtDlp();
    if (!ytdlp) {
      console.error('❌ yt-dlp not found on PATH. Install it: pip install yt-dlp (and ffmpeg).');
    } else {
      console.log(`🎬 yt-dlp ${ytdlp} ready`);
    }

    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
      if (process.env.GUILD_ID) {
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
          { body: commands },
        );
        console.log('📝 Commands registered to test server (instant).');
      } else {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('📝 Global commands registered (can take up to an hour to appear).');
      }
    } catch (err) {
      console.error('❌ Failed to register commands:', err.message);
    }

    // Dress the bot's own profile (avatar, banner, About Me) from
    // assets/ — guarded so it only applies what is missing. Never throws.
    await applyProfile(client);
  });

  attachInteractionHandler(client);
  if (withMessageIntents) attachUploadHandler(client);
  return client;
}

process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

// Tiny HTTP server so free hosting plans have a health check to hit.
// (Free services sleep without HTTP traffic — see README.)
// Default 7860 suits Hugging Face Spaces Docker; hosts like Render/Koyeb set PORT.
const PORT = process.env.PORT || 7860;
import { probePlayback } from './player.js';

let probePromise = null;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/probe' && process.env.PROBE_KEY && url.searchParams.get('k') === process.env.PROBE_KEY) {
    if (!probePromise) probePromise = probePlayback().catch((e) => ({ error: String(e?.message || e) }));
    const result = await probePromise;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Swamp Tunes is swimming 🐊');
}).listen(PORT, () => console.log(`🌐 Health check listening on port ${PORT}`));

// Uploads need the privileged Message Content intent. If it isn't enabled
// in the developer portal yet, Discord rejects the login — so fall back
// to running without message intents (everything else keeps working)
// instead of crashing.
(async () => {
  try {
    await buildClient(true).login(TOKEN);
  } catch (err) {
    if (/disallowed intents/i.test(err?.message || '')) {
      console.error('⚠️ Message Content intent is not enabled for this bot — starting WITHOUT file uploads.');
      console.error('   Enable it in the developer portal (Bot → Privileged Gateway Intents → Message Content Intent) and restart to turn uploads on.');
      await buildClient(false).login(TOKEN);
    } else {
      throw err;
    }
  }
})().catch((err) => {
  console.error('❌ Login failed:', err.message);
  process.exit(1);
});
