// Work that runs after the HTTP response has been sent (notification fan-out, Google Calendar
// sync). On Vercel a function can be frozen as soon as it responds, so such work is registered
// with waitUntil, which keeps the function alive until it settles. Outside Vercel (local dev)
// waitUntil is a no-op and the promise simply runs to completion in the long-lived process.
// Errors are logged, never thrown — this work is best-effort by design.
import { waitUntil } from '@vercel/functions';

export function runInBackground(taskOrPromise, label = 'background task') {
  const promise = (typeof taskOrPromise === 'function' ? Promise.resolve().then(taskOrPromise) : Promise.resolve(taskOrPromise))
    .catch((err) => console.error(`[${label}] failed:`, err));
  waitUntil(promise);
  return promise;
}
