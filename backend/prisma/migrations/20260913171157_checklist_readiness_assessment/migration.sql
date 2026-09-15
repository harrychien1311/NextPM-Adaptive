-- CreateEnum
CREATE TYPE "ChecklistStatus" AS ENUM ('MET', 'PARTIAL', 'NOT_MET', 'NOT_APPLICABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AssessmentSource" AS ENUM ('DETERMINISTIC', 'AI', 'PM');

-- CreateTable
CREATE TABLE "project_checklist_assessments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "runState" TEXT NOT NULL DEFAULT 'IDLE',
    "lastError" TEXT,
    "aiProvider" TEXT NOT NULL DEFAULT 'none',
    "assessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_checklist_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_assessment_items" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "checklistItemId" TEXT NOT NULL,
    "status" "ChecklistStatus" NOT NULL DEFAULT 'UNKNOWN',
    "source" "AssessmentSource" NOT NULL DEFAULT 'DETERMINISTIC',
    "evidence" TEXT,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_assessment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_checklist_assessments_projectId_idx" ON "project_checklist_assessments"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_checklist_assessments_projectId_checklistId_key" ON "project_checklist_assessments"("projectId", "checklistId");

-- CreateIndex
CREATE INDEX "checklist_assessment_items_assessmentId_status_idx" ON "checklist_assessment_items"("assessmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_assessment_items_assessmentId_checklistItemId_key" ON "checklist_assessment_items"("assessmentId", "checklistItemId");

-- AddForeignKey
ALTER TABLE "project_checklist_assessments" ADD CONSTRAINT "project_checklist_assessments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_checklist_assessments" ADD CONSTRAINT "project_checklist_assessments_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "customer_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_assessment_items" ADD CONSTRAINT "checklist_assessment_items_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "project_checklist_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_assessment_items" ADD CONSTRAINT "checklist_assessment_items_checklistItemId_fkey" FOREIGN KEY ("checklistItemId") REFERENCES "checklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
