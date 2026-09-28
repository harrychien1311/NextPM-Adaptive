import type { ProjectType } from './types';

/**
 * The project types a PM picks from. Mirrors `PROJECT_CATEGORIES` on the server
 * (`backend/src/data/project-categories.ts`), which is the one that decides the delivery family —
 * `family` here is only used to colour the badge the same way the server will file the project.
 */
export const PROJECT_CATEGORIES: { value: string; badge: string; family: ProjectType; hint: string }[] = [
  { value: 'Development', badge: 'DEV', family: 'SI', hint: 'Build, integrate, test and hand over software' },
  { value: 'Maintenance', badge: 'MNT', family: 'SM', hint: 'Fix and enhance a system already in production' },
  { value: 'AMS / O&M', badge: 'AMS', family: 'SM', hint: 'Run applications and operations under SLA' },
  { value: 'IT Managed Services', badge: 'ITMS', family: 'SM', hint: 'Operate infrastructure and IT services end to end' },
  { value: 'Business Process Outsourcing', badge: 'BPO', family: 'SM', hint: 'Deliver a business process as a service' },
  { value: 'Automotive (ASPICE)', badge: 'ASPICE', family: 'SI', hint: 'Automotive software under ASPICE process control' },
];

/**
 * A project created before categories existed may have none — only a PRODUCT one, since SI and SM
 * were given the category they plan as. It is shown by its earlier type until the PM picks one.
 */
const EARLIER_TYPE_LABEL: Record<ProjectType, string> = {
  SI: 'System Integration',
  SM: 'Service Management',
  PRODUCT: 'Product Development',
};

export function categoryLabel(project: { category: string | null; type: ProjectType }) {
  return project.category ?? EARLIER_TYPE_LABEL[project.type];
}

export function categoryBadge(project: { category: string | null; type: ProjectType }) {
  return PROJECT_CATEGORIES.find((entry) => entry.value === project.category)?.badge ?? (project.type === 'PRODUCT' ? 'P' : project.type);
}
