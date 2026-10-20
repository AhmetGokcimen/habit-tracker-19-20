'use strict';

// Central error handler: clients get a status code and a safe message only.
// Stack traces, SQL errors and file paths are logged server-side, never sent.

const multer = require('multer');
const config = require('../config');

function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Express identifies error handlers by their 4-argument signature.
function errorHandler(err, _req, res, _next) {
  if (err.expose && err.status >= 400 && err.status < 500) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Invalid upload';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  }

  // body-parser errors (malformed JSON, payload too large, ...)
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });

  if (!config.isTest) console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };
