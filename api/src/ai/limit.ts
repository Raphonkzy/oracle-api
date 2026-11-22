/** A per-person limit for AI calls (they cost money). Kept in memory, which is enough for one server. */
export function createUserLimiter({ max, windowMs }: { max: number; windowMs: number }, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** Counts one call. `retryAfter` is in seconds when the person is over the limit. */
    take(userId: string): { ok: true } | { ok: false; retryAfter: number } {
      const t = now();
      let w = windows.get(userId);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(userId, w);
        if (windows.size > 2_000) for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
      }
      w.count += 1;
      return w.count > max ? { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) } : { ok: true };
    },
  };
}
