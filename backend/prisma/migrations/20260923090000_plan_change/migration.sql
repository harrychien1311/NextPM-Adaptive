-- Change plan mode: recording a change to a plan that already exists, and what it affected.

CREATE TYPE "PlanChangeStatus" AS ENUM ('DRAFT', 'ANALYZED', 'APPLIED', 'DISMISSED');

CREATE TABLE "plan_changes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "note" TEXT,
    "newReferenceId" TEXT,
    "supersedesReferenceId" TEXT,
    "status" "PlanChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "impact" JSONB,
    "analysisId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analyzedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "plan_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plan_changes_projectId_status_idx" ON "plan_changes"("projectId", "status");

ALTER TABLE "plan_changes" ADD CONSTRAINT "plan_changes_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_changes" ADD CONSTRAINT "plan_changes_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Snapshots are immutable, so a change writes a new one and links back. The chain of these is the
-- history of the plan itself.
ALTER TABLE "ai_approach_suggestions" ADD COLUMN "changeOfId" TEXT;

-- A flag on a document a change made out of date. Deliberately not a status: an approved document is
-- something the PM signed, and only the PM decides whether it is regenerated or deleted.
ALTER TABLE "planning_documents" ADD COLUMN "staleReason" TEXT;
ALTER TABLE "planning_documents" ADD COLUMN "staleSince" TIMESTAMP(3);
