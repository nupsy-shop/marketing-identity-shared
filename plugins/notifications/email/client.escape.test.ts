// Uses @jest/globals because the parent jest config (jest.config.ts globs
// shared/**/*.test.ts) is the runner that gates shared tests in this repo
// (matching the shared/lib/identity/teardown.test.ts precedent).
import { describe, it, expect } from '@jest/globals';
import { buildEmailHtml, type EmailNotificationMessage } from './client';

function msg(over: Partial<EmailNotificationMessage>): EmailNotificationMessage {
  return {
    title: 'Title',
    body: 'Body',
    severity: 'info',
    eventType: 'partner.invited',
    timestamp: '2026-06-05T00:00:00.000Z',
    ...over,
  };
}

describe('buildEmailHtml — HTML escaping', () => {
  it('escapes script payloads in the title', () => {
    const html = buildEmailHtml(msg({ title: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes <, >, &, " and an <a href> payload in the body', () => {
    const html = buildEmailHtml(msg({ body: 'a < b & c > d " <a href="x">link</a>' }));
    expect(html).not.toContain('<a href="x">link</a>');
    expect(html).toContain('&lt;a href=&quot;x&quot;&gt;link&lt;/a&gt;');
    expect(html).toContain('a &lt; b &amp; c &gt; d');
  });

  it('preserves intended body line breaks as <br> after escaping', () => {
    const html = buildEmailHtml(msg({ body: 'line1\n\nline2' }));
    expect(html).toContain('line1<br><br>line2');
  });

  it('does NOT render a button for a javascript: actionUrl', () => {
    const html = buildEmailHtml(msg({ actionUrl: 'javascript:alert(1)' }));
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('href="javascript');
  });

  it('does NOT render a button for a non-http(s) scheme', () => {
    const html = buildEmailHtml(msg({ actionUrl: 'data:text/html,<script>1</script>' }));
    expect(html).not.toContain('data:text/html');
  });

  it('renders a button for a valid https actionUrl and attribute-escapes it', () => {
    const html = buildEmailHtml(msg({ actionUrl: 'https://app.x/partners/accept/tok-123' }));
    expect(html).toContain('href="https://app.x/partners/accept/tok-123"');
  });

  it('attribute-escapes quotes in an otherwise-valid https actionUrl', () => {
    const html = buildEmailHtml(msg({ actionUrl: 'https://app.x/a"onmouseover="alert(1)' }));
    // The raw quote must not survive unescaped inside the href attribute.
    expect(html).not.toContain('href="https://app.x/a"onmouseover="alert(1)"');
    expect(html).toContain('&quot;onmouseover=&quot;');
  });

  it('escapes the footer eventType and timestamp', () => {
    const html = buildEmailHtml(msg({ eventType: '<b>evt</b>' }));
    expect(html).not.toContain('<b>evt</b>');
    expect(html).toContain('&lt;b&gt;evt&lt;/b&gt;');
  });

  it('escapes an ampersand in the title to &amp;', () => {
    const html = buildEmailHtml(msg({ title: 'Acme & Co' }));
    expect(html).toContain('Acme &amp; Co');
  });
});
