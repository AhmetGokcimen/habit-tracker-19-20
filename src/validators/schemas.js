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

const habitFields = {
  title: z.string().trim().min(1, 'Title is required').max(100, 'Title must be at most 100 characters'),
  description: z.string().trim().max(1000, 'Description must be at most 1000 characters'),
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

module.exports = { CATEGORIES, register, login, habitCreate, habitUpdate, habitSearch };
