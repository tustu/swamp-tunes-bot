import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function yt(args, { timeout = 45000 } = {}) {
  return execFileAsync('yt-dlp', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

/** Returns yt-dlp version string, or null if the binary is missing. */
export async function checkYtDlp() {
  try {
    const { stdout } = await yt(['--version']);
    return stdout.trim().split('\n').pop();
  } catch {
    return null;
  }
}

const PRINT = '%(id)s\t%(title)s\t%(duration)s';

function parseTrackLine(line) {
  const [id, title, dur] = line.trim().split('\t');
  if (!id) throw new Error('Could not resolve that track.');
  return {
    id,
    title: (title || 'Unknown title').replace(/\s+/g, ' ').trim(),
    duration: Number(dur) || 0,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function searchFirstLine(stdout) {
  const line = stdout.split('\n').find((l) => l.trim());
  if (!line) throw new Error('No results found.');
  return parseTrackLine(line);
}

/**
 * Resolve a search query or a media URL to a single track.
 * - Plain text searches YouTube (prefix with "sc:" to search SoundCloud instead).
 * - URLs go straight to yt-dlp, which handles YouTube, SoundCloud, and many
 *   other sites. Playlist URLs are forced to a single video (--no-playlist).
 */
export async function resolveTrack(query) {
  const q = query.trim();
  if (/^https?:\/\//i.test(q)) {
    const { stdout } = await yt(['--no-playlist', '--skip-download', '--print', PRINT, q]);
    return searchFirstLine(stdout);
  }
  const sc = q.match(/^(?:sc:|soundcloud:)\s*(.+)/i);
  const target = sc ? sc[1] : q;
  const prefix = sc ? 'scsearch1:' : 'ytsearch1:';
  const { stdout } = await yt([
    '--no-playlist',
    '--skip-download',
    '--print',
    PRINT,
    `${prefix}${target}`,
  ]);
  return searchFirstLine(stdout);
}

/**
 * Find the best YouTube match for a { title, artist } pair.
 * Used to play Spotify / Deezer links, whose audio comes from YouTube.
 */
export async function findOnYouTube(title, artist) {
  const q = `${title} ${artist || ''}`.trim();
  const { stdout } = await yt([
    '--no-playlist',
    '--skip-download',
    '--print',
    PRINT,
    `ytsearch1:${q}`,
  ]);
  try {
    return searchFirstLine(stdout);
  } catch {
    throw new Error(`No YouTube match for "${q}"`);
  }
}

/** Direct audio stream URL for a video id (expires after a few hours — fine for a queue). */
export async function streamUrlFor(videoId) {
  const { stdout } = await yt([
    '--no-playlist',
    '-f',
    'bestaudio[ext=webm]/bestaudio/best',
    '-g',
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  const url = stdout.trim().split('\n')[0];
  if (!url.startsWith('http')) throw new Error('Could not get an audio stream.');
  return url;
}

export function formatDuration(sec) {
  if (!sec || sec <= 0) return 'LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
