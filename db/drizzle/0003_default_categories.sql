-- Moves existing accounts to the new default categories. Safe to run on an empty database.
--
-- 1. A category that still has one of the old default names is renamed to its new name. Transactions and budgets
--    point at the category, not at its name, so history and limits follow. It is skipped when the person already
--    has a category with the new name.
-- 2. The new defaults that did not exist before are added where the person does not have them.
--
-- 3. The old default "Phone & Internet" is not in the new list. It is hidden only when nothing uses it (no
--    transactions and no budgets), so nobody loses sight of money that was recorded under it.
--
-- Categories the person made or renamed are never touched, and a category the person hid stays hidden.
UPDATE categories c
SET name = m.new_name, updated_at = now()
FROM (VALUES
  ('expense', 'Transport', 'Transportation'),
  ('expense', 'Home', 'Housing'),
  ('expense', 'Family', 'Family & Kids'),
  ('expense', 'Admin Fee', 'Financial & Fees'),
  ('expense', 'Charity & Zakat', 'Charity'),
  ('income', 'Cashback', 'Cashback & Rewards')
) AS m(kind, old_name, new_name)
WHERE c.kind::text = m.kind
  AND c.name = m.old_name
  AND NOT EXISTS (
    SELECT 1 FROM categories x WHERE x.user_id = c.user_id AND x.kind = c.kind AND x.name = m.new_name
  );
--> statement-breakpoint
INSERT INTO categories (user_id, name, kind, color, icon, sort_order)
SELECT u.id, v.name, v.kind::category_kind, v.color, v.icon, 100 + v.ord
FROM "user" u
CROSS JOIN (VALUES
  ('expense', 'Personal Care', '#F472B6', 'spa', 1),
  ('expense', 'Travel', '#38BDF8', 'airplane', 2),
  ('expense', 'Insurance', '#6366F1', 'umbrella', 3),
  ('income', 'Business Income', '#0891B2', 'handshake-outline', 4),
  ('income', 'Investment Income', '#2563EB', 'chart-line', 5),
  ('income', 'Interest', '#CA8A04', 'piggy-bank', 6),
  ('income', 'Rental Income', '#65A30D', 'home-variant', 7),
  ('income', 'Allowance', '#0EA5A4', 'wallet', 8),
  ('income', 'Refund', '#94A3B8', 'cash', 9),
  ('income', 'Other Income', '#A3A3A3', 'star', 10)
) AS v(kind, name, color, icon, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM categories c WHERE c.user_id = u.id AND c.kind::text = v.kind AND c.name = v.name
);
--> statement-breakpoint
UPDATE categories c
SET archived_at = now(), updated_at = now()
WHERE c.kind::text = 'expense'
  AND c.name = 'Phone & Internet'
  AND c.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.category_id = c.id);
