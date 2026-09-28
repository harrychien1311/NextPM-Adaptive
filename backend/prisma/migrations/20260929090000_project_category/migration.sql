-- The project type the PM picks (data/project-categories.ts); `type` stays the delivery family.
ALTER TABLE "projects" ADD COLUMN "category" TEXT;

-- Existing projects get the category their family plans as today. PRODUCT has no category that maps
-- back to it, so those projects keep a null category and show their earlier type until changed.
UPDATE "projects" SET "category" = 'Development' WHERE "type" = 'SI';
UPDATE "projects" SET "category" = 'AMS / O&M' WHERE "type" = 'SM';
