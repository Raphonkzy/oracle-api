import { schema, type Db } from "@oracle/db/client";
import { DEFAULT_CATEGORIES } from "@oracle/db/seed/categories";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { count } from "drizzle-orm";
import type { Mailer } from "./mailer";

/** Deep-link scheme of the phone app (mobile/app.json). */
export const APP_SCHEME = "oracle";

/** Expo Go (the development client) signs in from exp:// addresses on the local network. Only trusted outside production. */
const EXPO_GO_ORIGINS = ["exp://", "exp://**", "exp://10.*.*.*:*/**", "exp://192.168.*.*:*/**", "exp://172.*.*.*:*/**"];
const isDevelopment = () => process.env.NODE_ENV !== "production";

/** The longest display name. */
export const MAX_NAME_LENGTH = 60;
/** How long a reset code works. */
export const RESET_CODE_MINUTES = 10;
export type SignupMode = "closed" | "open";

/** `closed` allows sign-up only until the first user (the owner) exists. */
export async function canSignUp(db: Db, mode: SignupMode): Promise<boolean> {
  if (mode === "open") return true;
  const [{ value }] = await db.select({ value: count() }).from(schema.user);
  return value === 0;
}

export function createAuth(opts: {
  db: Db;
  secret: string;
  baseURL: string;
  signupMode: SignupMode;
  trustedOrigins?: string[];
  rateLimit?: boolean;
  /** Sends the password reset code. Without it, "Forgot password" does not exist on this server. */
  mailer?: Mailer | null;
}) {
  const { db } = opts;
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: [`${APP_SCHEME}://`, ...(opts.trustedOrigins ?? []), ...(isDevelopment() ? EXPO_GO_ORIGINS : [])],
    plugins: [
      expo(),
      // Forgot password: a 6-digit code goes to the person's email, and they type it in the app. No link has to open the app.
      ...(opts.mailer
        ? [
            emailOTP({
              otpLength: 6,
              expiresIn: RESET_CODE_MINUTES * 60,
              allowedAttempts: 3,
              storeOTP: "hashed",
              // A code is only ever for resetting a password here, never for signing in or creating an account.
              disableSignUp: true,
              sendVerificationOTP: async ({ email, otp, type }) => {
                if (type !== "forget-password") return;
                // A failed email is logged and swallowed, so the answer is the same whether the address exists or not.
                await opts.mailer!.sendPasswordResetCode(email, otp, RESET_CODE_MINUTES).catch((e) => console.error(`password reset email failed: ${e instanceof Error ? e.message : "unknown"}`));
              },
            }),
          ]
        : []),
    ],
    // Behind the Cloudflare Tunnel the real client address arrives in these headers. The API port is never published, so only the tunnel can set them.
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] } },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true, revokeSessionsOnPasswordReset: true },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: opts.rateLimit ?? true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        // Changing a password asks for the current one, so it is a way to guess it.
        "/change-password": { window: 60, max: 5 },
        // A reset code is six digits, so guessing is limited here and by the code itself (three tries, then it is void).
        "/email-otp/request-password-reset": { window: 60, max: 3 },
        "/email-otp/reset-password": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        update: {
          // The display name is typed by the person. Keep it a normal one-line name.
          before: async (data) => {
            if (typeof data.name === "string") {
              const name = data.name.trim().replace(/\s+/g, " ");
              if (!name || name.length > MAX_NAME_LENGTH) throw new APIError("BAD_REQUEST", { message: `The name must have 1 to ${MAX_NAME_LENGTH} characters.` });
              return { data: { ...data, name } };
            }
          },
        },
        create: {
          before: async () => {
            if (!(await canSignUp(db, opts.signupMode))) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is closed." });
            }
          },
          after: async (user) => {
            await db.insert(schema.categories).values(DEFAULT_CATEGORIES.map((c, i) => ({ ...c, userId: user.id, sortOrder: i })));
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
