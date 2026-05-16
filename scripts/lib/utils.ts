import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Bounded-concurrency parallel map. Runs at most `n` items at once.
 */
export async function pmap<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Parse a JSONL file through a Zod schema. Returns [] if the file doesn't exist.
 * Throws a descriptive error on any malformed line.
 */
export function loadJSONL<T>(filePath: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return schema.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`Bad JSONL in ${filePath} line ${i + 1}: ${(err as Error).message}`);
      }
    });
}
