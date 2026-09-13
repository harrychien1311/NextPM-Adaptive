-- Drops the Portfolio level (Program is now the top of the hierarchy) and reworks roles into
-- three non-overlapping account roles plus a separate per-project membership role.

-- ---------------------------------------------------------------- project membership role
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'MEMBER', 'VIEWER');

ALTER TABLE "project_members" ADD COLUMN "projectRole" "ProjectRole" NOT NULL DEFAULT 'MEMBER';

UPDATE "project_members"
SET "projectRole" = CASE
  WHEN "role" IN ('ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER') THEN 'OWNER'::"ProjectRole"
  WHEN "role" = 'VIEWER' THEN 'VIEWER'::"ProjectRole"
  ELSE 'MEMBER'::"ProjectRole"
END;

ALTER TABLE "project_members" DROP COLUMN "role";
ALTER TABLE "project_members" RENAME COLUMN "projectRole" TO "role";

-- ---------------------------------------------------------------- account role
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;

CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'PROGRAM_OWNER', 'PROJECT_OWNER');

ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING (
  CASE
    WHEN "role" = 'ADMIN' THEN 'ADMIN'
    WHEN "role" = 'PORTFOLIO_MANAGER' THEN 'PROGRAM_OWNER'
    ELSE 'PROJECT_OWNER'
  END
)::"Role_new";

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'PROJECT_OWNER';

-- ---------------------------------------------------------------- explicit project owner
ALTER TABLE "projects" ADD COLUMN "ownerId" TEXT;

UPDATE "projects" p
SET "ownerId" = (
  SELECT m."userId"
  FROM "project_members" m
  WHERE m."projectId" = p."id"
  ORDER BY (m."role" = 'OWNER') DESC, m."createdAt" ASC
  LIMIT 1
);

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "projects_ownerId_idx" ON "projects"("ownerId");

-- ---------------------------------------------------------------- drop the portfolio level
ALTER TABLE "programs" DROP CONSTRAINT "programs_portfolioId_fkey";
ALTER TABLE "projects" DROP CONSTRAINT "projects_portfolioId_fkey";

DROP INDEX "programs_portfolioId_key_key";
DROP INDEX "projects_portfolioId_status_idx";

ALTER TABLE "programs" DROP COLUMN "portfolioId";
ALTER TABLE "projects" DROP COLUMN "portfolioId";

CREATE UNIQUE INDEX "programs_key_key" ON "programs"("key");
CREATE INDEX "projects_status_idx" ON "projects"("status");

DROP TABLE "portfolios";
