-- A change carries several documents, not one.
--
-- A revised SOW usually arrives with a change request form and an updated schedule; the single pair
-- on plan_changes kept only the newest upload and dropped the rest without saying so.

CREATE TABLE "plan_change_documents" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "supersedesReferenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_change_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_change_documents_changeId_referenceId_key"
    ON "plan_change_documents"("changeId", "referenceId");

ALTER TABLE "plan_change_documents" ADD CONSTRAINT "plan_change_documents_changeId_fkey"
    FOREIGN KEY ("changeId") REFERENCES "plan_changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry over the pair that already exists, so an applied change keeps describing what it described.
INSERT INTO "plan_change_documents" ("id", "changeId", "referenceId", "supersedesReferenceId", "createdAt")
SELECT gen_random_uuid()::text, "id", "newReferenceId", "supersedesReferenceId", "createdAt"
  FROM "plan_changes"
 WHERE "newReferenceId" IS NOT NULL;

ALTER TABLE "plan_changes" DROP COLUMN "newReferenceId";
ALTER TABLE "plan_changes" DROP COLUMN "supersedesReferenceId";

-- Uploads the PM removed from a change, so the automatic suggestion pass does not put them back.
ALTER TABLE "plan_changes" ADD COLUMN "removedReferenceIds" JSONB NOT NULL DEFAULT '[]';

-- Which upload replaced this one, so pairing is an exact lookup rather than a guess from timestamps.
ALTER TABLE "reference_files" ADD COLUMN "supersededById" TEXT;
