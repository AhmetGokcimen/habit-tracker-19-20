'use strict';

// First-time local setup: creates .env from .env.example with a freshly
// generated JWT_SECRET (only if .env does not exist yet), then seeds the
// local database. The secret is written to .env only — never printed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');

if (fs.existsSync(envPath)) {
  console.log('.env already exists — leaving it unchanged.');
} else {
  const template = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(envPath, template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`), { mode: 0o600 });
  console.log('Created .env with a random JWT_SECRET.');
}

const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], { cwd: ROOT, stdio: 'inherit' });
process.exit(seed.status ?? 1);
