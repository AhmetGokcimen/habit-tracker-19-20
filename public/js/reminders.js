// In-page habit reminders.
//
// Runs only while an app page is open. There is deliberately no service
// worker and no Web Push: push would make the server send requests to
// subscription URLs supplied by browsers (an SSRF-shaped surface) and depend
// on third-party push services. Here nothing leaves the browser except the
// normal same-origin API call.
//
// A reminder fires once per habit per day, at or after its reminder time,
// when the habit is due and not done yet. It is a system notification if the
// user allowed them, otherwise a toast.

import { api } from './api.js';
import { localISODate } from './dom.js';
import { toast } from './shell.js';
import { isDue } from './components.js';

const CHECK_EVERY_MS = 30 * 1000;
const REFRESH_EVERY_MS = 5 * 60 * 1000;
const PREFIX = 'reminded:';

let habits = [];
let loadedAt = 0;

const pad = (n) => String(n).padStart(2, '0');

function storage(fn) {
  try {
    return fn(localStorage);
  } catch {
    return undefined; // private mode / blocked storage: reminders still toast
  }
}

// Forget markers from earlier days.
function prune(today) {
  storage((ls) => {
    for (let i = ls.length - 1; i >= 0; i--) {
      const key = ls.key(i);
      if (key?.startsWith(PREFIX) && !key.endsWith(`:${today}`)) ls.removeItem(key);
    }
  });
}

function dueToday(h, today) {
  if (h.recent_checkins.includes(today)) return false;
  if (h.schedule.type === 'weekly') return h.week_count < h.schedule.times;
  return isDue(h, today);
}

function notify(habit) {
  const text = `Time for: ${habit.title}`;
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('Habit Tracker', { body: text, tag: `habit-${habit.id}` });
    n.addEventListener('click', () => {
      window.focus();
      location.assign(`/habit.html?id=${Number(habit.id)}`);
    });
  } else {
    toast(`⏰ ${text}`);
  }
}

async function tick() {
  if (Date.now() - loadedAt > REFRESH_EVERY_MS) {
    try {
      ({ habits } = await api.get('/api/habits/mine'));
      loadedAt = Date.now();
    } catch {
      return;
    }
  }
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const today = localISODate(now);
  for (const h of habits) {
    if (!h.reminder_time || h.reminder_time > time || !dueToday(h, today)) continue;
    const key = `${PREFIX}${h.id}:${today}`;
    if (storage((ls) => ls.getItem(key))) continue;
    storage((ls) => ls.setItem(key, '1'));
    notify(h);
  }
}

let started = false;

export function startReminders() {
  if (started) return;
  started = true;
  prune(localISODate());
  tick();
  setInterval(tick, CHECK_EVERY_MS);
}

/** Current permission: 'granted' | 'denied' | 'default' | 'unsupported'. */
export function notificationPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.requestPermission();
}
