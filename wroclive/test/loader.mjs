/**
 * Just enough module resolution to run `src/lib` under `node --test`.
 *
 * Node 22 strips TypeScript types by itself, so the app's pure modules need no
 * build step and no test framework — the same `node --test` the server uses.
 * What Node does *not* do is Metro's resolution, and three of its habits show
 * up in this code:
 *
 *   1. extensionless relative imports (`./config`), which Node ESM rejects,
 *   2. the `@/` alias from `tsconfig.json`,
 *   3. packages that only exist inside a React Native runtime.
 *
 * Only (3) is a substitution; the first two resolve to the real files, so a
 * test still exercises the module the app ships. Keep the stub list short — a
 * module that needs half of React Native mocked out is telling you the logic
 * worth testing has not been separated from the view yet.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);
const STUBS = new URL('./stubs/', import.meta.url);

/** Packages with no meaning outside the app, answered by `test/stubs/`. */
const STUBBED = new Set(['expo-constants']);

export async function resolve(specifier, context, next) {
  if (STUBBED.has(specifier)) {
    return { url: new URL(`${specifier}.mjs`, STUBS).href, shortCircuit: true };
  }

  if (specifier.startsWith('@/')) {
    return next(new URL(specifier.slice(2), SRC).href, context);
  }

  if (/^\.{1,2}\//.test(specifier) && !path.extname(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL ?? import.meta.url);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }

  return next(specifier, context);
}
