/**
 * Globals the app's modules read that Node does not define.
 *
 * `types: ["node"]` in this directory's tsconfig deliberately keeps React
 * Native's ambient types out (see the comment there), which also takes
 * `__DEV__` with it — and `src/lib/config.ts` reads it to decide whether to
 * look for the Expo CLI's host. Declaring it here keeps the exclusion narrow
 * rather than pulling the whole RN type environment back in.
 *
 * It is genuinely absent at runtime under `node --test`, which is why
 * `config.ts` guards it with `typeof __DEV__ !== 'undefined'` and the tests see
 * the production API URL.
 */

declare const __DEV__: boolean;
