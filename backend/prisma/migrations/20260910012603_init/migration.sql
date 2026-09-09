-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('SI', 'SM', 'PRODUCT');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'HOLD', 'CLOSED');

-- CreateEnum
CREATE TYPE "ManagementDomain" AS ENUM ('GOVERNANCE', 'SCOPE', 'SCHEDULE', 'FINANCE', 'STAKEHOLDERS', 'RESOURCES', 'RISK');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'TEXTAREA', 'DATE', 'DATE_RANGE', 'SELECT', 'NUMBER');

-- CreateEnum
CREATE TYPE "InputSource" AS ENUM ('PM_INPUT', 'FILE_REFERENCE', 'AI_SUGGESTED');

-- CreateEnum
CREATE TYPE "ReferenceGroup" AS ENUM ('COMMITMENT', 'SCOPE', 'ORGANIZATION', 'SCHEDULE', 'DESCRIPTION');

-- CreateEnum
CREATE TYPE "ReferenceStatus" AS ENUM ('UPLOADED', 'CLASSIFYING', 'VERIFIED', 'WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "Requirement" AS ENUM ('REQUIRED', 'CONDITIONAL');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('NOT_GENERATED', 'GENERATING', 'PM_REVIEW', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('CONFIRMED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "ActionPriority" AS ENUM ('REQUIRED', 'CONDITIONAL', 'INFO');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('TODO', 'REVIEW', 'BLOCKED', 'DONE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('PM', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('USER', 'AGENT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL DEFAULT 'Project Manager',
    "role" "Role" NOT NULL DEFAULT 'PROJECT_MANAGER',
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessUnit" TEXT,
    "strategicObjective" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetOutcome" TEXT,
    "colorKey" TEXT NOT NULL DEFAULT 'blue',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "programId" TEXT,
    "name" TEXT NOT NULL,
    "type" "ProjectType" NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "customer" TEXT,
    "summary" TEXT,
    "phaseLabel" TEXT,
    "targetStart" TIMESTAMP(3),
    "targetEnd" TIMESTAMP(3),
    "targetLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_field_definitions" (
    "id" TEXT NOT NULL,
    "projectType" "ProjectType" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "fieldType" "FieldType" NOT NULL DEFAULT 'TEXT',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT true,
    "domain" "ManagementDomain" NOT NULL DEFAULT 'GOVERNANCE',
    "signalKey" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "input_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_input_values" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "value" TEXT,
    "source" "InputSource" NOT NULL DEFAULT 'PM_INPUT',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "conflictNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_input_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_custom_fields" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT,
    "useIn" TEXT NOT NULL DEFAULT 'BOTH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_files" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "group" "ReferenceGroup" NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "ReferenceStatus" NOT NULL DEFAULT 'UPLOADED',
    "verifiedFields" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "extraction" JSONB,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_approach_suggestions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceFileId" TEXT,
    "recommendedApproach" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "confidenceLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "rationale" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "risks" JSONB NOT NULL DEFAULT '[]',
    "alternatives" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "candidateValues" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_approach_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approach_decisions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "evaluationId" TEXT,
    "approach" TEXT NOT NULL,
    "outcome" "DecisionOutcome" NOT NULL DEFAULT 'CONFIRMED',
    "rigor" TEXT NOT NULL DEFAULT 'Standard+',
    "rationale" TEXT,
    "operatingModel" JSONB,
    "documentPack" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approach_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_definitions" (
    "id" TEXT NOT NULL,
    "projectType" "ProjectType" NOT NULL,
    "domain" "ManagementDomain" NOT NULL,
    "name" TEXT NOT NULL,
    "requirement" "Requirement" NOT NULL DEFAULT 'REQUIRED',
    "conditionKey" TEXT,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "fitScore" INTEGER NOT NULL DEFAULT 80,
    "sections" JSONB NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "templateId" TEXT,
    "name" TEXT NOT NULL,
    "domain" "ManagementDomain" NOT NULL,
    "requirement" "Requirement" NOT NULL DEFAULT 'REQUIRED',
    "status" "DocumentStatus" NOT NULL DEFAULT 'NOT_GENERATED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "coverage" INTEGER NOT NULL DEFAULT 0,
    "sourceTrace" JSONB,
    "structuredData" JSONB,
    "generatedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "pmQuestions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sections" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hint" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT,
    "custom" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "document_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_items" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "priority" "ActionPriority" NOT NULL DEFAULT 'REQUIRED',
    "domain" "ManagementDomain" NOT NULL DEFAULT 'GOVERNANCE',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targetView" TEXT NOT NULL DEFAULT 'input',
    "suggestions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ActionStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedValue" TEXT,
    "blocksDocument" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_tasks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "state" "TaskState" NOT NULL DEFAULT 'TODO',
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "planning_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_readiness" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domain" "ManagementDomain" NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL DEFAULT 80,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_readiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL DEFAULT 'PM',
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_messages" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_layouts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "widgets" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "includeOnly" TEXT NOT NULL DEFAULT 'APPROVED',
    "fileKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "programs_portfolioId_key_key" ON "programs"("portfolioId", "key");

-- CreateIndex
CREATE INDEX "projects_portfolioId_status_idx" ON "projects"("portfolioId", "status");

-- CreateIndex
CREATE INDEX "projects_programId_idx" ON "projects"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "input_field_definitions_projectType_key_key" ON "input_field_definitions"("projectType", "key");

-- CreateIndex
CREATE UNIQUE INDEX "project_input_values_projectId_definitionId_key" ON "project_input_values"("projectId", "definitionId");

-- CreateIndex
CREATE INDEX "reference_files_projectId_group_idx" ON "reference_files"("projectId", "group");

-- CreateIndex
CREATE INDEX "ai_approach_suggestions_projectId_createdAt_idx" ON "ai_approach_suggestions"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "approach_decisions_projectId_active_idx" ON "approach_decisions"("projectId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "document_definitions_projectType_domain_name_key" ON "document_definitions"("projectType", "domain", "name");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_definitionId_key_key" ON "document_templates"("definitionId", "key");

-- CreateIndex
CREATE INDEX "planning_documents_projectId_status_idx" ON "planning_documents"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "planning_documents_projectId_definitionId_key" ON "planning_documents"("projectId", "definitionId");

-- CreateIndex
CREATE INDEX "document_sections_documentId_order_idx" ON "document_sections"("documentId", "order");

-- CreateIndex
CREATE INDEX "action_items_projectId_status_idx" ON "action_items"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "domain_readiness_projectId_domain_key" ON "domain_readiness"("projectId", "domain");

-- CreateIndex
CREATE INDEX "audit_events_projectId_createdAt_idx" ON "audit_events"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_messages_projectId_createdAt_idx" ON "agent_messages"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_layouts_projectId_userId_key" ON "dashboard_layouts"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_input_values" ADD CONSTRAINT "project_input_values_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_input_values" ADD CONSTRAINT "project_input_values_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "input_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_input_values" ADD CONSTRAINT "project_input_values_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_custom_fields" ADD CONSTRAINT "project_custom_fields_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_files" ADD CONSTRAINT "reference_files_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_approach_suggestions" ADD CONSTRAINT "ai_approach_suggestions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_approach_suggestions" ADD CONSTRAINT "ai_approach_suggestions_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "reference_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approach_decisions" ADD CONSTRAINT "approach_decisions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approach_decisions" ADD CONSTRAINT "approach_decisions_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ai_approach_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approach_decisions" ADD CONSTRAINT "approach_decisions_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "document_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_documents" ADD CONSTRAINT "planning_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_documents" ADD CONSTRAINT "planning_documents_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "document_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_documents" ADD CONSTRAINT "planning_documents_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_documents" ADD CONSTRAINT "planning_documents_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "planning_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_readiness" ADD CONSTRAINT "domain_readiness_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

