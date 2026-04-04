// Stub — real implementation fetched during heroku-postbuild

export interface SearchOptions {
  index?: string;
  body?: Record<string, unknown>;
  size?: number;
  from?: number;
  sort?: Record<string, unknown>[];
  [key: string]: unknown;
}

export function search(_options?: SearchOptions, _indices?: string | string[]): Promise<{
  hits: { total: number | { value: number }; hits: Array<{ _source: Record<string, unknown> }> };
}> {
  return Promise.resolve({ hits: { total: { value: 0 }, hits: [] } });
}

export function ensureIndexTemplate(): Promise<void> { return Promise.resolve(); }
export function ensureCurrentIndex(): Promise<void> { return Promise.resolve(); }
export function clusterHealth(): Promise<Record<string, unknown>> { return Promise.resolve({}); }
export function ping(): Promise<boolean> { return Promise.resolve(true); }
export function allIndicesPattern(): string { return 'audit-*'; }
export function indexNameForDate(_date?: Date): string { return 'audit-' + new Date().toISOString().slice(0, 10); }
