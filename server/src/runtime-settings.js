'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The handful of settings the admin dashboard may change while the server is
 * running, persisted so a restart does not silently undo them.
 *
 * This repository treats the environment as the source of truth, and that is
 * still the rule — the exception is deliberately narrow. A model that times
 * out (see `/health` -> `alerts.aiIncidents.lastError`) is something you want
 * to change and see the effect of in seconds, not something worth a redeploy
 * and a 30–60 s GTFS boot to try. So exactly one key is overridable, it is
 * written where the operator can read and delete it, and it announces itself:
 * an override that differs from the environment is printed at boot and shown
 * in `/health`, because a setting that quietly disagrees with `.env` is the
 * failure mode this project keeps re-learning (invariant 1).
 *
 * Deliberately not generic. A key/value store here would grow into a second,
 * undocumented configuration system living next to `config.js`.
 */

const MODEL_MAX_LENGTH = 120;

/**
 * A model id: `nvidia/nemotron-3.5-lightning:free`, `openai/gpt-4o-mini`,
 * `qwen3:8b`.
 *
 * Word-ish segments joined by single `/` or `:` separators, each of which must
 * be followed by something. Simply allowing those characters anywhere — the
 * first version of this — also accepts `https://evil.example.com/v1`, because
 * a URL is nothing but those same characters. Requiring a non-separator after
 * every separator makes `://` unmatchable, so a scheme cannot get through.
 *
 * This is defence in depth rather than the boundary itself: the base URL is
 * not settable over the API at all, so a URL-shaped model would only have been
 * posted to the configured provider and rejected. It is still not a model id.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][\w.-]*(?:[/:][\w.-]+)*$/;

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
const validateModel = (value) => {
  if (typeof value !== 'string') return { ok: false, error: 'model must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'model must not be empty' };
  if (trimmed.length > MODEL_MAX_LENGTH) {
    return { ok: false, error: `model must be at most ${MODEL_MAX_LENGTH} characters` };
  }
  if (!MODEL_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: 'model may only contain letters, digits and . _ - separated by / or :',
    };
  }
  return { ok: true, value: trimmed };
};

class RuntimeSettings {
  /**
   * @param {{ cacheDir: string, logger?: { info: Function, warn: Function } }} options
   */
  constructor({ cacheDir, logger = null }) {
    this.file = path.join(cacheDir, 'runtime-settings.json');
    this.logger = logger;
    /** @type {{ aiModel: string|null }} */
    this.values = { aiModel: null };
  }

  /** Read the file if there is one. A missing or corrupt file is not an error. */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this.values;
    }

    try {
      const parsed = JSON.parse(raw);
      const model = validateModel(parsed?.aiModel);
      // A hand-edited file that fails validation is dropped rather than
      // trusted: it reaches the provider as a model name.
      this.values.aiModel = model.ok ? model.value : null;
      if (!model.ok && parsed?.aiModel != null) {
        this.logger?.warn(`Ignoring invalid aiModel in ${this.file}: ${model.error}`);
      }
    } catch {
      this.logger?.warn(`Ignoring unreadable ${this.file}`);
    }

    return this.values;
  }

  /**
   * @param {string|null} model  null clears the override and returns to env
   * @returns {{ ok: boolean, error?: string }}
   */
  setAiModel(model) {
    if (model === null) {
      this.values.aiModel = null;
      return this.#persist();
    }

    const checked = validateModel(model);
    if (!checked.ok) return checked;
    this.values.aiModel = checked.value;
    return this.#persist();
  }

  /** Written via a temp file and renamed, so a crash cannot leave a half file. */
  #persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
      fs.renameSync(tmp, this.file);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `could not save: ${error.message}` };
    }
  }
}

module.exports = { RuntimeSettings, validateModel };
