import type { CategoryKind } from "@oracle/core";

export type CategorySeed = { name: string; kind: CategoryKind; color: string; icon: string };

/**
 * Created for every new user. Users can rename, hide, or add their own. The order here is the order in the app.
 * "Financial & Fees" is where transfer fees are booked, so it cannot be renamed or hidden.
 * The icons must come from CATEGORY_ICONS (CATEGORY_ICONS in @oracle/core, constants.ts).
 */
export const DEFAULT_CATEGORIES: CategorySeed[] = [
  { kind: "expense", name: "Food & Drinks", color: "#F97316", icon: "silverware-fork-knife" },
  { kind: "expense", name: "Transportation", color: "#0EA5E9", icon: "car" },
  { kind: "expense", name: "Shopping", color: "#EC4899", icon: "shopping" },
  { kind: "expense", name: "Bills & Utilities", color: "#EAB308", icon: "receipt" },
  { kind: "expense", name: "Housing", color: "#84CC16", icon: "home-variant" },
  { kind: "expense", name: "Entertainment", color: "#A855F7", icon: "movie-open" },
  { kind: "expense", name: "Health", color: "#EF4444", icon: "heart-pulse" },
  { kind: "expense", name: "Personal Care", color: "#F472B6", icon: "spa" },
  { kind: "expense", name: "Education", color: "#14B8A6", icon: "school" },
  { kind: "expense", name: "Family & Kids", color: "#F43F5E", icon: "baby-carriage" },
  { kind: "expense", name: "Travel", color: "#38BDF8", icon: "airplane" },
  { kind: "expense", name: "Financial & Fees", color: "#64748B", icon: "bank" },
  { kind: "expense", name: "Insurance", color: "#6366F1", icon: "umbrella" },
  { kind: "expense", name: "Charity", color: "#10B981", icon: "hand-heart" },
  { kind: "expense", name: "Subscriptions", color: "#8B5CF6", icon: "credit-card" },
  { kind: "income", name: "Salary", color: "#16A34A", icon: "briefcase" },
  { kind: "income", name: "Bonus", color: "#22C55E", icon: "gift" },
  { kind: "income", name: "Freelance", color: "#0D9488", icon: "laptop" },
  { kind: "income", name: "Business Income", color: "#0891B2", icon: "handshake-outline" },
  { kind: "income", name: "Investment Income", color: "#2563EB", icon: "chart-line" },
  { kind: "income", name: "Interest", color: "#CA8A04", icon: "piggy-bank" },
  { kind: "income", name: "Gifts", color: "#D946EF", icon: "party-popper" },
  { kind: "income", name: "Cashback & Rewards", color: "#F59E0B", icon: "sale" },
  { kind: "income", name: "Rental Income", color: "#65A30D", icon: "home-variant" },
  { kind: "income", name: "Allowance", color: "#0EA5A4", icon: "wallet" },
  { kind: "income", name: "Refund", color: "#94A3B8", icon: "cash" },
  { kind: "income", name: "Other Income", color: "#A3A3A3", icon: "star" },
];
