// Self-dressing profile for Swamp Tunes: on boot the bot sets its own
// avatar, banner, and About Me bio from the art in assets/ — once, not
// on every boot. A small profile-state.json at the project root records
// what has been applied (same store pattern as themes.json), and the
// live Discord state is re-checked every boot: the banner is only set
// while it is unset, the avatar while it is still the default (or not
// yet recorded as applied), and the bio while it differs from PROFILE_BIO.
// Every failure is a warning only — profile dressing never blocks boot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Routes } from 'discord.js';

export const PROFILE_BIO = "🎧 Swamp Tunes — THE SWAMP's own music bot. Hit /play with a song name or a link and I will blast it in voice. YouTube, Spotify, SoundCloud and Deezer. Queue it up, swamp style 🐊";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_PATH = path.join(ROOT, 'assets', 'profile-avatar.png');
const BANNER_PATH = path.join(ROOT, 'assets', 'profile-banner.jpg');
const STATE_PATH = path.join(ROOT, 'profile-state.json');

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (state && typeof state === 'object') {
      return { avatar: !!state.avatar, banner: !!state.banner, bio: state.bio || null };
    }
  } catch { /* no state yet */ }
  return { avatar: false, banner: false, bio: null };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`⚠️ [Swamp Tunes] could not save profile-state.json: ${err.message}`);
  }
}

/**
 * Decide what still needs applying, from the persisted state and the
 * live Discord state ({ avatar, banner, bio } — hashes/strings or null;
 * live.bio is null when the live bio could not be read).
 */
export function decideProfileActions(state, live) {
  return {
    avatar: !state.avatar || !live.avatar,
    banner: !live.banner,
    bio: live.bio !== null && live.bio !== undefined
      ? live.bio !== PROFILE_BIO
      : state.bio !== PROFILE_BIO,
  };
}

/** Apply any missing profile pieces. Never throws. */
export async function applyProfile(client) {
  const state = loadState();

  // Live state: one GET of the current user gives the avatar and banner
  // hashes and (for the bot's own user) the current bio. Fall back to
  // the cached client.user fields if the GET fails.
  let live = {
    avatar: client.user?.avatar ?? null,
    banner: client.user?.banner ?? null,
    bio: null,
  };
  try {
    const me = await client.rest.get(Routes.user());
    live = {
      avatar: me?.avatar ?? null,
      banner: me?.banner ?? null,
      bio: typeof me?.bio === 'string' ? me.bio : null,
    };
  } catch { /* keep the cached fallback */ }

  const want = decideProfileActions(state, live);
  let dirty = false;

  if (want.avatar) {
    if (!fs.existsSync(AVATAR_PATH)) {
      console.warn('⚠️ [Swamp Tunes] assets/profile-avatar.png not found — skipping profile avatar.');
    } else {
      try {
        await client.user.setAvatar(AVATAR_PATH);
        console.log('profile avatar set from assets/profile-avatar.png');
        state.avatar = true;
        dirty = true;
      } catch (err) {
        console.warn(`⚠️ [Swamp Tunes] could not set profile avatar: ${err.message}`);
      }
    }
  }

  if (want.banner) {
    if (!fs.existsSync(BANNER_PATH)) {
      console.warn('⚠️ [Swamp Tunes] assets/profile-banner.jpg not found — skipping profile banner.');
    } else {
      try {
        await client.user.setBanner(BANNER_PATH);
        console.log('profile banner set from assets/profile-banner.jpg');
        state.banner = true;
        dirty = true;
      } catch (err) {
        console.warn(`⚠️ [Swamp Tunes] could not set profile banner: ${err.message}`);
      }
    }
  }

  if (want.bio) {
    try {
      // discord.js 14.27 has no client.user.setAboutMe — PATCH the
      // current user with a bio field instead.
      await client.rest.patch(Routes.user(), { body: { bio: PROFILE_BIO } });
      console.log('profile bio set');
      state.bio = PROFILE_BIO;
      dirty = true;
    } catch (err) {
      console.warn(`⚠️ [Swamp Tunes] could not set profile bio: ${err.message}`);
    }
  }

  if (dirty) saveState(state);
}
