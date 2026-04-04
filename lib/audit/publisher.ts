// Stub — real implementation fetched during heroku-postbuild

export interface AuditEventPayload {
  type?: string;
  eventType?: string;
  action?: string;
  source?: string;
  severity?: string;
  actor?: { id: string | null; email?: string | null; name?: string | null; type?: string; [key: string]: unknown };
  target?: { id: string | null; type: string; name?: string | null };
  resource?: { type?: string; id?: string | null; name?: string | null };
  agency?: { id: string | null; slug?: string | null };
  context?: Record<string, unknown>;
  agency_id?: string | null;
  timestamp?: Date | string;
  [key: string]: unknown;
}

export interface NotificationEvent {
  type: string;
  action: string;
  [key: string]: unknown;
}

export function publishAuditEvent(_event: AuditEventPayload): Promise<void> { return Promise.resolve(); }
export function publishLegacyEvent(_event: Record<string, unknown>): Promise<void> { return Promise.resolve(); }
export function flushAll(): Promise<void> { return Promise.resolve(); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setNotificationHook(_hook: (...args: any[]) => any): void {}
