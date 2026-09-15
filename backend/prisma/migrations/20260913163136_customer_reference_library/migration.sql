-- AlterTable
ALTER TABLE "audit_events" ALTER COLUMN "projectId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[],
    "logoStorageKey" TEXT,
    "logoFileName" TEXT,
    "logoMimeType" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_checklists" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "parseNote" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "section" TEXT,
    "code" TEXT,
    "text" TEXT NOT NULL,
    "guidance" TEXT,
    "expected" TEXT,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_templates" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "placeholders" JSONB NOT NULL,
    "parseNote" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_key_key" ON "customers"("key");

-- CreateIndex
CREATE INDEX "customer_checklists_customerId_active_idx" ON "customer_checklists"("customerId", "active");

-- CreateIndex
CREATE INDEX "checklist_items_checklistId_order_idx" ON "checklist_items"("checklistId", "order");

-- CreateIndex
CREATE INDEX "customer_templates_customerId_active_idx" ON "customer_templates"("customerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "customer_templates_customerId_documentType_version_key" ON "customer_templates"("customerId", "documentType", "version");

-- AddForeignKey
ALTER TABLE "customer_checklists" ADD CONSTRAINT "customer_checklists_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "customer_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_templates" ADD CONSTRAINT "customer_templates_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
