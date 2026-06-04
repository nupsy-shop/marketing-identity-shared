export interface ReferenceCounts {
  roleMappings: number;
  governanceAssignments: number;
  total: number;
  blocked: boolean;
}

export interface ReferenceSummary {
  summary: string;
  reason: string | null;
}

interface CountArgs {
  prisma: { idp_role_mappings: { count: (args: unknown) => Promise<number> } };
  db: { countActiveRoleTemplateReferences: (key: string) => Promise<number> };
  agencyId: string;
  templateId: string;
  templateKey: string;
}

export async function countTemplateReferences(args: CountArgs): Promise<ReferenceCounts> {
  const { prisma, db, agencyId, templateId, templateKey } = args;
  const roleMappings = await prisma.idp_role_mappings.count({
    where: { agency_id: agencyId, role_template_id: templateId },
  });
  const governanceAssignments = await db.countActiveRoleTemplateReferences(templateKey);
  const total = roleMappings + governanceAssignments;
  return { roleMappings, governanceAssignments, total, blocked: total > 0 };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function summarizeReferences(c: ReferenceCounts): ReferenceSummary {
  if (!c.blocked) return { summary: '', reason: null };
  const parts: string[] = [];
  if (c.roleMappings > 0) parts.push(plural(c.roleMappings, 'role mapping'));
  if (c.governanceAssignments > 0) parts.push(plural(c.governanceAssignments, 'governance assignment'));
  const summary = parts.join(' and ');
  const them = c.total === 1 ? 'it' : 'them';
  return { summary, reason: `In use by ${summary} — remove ${them} first` };
}
