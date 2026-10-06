// Deezer link support for Swamp Tunes.
// Deezer's public API needs no key: we resolve the link to track metadata
// and play the matching audio from YouTube.

async function dz(path) {
  const res = await fetch(`https://api.deezer.com${path}`);
  if (!res.ok) throw new Error(`Deezer API error (${res.status}).`);
  const data = await res.json();
  if (data.error) throw new Error(`Deezer: ${data.error.message}`);
  return data;
}

export function isDeezerUrl(q) {
  return /deezer\.com/i.test(q);
}

const fmt = (t) => ({ title: t.title, artist: t.artist?.name || '' });

/** Resolve a Deezer URL to a list of { title, artist }. Caps at 50 tracks. */
export async function resolveDeezer(url) {
  const m = url.match(/deezer\.com(?:\/[a-z]{2})?\/(track|album|playlist)\/(\d+)/i);
  if (!m) throw new Error('Could not read that Deezer link.');
  const [, kind, id] = m;

  if (kind === 'track') {
    const t = await dz(`/track/${id}`);
    return [fmt(t)];
  }
  if (kind === 'album') {
    const a = await dz(`/album/${id}`);
    const tracks = (a.tracks?.data || []).map(fmt);
    if (!tracks.length) throw new Error('That Deezer album has no playable tracks.');
    return tracks;
  }
  let tracks = [];
  let index = 0;
  while (tracks.length < 50) {
    const p = await dz(`/playlist/${id}/tracks?index=${index}&limit=50`);
    const items = p.data || [];
    if (!items.length) break;
    tracks.push(...items.map(fmt));
    index += items.length;
    if (items.length < 50) break;
  }
  tracks = tracks.slice(0, 50);
  if (!tracks.length) throw new Error('That Deezer playlist is empty or private.');
  return tracks;
}
