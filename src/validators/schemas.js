'use strict';

// All request schemas in one place. Every schema is strict: unknown keys are a
// 400, so clients cannot smuggle fields such as `role`, `user_id` or `is_admin`.

const { z } = require('zod');

const CATEGORIES = ['health', 'fitness', 'learning', 'productivity', 'mindfulness', 'social', 'other'];

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[A-Za-z0-9_]+$/, 'Username may contain only letters, digits and underscores');

// bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than truncated.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes')
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Password must contain a letter and a digit');

const register = z.strictObject({
  username,
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Invalid email address')),
  password,
});

const login = z.strictObject({
  username: z.string().trim().min(1, 'Username is required').max(30),
  password: z.string().min(1, 'Password is required').max(200),
});

// Free text shown to users. Output is always escaped by the frontend; in
// addition, invisible control characters and Unicode bidi overrides (used to
// visually spoof text) are rejected here.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;
const safeText = (max, label) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .refine((s) => !UNSAFE_CHARS.test(s), `${label} contains invalid characters`);

const habitFields = {
  title: safeText(100, 'Title').pipe(z.string().min(1, 'Title is required')),
  description: safeText(1000, 'Description'),
  category: z.enum(CATEGORIES, 'Unknown category'),
  is_public: z.boolean(),
};

const habitCreate = z.strictObject({
  ...habitFields,
  description: habitFields.description.default(''),
  is_public: habitFields.is_public.default(false),
});

const habitUpdate = z
  .strictObject(habitFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update');

// Query strings: repeated keys (?q=a&q=b) arrive as arrays and fail z.string().
const habitSearch = z.strictObject({
  q: z.string().trim().max(50, 'Search text must be at most 50 characters').optional(),
  category: z.enum(CATEGORIES, 'Unknown category').optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

// YYYY-MM-DD, a real calendar day, not before 2000 and not in the future
// (one day of slack for users in time zones ahead of UTC).
const checkinDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a valid calendar date')
  .refine((s) => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return s >= '2000-01-01' && s <= tomorrow;
  }, 'Date must not be in the future');

const checkinNote = safeText(500, 'Note');

const checkinCreate = z.strictObject({
  checkin_date: checkinDate,
  note: checkinNote.default(''),
});

const checkinUpdate = z
  .strictObject({ checkin_date: checkinDate, note: checkinNote })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update');

// Same free-text rules as check-in notes (F6).
const commentBody = z.strictObject({
  body: safeText(500, 'Comment').pipe(z.string().min(1, 'Comment must not be empty')),
});

const roleUpdate = z.strictObject({
  role: z.enum(['user', 'admin'], 'Role must be "user" or "admin"'),
});

module.exports = {
  CATEGORIES,
  commentBody,
  roleUpdate,
  register,
  login,
  habitCreate,
  habitUpdate,
  habitSearch,
  checkinCreate,
  checkinUpdate,
};
