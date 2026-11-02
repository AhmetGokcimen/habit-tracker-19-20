'use strict';

// F8: proof-photo upload.
//
//  - Kept in memory only (never written to disk), max 1 MB, exactly one file,
//    only in the field named "photo".
//  - The type is decided by the file's CONTENT (magic bytes). The client's
//    filename, extension and Content-Type header are ignored completely, so a
//    "photo.jpg" that actually contains PHP, HTML, SVG or a script is rejected.
//  - No user input is ever used to build a path: bytes are stored in the
//    database and served back by check-in id.

const multer = require('multer');
const config = require('../config');
const { HttpError, badRequest } = require('../utils/httpError');

// Signatures of the only accepted formats.
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

const EXTENSIONS = Object.fromEntries(SIGNATURES.map((s) => [s.mime, s.ext]));

// Proof photos only for recent days (one extra day of slack in UTC for time
// zones behind it), so old dates cannot be used to pile up stored photos.
const PHOTO_MAX_AGE_DAYS = 7;
function photoAllowedOn(isoDate, now = Date.now()) {
  const earliest = new Date(now - (PHOTO_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return isoDate >= earliest;
}

// Returns { mime, ext } for a supported image, or null.
function detectImageType(buffer) {
  const match = SIGNATURES.find((s) => s.test(buffer));
  return match ? { mime: match.mime, ext: match.ext } : null;
}

const parser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 5,
    fieldSize: 4 * 1024,
    parts: 6,
  },
}).single('photo');

// Parses multipart/form-data (JSON requests pass through untouched), then
// verifies the uploaded bytes. On success req.photo = { data, mime } or undefined.
function photoUpload(req, res, next) {
  parser(req, res, (err) => {
    if (err instanceof multer.MulterError) return next(err);
    if (err) return next(badRequest('Invalid upload'));
    if (req.file) {
      const type = detectImageType(req.file.buffer);
      if (!type) return next(new HttpError(415, 'Only JPEG, PNG or WebP images are allowed'));
      req.photo = { data: req.file.buffer, mime: type.mime };
    }
    // multer creates a prototype-less body; normalise it for validation.
    if (req.is('multipart/form-data')) req.body = { ...req.body };
    next();
  });
}

module.exports = { photoUpload, detectImageType, EXTENSIONS, PHOTO_MAX_AGE_DAYS, photoAllowedOn };
