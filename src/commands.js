// Slash command definitions for Swamp Tunes.
// Kept in their own module so the full list can be built (and tested)
// without a Discord token or a login.
import { SlashCommandBuilder } from 'discord.js';

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play music: YouTube / Spotify / SoundCloud / Deezer / Apple Music link or search')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name, or a link from YouTube, Spotify, SoundCloud, Deezer, Apple Music').setRequired(true),
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
  new SlashCommandBuilder().setName('queue').setDescription('Show the upcoming queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the song playing right now'),
  new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Lyrics for the current song (or a song you name)')
    .addStringOption((o) =>
      o.setName('query').setDescription('Optional: "Artist - Title" to look up a different song').setRequired(false),
    ),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode: off, track, or queue (no choice = cycle)')
    .addStringOption((o) =>
      o.setName('mode').setDescription('Loop mode').setRequired(false)
        .addChoices(
          { name: 'off', value: 'off' },
          { name: 'track', value: 'track' },
          { name: 'queue', value: 'queue' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a queued song to a different position')
    .addIntegerOption((o) =>
      o.setName('from').setDescription('Current position in /queue').setRequired(true).setMinValue(1),
    )
    .addIntegerOption((o) =>
      o.setName('to').setDescription('New position in /queue').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue by its /queue number')
    .addIntegerOption((o) =>
      o.setName('position').setDescription('Position in /queue').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the upcoming queue (current song keeps playing)'),
  new SlashCommandBuilder()
    .setName('forceplay')
    .setDescription('Play a song right now, interrupting the current one')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name, or a link from YouTube, Spotify, SoundCloud, Deezer, Apple Music').setRequired(true),
    ),
  new SlashCommandBuilder().setName('forceskip').setDescription('Skip the current song immediately (no vote)'),
  new SlashCommandBuilder()
    .setName('theme')
    .setDescription('Set this server\'s music embed color and thumbnail style (Manage Server)')
    .addStringOption((o) =>
      o.setName('color').setDescription('Hex color like #2bff88').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('style').setDescription('Thumbnail style').setRequired(false)
        .addChoices(
          { name: 'track thumbnail', value: 'track' },
          { name: 'server icon', value: 'server' },
          { name: 'none', value: 'none' },
        ),
    ),
];

/** Command definitions as JSON, ready for the Discord REST API. */
export const commands = commandBuilders.map((c) => c.toJSON());
