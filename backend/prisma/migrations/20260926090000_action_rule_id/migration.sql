-- The Planning Assessment rule a PM action came from. Null for gap-derived and hand-made actions.
ALTER TABLE "action_items" ADD COLUMN "ruleId" TEXT;
