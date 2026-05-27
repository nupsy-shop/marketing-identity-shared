import { describe, test, expect } from 'vitest';
import { applyMask } from './masking.js';
import type { MaskingSettings, MaskedEvent } from './masking.js';

const baseSettings: MaskingSettings = {
  piiMode: 'exports',
  stripBodiesOnFailure: true,
  anonymizeAuditor: true,
};

const event = (over: Partial<MaskedEvent> = {}): MaskedEvent => ({
  eventId: 'e1',
  timestamp: '2026-05-26T00:00:00Z',
  eventType: 'admin.client.created',
  severity: 'info',
  source: 'accesshive',
  actor: { id: 'u1', email: 'alice@example.com', name: 'Alice Cooper', ip: '203.0.113.42', type: 'user' },
  agency: { id: 'ag1' },
  resource: { type: 'client', id: 'c1', name: 'Acme Corp' },
  context: { freeText: 'Sent invite to bob@example.com from 198.51.100.7' },
  ...over,
});

describe('applyMask', () => {
  test('piiMode=off, viewer: returns raw events untouched', () => {
    const settings = { ...baseSettings, piiMode: 'off' as const };
    const [masked] = applyMask([event()], settings, 'viewer', 'salt-A');
    expect(masked.actor.email).toBe('alice@example.com');
    expect(masked.actor.name).toBe('Alice Cooper');
    expect(masked.actor.ip).toBe('203.0.113.42');
  });

  test('piiMode=off, auditor: still anonymizes auditor name when anonymizeAuditor=true', () => {
    const [masked] = applyMask([event()], baseSettings, 'auditor', 'salt-A');
    expect(masked.actor.name).not.toBe('Alice Cooper');
    expect(masked.actor.name).toMatch(/^[0-9a-f]{16}$/);
  });

  test('piiMode=exports, viewer: PII passes through unchanged', () => {
    const [masked] = applyMask([event()], baseSettings, 'viewer', 'salt-A');
    expect(masked.actor.email).toBe('alice@example.com');
    expect(masked.actor.ip).toBe('203.0.113.42');
  });

  test('piiMode=exports, export: emails+ips+names redacted', () => {
    const [masked] = applyMask([event()], baseSettings, 'export', 'salt-A');
    expect(masked.actor.email).toBe('[redacted-email]');
    expect(masked.actor.ip).toBe('[redacted-ip]');
    expect(masked.actor.name).toBe('[redacted]');
  });

  test('piiMode=all, viewer: emails+ips+names redacted', () => {
    const settings = { ...baseSettings, piiMode: 'all' as const };
    const [masked] = applyMask([event()], settings, 'viewer', 'salt-A');
    expect(masked.actor.email).toBe('[redacted-email]');
    expect(masked.actor.ip).toBe('[redacted-ip]');
    expect(masked.actor.name).toBe('[redacted]');
  });

  test('resource.name redacted only when resource.type === "user"', () => {
    const settings = { ...baseSettings, piiMode: 'all' as const };
    const [client] = applyMask([event({ resource: { type: 'client', id: 'c1', name: 'Acme Corp' } })], settings, 'viewer', 'salt-A');
    expect(client.resource?.name).toBe('Acme Corp');

    const [user] = applyMask([event({ resource: { type: 'user', id: 'u9', name: 'Charlie' } })], settings, 'viewer', 'salt-A');
    expect(user.resource?.name).toBe('[redacted]');
  });

  test('free-text email + IP inside context get regex-redacted', () => {
    const settings = { ...baseSettings, piiMode: 'all' as const };
    const [masked] = applyMask([event()], settings, 'viewer', 'salt-A');
    const ctx = masked.context as { freeText: string };
    expect(ctx.freeText).toMatch(/\[redacted-email\]/);
    expect(ctx.freeText).toMatch(/\[redacted-ip\]/);
  });

  test('anonymizeAuditor=false: auditor sees real actor.name', () => {
    const settings = { ...baseSettings, anonymizeAuditor: false, piiMode: 'off' as const };
    const [masked] = applyMask([event()], settings, 'auditor', 'salt-A');
    expect(masked.actor.name).toBe('Alice Cooper');
  });

  test('same actor.id + salt → same hash; different salt → different hash', () => {
    const [aSalt1] = applyMask([event()], baseSettings, 'auditor', 'salt-A');
    const [aSalt2] = applyMask([event()], baseSettings, 'auditor', 'salt-B');
    expect(aSalt1.actor.name).not.toBe(aSalt2.actor.name);
  });

  test('empty events array returns empty array', () => {
    expect(applyMask([], baseSettings, 'viewer', 'salt-A')).toEqual([]);
  });
});
