export const timingAnnotation = 'harness-timing-v1';
export const timingFields = ['build_ms', 'database_ms', 'startup_ms', 'journey_ms', 'cleanup_ms', 'build_commands'] as const;
export type HarnessTiming = Record<typeof timingFields[number], number>;
export const emptyTiming = (): HarnessTiming => ({ build_ms: 0, database_ms: 0, startup_ms: 0, journey_ms: 0, cleanup_ms: 0, build_commands: 0 });

export async function measure<T>(timing: HarnessTiming, field: Exclude<keyof HarnessTiming, 'build_commands'>, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await operation(); }
  finally { timing[field] += Math.round(performance.now() - start); }
}

// Never forward arbitrary annotations or worker output to the privacy reporter.
export function parseTiming(description: string | undefined): HarnessTiming | null {
  if (typeof description !== 'string' || description.length > 512) return null;
  let value: unknown;
  try { value = JSON.parse(description); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== timingFields.length || timingFields.some((key) => !Object.hasOwn(record, key))) return null;
  if (timingFields.some((key) => typeof record[key] !== 'number' || !Number.isSafeInteger(record[key]) || Number(record[key]) < 0 || Number(record[key]) > 86_400_000)) return null;
  return record as HarnessTiming;
}
