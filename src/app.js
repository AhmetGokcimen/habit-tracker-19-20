'use strict';

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { authenticate } = require('./middleware/authenticate');
const { csrfProtection } = require('./middleware/csrf');
const { limiters } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const habitRoutes = require('./routes/habits');
const checkinRoutes = require('./routes/checkins');
const commentRoutes = require('./routes/comments');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Client IPs are read explicitly in utils/clientIp.js; never trust forwarding headers here.
  app.set('trust proxy', false);

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
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfProtection);
  api.use((req, res, next) => (SAFE_METHODS.has(req.method) ? next() : limiters.writes(req, res, next)));
  api.use('/auth', authRoutes);
  api.use('/habits/:id/checkins', checkinRoutes.habitCheckins);
  api.use('/habits/:id/comments', commentRoutes.habitComments);
  api.use('/habits', habitRoutes);
  api.use('/checkins', checkinRoutes.checkins);
  api.use('/comments', commentRoutes.comments);
  api.use('/users', userRoutes);
  api.use('/admin', adminRoutes);
  api.use(notFoundHandler);
  app.use('/api', api);

  // Local static files. On Vercel, public/ is served by the CDN instead and
  // gets the same security headers from vercel.json.
  app.use(express.static(config.publicDir, { extensions: ['html'], index: 'index.html' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// Vercel uses this file as the function entry point and expects the app as the
// module's default export. createApp stays available for tests and server.js.
const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
