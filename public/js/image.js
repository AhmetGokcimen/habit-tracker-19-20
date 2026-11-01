// Shrinks a proof photo in the browser before it is uploaded, so phone photos
// fit the server's 1 MB limit and use less of the user's photo storage.
// Only built-in browser APIs (createImageBitmap, canvas). The server still
// checks the size and the real file type (magic bytes) of whatever arrives.

export const MAX_EDGE = 1280;
export const JPEG_QUALITY = 0.8;

// Width and height scaled so the long edge is at most `max` (never enlarged).
export function fitWithin(width, height, max = MAX_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Decodes the file; honours the EXIF orientation of phone photos.
async function decodeImage(file) {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

// Draws the image at the given size and encodes it as JPEG.
async function encodeJpeg(image, { width, height }, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency: transparent PNG/WebP areas become white, not black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

const jpegName = (name) => `${String(name || 'photo').replace(/\.[^.]*$/, '') || 'photo'}.jpg`;

/**
 * Returns a JPEG of at most MAX_EDGE px on the long edge, or the original
 * file when that would not be smaller, or when the browser cannot decode or
 * encode it (the server then decides).
 * `decode` / `encode` are replaceable for tests only.
 */
export async function shrinkPhoto(file, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY, decode = decodeImage, encode = encodeJpeg } = {}) {
  let image;
  try {
    image = await decode(file);
    const blob = await encode(image, fitWithin(image.width, image.height, maxEdge), quality);
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    image?.close?.();
  }
}
