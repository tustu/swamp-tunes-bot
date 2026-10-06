// Spotify link support for Swamp Tunes.
// Spotify streams are DRM-protected, so we resolve the link to track metadata
// via the Spotify Web API and play the matching audio from YouTube.
// Needs SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET (free at developer.spotify.com).

let tokenCache = null;

async function getToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'Spotify links need SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env — see the README for the 2-minute setup.',
    );
  }
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify login failed — double-check your client ID and secret.');
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function api(path) {
  const token = await getToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new Error('That Spotify link was not found (it may be private or region-locked).');
  if (!res.ok) throw new Error(`Spotify API error (${res.status}).`);
  return res.json();
}

export function isSpotifyUrl(q) {
  return /open\.spotify\.com/i.test(q);
}

function parseSpotifyUrl(url) {
  const m = url.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/i);
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}

const fmt = (t) => ({
  title: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', '),
});

/** Resolve a Spotify URL to a list of { title, artist }. Caps at 50 tracks. */
export async function resolveSpotify(url) {
  const parsed = parseSpotifyUrl(url);
  if (!parsed) throw new Error('Could not read that Spotify link.');
  const { kind, id } = parsed;

  if (kind === 'track' || kind === 'episode') {
    const t = await api(kind === 'track' ? `/tracks/${id}` : `/episodes/${id}`);
    return [fmt(t)];
  }
  if (kind === 'album') {
    const a = await api(`/albums/${id}?limit=50`);
    const tracks = (a.tracks?.items || []).map(fmt);
    if (!tracks.length) throw new Error('That Spotify album has no playable tracks.');
    return tracks;
  }
  if (kind === 'playlist' || kind === 'show') {
    const base = kind === 'playlist' ? `/playlists/${id}/tracks` : `/shows/${id}/episodes`;
    const fields = kind === 'playlist'
      ? 'items(track(name,artists(name)))'
      : 'items(name,artists(name))';
    let tracks = [];
    let next = `${base}?limit=50&fields=${encodeURIComponent(fields + ',next')}`;
    while (next && tracks.length < 50) {
      const page = await api(next);
      for (const item of page.items || []) {
        const t = kind === 'playlist' ? item.track : item;
        if (t?.name) tracks.push(fmt(t));
      }
      next = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
    }
    tracks = tracks.slice(0, 50);
    if (!tracks.length) throw new Error('That Spotify link has no playable tracks (it may be private).');
    return tracks;
  }
  throw new Error('Spotify artist links are not supported — use a track, album, or playlist link.');
}
