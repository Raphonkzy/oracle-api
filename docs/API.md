# Oracle API v1

Base URL: `http://localhost:3200` in development. All data endpoints live under `/api/v1` and need a login. Every response is JSON, money is whole rupiah as a number, and dates are `YYYY-MM-DD`.

Types for every response are in `shared/core/src/api-types.ts` (the shared logic, `@oracle/core`, is `vendor/oracle/shared/core` here; its source repository is `oracle`). Request bodies are validated by the zod schemas in `shared/core/src/validation.ts`, which the mobile app uses too.

## Login and account security
Login uses Better Auth under `/api/auth/*`. It sets a session cookie, which lasts 30 days. The phone app sends the header `expo-origin: oracle://` (the Expo plugin does this) and stores the cookie in SecureStore. Browser calls send `Origin` with the same value as `API_URL`.
| Call | Purpose |
|---|---|
| `POST /api/auth/sign-up/email` `{ name, email, password }` | Create the owner account. The password is at least 10 characters. Returns 403 when sign-up is closed (`SIGNUP_MODE=closed` allows only the first account). Limited to 3 a minute |
| `POST /api/auth/sign-in/email` `{ email, password }` | Log in. Limited to 5 attempts a minute |
| `POST /api/auth/sign-out` | Log out. The cookie stops working at once |
| `GET /api/auth/list-sessions` | Every device that is signed in |
| `POST /api/auth/revoke-other-sessions` | Sign out every other device and keep this one |
| `POST /api/auth/change-password` `{ currentPassword, newPassword, revokeOtherSessions? }` | The current password must be right (400 otherwise) and the new one at least 10 characters. With `revokeOtherSessions: true` every other device is signed out too. Limited to 5 a minute |
| `POST /api/auth/update-user` `{ name }` | Change the display name. Spaces and line breaks are tidied, and it must have 1 to 60 characters (400 otherwise) |
| `POST /api/auth/email-otp/request-password-reset` `{ email }` | Forgot password, step 1. Emails a 6-digit code (valid 10 minutes). The answer is `{ success: true }` whether or not the address has an account, so it cannot be used to find out who is registered. Limited to 3 a minute per caller. Only exists when the server has `SMTP_*` set (404 otherwise) |
| `POST /api/auth/email-otp/reset-password` `{ email, otp, password }` | Forgot password, step 2. Sets the new password (10 characters or more) and signs every device out. The code works once and dies after 3 wrong tries (400 or 403). Limited to 5 a minute per caller |
| `GET /api/v1/public/config` | No login needed. `{ signupOpen, passwordReset }`. `signupOpen` is false when sign-up is closed, and `passwordReset` is true when the server can email a reset code (`SMTP_*` set), so the app shows or hides those options |
## Errors

```json
{ "error": { "code": "validation", "message": "Amount must be greater than 0." } }
```

| Status | Meaning | Common codes |
|---|---|---|
| 400 | Bad input or a rule was broken | `validation`, `invalid_json`, `invalid_cursor`, `account_unavailable`, `invalid_category`, `unknown_provider`, `invalid_order`, `transfer_locked`, `adjustment_locked`, `category_locked`, `duplicate_category`, `insufficient_balance` |
| 401 | Not logged in | `unauthorized` |
| 404 | Not found, or it belongs to another user | `not_found` |
| 413 | The request body is bigger than 256 KB | `too_large` |
| 429 | Too many requests from one address (more than 600 a minute), or too many assistant calls in an hour. `Retry-After` says how many seconds to wait | `rate_limited`, `ai_rate_limited` |
| 503 | The assistant is off or its provider cannot be reached | `ai_disabled`, `ai_unavailable` |
| 500 | A bug. Details are in the server log, never in the response | `internal` |

Another user's data always answers 404 on reads and 400 `account_unavailable` / `invalid_category` when you try to reference it in a write.

### Balance rules

An account balance is its opening balance plus everything booked on that account, and it is read from one place (`services/balance.ts`) by every screen, the total and the assistant. The rules:

- Each account stands alone. Money is never taken from another account.
- A change that would leave an account below zero is refused with `insufficient_balance`. The body carries `details: { account, balance, after }` so the app can word the message in the person's language. This covers a new expense or transfer (the fee counts), editing an amount, moving a transaction to another account, changing income into an expense, deleting an income or a transfer whose money was already spent, and lowering an opening balance.
- Paylater and credit cards are bills (`isDebtType`): they may go further into debt, so they are exempt.
- An account that was already below zero (older data) may stay there but may not go lower, so unrelated edits still work.
- The accounts involved are locked inside the same database transaction, so two requests cannot spend the same money.
- A transfer is `transfer_out` and `transfer_in` rows. It is never income or expense. Its fee is an expense on the source account only.
- A "balance update" (`POST /accounts/:id/balance-checks`) books an adjustment to match the real balance and is never refused.

## Paging

List endpoints return `{ items, nextCursor }`. Pass `nextCursor` back as `?cursor=` to get the next page. `nextCursor` is `null` on the last page. The order is stable even when rows are added while you scroll.

## Endpoints

### Account and catalog
| Method and path | Notes |
|---|---|
| `GET /me` | `{ user: { id, name, email, createdAt } }` |
| `GET /settings` | `{ cycleStartDay }`. The day of the month (1 to 28) a "month" starts. 1, the default, is the calendar month. |
| `PUT /settings` | `{ cycleStartDay }` (whole number 1 to 28, nothing else allowed). Returns the saved settings. With 20, "this month" in Home, Statistics, Budgets, insights and the assistant runs from the 20th to the 19th. A budget `month` is named after the month its cycle starts in. Weeks, years and account statements stay calendar-based. |
| `GET /providers` | The 87 built-in banks, e-wallets and others, with `aliases` for search |
| `GET /categories` | The user's own active categories (`income` and `expense`), each with `icon` and `color`. A new account starts with 15 expense and 12 income categories (Food & Drinks, Transportation, ... Subscriptions; Salary, Bonus, ... Other Income). Names are stored in English and the app shows the default ones in the person's language |
| `POST /categories` | `{ name, kind: "income"\|"expense", icon }`. 201 `{ category }`. The color is chosen for you. A name must be unique within its kind (400 `duplicate_category`), and a person can have at most 100 (400 `too_many_categories`) |
| `POST /categories/:id/archive` | 204. Hides the category from the pickers. Transactions that used it keep it, and its budgets are removed. "Financial & Fees" cannot be hidden (400 `category_locked`) |
| `PATCH /categories/:id` | `{ name?, icon? }`. `icon` is one of the 85 names in `CATEGORY_ICONS` (`shared/core/src/constants.ts`), which are Material Community Icons names. Old transactions follow the new name. The expense category "Financial & Fees" keeps its name (400 `category_locked`) because transfer fees are booked under it. A name that already exists is 400 `duplicate_category` |

### Accounts
| Method and path | Notes |
|---|---|
| `GET /accounts?archived=true\|false` | Ordered list with the live `balance`. Default is active accounts |
| `POST /accounts` | One account. 201 `{ account }` |
| `POST /accounts/batch` | Onboarding: `{ accounts: [...] }`, 1 to 50. 201 `{ accounts }`. All or nothing |
| `POST /accounts/reorder` | `{ ids: [...] }` must list every active account exactly once |
| `GET /accounts/:id` | Works for archived accounts too |
| `PATCH /accounts/:id` | Any of `name`, `type`, `initialBalance`, `includeInTotal` |
| `POST /accounts/:id/archive` | Archived accounts leave the total and cannot receive new transactions |
| `POST /accounts/:id/restore` | Brings an archived account back |
| `GET /accounts/:id/ledger?month=YYYY-MM&limit=&cursor=` | Statement, newest first, each row with `runningBalance` |
| `POST /accounts/:id/balance-checks` | "Balance update": `{ actualBalance, date }`. Books an adjustment for the difference. Returns `{ difference, adjustmentId, account }` |

Paylater and credit cards are stored with a negative balance (money owed). Send the bill as a negative number.

### Transactions
| Method and path | Notes |
|---|---|
| `GET /transactions?q=&account=&category=&kind=&from=&to=&limit=&cursor=` | `category` is a category id, or `none` for transactions without a category. `kind` is `income`, `expense`, `transfer` or `adjustment`. `q` searches description, note, category and account name |
| `POST /transactions` | `{ kind: "income"\|"expense", accountId, amount, date, categoryId, description?, note? }`. `amount` is always positive. 201 `{ transaction }` |
| `GET /transactions/:id` | |
| `PATCH /transactions/:id` | Any of the create fields. A transfer row is refused with 400 `transfer_locked`: use `PATCH /transfers/:id`. Adjustments cannot be edited (400) |
| `DELETE /transactions/:id` | 204. Deleting any row of a transfer deletes the whole transfer, fee included |
| `POST /transfers` | `{ fromAccountId, toAccountId, amount, fee?, date, note? }`. 201 `{ rows }` with the out, in and optional fee rows. The fee is booked as an expense in "Financial & Fees" |
| `PATCH /transfers/:id` | Any of `{ fromAccountId, toAccountId, amount, fee, date, note }`, at least one. `note: null` clears the note. A field you leave out keeps its value, so a patch with only `amount` keeps the fee and the note. The result is checked like a new transfer (the two accounts must differ and must be active) and both accounts are checked for overdraft, the old and the new. 200 `{ rows }`, the same shape as `POST /transfers`. 400 `validation`, `account_unavailable`, `insufficient_balance` or `invalid_json`. 404 `not_found` for a missing id, another person's id or an id that is not a UUID |
| `DELETE /transfers/:id` | 204. Removes the transfer, both legs and the fee row. 400 `insufficient_balance` when removing the money that came in would leave an account below zero. 404 `not_found` as for `PATCH` |

A transaction row (`LedgerRow`) has `kind`, a signed `amount`, `accountName`, `categoryName`, `categoryIcon`, `counterpartName` for transfers, `isTransferFee`, and `runningBalance` (only on the account ledger).

### Budgets
Budgets are a limit per expense category for one "month". `month` is `YYYY-MM`. It is the calendar month unless the person set a pay cycle (`PUT /settings`), in which case it is named after the month the cycle starts in.
| Method and path | Notes |
|---|---|
| `GET /budgets?month=` | Default is the current month. Returns `{ month, budget, spent, left, items: [{ categoryId, name, budget, spent }], unbudgetedSpent }`. `budget` is the sum of the limits and `spent` only counts budgeted categories |
| `PUT /budgets/:month` | `{ items: [{ categoryId, amount }] }` replaces every budget of the month. An empty list clears it. Only your own active expense categories, one budget each (400 `invalid_category` or `validation`) |
| `POST /budgets/:month/copy-previous` | Copies last month's budgets into categories that have none yet. Existing budgets stay. Returns the month plus `copied` |
### Statistics and insights
All three take `?period=week|month|year` (default `month`). Weeks run Monday to Sunday, days follow Jakarta time, and only expenses count (a transfer fee is an expense).
| Method and path | Notes |
|---|---|
| `GET /stats/flow?period=&date=` | `{ period, range, total, previousTotal, changePct, buckets: [{ label, from, to, amount, current }] }`. Buckets are days for a week, Monday-to-Sunday weeks for a month (first and last clipped), months for a year |
| `GET /stats/categories` | `{ period, range, total, items: [{ categoryId, name, amount, share, previousAmount, changePct }] }`, biggest first |
| `GET /stats/trend?months=&date=` | `{ months: [{ month, from, to, income, expense, net }] }`. The last `months` pay cycles (1 to 12, default 6), oldest first, ending with the one that holds `date` (today when left out). A cycle is named after the month it starts in, like budgets. Transfers are in neither income nor expense; transfer fees are expense. One query for all the months |
| `GET /stats/details?period=&date=` | The numbers behind the charts: `{ period, range, isCurrent, days: [{ date, income, expense }], totals: { income, expense, net, count }, avgDailyExpense, projection: { expense, daysLeft } \| null, biggest: LedgerRow[] }`. `days` has every day of the range (365 or 366 for a year), zeros included. `avgDailyExpense` counts the days so far for a running period and all days for a finished one. `projection` is the spending at the same pace to the end of the period, and is null for a finished period, a year, or fewer than 3 days of a month (2 of a week). `biggest` is the five largest expenses |
| `GET /insights?period=&language=&date=` | `language` is one of `en id de fr es pt ru zh` (default `en`; anything else is 400) and the notes are worded in it. `{ period, items: [{ id, kind, tone, text }] }`. Rule-based notes, warnings first, at most 6. Kinds: `budget`, `trend`, `peak`, `fees`, `stale`, `empty`. Every text quotes its numbers |
`previousTotal`, `previousAmount` and `changePct` compare with the same stretch of the previous period, not all of it. On a Thursday, "this week" is compared with Monday to Thursday of last week. `changePct` is `null` when the earlier value is 0. Budget notes always use the current month. A `stale` note means a bank, e-wallet or other non-cash account has not had a balance update for 14 days.
### Quick picks
| Method and path | Notes |
|---|---|
| `GET /suggestions?kind=expense\|income` | `{ items: [{ kind, description, categoryId, categoryName, categoryIcon, accountId, accountName, amount, uses, lastDate }] }`, at most 8. Things you record again and again: same description (ignoring case and spaces), category and account, used at least 2 times in the last 120 days. `amount` is the one you use most often. `description` is `null` when you never typed one, so show `categoryName`. Habits you usually do at this time of day (Jakarta, within 2 hours) come first. Transfers, fees, adjustments, archived accounts and archived categories are never suggested |
### Summary
| Method and path | Notes |
|---|---|
| `GET /summary?period=week\|month\|year&date=` | Everything the home screen needs in one call. Default is `month`. `date` (YYYY-MM-DD) is any day inside the period to show; with a day in an earlier period the whole finished period is returned (`range` says which), a future day means the current period. Balances are always as of now |
Returns `total`, `assets`, `debts`, `countedCount`, `allCount`, `ring` (one segment per account with money), `byType`, `flow` (`income`, `expense`), `spendingByCategory`, `accounts`, `recent` (the 5 newest rows) and the `range` that was used.
- Weeks run Monday to Sunday and days follow Jakarta time.
- Transfers are not income or expense. A transfer fee is an expense.
- `total` and the account balances do not depend on the period. Only `flow` and `spendingByCategory` do.
### Assistant (AI)
The assistant is optional. It works with any OpenAI-compatible endpoint and is switched on by `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` (see `.env.example`). Without a key it is off, and the app hides it.
| Method and path | Notes |
|---|---|
| `GET /ai/status` | `{ enabled }`. The app shows the assistant only when this is true |
| `POST /ai/summary` | `{ period: "week"\|"month"\|"year", language? }`. `language` is the app language (same list as `/insights`) and the text is written in it returns `{ period, text, source }`. `source` is `ai` when the model wrote it, or `rules` when it is the rule-based text (the model is off, down, or wrote a figure that is not in the data). It always returns text. The same figures give the same text for 30 minutes |
| `POST /ai/chat` | `{ language?, view?, messages: [{ role: "user"\|"assistant", content }] }`. `view` is what the person is looking at (`screen`, `period`, `from`, `to`, `month`, `theme`), so "this month" and "here" mean what is on screen. The assistant answers in the language the person writes in, or in `language` when that is unclear. The fixed refusal and fallback replies are written in `language` too, at most 12 messages of 4,000 characters, the last one from the person. Returns `{ reply, drafts, changes, refused }`. `drafts` are records to add. `changes` are proposed edits and deletions of transactions and transfers, budget limits, new, renamed and hidden categories, and the personal settings for the first day of the month, the theme and the language (`AiChange` in `shared/core/src/api-types.ts`). Creating, renaming or archiving an account, balance updates and the profile name are not offered: the assistant explains where to do them in the app. Both are only cards: the app applies a confirmed card through the ordinary endpoints (`POST /transactions`, `POST /transfers`, `PATCH` or `DELETE /transactions/:id`, `PATCH` or `DELETE /transfers/:id`, `PUT /budgets/:month`, `POST /categories`, `PATCH /categories/:id`, `POST /categories/:id/archive`, `PUT /settings`). A theme or language card calls no endpoint: the app sets it on the phone. Cancel on a card sends nothing. Replies are plain text: markdown markers are removed, and a reply that holds code, a link, markup or a table is replaced. A reply is cut at 4,000 characters, at the end of a sentence when there is one. The server keeps no conversation: the app sends it every time |
**Hard rules**, enforced in code and not only in the prompt:
1. **Scope.** Before anything runs, a separate check decides whether every message is about the person's own money in Oracle (accounts, bills, transactions, budgets, statistics, adding records, how to use the app). Anything else, including general knowledge, code, writing, advice on investing, tax or health, role-play and any attempt to change the rules, gets a fixed refusal (`refused: true`) with no model reply and no tool run. If the check's answer is missing or unclear it counts as out of scope. Only the roles `user` and `assistant` are accepted, so nobody can send their own instructions.
2. **Read only.** The assistant has eleven tools: overview, spending, trend, budgets, insights, search, aggregate, calculate, get_app_guide, propose_transactions and propose_changes. The first nine only read the person's own data. The last two only create cards. None can save, edit or delete anything: a proposal for a transaction is checked against the person's own rows (another person's id is the same as an id that does not exist), a transfer is changed only through its transfer id, a new amount must be one the person wrote or one from their data, and at most 20 cards come back per answer.
3. **Drafts, not records.** To add data it calls `propose_transactions`, which only returns `drafts`. The app shows them as cards, and nothing exists until the person confirms a card, which calls the ordinary `POST /transactions` or `POST /transfers`. A draft's accounts and category are checked against the person's own, and its amount must be one the person wrote (`25rb`, `1,5 juta`, `25.000` all count) or a figure from their own data. At most 20 drafts a turn.
4. **Numbers.** Every amount and percentage in an answer must appear in the data the model was given or in what the person wrote. If not, the model is asked once to correct it, and if it fails again the person sees a plain "could not verify" message instead. Shorthand such as `50k` is never allowed in an answer.
5. **Secrecy.** The internal rules carry a marker. An answer that contains it is replaced by the refusal.
6. **Data is not instructions.** Descriptions, notes and names are shortened, stripped of control characters and handed over as data.
7. **Cost.** At most 40 assistant calls (chat and summary together) per person per hour (`AI_RATE_PER_HOUR`), at most 6 tool rounds and 4 tool calls per round for one answer.
8. **Privacy.** What a person asks and what the model answers is never written to the log. The model's private reasoning is never read or returned. Provider errors become a generic `ai_unavailable` (503), and a missing key is `ai_disabled` (503). Going over the hourly limit is `ai_rate_limited` (429).
### Export
| Method and path | Notes |
|---|---|
| `GET /export/transactions.csv?q=&account=&kind=&from=&to=` | A CSV file of every matching transaction, oldest first. The filters are the same as `GET /transactions`, without paging. Columns: `Date, Account, Type, Category, Description, Note, Counterpart account, Amount (IDR)`. Amounts are signed whole rupiah. UTF-8 with a byte order mark, so Excel reads accents correctly. Text that starts with `=`, `+`, `-` or `@` gets a leading apostrophe, so a description can never run as a spreadsheet formula. A filter with no match still returns a file with only the header. Invalid filters are a JSON 400, not a file |
## Limits and safety
- Every `/api/v1` answer is sent with `Cache-Control: no-store`, and every response carries the usual browser safety headers.
- A request body can be at most 256 KB (the biggest real one, the onboarding batch, is about 15 KB).
- At most 600 requests a minute per client address. Behind the Cloudflare Tunnel the address comes from `CF-Connecting-IP`. Login, sign-up and password change have their own much tighter limits, and the login routes accept at most 16 KB per request.
- A 500 never shows details. They go to the server log, which has one line per request (method, path, status, time) and never the query string or a body.
## Health
| Method and path | Notes |
|---|---|
| `GET /api/health` | `{ ok: true }` when the database responds, 503 otherwise. No login needed, and it is not rate limited |
## Not built
Deleting your own account is not part of the plan. Archiving an account keeps its history.
