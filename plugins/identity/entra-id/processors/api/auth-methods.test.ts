/**
 * Tests for auth-methods.ts — strong-method classification, chunkBatch,
 * buildBatchRequest, and parseBatchResponse.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMethods,
  STRONG_METHOD_TYPES,
  chunkBatch,
  buildBatchRequest,
  parseBatchResponse,
} from './auth-methods.js';

// ---------------------------------------------------------------------------
// classifyMethods — 13-case strong/weak truth table
// ---------------------------------------------------------------------------

describe('classifyMethods', () => {
  it('returns enrolled=true when any strong method is present', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' }];
    expect(classifyMethods(methods)).toEqual({
      enrolled: true,
      methods: ['#microsoft.graph.microsoftAuthenticatorAuthenticationMethod'],
    });
  });

  it('returns enrolled=true for fido2', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('returns enrolled=true for windows hello for business', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.windowsHelloForBusinessAuthenticationMethod' }];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('returns enrolled=true for software OATH', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.softwareOathAuthenticationMethod' }];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('returns enrolled=true for temporary access pass', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.temporaryAccessPassAuthenticationMethod' }];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('returns enrolled=true for mobile phone auth method', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.phoneAuthenticationMethod', phoneType: 'mobile' }];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('returns enrolled=true for alternateMobile phone auth method', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.phoneAuthenticationMethod', phoneType: 'alternateMobile' }];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('returns enrolled=false when only password is present', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' }];
    expect(classifyMethods(methods)).toEqual({
      enrolled: false,
      methods: ['#microsoft.graph.passwordAuthenticationMethod'],
    });
  });

  it('returns enrolled=false when only email is present', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.emailAuthenticationMethod' }];
    expect(classifyMethods(methods).enrolled).toBe(false);
  });

  it('returns enrolled=false for empty methods list', () => {
    expect(classifyMethods([])).toEqual({ enrolled: false, methods: [] });
  });

  it('returns enrolled=true when strong + weak methods coexist', () => {
    const methods = [
      { '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' },
      { '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' },
    ];
    expect(classifyMethods(methods).enrolled).toBe(true);
  });

  it('does NOT treat phoneAuthenticationMethod with phoneType="office" as strong', () => {
    const methods = [{ '@odata.type': '#microsoft.graph.phoneAuthenticationMethod', phoneType: 'office' }];
    expect(classifyMethods(methods).enrolled).toBe(false);
  });

  it('exports the full STRONG_METHOD_TYPES list for documentation', () => {
    expect(STRONG_METHOD_TYPES).toContain('#microsoft.graph.microsoftAuthenticatorAuthenticationMethod');
    expect(STRONG_METHOD_TYPES).toContain('#microsoft.graph.fido2AuthenticationMethod');
    expect(STRONG_METHOD_TYPES).toContain('#microsoft.graph.windowsHelloForBusinessAuthenticationMethod');
    expect(STRONG_METHOD_TYPES).toContain('#microsoft.graph.softwareOathAuthenticationMethod');
    expect(STRONG_METHOD_TYPES).toContain('#microsoft.graph.temporaryAccessPassAuthenticationMethod');
  });
});

// ---------------------------------------------------------------------------
// chunkBatch — boundary cases
// ---------------------------------------------------------------------------

describe('chunkBatch', () => {
  it('returns empty array for empty input', () => {
    expect(chunkBatch([], 20)).toEqual([]);
  });

  it('returns a single chunk for input shorter than chunk size', () => {
    expect(chunkBatch([1, 2, 3], 20)).toEqual([[1, 2, 3]]);
  });

  it('returns a single chunk of exactly the chunk size', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    expect(chunkBatch(input, 20)).toEqual([input]);
  });

  it('splits at boundary when input is one larger than chunk size', () => {
    const input = Array.from({ length: 21 }, (_, i) => i);
    const result = chunkBatch(input, 20);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(20);
    expect(result[1]).toEqual([20]);
  });

  it('splits 40 items into two chunks of 20', () => {
    const input = Array.from({ length: 40 }, (_, i) => i);
    const result = chunkBatch(input, 20);
    expect(result.length).toBe(2);
    expect(result.every((c) => c.length === 20)).toBe(true);
  });

  it('throws when chunk size <= 0', () => {
    expect(() => chunkBatch([1, 2, 3], 0)).toThrow();
    expect(() => chunkBatch([1, 2, 3], -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildBatchRequest
// ---------------------------------------------------------------------------

describe('buildBatchRequest', () => {
  it('produces a Graph $batch payload with GET requests', () => {
    const userIds = ['u1', 'u2'];
    const req = buildBatchRequest(userIds);
    expect(req).toEqual({
      requests: [
        { id: 'u1', method: 'GET', url: '/users/u1/authentication/methods' },
        { id: 'u2', method: 'GET', url: '/users/u2/authentication/methods' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// parseBatchResponse
// ---------------------------------------------------------------------------

describe('parseBatchResponse', () => {
  it('returns enrolled=true for a 200 response with a strong method', () => {
    const resp = {
      responses: [
        {
          id: 'u1',
          status: 200,
          body: {
            value: [{ '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }],
          },
        },
      ],
    };
    const result = parseBatchResponse(resp);
    expect(result.classifications.get('u1')).toEqual({
      enrolled: true,
      methods: ['#microsoft.graph.fido2AuthenticationMethod'],
    });
    expect(result.consentMissingFor).toEqual([]);
    expect(result.throttledFor).toEqual([]);
  });

  it('records consentMissing for 403 responses', () => {
    const resp = {
      responses: [
        { id: 'u1', status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
        { id: 'u2', status: 200, body: { value: [] } },
      ],
    };
    const result = parseBatchResponse(resp);
    expect(result.classifications.get('u1')).toBeUndefined();
    expect(result.consentMissingFor).toEqual(['u1']);
    expect(result.classifications.get('u2')).toEqual({ enrolled: false, methods: [] });
  });

  it('records throttled users for 429 responses', () => {
    const resp = {
      responses: [
        { id: 'u1', status: 429, headers: { 'Retry-After': '5' }, body: {} },
      ],
    };
    const result = parseBatchResponse(resp);
    expect(result.throttledFor).toEqual(['u1']);
    expect(result.classifications.get('u1')).toBeUndefined();
  });

  it('ignores other non-200 statuses (logged at caller level)', () => {
    const resp = {
      responses: [
        { id: 'u1', status: 500, body: {} },
        { id: 'u2', status: 200, body: { value: [] } },
      ],
    };
    const result = parseBatchResponse(resp);
    expect(result.classifications.size).toBe(1);
    expect(result.classifications.get('u2')).toEqual({ enrolled: false, methods: [] });
    expect(result.errorFor).toEqual([{ userId: 'u1', status: 500 }]);
  });
});
