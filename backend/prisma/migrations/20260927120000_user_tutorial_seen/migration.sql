-- First-run tutorial: null until the account finishes or skips it.
ALTER TABLE "users" ADD COLUMN "tutorialSeenAt" TIMESTAMP(3);
