import { ProjectType } from '@prisma/client';

/**
 * The project types a PM picks from — FPT's own delivery categories.
 *
 * They are not the `ProjectType` enum. That enum (SI / SM / PRODUCT) is the *delivery family*: it
 * decides which input schema, document catalog and assessment wording a project gets, and each of
 * those exists once per family. Six categories do not need six catalogs — a maintenance contract and
 * an AMS contract plan the same documents — so each category names the family it plans with, and
 * the family is set from it whenever the category changes. Moving a category to another family is
 * an edit to this table and nothing else.
 *
 * The category still reaches every model call as an input ("Project type: Automotive (ASPICE)"),
 * because it says things the family cannot: ASPICE means a V-model with process-compliance
 * evidence, BPO means a business service rather than software.
 */
export const PROJECT_CATEGORIES = [
  { value: 'Development', family: ProjectType.SI },
  { value: 'Maintenance', family: ProjectType.SM },
  { value: 'AMS / O&M', family: ProjectType.SM },
  { value: 'IT Managed Services', family: ProjectType.SM },
  { value: 'Business Process Outsourcing', family: ProjectType.SM },
  { value: 'Automotive (ASPICE)', family: ProjectType.SI },
] as const;

export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number]['value'];

export const PROJECT_CATEGORY_VALUES = PROJECT_CATEGORIES.map((entry) => entry.value) as [
  ProjectCategory,
  ...ProjectCategory[],
];

export function familyForCategory(category: ProjectCategory): ProjectType {
  return PROJECT_CATEGORIES.find((entry) => entry.value === category)!.family;
}
