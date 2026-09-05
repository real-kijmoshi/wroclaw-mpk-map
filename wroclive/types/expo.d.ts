/**
 * The ambient declarations Expo provides, referenced from a file that is
 * actually in the repository.
 *
 * `expo/types` is what declares `*.css` (among other things), and
 * `src/constants/theme.ts` imports `@/global.css` for its side effect. Expo
 * normally pulls those declarations in through `expo-env.d.ts` — but that file
 * is *generated* by `expo start`/`expo prebuild` and is gitignored, so it does
 * not exist on a clean checkout. CI runs `npm ci && lint && typecheck` and
 * never starts Expo, which is why `npm run typecheck` failed there with
 * TS2882 while passing on any machine that had run the app once.
 *
 * `tsconfig.json` still lists `expo-env.d.ts` in `include`, so a generated copy
 * is harmless alongside this one — a duplicate triple-slash reference is a
 * no-op.
 */

/// <reference types="expo/types" />
