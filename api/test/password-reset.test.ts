import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resetPassword } from "../src/cli/reset-password";
import { resetEmail, type Mailer } from "../src/mailer";
import { createContext, PASSWORD, type TestContext } from "./helpers";

class FakeMailer implements Mailer {
  sent: { to: string; code: string; minutes: number }[] = [];
  fail = false;
  async sendPasswordResetCode(to: string, code: string, minutes: number) {
    if (this.fail) throw new Error("smtp is down");
    this.sent.push({ to, code, minutes });
  }
}

const json = (body: unknown) => ({ method: "POST", headers: { origin: "http://localhost:3200", "content-type": "application/json" }, body: JSON.stringify(body) });

describe("forgot password", () => {
  const mailer = new FakeMailer();
  let ctx: TestContext;
  const request = (email: string) => ctx.app.request("/api/auth/email-otp/request-password-reset", json({ email }));
  const reset = (email: string, otp: string, password: string) => ctx.app.request("/api/auth/email-otp/reset-password", json({ email, otp, password }));
  const lastCode = () => mailer.sent.at(-1)!.code;
  before(async () => {
    ctx = await createContext({ mailer });
    await ctx.signUp("owner@example.com", "Owner");
  });
  after(async () => ctx.close());

  it("tells the sign-in screen whether the server can send the code", async () => {
    assert.equal((await ctx.anonymous.get("/api/v1/public/config")).body.passwordReset, true);
    const off = await createContext();
    assert.equal((await off.anonymous.get("/api/v1/public/config")).body.passwordReset, false);
    await off.close();
  });

  it("emails a six-digit code to a known address", async () => {
    const res = await request("owner@example.com");
    assert.equal(res.status, 200);
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "owner@example.com");
    assert.match(mailer.sent[0].code, /^\d{6}$/);
    assert.equal(mailer.sent[0].minutes, 10);
  });

  it("answers the same for an address that has no account, and sends nothing", async () => {
    const before = mailer.sent.length;
    const known = await request("owner@example.com");
    const unknown = await request("nobody@example.com");
    assert.equal(unknown.status, known.status);
    assert.deepEqual(await unknown.json(), await known.json());
    assert.equal(mailer.sent.length, before + 1, "only the known address got an email");
    assert.ok(!mailer.sent.some((m) => m.to === "nobody@example.com"));
  });

  it("still answers the same when the email server is down", async () => {
    mailer.fail = true;
    const res = await request("owner@example.com");
    mailer.fail = false;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
  });

  it("a wrong code changes nothing, and three wrong tries void the code", async () => {
    await request("owner@example.com");
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i += 1) assert.ok((await reset("owner@example.com", wrong, "a-brand-new-password")).status >= 400);
    // The right code no longer works after three failures.
    assert.ok((await reset("owner@example.com", code, "a-brand-new-password")).status >= 400);
    assert.equal((await ctx.signInRaw("owner@example.com", PASSWORD)).status, 200, "the old password still works");
  });

  it("refuses a new password that is too short", async () => {
    await request("owner@example.com");
    assert.equal((await reset("owner@example.com", lastCode(), "short")).status, 400);
  });

  it("the right code sets the new password, works once, and signs every phone out", async () => {
    const phone = await ctx.signIn("owner@example.com");
    assert.equal((await phone.get("/api/v1/me")).status, 200);
    await request("owner@example.com");
    const code = lastCode();
    const res = await reset("owner@example.com", code, "a-brand-new-password");
    assert.equal(res.status, 200);
    assert.equal((await ctx.signInRaw("owner@example.com", PASSWORD)).status, 401, "the old password is gone");
    assert.equal((await ctx.signInRaw("owner@example.com", "a-brand-new-password")).status, 200, "the new one works");
    assert.equal((await phone.get("/api/v1/me")).status, 401, "the phone that was signed in has to sign in again");
    assert.equal((await reset("owner@example.com", code, "another-new-password-1")).status, 400, "a code works only once");
  });

  it("a code cannot be used for another person's account", async () => {
    await ctx.signUp("second@example.com", "Second");
    await request("owner@example.com");
    const code = lastCode();
    assert.equal((await reset("second@example.com", code, "a-brand-new-password-2")).status, 400);
    assert.equal((await ctx.signInRaw("second@example.com", PASSWORD)).status, 200);
  });

  it("limits how often a code can be asked for, per address of the caller", async () => {
    const limited = await createContext({ mailer: new FakeMailer(), authRateLimit: true });
    await limited.signUp("rate@example.com", "Rate");
    const ask = (ip: string) =>
      limited.app.request("/api/auth/email-otp/request-password-reset", { ...json({ email: "rate@example.com" }), headers: { origin: "http://localhost:3200", "content-type": "application/json", "x-forwarded-for": ip } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await ask("203.0.113.9")).status);
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.equal(statuses[3], 429, "the fourth request in a minute is refused");
    assert.equal((await ask("203.0.113.10")).status, 200, "another caller is not affected");
    await limited.close();
  });
});

describe("forgot password when the server has no email", () => {
  it("has no reset endpoints at all", async () => {
    const ctx = await createContext();
    const res = await ctx.app.request("/api/auth/email-otp/request-password-reset", json({ email: "a@example.com" }));
    assert.equal(res.status, 404);
    await ctx.close();
  });
});

describe("the email", () => {
  it("shows the code and how long it works", () => {
    const mail = resetEmail("123456", 10);
    assert.match(mail.text, /123456/);
    assert.match(mail.text, /10 minutes/);
    assert.match(mail.html, /123456/);
    assert.match(mail.subject, /123456/);
  });
});

describe("reset-password from the server", () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createContext();
    await ctx.signUp("cli@example.com", "Cli");
  });
  after(async () => ctx.close());

  it("refuses a short password and an unknown email", async () => {
    assert.match((await resetPassword(ctx.auth, "cli@example.com", "short"))!, /at least 10/);
    assert.match((await resetPassword(ctx.auth, "nobody@example.com", "a-long-enough-password"))!, /no account/);
  });

  it("sets the password and signs every phone out", async () => {
    const phone = await ctx.signIn("cli@example.com");
    assert.equal(await resetPassword(ctx.auth, "CLI@example.com", "from-the-server-1"), null);
    assert.equal((await ctx.signInRaw("cli@example.com", PASSWORD)).status, 401);
    assert.equal((await ctx.signInRaw("cli@example.com", "from-the-server-1")).status, 200);
    assert.equal((await phone.get("/api/v1/me")).status, 401);
  });
});
