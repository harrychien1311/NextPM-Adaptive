-- The PM's own verdict on a Planning Assessment rule. See the model comment in schema.prisma.
CREATE TABLE "assessment_overrides" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "met" BOOLEAN NOT NULL,
    "byId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assessment_overrides_projectId_ruleId_key" ON "assessment_overrides"("projectId", "ruleId");

ALTER TABLE "assessment_overrides" ADD CONSTRAINT "assessment_overrides_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
