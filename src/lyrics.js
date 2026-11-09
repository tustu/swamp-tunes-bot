// Lyrics lookup for Swamp Tunes via the free, no-key lyrics.ovh API.
// Everything here fails soft: any network/API problem returns null,
// never throws, so /lyrics can answer gracefully.

const API = 'https://api.lyrics.ovh/v1';

/** Strip decorations that keep lyric searches from matching ("(Official Video)" etc). */
export function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*(?:official|video|audio|lyrics?|mv|hd|4k|visualizer|remaster)[^)]*)\)/gi, ' ')
    .replace(/\b(?:official\s+(?:music\s+)?video|official\s+audio|lyrics?\s+video|music\s+video)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip YouTube uploader decorations ("Artist - Topic", "ArtistVEVO"). */
export function cleanArtist(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort { artist, title } for a track.
 * Prefers an explicit "Artist - Title" split in the title, then an
 * artist field, then the uploader/channel name.
 */
export function parseArtistTitle(track) {
  const rawTitle = track?.title || '';
  const dash = rawTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    return { artist: cleanArtist(dash[1]), title: cleanTitle(dash[2]) };
  }
  const artist = cleanArtist(track?.artist || track?.uploader || track?.channel || '');
  return { artist, title: cleanTitle(rawTitle) };
}

/** Parse a free-text /lyrics query ("Artist - Title", or just a title). */
export function parseQuery(query) {
  const dash = String(query || '').match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { artist: cleanArtist(dash[1]), title: cleanTitle(dash[2]) };
  return { artist: '', title: cleanTitle(query) };
}

async function fetchLyrics(artist, title) {
  if (!artist || !title) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `${API}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const lyrics = typeof data?.lyrics === 'string' ? data.lyrics.trim() : '';
    return lyrics || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Lyrics for a playing track. Returns { lyrics, artist, title } or null. */
export async function lyricsForTrack(track) {
  const { artist, title } = parseArtistTitle(track);
  if (!title) return null;
  // Try the parsed pair first, then the raw dash-split reversed is useless,
  // so fall back to uploader-as-artist when the title had no dash.
  let lyrics = await fetchLyrics(artist, title);
  if (!lyrics && track?.uploader) {
    lyrics = await fetchLyrics(cleanArtist(track.uploader), title);
  }
  return lyrics ? { lyrics, artist, title } : null;
}

/** Lyrics for a free-text query. Returns { lyrics, artist, title } or null. */
export async function lyricsForQuery(query) {
  const { artist, title } = parseQuery(query);
  if (!title) return null;
  const lyrics = await fetchLyrics(artist, title);
  return lyrics ? { lyrics, artist, title } : null;
}
