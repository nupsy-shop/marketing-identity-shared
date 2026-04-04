// Stub — real implementation fetched during heroku-postbuild

export interface AuditEvent {
  id: string;
  type: string;
  action: string;
  eventType?: string;
  severity?: string;
  source?: string;
  actor?: { id: string; email?: string; name?: string };
  target?: { id: string; type: string; name?: string };
  resource?: { id?: string; type?: string; name?: string };
  context?: Record<string, unknown> & { changeTimestamp?: string };
  agency_id?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface AuditQueryOptions {
  agency_id?: string | null;
  agencyId?: string | null;
  type?: string | null;
  eventType?: string | string[] | null;
  action?: string | null;
  actor_id?: string | null;
  actorEmail?: string | null;
  target_id?: string | null;
  resourceId?: string | null;
  clientId?: string | null;
  from?: string | Date | null;
  to?: string | Date | null;
  dateFrom?: string | Date | null;
  dateTo?: string | Date | null;
  size?: number;
  limit?: number;
  offset?: number;
  severity?: string | null;
  sort?: 'asc' | 'desc';
  search?: string | null;
  [key: string]: unknown;
}

export interface AuditQueryResult {
  data: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventCountsResult {
  byEventType: Array<{ key: string; doc_count: number }>;
  bySeverity: Array<{ key: string; doc_count: number }>;
  bySource: Array<{ key: string; doc_count: number }>;
  total: number;
}

export function queryAuditEvents(_options: AuditQueryOptions): Promise<AuditQueryResult> {
  return Promise.resolve({ data: [], total: 0, limit: 0, offset: 0 });
}

export function getActivityForResource(_resourceId: string, _options?: AuditQueryOptions): Promise<AuditEvent[]> {
  return Promise.resolve([]);
}

export function getActivityForClient(_clientId: string, _options?: AuditQueryOptions): Promise<AuditEvent[]> {
  return Promise.resolve([]);
}

export function getEventCountsByType(_agencyId: string | undefined, _dateFrom?: string, _dateTo?: string): Promise<EventCountsResult> {
  return Promise.resolve({ byEventType: [], bySeverity: [], bySource: [], total: 0 });
}

export function exportAuditEvents(_options: AuditQueryOptions): Promise<AuditQueryResult> {
  return Promise.resolve({ data: [], total: 0, limit: 0, offset: 0 });
}
