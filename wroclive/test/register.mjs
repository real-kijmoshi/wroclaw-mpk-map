/** Installs `loader.mjs` for the test run. Loaded via `node --import`. */

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
