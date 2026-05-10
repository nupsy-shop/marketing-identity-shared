/**
 * `assertClientWritable(clientId)` — write-lock helper.
 *
 * Returns a 409 conflict shape when the client has been offboarded.
 * Callers use it as the first guard in every `/api/clients/[clientId]/*`
 * write endpoint (POST/PATCH/PUT/DELETE) — except the offboarding +
 * evidence routes themselves, which must remain reachable so the run
 * can finalise and evidence can be retrieved.
 *
 * Reads `offboarded_at` directly from the DB (server state, never form
 * state). Must be invoked inside `withTenantContext(agencyId, …)` so
 * the read is RLS-scoped to the caller's agency.
 *
 * Shape (when locked):
 *   {
 *     status: 409,
 *     code: 'client_offboarded',
 *     message: 'Client is offboarded; writes are locked',
 *     offboardedAt: ISO string,
 *   }
 *
 * Shape (when writable):
 *   null
 *
 * Web hosts wrap the response into a NextResponse with the status code.
 */

import { getRuntime } from '../runtime.js';

export interface ClientOffboardedConflict {
  status: 409;
  code: 'client_offboarded';
  message: string;
  offboardedAt: string;
}

export async function assertClientWritable(
  clientId: string,
): Promise<ClientOffboardedConflict | null> {
  const { prisma } = getRuntime();
  const client = await prisma.clients.findUnique({
    where: { id: clientId },
    select: { offboarded_at: true },
  });
  if (!client?.offboarded_at) return null;

  return {
    status: 409,
    code: 'client_offboarded',
    message: 'Client is offboarded; writes are locked',
    offboardedAt: new Date(client.offboarded_at).toISOString(),
  };
}
