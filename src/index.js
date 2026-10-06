import 'dotenv/config';
import http from 'node:http';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
} from 'discord.js';
import { checkYtDlp, resolveTrack, findOnYouTube, formatDuration } from './youtube.js';
import { isSpotifyUrl, resolveSpotify } from './spotify.js';
import { isDeezerUrl, resolveDeezer } from './deezer.js';
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
} from './player.js';

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN || TOKEN === 'paste-your-bot-token-here') {
  console.error('❌ Set DISCORD_TOKEN in your .env file (see .env.example).');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play music: YouTube / Spotify / SoundCloud / Deezer link or search')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name, or a link from YouTube, Spotify, SoundCloud, Deezer').setRequired(true),
    ),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Stop everything and leave the voice channel'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the volume (0–200)')
    .addIntegerOption((o) =>
      o.setName('level').setDescription('Volume level').setRequired(true).setMinValue(0).setMaxValue(200),
    ),
  new SlashCommandBuilder().setName('bassboost').setDescription('Toggle bass boost on/off'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause or resume playback'),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
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
});

function errEmbed(message) {
  return new EmbedBuilder().setColor(0xb00020).setDescription(`❌ ${message}`).setFooter({ text: BOT_NAME });
}

function okEmbed(text) {
  return new EmbedBuilder().setColor(BRAND).setDescription(text).setFooter({ text: BOT_NAME });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    if (commandName === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);

      // Spotify / Deezer links: resolve to track list, then match each on YouTube.
      const isSp = isSpotifyUrl(query);
      const isDz = isDeezerUrl(query);
      if (isSp || isDz) {
        const sourceName = isSp ? 'Spotify' : 'Deezer';
        // Fail fast if the user isn't in a voice channel before the slow lookups.
        prepareVoice(interaction.guild, interaction.member, interaction.channel);
        await interaction.editReply(`🔍 Reading ${sourceName} link…`);
        const metas = isSp ? await resolveSpotify(query) : await resolveDeezer(query);
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
          .setColor(BRAND)
          .setTitle(`➕ Added ${added} song${added === 1 ? '' : 's'} from ${sourceName}`)
          .setDescription(preview + (added > 5 ? `\n…and ${added - 5} more` : ''))
          .setFooter({ text: BOT_NAME });
        await interaction.editReply({ content: '', embeds: [embed] });
        return;
      }

      const track = await resolveTrack(query);
      const { position } = enqueue(interaction.guild, interaction.member, interaction.channel, track);
      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setTitle('➕ Added to queue')
        .setDescription(`**[${track.title}](${track.url})**`)
        .addFields(
          { name: 'Duration', value: formatDuration(track.duration), inline: true },
          { name: 'Position', value: position === 1 ? 'Up next' : `#${position}`, inline: true },
        )
        .setFooter({ text: BOT_NAME });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    switch (commandName) {
      case 'stop':
        stopAll(interaction.guildId);
        await interaction.reply({ embeds: [okEmbed('⏹️ Stopped and cleared the queue.')] });
        break;
      case 'disconnect':
        disconnect(interaction.guildId);
        await interaction.reply({ embeds: [okEmbed('👋 Disconnected from the voice channel.')] });
        break;
      case 'volume': {
        const level = setVolume(interaction.guildId, interaction.options.getInteger('level', true));
        await interaction.reply({ embeds: [okEmbed(`🔊 Volume set to **${level}%**`)] });
        break;
      }
      case 'bassboost': {
        const { enabled, title } = toggleBassBoost(interaction.guildId);
        await interaction.reply({
          embeds: [okEmbed(enabled
            ? `🔊 **Bass boost ON**${title ? ` — replaying **${title}** with extra bass` : ''}`
            : '🔊 **Bass boost OFF**')],
        });
        break;
      }
      case 'pause': {
        const { paused, title } = togglePause(interaction.guildId);
        await interaction.reply({ embeds: [okEmbed(paused ? `⏸️ Paused **${title}**` : `▶️ Resumed **${title}**`)] });
        break;
      }
      default:
        await interaction.reply({ embeds: [errEmbed('Unknown command.')] });
    }
  } catch (err) {
    console.error(`[${BOT_NAME}] command error:`, err.message);
    const payload = { embeds: [errEmbed(err.message || 'Something went wrong.')] };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => interaction.followUp({ ...payload, ephemeral: true }));
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

// Tiny HTTP server so hosts with HTTP health checks (e.g. Render/Koyeb web services)
// have something to hit. Free tiers may sleep the service after inactivity.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Swamp Tunes is swimming 🐊');
}).listen(PORT, () => console.log(`🌐 Health check listening on port ${PORT}`));

client.login(TOKEN);
