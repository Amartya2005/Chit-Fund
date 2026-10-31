import { env } from '../config/env.js';
import { badRequest } from './http.js';

const ALLOWED_IMAGE = /^data:image\/(png|jpe?g|webp|gif|heic|heif);base64,([A-Za-z0-9+/=\r\n]+)$/;

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.length > 6 && b.subarray(0, 3).toString('ascii') === 'GIF',
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  heic: (b) => b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp',
  heif: (b) => b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp',
};

/**
 * Validate an uploaded image sent as a base64 data URL (receipt / bill photos).
 *
 * The app stores these photos inline in the database (existing behaviour). This
 * check ensures the value really is an image of an allowed type (MIME prefix and
 * file signature) and within MAX_UPLOAD_BYTES, so arbitrary payloads or scripts
 * (e.g. data:text/html) cannot be stored and served back to other users.
 * Returns null for empty input.
 */
export function validateImageDataUrl(value: unknown, field = 'photo'): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(`${field} must be an image data URL`);
  const match = ALLOWED_IMAGE.exec(value);
  if (!match) throw badRequest(`${field} must be a PNG, JPEG, WEBP, GIF or HEIC image`);
  const type = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw badRequest(`${field} is empty`);
  if (bytes.length > env.maxUploadBytes) {
    throw badRequest(`${field} is too large (max ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB)`);
  }
  const check = MAGIC[type];
  if (check && !check(bytes)) throw badRequest(`${field} content does not match its image type`);
  return value;
}
