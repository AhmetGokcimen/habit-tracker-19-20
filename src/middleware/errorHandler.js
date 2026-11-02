'use strict';

// Central error handler: clients get a status code and a safe message only.
// Stack traces, SQL errors and file paths are logged server-side, never sent.

const multer = require('multer');
const config = require('../config');
const { HttpError } = require('../utils/httpError');

function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// A message reaches the client for exposed 4xx errors, and for 5xx errors
// only when the app raised them deliberately with its own HttpError (e.g. 507
// "storage is full"). Any other 5xx stays a generic 500.
const isSafeToShow = (err) =>
  err.expose && ((err.status >= 400 && err.status < 500) || (err instanceof HttpError && err.status >= 500 && err.status < 600));

// Express identifies error handlers by their 4-argument signature.
function errorHandler(err, _req, res, _next) {
  if (isSafeToShow(err)) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }

  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File too large' : 'Invalid upload' });
  }

  // body-parser errors (malformed JSON, payload too large, ...)
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });

  if (!config.isTest) console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };
