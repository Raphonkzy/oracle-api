/**
 * Two years of believable money for a developer account: a salary, rent, bills, daily food and transport, paylater and a
 * credit card, savings, an investment account, trips, subscriptions, an account that was closed, and budgets.
 *
 * `buildDevData` only makes a list of steps. It follows its own balances, so no step ever takes an account below zero (the
 * server would refuse it), and it is always the same for the same `today`. `runDevData` plays the steps through any
 * `call` function: the real API over the network, or the app in a test.
 */
import { addDays, isDebtType, shiftMonth, type AccountType } from "@oracle/core";

export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

type AccountSpec = { key: string; name: string; type: AccountType; opening: number };
export type Step =
  | { kind: "tx"; date: string; type: "expense" | "income"; account: string; amount: number; category: string; description: string }
  | { kind: "transfer"; date: string; from: string; to: string; amount: number; fee: number; note: string }
  | { kind: "archive"; account: string }
  | { kind: "budgets"; month: string; items: { category: string; amount: number }[] };

export const ACCOUNTS: AccountSpec[] = [
  { key: "bca", name: "BCA", type: "bank", opening: 6_500_000 },
  { key: "jago", name: "Bank Jago", type: "bank", opening: 3_000_000 },
  { key: "gopay", name: "GoPay", type: "ewallet", opening: 350_000 },
  { key: "shopeepay", name: "ShopeePay", type: "ewallet", opening: 150_000 },
  { key: "dana", name: "DANA", type: "ewallet", opening: 120_000 },
  { key: "cash", name: "Tunai", type: "cash", opening: 400_000 },
  { key: "bibit", name: "Bibit Reksadana", type: "investment", opening: 5_000_000 },
  { key: "spaylater", name: "SPayLater", type: "paylater", opening: -300_000 },
  { key: "cc", name: "Kartu Kredit BCA", type: "credit_card", opening: -1_200_000 },
];

/** A small repeatable random generator, so the same data comes out every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number, step = 1000) => Math.round((lo + next() * (hi - lo)) / step) * step;
  const chance = (p: number) => next() < p;
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  return { next, between, chance, pick };
}

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const dom = (iso: string) => Number(iso.slice(8));
const lastDay = (iso: string) => dom(addDays(`${shiftMonth(iso.slice(0, 7), 1)}-01`, -1));

/** The steps for the two years before `today`, oldest first. */
export function buildDevData(today: string, seed = 13, months = 24): { start: string; steps: Step[] } {
  const r = rng(seed);
  const start = `${shiftMonth(today.slice(0, 7), -months)}-01`;
  const balance = new Map(ACCOUNTS.map((a) => [a.key, a.opening]));
  const type = new Map(ACCOUNTS.map((a) => [a.key, a.type]));
  const steps: Step[] = [];
  let danaOpen = true;

  const have = (key: string) => balance.get(key) ?? 0;
  const canPay = (key: string, amount: number) => isDebtType(type.get(key)!) || have(key) >= amount;
  const move = (key: string, delta: number) => balance.set(key, have(key) + delta);

  const tx = (date: string, kind: "expense" | "income", account: string, amount: number, category: string, description: string) => {
    if (kind === "expense" && !canPay(account, amount)) return false;
    move(account, kind === "income" ? amount : -amount);
    steps.push({ kind: "tx", date, type: kind, account, amount, category, description });
    return true;
  };
  const transfer = (date: string, from: string, to: string, amount: number, fee: number, note: string) => {
    if (amount <= 0 || !canPay(from, amount + fee)) return false;
    move(from, -(amount + fee));
    move(to, amount);
    steps.push({ kind: "transfer", date, from, to, amount, fee, note });
    return true;
  };
  /** Spends from the first account that can afford it. When a bank account is short, savings in Jago cover it. */
  const spend = (date: string, prefs: string[], amount: number, category: string, description: string) => {
    for (const key of prefs) {
      if (canPay(key, amount)) return tx(date, "expense", key, amount, category, description);
    }
    // The bank account is short: savings cover it.
    if (prefs[0] === "bca" && have("jago") > amount + 500_000) {
      if (transfer(date, "jago", "bca", Math.ceil((amount + 100_000) / 100_000) * 100_000, 0, "From savings")) return tx(date, "expense", "bca", amount, category, description);
    }
    // Top up from the bank (and from savings first, when the bank is low) and try the wallet again.
    for (const key of prefs) {
      if (key === "gopay" || key === "shopeepay" || key === "cash") {
        const need = amount + 50_000;
        if (have("bca") < need + 600_000 && have("jago") > need + 800_000) transfer(date, "jago", "bca", Math.ceil(need / 100_000) * 100_000 + 300_000, 0, "From savings");
        if (transfer(date, "bca", key, Math.max(300_000, Math.ceil(need / 100_000) * 100_000), key === "cash" ? 6_500 : 0, key === "cash" ? "ATM cash withdrawal" : "Top up balance")) return tx(date, "expense", key, amount, category, description);
      }
    }
    return false;
  };

  const monthList: string[] = [];
  for (let m = start.slice(0, 7); m <= today.slice(0, 7); m = shiftMonth(m, 1)) monthList.push(m);

  for (let day = start; day <= today; day = addDays(day, 1)) {
    const d = dom(day);
    const wd = dow(day); // 0 Sun .. 6 Sat
    const weekend = wd === 0 || wd === 6;
    const year = Number(day.slice(0, 4));
    const mo = Number(day.slice(5, 7));
    const raise = day >= "2025-11-01"; // a raise after the first year

    // ----- Money in -----
    if (d === Math.min(25, lastDay(day))) tx(day, "income", "bca", raise ? 10_500_000 : 9_500_000, "Salary", "Monthly salary");
    if (mo === 3 && d === 20) tx(day, "income", "bca", raise ? 10_500_000 : 9_500_000, "Bonus", "THR");
    if (mo === 12 && d === 28) tx(day, "income", "bca", r.between(2_500_000, 3_500_000, 50_000), "Bonus", "Year-end bonus");
    if (d === 18 && r.chance(0.65)) tx(day, "income", "bca", r.between(600_000, 3_200_000, 50_000), "Freelance", r.pick(["Landing page project", "Logo design", "Website maintenance", "App consulting", "Content writing"]));
    if (d === Math.min(28, lastDay(day))) tx(day, "income", "jago", Math.max(2_000, Math.round(have("jago") * 0.0025)), "Interest", "Savings interest");
    if (d === 15 && mo % 3 === 0) tx(day, "income", "bibit", r.between(60_000, 380_000, 1000), "Investment Income", "Mutual fund returns");
    if (r.chance(0.025)) tx(day, "income", "gopay", r.between(5_000, 35_000, 500), "Cashback & Rewards", r.pick(["GoPay cashback", "Credit card reward", "ShopeePay points"]));
    if (mo === 3 && d === 14) tx(day, "income", "bca", r.between(400_000, 900_000, 50_000), "Gifts", "Birthday gift");
    if (d === 9 && r.chance(0.04)) tx(day, "income", "bca", r.between(50_000, 250_000, 5_000), "Refund", "Order refund");

    // ----- Bills and fixed costs -----
    if (d === 1) spend(day, ["bca"], year >= 2026 ? 1_900_000 : 1_800_000, "Housing", "Boarding house rent");
    if (d === 3) spend(day, ["bca"], r.between(280_000, 430_000, 1000), "Bills & Utilities", "Listrik PLN");
    if (d === 6) spend(day, ["bca"], 385_000, "Bills & Utilities", "Internet IndiHome");
    if (d === 10) spend(day, ["bca"], 150_000, "Insurance", "BPJS Kesehatan");
    if (d === 10) spend(day, ["gopay"], r.between(50_000, 150_000, 5_000), "Bills & Utilities", "Mobile credit and data plan");
    if (d === 12) spend(day, ["cc"], 54_000, "Subscriptions", "Netflix");
    if (d === 12) spend(day, ["cc"], 55_000, "Subscriptions", "Spotify");
    if (d === 20) spend(day, ["cc"], 59_000, "Subscriptions", "YouTube Premium");
    if (d === 15) spend(day, ["bca"], 250_000, "Health", "Gym");
    if (d === 20) spend(day, ["bca"], 425_000, "Insurance", "Life insurance premium");
    if (d === 2) spend(day, ["bca"], 12_500, "Financial & Fees", "Monthly admin fee");
    if (d === 27) spend(day, ["bca"], 800_000, "Family & Kids", "For my parents");
    if (d === 5 && wd >= 1 && wd <= 5 && r.chance(0.3)) spend(day, ["gopay"], 100_000, "Transportation", "E-toll top-up");

    // ----- Moving money around -----
    if (d === 8) {
      const owed = -have("spaylater");
      if (owed > 0) transfer(day, "bca", "spaylater", owed, 0, "SPayLater bill payment");
    }
    if (d === 22) {
      const owed = -have("cc");
      if (owed > 0) transfer(day, "bca", "cc", owed, 0, "Credit card bill payment");
    }
    if (d === 26) {
      transfer(day, "bca", "jago", r.between(1_200_000, 1_800_000, 50_000), 0, "Monthly savings");
      transfer(day, "bca", "bibit", 1_000_000, 0, "Mutual fund purchase");
    }
    // A bank account that ran low is topped up from savings.
    if (have("bca") < 1_200_000 && have("jago") > 2_500_000) transfer(day, "jago", "bca", 1_500_000, 0, "From savings");

    // ----- Every day -----
    if (!weekend && r.chance(0.7)) spend(day, danaOpen && r.chance(0.35) ? ["dana", "gopay", "cash"] : ["gopay", "cash", "shopeepay"], r.between(20_000, 38_000, 1000), "Food & Drinks", r.pick(["Lunch: warteg", "Lunch: nasi padang", "Lunch: ayam geprek", "Lunch: soto", "Lunch: bakmi"]));
    if (r.chance(0.35)) spend(day, ["gopay", "cash"], r.between(16_000, 32_000, 1000), "Food & Drinks", r.pick(["Kopi Kenangan", "Iced milk coffee", "Janji Jiwa", "Morning coffee", "Teh tarik"]));
    if (r.chance(0.4)) spend(day, ["gopay", "cash", "shopeepay"], r.between(22_000, 55_000, 1000), "Food & Drinks", r.pick(["Dinner", "GoFood - grilled chicken", "GrabFood - noodles", "Nasi goreng", "Sate ayam"]));
    if (weekend && r.chance(0.4)) spend(day, ["bca", "cc", "gopay"], r.between(80_000, 190_000, 5_000), "Food & Drinks", r.pick(["Restaurant meal", "Weekend brunch", "Sushi", "Seafood with friends", "Bakso Solo"]));
    if (wd === 0) spend(day, ["bca", "shopeepay", "gopay"], r.between(120_000, 300_000, 5_000), "Food & Drinks", r.pick(["Weekly groceries at Indomaret", "Groceries: vegetables and side dishes", "Groceries at Alfamart", "Groceries at Superindo"]));
    if (!weekend && r.chance(0.5)) spend(day, danaOpen && r.chance(0.3) ? ["dana", "gopay"] : ["gopay"], r.between(13_000, 34_000, 1000), "Transportation", r.pick(["Gojek to the office", "Grab home", "Gojek to the station", "KRL", "TransJakarta"]));
    if (wd === 6) spend(day, ["cash", "gopay"], r.between(40_000, 100_000, 5_000), "Transportation", "Pertalite fuel");
    if (r.chance(0.04)) spend(day, ["cash"], r.between(2_000, 8_000, 1000), "Transportation", "Parking");

    // ----- Now and then -----
    if (d === 16 || d === 4) {
      if (r.chance(0.4)) spend(day, r.chance(0.5) ? ["spaylater"] : ["shopeepay", "spaylater"], r.between(80_000, 520_000, 5_000), "Shopping", r.pick(["Shopee - kaos", "Tokopedia - charger", "Shopee - peralatan dapur", "Tokopedia - tas", "Shopee - sepatu", "Lazada - buku"]));
    }
    if (weekend && r.chance(0.16)) spend(day, ["gopay", "bca", "cc"], r.between(50_000, 160_000, 5_000), "Entertainment", r.pick(["Movie", "Hanging out with friends", "Game top-up", "Karaoke", "Small concert"]));
    if (d === 9 && r.chance(0.5)) spend(day, ["bca", "gopay", "cash"], r.between(80_000, 600_000, 5_000), "Health", r.pick(["Pharmacy", "GP visit", "Vitamin", "Dental check-up", "Flu medicine"]));
    if (d === 11) spend(day, ["cash"], r.between(50_000, 80_000, 5_000), "Personal Care", "Haircut");
    if (d === 14 && mo % 3 === 0) spend(day, ["shopeepay", "spaylater", "bca"], r.between(150_000, 350_000, 5_000), "Personal Care", "Skincare");
    if (d === 23 && r.chance(0.35)) spend(day, ["bca", "cc"], r.between(100_000, 300_000, 5_000), "Family & Kids", r.pick(["Gift for a friend", "Souvenirs for family", "Toy for a niece or nephew", "Wedding gift money"]));
    if (wd === 5 && d <= 7) spend(day, ["gopay", "cash"], r.between(100_000, 250_000, 10_000), "Charity", "Friday charity");
    if (day >= "2025-02-01" && day < "2025-08-01" && d === 5) spend(day, ["bca"], 450_000, "Education", "English course");
    if ((mo === 5 || mo === 11) && d === 21) spend(day, ["cc", "bca"], r.between(120_000, 200_000, 5_000), "Education", "Udemy online course");
    if (mo === 3 && d === 25 && year === 2025) spend(day, ["bca"], 250_000, "Charity", "Zakat al-fitr and Ramadan charity");

    // Big purchases and trips.
    if (day === `${year}-12-12` && year >= 2025) spend(day, ["cc"], r.between(1_800_000, 3_200_000, 50_000), "Shopping", "Harbolnas - headphone");
    if (day === "2025-06-14") spend(day, ["cc"], 1_650_000, "Shopping", "Running shoes");
    if (day === "2026-06-21") spend(day, ["cc"], 2_400_000, "Shopping", "Mechanical keyboard");
    if (day === "2025-03-28" || day === "2026-03-18") {
      spend(day, ["cc", "bca"], r.between(900_000, 1_700_000, 50_000), "Travel", "Homecoming trip tickets");
      spend(day, ["bca"], r.between(300_000, 600_000, 50_000), "Travel", "Oleh-oleh mudik");
    }
    if (day === "2025-12-26" || day === "2026-08-15") {
      spend(day, ["cc", "bca"], r.between(1_100_000, 1_900_000, 50_000), "Travel", "Holiday flight tickets");
      spend(day, ["bca", "cc"], r.between(1_000_000, 1_800_000, 50_000), "Travel", "Holiday hotel");
    }
    if (day === "2025-12-29" || day === "2026-08-17") spend(day, ["cash", "gopay"], r.between(250_000, 450_000, 10_000), "Travel", "Snacks and transport on holiday");

    // The old wallet is closed after a year: what is left moves to GoPay.
    if (day === "2025-11-03" && danaOpen) {
      transfer(day, "dana", "gopay", Math.max(have("dana"), 0), 0, "Move remaining balance");
      steps.push({ kind: "archive", account: "dana" });
      danaOpen = false;
    }
  }

  // Budgets for every month of the two years (the month's cycle starts on the 1st).
  const BUDGET = [
    { category: "Food & Drinks", amount: 2_600_000 },
    { category: "Transportation", amount: 800_000 },
    { category: "Shopping", amount: 1_000_000 },
    { category: "Bills & Utilities", amount: 1_100_000 },
    { category: "Entertainment", amount: 500_000 },
    { category: "Health", amount: 450_000 },
    { category: "Subscriptions", amount: 200_000 },
    { category: "Personal Care", amount: 250_000 },
  ];
  for (const m of monthList) steps.push({ kind: "budgets", month: m, items: BUDGET.map((b) => ({ ...b, amount: m >= "2026-01" ? Math.round((b.amount * 1.08) / 50_000) * 50_000 : b.amount })) });
  return { start, steps };
}

export type Progress = (done: number, total: number) => void;

/** Plays the steps through `call`. Creates the accounts first. Stops with a clear message on the first refusal. */
export async function runDevData(call: Call, today: string, onProgress?: Progress, months = 24): Promise<{ transactions: number; transfers: number; accounts: number }> {
  const { start, steps } = buildDevData(today, 13, months);
  const need = async (method: string, path: string, body?: unknown) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await call(method, path, body);
      if (res.status === 429) {
        await new Promise((ok) => setTimeout(ok, 5_000 * (attempt + 1)));
        continue;
      }
      if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body?.error ?? res.body)} ${JSON.stringify(body)}`);
      return res.body;
    }
    throw new Error(`${method} ${path}: still rate limited`);
  };

  const accountIds = new Map<string, string>();
  for (const a of ACCOUNTS) {
    const made = await need("POST", "/api/v1/accounts", { providerId: null, name: a.name, type: a.type, initialBalance: a.opening, initialBalanceDate: start, includeInTotal: true });
    accountIds.set(a.key, made.account.id);
  }
  const cats = (await need("GET", "/api/v1/categories")).categories as { id: string; name: string; kind: string }[];
  const cat = (name: string, kind: string) => {
    const found = cats.find((c) => c.name === name && c.kind === kind);
    if (!found) throw new Error(`category ${name} (${kind}) not found`);
    return found.id;
  };
  const acc = (key: string) => accountIds.get(key)!;

  let tx = 0;
  let tr = 0;
  let done = 0;
  for (const s of steps) {
    if (s.kind === "tx") {
      await need("POST", "/api/v1/transactions", { kind: s.type, accountId: acc(s.account), amount: s.amount, date: s.date, categoryId: cat(s.category, s.type), description: s.description });
      tx += 1;
    } else if (s.kind === "transfer") {
      await need("POST", "/api/v1/transfers", { fromAccountId: acc(s.from), toAccountId: acc(s.to), amount: s.amount, fee: s.fee, date: s.date, note: s.note });
      tr += 1;
    } else if (s.kind === "archive") {
      await need("POST", `/api/v1/accounts/${acc(s.account)}/archive`);
    } else {
      await need("PUT", `/api/v1/budgets/${s.month}`, { items: s.items.map((i) => ({ categoryId: cat(i.category, "expense"), amount: i.amount })) });
    }
    done += 1;
    if (done % 50 === 0) onProgress?.(done, steps.length);
  }
  onProgress?.(steps.length, steps.length);
  return { transactions: tx, transfers: tr, accounts: ACCOUNTS.length };
}
