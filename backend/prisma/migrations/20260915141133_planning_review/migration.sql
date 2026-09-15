-- AlterTable
ALTER TABLE "ai_approach_suggestions" ADD COLUMN     "approachMode" TEXT NOT NULL DEFAULT 'RECOMMENDED',
ADD COLUMN     "findings" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "overview" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "planningGaps" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "preferredApproach" TEXT;
