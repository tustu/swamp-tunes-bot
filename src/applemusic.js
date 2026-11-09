// Apple Music link support for Swamp Tunes.
// Apple Music streams are DRM-protected, so we resolve the link to track
// metadata and play the matching audio from YouTube — same trick as Spotify.
// No API key needed:
// - Tracks and albums come from Apple's public iTunes lookup endpoints.
// - Playlists are read through the same web-player API Apple's own site
//   uses: its token ships publicly inside the site's JavaScript bundle, so
//   every visitor's browser already has it. Public/catalog playlists work
//   this way; private library playlists (pl.u-…) cannot be read keylessly
//   and get a friendly error instead.

export function isAppleMusicUrl(q) {
  return /music\.apple\.com/i.test(q);
}

/**
 * Parse an Apple Music URL into { kind, id, storefront }.
 * Tracks arrive in two shapes: .../song/{slug}/{trackId}, and album links
 * carrying the song in the ?i= parameter: .../album/{slug}/{albumId}?i={trackId}.
 */
export function parseAppleMusicUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)music\.apple\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const kindIdx = parts.findIndex((p) => ['album', 'song', 'playlist'].includes(p.toLowerCase()));
  if (kindIdx === -1) return null;
  const kind = parts[kindIdx].toLowerCase();
  // Leading segment before the kind is the storefront country code (/us/, /gb/, …).
  const storefront = kindIdx > 0 && /^[a-z]{2}$/i.test(parts[0]) ? parts[0].toLowerCase() : 'us';
  const id = parts[parts.length - 1];
  if (!id) return null;
  if (kind === 'song') return { kind: 'track', id, storefront };
  if (kind === 'album') {
    const i = u.searchParams.get('i');
    if (i) return { kind: 'track', id: i, storefront };
    return { kind: 'album', id, storefront };
  }
  return { kind: 'playlist', id, storefront };
}

async function lookup(params) {
  const res = await fetch(`https://itunes.apple.com/lookup?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`Apple Music lookup error (${res.status}).`);
  return res.json();
}

const fmt = (t) => ({
  title: t.trackName,
  artist: t.artistName || '',
  url: t.trackViewUrl || '',
  duration: t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : 0,
});

// --- Playlist support via Apple's web-player API --------------------------

let webToken = null;

/**
 * Find the API token Apple's own web player uses. It is embedded, publicly,
 * in the JavaScript bundle music.apple.com serves to every browser.
 */
async function getWebToken(storefront) {
  if (webToken) return webToken;
  const pageRes = await fetch(`https://music.apple.com/${storefront}/browse`);
  if (!pageRes.ok) return null;
  const page = await pageRes.text();
  const srcs = [...new Set([...page.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]))]
    .sort((a, b) => Number(b.includes('index')) - Number(a.includes('index')))
    .slice(0, 6);
  for (const src of srcs) {
    const jsRes = await fetch(new URL(src, 'https://music.apple.com'));
    if (!jsRes.ok) continue;
    const js = await jsRes.text();
    const candidates = js.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
    for (const c of candidates) {
      try {
        const payload = JSON.parse(Buffer.from(c.split('.')[1], 'base64url').toString('utf8'));
        if (payload.iss) {
          webToken = c;
          return webToken;
        }
      } catch { /* not a token, keep looking */ }
    }
    if (candidates.length) {
      webToken = candidates[0];
      return webToken;
    }
  }
  return null;
}

async function resolvePlaylist(id, storefront) {
  const token = await getWebToken(storefront).catch(() => null);
  if (!token) {
    throw new Error('Apple Music playlists could not be read right now — try a track or album link instead.');
  }
  const res = await fetch(
    `https://amp-api.music.apple.com/v1/catalog/${storefront}/playlists/${encodeURIComponent(id)}?include=tracks`,
    { headers: { Authorization: `Bearer ${token}`, Origin: 'https://music.apple.com' } },
  );
  if (res.status === 404) throw new Error('That Apple Music playlist was not found (it may be private).');
  if (!res.ok) throw new Error(`Apple Music playlist error (${res.status}).`);
  const data = await res.json();
  const rel = data.data?.[0]?.relationships?.tracks?.data || [];
  const tracks = rel
    .map((t) => ({
      title: t.attributes?.name,
      artist: t.attributes?.artistName || '',
      url: t.attributes?.url || '',
      duration: t.attributes?.durationInMillis ? Math.round(t.attributes.durationInMillis / 1000) : 0,
    }))
    .filter((t) => t.title)
    .slice(0, 50);
  if (!tracks.length) throw new Error('That Apple Music playlist has no playable tracks (it may be private).');
  return tracks;
}

/** Resolve an Apple Music URL to a list of { title, artist, url, duration }. Caps at 50 tracks. */
export async function resolveAppleMusic(url) {
  const parsed = parseAppleMusicUrl(url);
  if (!parsed) throw new Error('Could not read that Apple Music link.');
  const { kind, id, storefront } = parsed;

  if (kind === 'track') {
    const data = await lookup({ id, country: storefront });
    const t = (data.results || []).find((r) => r.wrapperType === 'track');
    if (!t) throw new Error('That Apple Music link was not found (it may be unavailable in this region).');
    return [fmt(t)];
  }
  if (kind === 'album') {
    const data = await lookup({ id, entity: 'song', limit: 200, country: storefront });
    const tracks = (data.results || [])
      .filter((r) => r.wrapperType === 'track')
      .map(fmt)
      .slice(0, 50);
    if (!tracks.length) throw new Error('That Apple Music album has no playable tracks.');
    return tracks;
  }
  return resolvePlaylist(id, storefront);
}
