// Local file uploads for Swamp Tunes.
// A permitted user drops a small .mp3 / .wav into a text channel and the
// bot downloads it to a temp file and queues it like any other track.
// The player deletes the temp file when the track leaves rotation.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';

const execFileAsync = promisify(execFile);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const PLAYABLE_EXTS = ['.mp3', '.wav'];
// Audio-ish but unsupported: worth one short note to a permitted user.
export const UNSUPPORTED_AUDIO_EXTS = ['.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.wma', '.aiff', '.aif', '.webm', '.mp4', '.mov', '.mid', '.midi'];

export function djRoleName() {
  return process.env.DJ_ROLE_NAME || 'Swamp DJ';
}

export function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

/**
 * Who may upload: the server owner, Administrators, members with
 * Manage Server, or anyone holding the DJ role (default "Swamp DJ",
 * override with the DJ_ROLE_NAME env var).
 */
export function canUpload(member, guild) {
  if (!member || !guild) return false;
  if (member.id === guild.ownerId) return true;
  const perms = member.permissions;
  if (perms?.has(PermissionFlagsBits.Administrator)) return true;
  if (perms?.has(PermissionFlagsBits.ManageGuild)) return true;
  const role = djRoleName();
  return member.roles?.cache?.some((r) => r.name === role) ?? false;
}

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swamp-tunes-'));

/** Duration in seconds via ffprobe, or 0 if it can't be read. */
async function probeDuration(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { timeout: 10_000 });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Download an attachment to a temp file and shape it as a player track.
 * Throws a friendly Error on failure; the caller cleans up partial files.
 */
export async function downloadAsTrack(attachment) {
  const ext = extOf(attachment.name);
  const safeBase = path.basename(attachment.name, ext).replace(/[^\w -]+/g, '').trim() || 'upload';
  const file = path.join(uploadDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
  const duration = await probeDuration(file);
  return {
    track: {
      id: `local:${path.basename(file)}`,
      title: safeBase,
      duration,
      url: null,
      isLocal: true,
      localFile: file,
    },
    file,
  };
}

/** Remove a temp file left behind by a failed download. */
export function removeTempFile(file) {
  if (file) fs.unlink(file, () => {});
}
