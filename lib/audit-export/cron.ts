/**
 * Cron expression validation + next-run computation for scheduled exports.
 *
 * Shared between web (POST /api/agency/audit/exports validates cron at
 * create-time) and the worker (processor updates `next_run_at` after each
 * run). Tries `cron-parser` first; falls back to a permissive shape check
 * when the optional dep is absent.
 */

interface CronParseResult {
  ok: boolean;
  nextRun?: Date;
  reason?: string;
}

const CRON_REGEX = /^(\S+\s+){4}\S+$/;

type CronParserModule = {
  parseExpression: (expr: string, opts?: { utc?: boolean; currentDate?: Date }) => {
    next: () => { toDate: () => Date };
  };
};

let cronParserModule: CronParserModule | null = null;
let cronParserLoaded = false;

function loadCronParser(): CronParserModule | null {
  if (cronParserLoaded) return cronParserModule;
  cronParserLoaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const req = eval('require') as (id: string) => unknown;
    cronParserModule = req('cron-parser') as CronParserModule;
  } catch {
    cronParserModule = null;
  }
  return cronParserModule;
}

export function parseCron(expr: string, from?: Date): CronParseResult {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { ok: false, reason: 'cron expression is required' };
  }
  const mod = loadCronParser();
  if (mod) {
    try {
      const opts: { utc?: boolean; currentDate?: Date } = { utc: true };
      if (from) opts.currentDate = from;
      const interval = mod.parseExpression(expr, opts);
      return { ok: true, nextRun: interval.next().toDate() };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'invalid cron expression' };
    }
  }
  if (!CRON_REGEX.test(expr.trim())) {
    return { ok: false, reason: 'cron expression must have 5 whitespace-separated fields' };
  }
  return { ok: true };
}
