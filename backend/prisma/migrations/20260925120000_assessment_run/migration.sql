-- One immutable snapshot per Planning Assessment run. See the model comment in schema.prisma.
CREATE TABLE "assessment_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "fptScore" INTEGER NOT NULL DEFAULT 0,
    "unknowns" INTEGER NOT NULL DEFAULT 0,
    "blockers" INTEGER NOT NULL DEFAULT 0,
    "aiProvider" TEXT NOT NULL DEFAULT 'mock',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_runs_pkey" PRIMARY KEY ("id")
);

-- Every read is "the newest run for this project".
CREATE INDEX "assessment_runs_projectId_createdAt_idx" ON "assessment_runs"("projectId", "createdAt");

ALTER TABLE "assessment_runs" ADD CONSTRAINT "assessment_runs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
