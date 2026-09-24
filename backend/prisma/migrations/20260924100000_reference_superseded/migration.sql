-- A replaced upload is kept rather than deleted, so a plan change can compare the new version
-- against the one it replaced. Superseded files are hidden from the current-document slot and
-- excluded from every analysis; they remain selectable when recording a change.
--
-- No backfill: rows that exist now are all current, and the previous behaviour deleted the ones
-- they replaced, so there is nothing left to mark.
ALTER TABLE "reference_files" ADD COLUMN "supersededAt" TIMESTAMP(3);
