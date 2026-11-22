import nodemailer from "nodemailer";

/** Sends the few emails the app needs. Only the password reset code today. */
export interface Mailer {
  sendPasswordResetCode(to: string, code: string, minutes: number): Promise<void>;
}

export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; password: string; from: string };

/** The plain wording of the reset email. Kept apart so a test can check it without a mail server. */
export function resetEmail(code: string, minutes: number) {
  const text = [
    `Your Oracle password reset code is ${code}`,
    "",
    `It works for ${minutes} minutes and only once. Type it in the app, then choose a new password.`,
    "If you did not ask for this, ignore this email. Your password stays as it is.",
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#0A0A0B;color:#F2F2F0;border-radius:8px">
<h2 style="margin:0 0 12px;color:#FFC400;letter-spacing:2px">ORACLE</h2>
<p style="margin:0 0 12px">Your password reset code:</p>
<p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:0 0 16px;color:#FFC400">${code}</p>
<p style="margin:0 0 8px;color:#9A9AA2">It works for ${minutes} minutes and only once. Type it in the app, then choose a new password.</p>
<p style="margin:0;color:#9A9AA2">If you did not ask for this, ignore this email. Your password stays as it is.</p></div>`;
  return { subject: `Oracle password reset code: ${code}`, text, html };
}

export function createSmtpMailer(c: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.password } : undefined, connectionTimeout: 15_000, socketTimeout: 20_000 });
  return {
    async sendPasswordResetCode(to, code, minutes) {
      const mail = resetEmail(code, minutes);
      await transport.sendMail({ from: c.from, to, ...mail });
    },
  };
}
