-- Which catalog document a PM action is about, so the dashboard's "Open" button can land on that
-- document in the Planning Studio instead of on whatever the Studio selects by default.
--
-- Nullable and with no backfill by design: an action whose gap named no catalog document has no
-- target, and `targetView` already sends those to Project Input. Existing rows written before this
-- column keep a null and behave exactly as they did.
ALTER TABLE "action_items" ADD COLUMN "targetDocument" TEXT;
