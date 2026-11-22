import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContext, type Client, type TestContext } from "./helpers";

describe("changing the name", () => {
  let ctx: TestContext;
  let c: Client;
  before(async () => {
    ctx = await createContext();
    c = await ctx.signUp("name@example.com", "First Name");
  });
  after(async () => ctx.close());

  it("changes the name shown by /me", async () => {
    assert.equal((await c.post("/api/auth/update-user", { name: "Raph Q" })).status, 200);
    assert.equal((await c.get("/api/v1/me")).body.user.name, "Raph Q");
  });

  it("tidies spaces and line breaks", async () => {
    assert.equal((await c.post("/api/auth/update-user", { name: "  Raph \n  Q   " })).status, 200);
    assert.equal((await c.get("/api/v1/me")).body.user.name, "Raph Q");
  });

  it("refuses an empty name and a very long one, and keeps the old name", async () => {
    assert.equal((await c.post("/api/auth/update-user", { name: "   " })).status, 400);
    assert.equal((await c.post("/api/auth/update-user", { name: "x".repeat(61) })).status, 400);
    assert.equal((await c.get("/api/v1/me")).body.user.name, "Raph Q");
  });

  it("accepts names in other scripts", async () => {
    for (const name of ["王小明", "Владимир", "José Ñandú"]) {
      assert.equal((await c.post("/api/auth/update-user", { name })).status, 200, name);
      assert.equal((await c.get("/api/v1/me")).body.user.name, name);
    }
  });

  it("is only for the signed-in person", async () => {
    assert.equal((await ctx.anonymous.post("/api/auth/update-user", { name: "Nobody" })).status, 401);
  });
});
