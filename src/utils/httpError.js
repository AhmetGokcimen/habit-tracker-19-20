'use strict';

// Errors thrown with an explicit HTTP status. Only these messages are ever
// shown to the client; anything else becomes a generic 500 (see errorHandler).
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (msg = 'Bad request', details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
const forbidden = (msg = 'You are not allowed to do this') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg = 'Conflict') => new HttpError(409, msg);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
