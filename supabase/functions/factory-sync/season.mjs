import { advanceFactory, hydrateFactory } from '../_shared/factory.mjs';

// A missed heartbeat never starts a
// catch-up simulation; active time is also bounded by the server's own clock.
export const MAX_ACTIVE_SECONDS = 120;

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

/** Advance explicitly reported live play while attributing sales to months.
 * Loading a save alone never advances production.
 * The ledger is separate from the factory so prestige never erases monthly sales.
 */
export function hydrateMonthlyFactory(stored, now, requestedSeconds = 0) {
  const { game } = hydrateFactory(stored, now);
  const wallSeconds = Number.isFinite(stored.savedAt) ? Math.max(0, (now - stored.savedAt) / 1000) : 0;
  const activeSeconds = Number.isFinite(requestedSeconds) && requestedSeconds >= 0 && wallSeconds <= MAX_ACTIVE_SECONDS
    ? Math.min(MAX_ACTIVE_SECONDS, wallSeconds, requestedSeconds) : 0;
  let cursor = now - activeSeconds * 1000;
  const buckets = new Map();
  const bucket = (at) => {
    const month = monthAt(at);
    if (!buckets.has(month)) buckets.set(month, { month, revenue: 0, seconds: 0 });
    return buckets.get(month);
  };
  const initialRevenue = game.lifetimeRevenue;
  // Attribute active duration separately from tick sales. A tick exactly at the
  // monthly boundary belongs to the new month even though its elapsed second
  // was spent in the previous month.
  while (cursor < now) {
    const boundary = nextMonthAt(cursor);
    const end = Math.min(now, boundary);
    const seconds = (end - cursor) / 1000;
    bucket(cursor).seconds += seconds;
    cursor = end;
  }
  const sales = [];
  const start = now - activeSeconds * 1000;
  const firstTick = 1 - game.stepRemainder;
  const ticks = Math.floor(game.stepRemainder + activeSeconds + 1e-9);
  let elapsed = 0;
  // At most 120 live seconds are accepted. Advancing each tick gives exact sale
  // timestamps, including simultaneous merchant/transmitter sales and OH price
  // bonuses, instead of spreading the interval's revenue uniformly over time.
  for (let index = 0; index < ticks; index++) {
    const end = Math.min(activeSeconds, firstTick + index);
    const before = game.lifetimeRevenue;
    advanceFactory(game, end - elapsed);
    const revenue = game.lifetimeRevenue - before;
    if (revenue > 0) {
      // Store epoch milliseconds, rounding down so a sub-millisecond sale just
      // before midnight cannot leak into the next month's ledger. The final
      // tick is already clamped to activeSeconds using the engine's tolerance.
      const at = Math.min(now, Math.floor(start + end * 1000));
      sales.push({ at, revenue });
      bucket(at).revenue += revenue;
    }
    elapsed = end;
  }
  advanceFactory(game, activeSeconds - elapsed);
  bucket(now);
  return { game, activeSeconds, earned: game.lifetimeRevenue - initialRevenue,
    offlineSeconds: 0, offlineEarned: 0, monthly: [...buckets.values()], sales };
}
