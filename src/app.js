'use strict';

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { authenticate } = require('./middleware/authenticate');
const { csrfProtection } = require('./middleware/csrf');
const { createAuthLimiters } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { authRouter } = require('./routes/auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Security headers. The CSP allows scripts and styles only from this origin,
  // so even if markup were injected, inline <script> and on*= handlers would not run.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  app.use(authenticate);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfProtection);
  api.use('/auth', authRouter(createAuthLimiters()));
  api.use(notFoundHandler);
  app.use('/api', api);

  app.use(express.static(config.publicDir, { extensions: ['html'], index: 'index.html' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
