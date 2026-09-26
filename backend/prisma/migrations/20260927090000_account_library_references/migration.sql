-- Account libraries: a template's own outline (followed when it has too few blanks to fill), and
-- the Approved Examples / Lessons Learned documents each library can hold.

ALTER TABLE "customer_templates" ADD COLUMN "outline" JSONB;

CREATE TYPE "CustomerReferenceKind" AS ENUM ('APPROVED_EXAMPLE', 'LESSON_LEARNED');

CREATE TABLE "customer_references" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "CustomerReferenceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "extraction" JSONB,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_references_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_references_customerId_kind_idx" ON "customer_references"("customerId", "kind");

ALTER TABLE "customer_references" ADD CONSTRAINT "customer_references_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
