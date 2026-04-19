/**
 * Partner Hub — monthly access review digest builder (#63).
 *
 * `buildAgencyDigest` queries partners + links for one agency and returns
 * a digest payload. Pure read — running it twice in the same calendar
 * month for the same agency is safe (no mutation).
 *
 * Every query filters on `agencyId`; runtime services via getRuntime().
 */

import { getRuntime } from '../runtime.js';

export interface AgencyPartnerDigestPartner {
  partnerId: string;
  name: string;
  externalOrgType: string;
  linkedClientCount: number;
  userCount: number;
  createdAt: Date;
}

export interface AgencyPartnerDigest {
  agencyId: string;
  generatedAt: string;
  activePartners: number;
  archivedPartners: number;
  totalLinks: number;
  partners: AgencyPartnerDigestPartner[];
}

export async function buildAgencyDigest(agencyId: string): Promise<AgencyPartnerDigest> {
  const { prisma } = getRuntime();

  const partners = await prisma.partners.findMany({
    where: { agency_id: agencyId, archived_at: null },
    orderBy: { created_at: 'desc' },
    include: {
      _count: { select: { partner_client_links: true, directory_users: true } },
    },
  });

  const archivedCount = await prisma.partners.count({
    where: { agency_id: agencyId, archived_at: { not: null } },
  });

  const totalLinks = await prisma.partner_client_links.count({
    where: { agency_id: agencyId },
  });

  return {
    agencyId,
    generatedAt: new Date().toISOString(),
    activePartners: partners.length,
    archivedPartners: archivedCount,
    totalLinks,
    partners: partners.map((p: {
      id: string;
      name: string;
      external_org_type: string;
      created_at: Date;
      _count: { partner_client_links: number; directory_users: number };
    }) => ({
      partnerId: p.id,
      name: p.name,
      externalOrgType: p.external_org_type,
      linkedClientCount: p._count.partner_client_links,
      userCount: p._count.directory_users,
      createdAt: p.created_at,
    })),
  };
}
