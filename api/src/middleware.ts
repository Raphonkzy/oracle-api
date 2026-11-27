import type { MiddlewareHandler } from "hono";

const failure = (code: string, message: string) => ({ error: { code, message } });

/** One line per request: method, path, status, time. The query string is left out because it can hold what someone searched for. */
export const accessLog = (): MiddlewareHandler => async (c, next) => {
  const start = Date.now();
  await next();
  if (c.req.path === "/api/health") return;
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
};

/** Everything under /api/v1 is private to one person, so no proxy or browser may keep a copy. */
export const noStore = (): MiddlewareHandler => async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
};

export type RateLimitOptions = { max: number; windowMs: number };

/**
 * The caller's address as the Cloudflare Tunnel reports it in cf-connecting-ip. The tunnel always sets this header.
 * X-Forwarded-For is deliberately not read: a client can send any value in it, so it would let one client pick a new bucket per request.
 * Without cf-connecting-ip (no tunnel in front, e.g. local tests), every caller shares the one bucket "direct".
 */
const clientKey = (headers: Headers) => headers.get("cf-connecting-ip") || "direct";

/**
 * A fixed-window limit per client address, kept in memory. It is a safety net against a runaway client or a guessing
 * script, not a quota: the default is far above what the app does. Login has its own, much tighter limits in Better Auth.
 */
export function rateLimit({ max, windowMs }: RateLimitOptions, now: () => number = Date.now): MiddlewareHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const t = now();
    const key = clientKey(c.req.raw.headers);
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(key, w);
      // Forget windows that ended, so the map cannot grow without bound.
      if (windows.size > 5_000) for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
    }
    w.count += 1;
    if (w.count > max) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((w.start + windowMs - t) / 1000))));
      return c.json(failure("rate_limited", "Too many requests. Try again in a moment."), 429);
    }
    await next();
  };
}

export const tooLarge = () => (c: Parameters<MiddlewareHandler>[0]) => c.json(failure("too_large", "The request is too large."), 413);
