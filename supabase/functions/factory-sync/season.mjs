import { advanceFactory, hydrateFactory, MAX_OFFLINE_SECONDS } from '../_shared/factory.mjs';

const KST_OFFSET = 9 * 60 * 60 * 1000;

/** Korea has a fixed UTC+09 offset: never use the worker/PC's local timezone. */
export function monthAt(timestamp) {
  const date = new Date(timestamp + KST_OFFSET);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function nextMonthAt(timestamp) {
  const date = new Date(timestamp + KST_OFFSET);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - KST_OFFSET;
}

/** Advance exactly the same capped simulation while attributing sales to months.
 * A long absence earns the most recent eight hours, not unbounded missed time.
 * The ledger is separate from the factory so prestige never erases monthly sales.
 */
export function hydrateMonthlyFactory(stored, now) {
  const { game } = hydrateFactory(stored, now, { offline: false });
  const offlineSeconds = Number.isFinite(stored.savedAt)
    ? Math.min(MAX_OFFLINE_SECONDS, Math.max(0, (now - stored.savedAt) / 1000)) : 0;
  let cursor = now - offlineSeconds * 1000;
  const buckets = new Map();
  const bucket = (at) => {
    const month = monthAt(at);
    if (!buckets.has(month)) buckets.set(month, { month, revenue: 0, seconds: 0 });
    return buckets.get(month);
  };
  const initialRevenue = game.lifetimeRevenue;
  while (cursor < now) {
    const boundary = nextMonthAt(cursor);
    const end = Math.min(now, boundary);
    const seconds = (end - cursor) / 1000;
    const current = bucket(cursor);
    current.seconds += seconds;
    const before = game.lifetimeRevenue;
    const ticks = game.stepRemainder + seconds;
    // A tick landing exactly at 00:00 belongs to the new month. Isolate that
    // final tick without epsilon nudges that would perturb simulation progress.
    if (end === boundary && ticks + 1e-9 >= 1 && Math.abs(ticks - Math.round(ticks)) < 1e-9) {
      const finalSeconds = Math.min(1, seconds);
      advanceFactory(game, seconds - finalSeconds);
      current.revenue += game.lifetimeRevenue - before;
      const finalRevenue = game.lifetimeRevenue;
      advanceFactory(game, finalSeconds);
      bucket(boundary).revenue += game.lifetimeRevenue - finalRevenue;
    } else {
      advanceFactory(game, seconds);
      current.revenue += game.lifetimeRevenue - before;
    }
    cursor = end;
  }
  bucket(now);
  return { game, offlineSeconds, offlineEarned: game.lifetimeRevenue - initialRevenue, monthly: [...buckets.values()] };
}
