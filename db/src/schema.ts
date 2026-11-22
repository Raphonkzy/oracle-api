import { ACCOUNT_TYPES, CATEGORY_KINDS, TRANSACTION_KINDS, type AccountType, type CategoryKind, type TransactionKind } from "@oracle/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Tables required by Better Auth.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

/** Better Auth "account" model: login credentials, not money accounts. */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const accountTypeEnum = pgEnum("account_type", ACCOUNT_TYPES);
export type { AccountType, CategoryKind, TransactionKind };

export const categoryKindEnum = pgEnum("category_kind", CATEGORY_KINDS);

export const transactionKindEnum = pgEnum("transaction_kind", TRANSACTION_KINDS);

/** Money columns: whole rupiah, stored as bigint. */
const rupiah = (name: string) => bigint(name, { mode: "number" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Built-in catalog of banks, e-wallets, etc. Seeded, read-only for users. */
export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: accountTypeEnum("type").notNull(),
  group: text("group").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  color: text("color").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** A user's bank account, e-wallet, cash, etc. */
export const moneyAccounts = pgTable(
  "money_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    initialBalance: rupiah("initial_balance").notNull().default(0),
    initialBalanceDate: date("initial_balance_date", { mode: "string" }).notNull().defaultNow(),
    color: text("color"),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    includeInTotal: boolean("include_in_total").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("money_accounts_user_idx").on(t.userId, t.sortOrder)],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: categoryKindEnum("kind").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    color: text("color"),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("categories_user_idx").on(t.userId, t.kind)],
);

/** A monthly spending limit for one expense category. `month` is "YYYY-MM". */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    amount: rupiah("amount").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("budgets_user_category_month_uq").on(t.userId, t.categoryId, t.month),
    index("budgets_user_month_idx").on(t.userId, t.month),
    check("budgets_amount_positive", sql`${t.amount} > 0`),
    check("budgets_month_format", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

/** Personal choices that change how the app counts. One row per person, made when they first change something. */
export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The day of the month a "month" starts, for people paid on the 20th, say. 1 means the calendar month. */
    cycleStartDay: integer("cycle_start_day").notNull().default(1),
    ...timestamps,
  },
  (t) => [check("user_settings_cycle_day", sql`${t.cycleStartDay} between 1 and 28`)],
);

/** Money moved between two of the user's own accounts. */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fromAccountId: uuid("from_account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "restrict" }),
    toAccountId: uuid("to_account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "restrict" }),
    amount: rupiah("amount").notNull(),
    fee: rupiah("fee").notNull().default(0),
    date: date("date", { mode: "string" }).notNull(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("transfers_user_date_idx").on(t.userId, t.date),
    check("transfers_amount_positive", sql`${t.amount} > 0`),
    check("transfers_fee_non_negative", sql`${t.fee} >= 0`),
    check("transfers_different_accounts", sql`${t.fromAccountId} <> ${t.toAccountId}`),
  ],
);

/**
 * One movement of money in one account. `amount` is signed,
 * so account balance = initial_balance + sum(amount).
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "restrict" }),
    kind: transactionKindEnum("kind").notNull(),
    amount: rupiah("amount").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    description: text("description"),
    note: text("note"),
    /** Set for both legs of a transfer and for its fee. Deleting the transfer deletes them. */
    transferId: uuid("transfer_id").references(() => transfers.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    index("transactions_user_account_date_idx").on(t.userId, t.accountId, t.date),
    index("transactions_user_date_idx").on(t.userId, t.date),
    index("transactions_transfer_idx").on(t.transferId),
    check(
      "transactions_amount_sign",
      sql`(${t.kind} in ('income', 'transfer_in') and ${t.amount} > 0)
        or (${t.kind} in ('expense', 'transfer_out') and ${t.amount} < 0)
        or (${t.kind} = 'adjustment' and ${t.amount} <> 0)`,
    ),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_user_name_uq").on(t.userId, t.name)],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] }), index("transaction_tags_tag_idx").on(t.tagId)],
);

/** "Update saldo": the real balance the user saw in their bank or e-wallet app. */
export const balanceChecks = pgTable(
  "balance_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    actualBalance: rupiah("actual_balance").notNull(),
    /** actual_balance minus the balance the app calculated at that moment. */
    difference: rupiah("difference").notNull(),
    adjustmentTransactionId: uuid("adjustment_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("balance_checks_account_idx").on(t.accountId, t.date)],
);
