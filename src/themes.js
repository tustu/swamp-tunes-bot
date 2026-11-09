// Per-server music embed themes for Swamp Tunes.
// Persisted in themes.json at the project root: { [guildId]: { color, style } }.
// style is one of: 'track' (track thumbnail), 'server' (server icon), 'none'.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_THEME = { color: 0x2bff88, style: 'track' }; // swamp green
export const THEME_STYLES = ['track', 'server', 'none'];

const THEMES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'themes.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(THEMES_PATH, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(THEMES_PATH, JSON.stringify(load(), null, 2));
  } catch (err) {
    console.error('[Swamp Tunes] could not save themes.json:', err.message);
  }
}

/** Parse '#2bff88' / '2bff88' into an int, or return null if invalid. */
export function parseHexColor(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? parseInt(m[1], 16) : null;
}

export function formatHexColor(color) {
  return `#${Number(color).toString(16).padStart(6, '0')}`;
}

/** The guild's theme, merged over the defaults. */
export function getTheme(guildId) {
  const stored = guildId ? load()[guildId] : null;
  if (!stored) return { ...DEFAULT_THEME };
  return {
    color: Number.isInteger(stored.color) ? stored.color : DEFAULT_THEME.color,
    style: THEME_STYLES.includes(stored.style) ? stored.style : DEFAULT_THEME.style,
  };
}

/** Update part or all of a guild's theme. Returns the new theme. */
export function setTheme(guildId, patch) {
  const all = load();
  const next = { ...getTheme(guildId) };
  if (patch.color !== undefined && patch.color !== null) next.color = patch.color;
  if (patch.style !== undefined && patch.style !== null) next.style = patch.style;
  all[guildId] = next;
  save();
  return next;
}

/** Thumbnail URL for a track (YouTube artwork derived from the video id). */
export function trackThumbnail(track) {
  if (!track) return null;
  if (track.thumbnail) return track.thumbnail;
  if (track.id && !String(track.id).includes(':')) {
    return `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
  }
  return null;
}

/**
 * Pick the thumbnail URL for an embed under a theme.
 * 'track' -> track artwork, 'server' -> guild icon, 'none' -> null.
 */
export function themeThumbnail(theme, { track = null, guildIcon = null } = {}) {
  if (!theme || theme.style === 'none') return null;
  if (theme.style === 'server') return guildIcon || trackThumbnail(track);
  return trackThumbnail(track);
}

/** Apply a guild's theme (color + thumbnail) to an EmbedBuilder. */
export function applyTheme(embed, guildId, { track = null, guildIcon = null } = {}) {
  const theme = getTheme(guildId);
  embed.setColor(theme.color);
  const thumb = themeThumbnail(theme, { track, guildIcon });
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}
