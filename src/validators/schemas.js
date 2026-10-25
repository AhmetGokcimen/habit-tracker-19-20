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

// ISO weekdays 1 (Monday) ... 7 (Sunday); see services/schedule.js.
const schedule = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('daily') }),
    z.strictObject({
      type: z.literal('weekdays'),
      days: z
        .array(z.number().int().min(1).max(7), 'Pick the days of the week')
        .min(1, 'Pick at least one day')
        .max(7)
        .refine((days) => new Set(days).size === days.length, 'Each day may appear only once'),
    }),
    z.strictObject({
      type: z.literal('weekly'),
      times: z.number().int().min(1, 'At least once a week').max(6, 'Use "daily" for every day'),
    }),
  ],
  'Unknown schedule type',
);

const habitFields = {
  title: safeText(100, 'Title').pipe(z.string().min(1, 'Title is required')),
  description: safeText(1000, 'Description'),
  category: z.enum(CATEGORIES, 'Unknown category'),
  is_public: z.boolean(),
  schedule,
  // Measurable habits ("8 glasses"); 1 and '' for a plain yes/no habit.
  target_count: z.number().int('Target must be a whole number').min(1).max(1000, 'Target must be at most 1000'),
  unit: safeText(20, 'Unit'),
  // Local wall-clock time, 00:00-23:59, or null for no reminder.
  reminder_time: z
    .string()
    .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use a time like 08:30')
    .nullable(),
};

const habitCreate = z.strictObject({
  ...habitFields,
  description: habitFields.description.default(''),
  is_public: habitFields.is_public.default(false),
  schedule: schedule.default({ type: 'daily' }),
  reminder_time: habitFields.reminder_time.default(null),
  target_count: habitFields.target_count.default(1),
  unit: habitFields.unit.default(''),
});

const habitUpdate = z
  .strictObject({ ...habitFields, archived: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update');

// The caller's complete list of active habit ids, in the new order.
const habitOrder = z.strictObject({
  ids: z
    .array(z.number().int().min(1).max(9_999_999_999))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'Each habit may appear only once'),
});

const mineQuery = z.strictObject({
  archived: z.enum(['0', '1']).default('0'),
});

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

// A freeze covers a recently missed day: up to 7 days back in the user's
// calendar (8 in UTC, for time zones behind UTC), never a future day.
const FREEZE_WINDOW_DAYS = 8;
const freezeCreate = z.strictObject({
  freeze_date: checkinDate.refine((s) => {
    const today = new Date().toISOString().slice(0, 10);
    const earliest = new Date(Date.now() - FREEZE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return s >= earliest && s <= today;
  }, 'You can only freeze one of the last 7 days'),
});

// Multipart forms send numbers as text: accept a number or a string of digits
// only (no booleans, exponents or whitespace that a blanket coerce would allow).
const checkinAmount = z
  .union([z.number(), z.string().regex(/^[0-9]{1,6}$/, 'Amount must be a whole number').transform(Number)])
  .pipe(z.number().int('Amount must be a whole number').min(1, 'Amount must be at least 1').max(100000));

const checkinCreate = z.strictObject({
  checkin_date: checkinDate,
  note: checkinNote.default(''),
  // Defaults to the habit's target (a full check-in) in the route.
  amount: checkinAmount.optional(),
});

// Atomic +/- on a day's amount (measurable habits).
const checkinProgress = z.strictObject({
  checkin_date: checkinDate,
  delta: z
    .number()
    .int()
    .min(-1000)
    .max(1000)
    .refine((n) => n !== 0, 'Delta must not be 0'),
});

const checkinUpdate = z
  .strictObject({ checkin_date: checkinDate, note: checkinNote, amount: checkinAmount })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update');

// Same free-text rules as check-in notes (F6).
const commentBody = z.strictObject({
  body: safeText(500, 'Comment').pipe(z.string().min(1, 'Comment must not be empty')),
});

const passwordChange = z
  .strictObject({
    current_password: z.string().min(1, 'Enter your current password').max(200),
    new_password: password,
  })
  .refine((b) => b.current_password !== b.new_password, {
    message: 'New password must be different from the current one',
    path: ['new_password'],
  });

// Statistics window in days.
const statsQuery = z.strictObject({
  range: z.enum(['30', '90', '365'], 'Range must be 30, 90 or 365').default('30'),
});

// "Don't break the chain" calendar: one year, from 2000 up to the current year.
const chainQuery = z.strictObject({
  year: z.coerce
    .number()
    .int()
    .min(2000)
    .refine((y) => y <= new Date().getUTCFullYear() + 1, 'Year must not be in the future')
    .optional(),
});

const roleUpdate = z.strictObject({
  role: z.enum(['user', 'admin'], 'Role must be "user" or "admin"'),
});

module.exports = {
  CATEGORIES,
  commentBody,
  passwordChange,
  roleUpdate,
  register,
  login,
  habitCreate,
  habitUpdate,
  habitSearch,
  habitOrder,
  mineQuery,
  checkinCreate,
  checkinUpdate,
  freezeCreate,
  checkinProgress,
  statsQuery,
  chainQuery,
};
