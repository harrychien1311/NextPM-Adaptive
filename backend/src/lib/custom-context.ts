import { prisma } from './prisma';

/**
 * The inputs every model call needs beyond the form's own fields: the project type the PM picked,
 * and the PM's custom context (Project Input → Custom context).
 *
 * Every call that reads the project's inputs reads these too: the planning analysis, the Planning
 * Assessment, the customer checklist, document drafting and the chat agent.
 *
 * - **Project type** is the category ("Automotive (ASPICE)", "Business Process Outsourcing"), not
 *   the delivery family the catalog keys on. The family is SI / SM / PRODUCT; the category is what
 *   tells the model a project is ASPICE-governed or a business service rather than software.
 * - **Custom context** is a fact the PM wrote themselves — "Release blackout: no deploys in
 *   December" — so it goes in beside the verified inputs like any answer they typed. There is no
 *   per-field routing; an earlier "Use in" setting claimed to send a field to rules or documents
 *   only, but nothing ever read it — nor the fields themselves — so it was removed. A field without
 *   a value says nothing yet and is left out, and each label is marked as custom context so a name
 *   the PM chose cannot pass for one of the standard form fields.
 */
export async function pmContextInputs(projectId: string): Promise<{ label: string; value: string }[]> {
  const [project, fields] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { category: true } }),
    prisma.projectCustomField.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return [
    ...(project?.category ? [{ label: 'Project type', value: project.category }] : []),
    ...fields
      .filter((field) => field.name.trim() && field.value?.trim())
      .map((field) => ({ label: `${field.name.trim()} (custom context)`, value: field.value!.trim() })),
  ];
}
