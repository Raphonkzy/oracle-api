import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { createContext, type TestContext } from "./helpers";

/** Every `METHOD /path` that docs/API.md lists in the first column of a table. */
function documented(): Set<string> {
  const text = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\| `(GET|POST|PUT|PATCH|DELETE) (\/[^`\s?]*)/);
    if (!m) continue;
    const path = m[2].startsWith("/api/") ? m[2] : `/api/v1${m[2]}`;
    out.add(`${m[1]} ${path}`);
  }
  return out;
}

describe("docs/API.md matches the real routes", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createContext();
  });
  after(async () => ctx.close());

  /** The app's own routes. The Better Auth wildcard stands for the auth calls the doc lists one by one. */
  const registered = () => {
    const set = new Set<string>();
    for (const r of ctx.hono.routes) if (r.method !== "ALL") set.add(`${r.method} ${r.path}`);
    return set;
  };

  it("every endpoint in the doc exists", () => {
    const routes = registered();
    const missing = [...documented()].filter((d) => {
      const [method, path] = d.split(" ");
      if (path.startsWith("/api/auth/")) return !routes.has(`${method} /api/auth/*`);
      return !routes.has(d);
    });
    assert.deepEqual(missing, [], "documented but not implemented");
  });

  it("every endpoint that exists is in the doc", () => {
    const docs = documented();
    const undocumented = [...registered()].filter((r) => !r.includes("/api/auth/*") && !docs.has(r));
    assert.deepEqual(undocumented, [], "implemented but not documented");
  });

  it("covers the whole surface the plan promises", () => {
    const docs = documented();
    for (const need of [
      "GET /api/v1/summary", "GET /api/v1/stats/flow", "GET /api/v1/stats/categories", "GET /api/v1/insights",
      "GET /api/v1/budgets", "PUT /api/v1/budgets/:month", "POST /api/v1/budgets/:month/copy-previous",
      "GET /api/v1/export/transactions.csv", "PATCH /api/v1/categories/:id", "POST /api/v1/accounts/:id/balance-checks",
      "POST /api/auth/change-password", "POST /api/auth/revoke-other-sessions",
    ]) assert.ok(docs.has(need), need);
  });
});
