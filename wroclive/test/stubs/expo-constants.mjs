/**
 * `expo-constants` outside an Expo runtime.
 *
 * `src/lib/config.ts` reads `Constants.expoConfig?.hostUri` to find the Expo
 * CLI's host during development. There is no CLI here, so the answer is "no
 * host" — which is exactly the production path, and the one worth testing.
 */

export default { expoConfig: null };
