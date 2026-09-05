'use strict';

class AiProviderError extends Error {
  constructor(message, code = 'provider_error', status = null) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    /** HTTP status when the failure was an HTTP one; null otherwise. */
    this.status = status;
  }
}

/** How many models a chain may carry, and how long a failed one is skipped. */
const MAX_MODELS = 5;
const MODEL_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Split `a, b, c` into a model chain, keeping order and dropping repeats.
 *
 * One model is the ordinary case and stays a one-entry chain, so nothing about
 * the single-model path changes.
 */
const parseModelList = (value) => [...new Set(
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
)].slice(0, MAX_MODELS);

/**
 * Is this failure worth handing to the next model in the chain?
 *
 * Anything about *this* model — a free tier's 429, a 404 "no endpoints found
 * that support JSON mode", a timeout, a model that cannot hold to JSON — is.
 * Anything about the account is not: 401/403 are the same answer for every
 * model behind one key, and walking the chain would turn one rejection into
 * five, all of them logged as if the models were at fault.
 */
const shouldTryNextModel = (error) => {
  if (!(error instanceof AiProviderError)) return false;
  if (error.code === 'disabled') return false;
  if (error.status === 401 || error.status === 403) return false;
  return ['timeout', 'http_error', 'invalid_response', 'invalid_json', 'provider_error']
    .includes(error.code);
};

const COORDINATE_KEYS = new Set([
  'coordinate',
  'coordinates',
  'lat',
  'latitude',
  'lng',
  'lon',
  'longitude',
]);

const hasCoordinateField = (value) => {
  if (Array.isArray(value)) return value.some(hasCoordinateField);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => COORDINATE_KEYS.has(key.toLowerCase()) || hasCoordinateField(child),
  );
};

/** Parse a strict JSON object, accepting an otherwise bare fenced JSON block. */
const parseJsonObject = (text) => {
  if (typeof text !== 'string') {
    throw new AiProviderError('AI provider returned non-text content', 'invalid_json');
  }

  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new AiProviderError('AI provider returned invalid JSON', 'invalid_json');
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new AiProviderError('AI provider JSON must be an object', 'invalid_json');
  }
  if (hasCoordinateField(parsed)) {
    throw new AiProviderError(
      'AI provider JSON must use location names or stop hints, not coordinates',
      'invalid_json',
    );
  }
  return parsed;
};

const stripTrailingSlash = (value) => String(value).replace(/\/+$/, '');

/** Strip control characters and cap length; used on anything upstream sends. */
const oneLine = (value, limit) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E -￿]/g, '')
    .trim()
    .slice(0, limit);

const safeStatus = (response) => {
  const status = Number.isInteger(response?.status) ? response.status : 'unknown';
  const text = oneLine(response?.statusText, 80);
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
};

/**
 * The reason the provider actually gave, not just the status line.
 *
 * A hosted provider puts the useful part in the response body — "No endpoints
 * found that support JSON mode", "Insufficient credits", "User not found" —
 * while the status alone is an undifferentiated 404 or 401. Reporting only
 * the code sent an operator hunting through config for a problem the response
 * had already named, so `/health` gets the message too.
 *
 * The body is upstream text, so it is capped and stripped the same way every
 * other foreign string in this project is. Nothing here echoes the request,
 * so the key cannot come back out this way.
 *
 * @param {Response} response  an already-failed response, body unread
 * @returns {Promise<string>}
 */
const describeFailure = async (response) => {
  const status = safeStatus(response);

  let body = '';
  try {
    body = await response.text();
  } catch {
    return status;
  }

  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? '';
    if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = body;
  }

  const message = oneLine(detail, 200);
  return message ? `${status} — ${message}` : status;
};

const parseHostedEnvelope = async (response) => {
  const text = await response.text();
  const trimmed = text.trim();
  const contentType = String(response.headers?.get?.('content-type') || 'unknown')
    .split(';', 1)[0]
    .slice(0, 80);

  // A hosted OpenAI-compatible endpoint should honour stream:false. Some
  // gateways still answer with SSE (including keep-alive comments), so consume
  // that response without retrying and paying for a duplicate generation.
  if (trimmed.startsWith('data:') || trimmed.startsWith(':')) {
    let content = '';
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new AiProviderError('AI provider returned invalid event JSON', 'invalid_response');
      }
      if (chunk?.error) {
        throw new AiProviderError('AI provider generation failed', 'provider_error');
      }
      content += chunk?.choices?.[0]?.delta?.content
        ?? chunk?.choices?.[0]?.message?.content
        ?? '';
    }
    return { choices: [{ message: { content } }] };
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const shape = !trimmed ? 'empty body' : trimmed.startsWith('<') ? 'HTML body' : 'non-JSON body';
    throw new AiProviderError(
      `AI provider returned ${shape} (${contentType}, ${Buffer.byteLength(text)} bytes)`,
      'invalid_response',
    );
  }
};

const disabledProvider = (reason) => ({
  enabled: false,
  name: 'off',
  status: { enabled: false, provider: 'off', reason },
  async completeJson() {
    throw new AiProviderError(reason, 'disabled');
  },
});

const validateConfig = (config) => {
  if (!config?.enabled) return { error: config?.status?.reason || 'AI alerts are disabled' };

  if (config.provider === 'openrouter') {
    if (!config.openrouter?.apiKey) return { error: 'OPENROUTER_API_KEY is required' };
    if (!config.openrouter?.model) return { error: 'OPENROUTER_MODEL is required' };
    return { settings: config.openrouter };
  }
  if (config.provider === 'cmdc') {
    if (!config.cmdc?.apiKey) return { error: 'CMD_API_KEY is required' };
    if (!config.cmdc?.model) return { error: 'CMDC_MODEL is required' };
    return { settings: config.cmdc };
  }
  if (config.provider === 'ollama') {
    if (!config.ollama?.model) return { error: 'OLLAMA_MODEL is required' };
    return { settings: config.ollama };
  }
  return { error: `Unsupported AI alerts provider: ${config.provider || '(empty)'}` };
};

const createAiProvider = (config, logger = null) => {
  const validation = validateConfig(config);
  if (validation.error) {
    if (config?.enabled) logger?.warn?.(`AI alerts disabled: ${validation.error}`);
    return disabledProvider(validation.error);
  }

  const { settings } = validation;
  const providerName = config.provider;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : 20_000;
  const temperature = Number.isFinite(config.temperature) ? config.temperature : 0.1;

  const models = parseModelList(settings.model);
  if (!models.length) return disabledProvider(`${providerName} model is required`);
  /** model -> the time it may be tried again. Empty in the ordinary case. */
  const cooldowns = new Map();
  let activeModel = models[0];

  const attempt = async (model, { system, user, schemaName: _schemaName }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const isOllama = providerName === 'ollama';
    const url = isOllama
      ? `${stripTrailingSlash(settings.baseUrl)}/api/chat`
      : `${stripTrailingSlash(settings.baseUrl)}/chat/completions`;
    const body = isOllama
      ? {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          format: 'json',
          options: { temperature },
        }
      : {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          temperature,
          response_format: { type: 'json_object' },
        };

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(isOllama ? {} : {
            Accept: 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          }),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new AiProviderError(
          `AI provider request failed: ${await describeFailure(response)}`,
          'http_error',
          response.status,
        );
      }

      let payload;
      try {
        payload = isOllama ? await response.json() : await parseHostedEnvelope(response);
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') throw error;
        throw new AiProviderError('AI provider returned invalid response JSON', 'invalid_response');
      }

      const content = isOllama
        ? payload?.message?.content
        : payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new AiProviderError('AI provider response is missing message content', 'invalid_response');
      }
      return parseJsonObject(content);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new AiProviderError(
          `AI provider timed out after ${timeoutMs}ms`,
          'timeout',
        );
      }
      throw new AiProviderError('AI provider request failed', 'network_error');
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Try the chain in order and return the first model that answers.
   *
   * Free tiers are the reason this exists: they rate-limit (429), drop a model
   * without warning (404 "no endpoints found"), and are slow enough to hit the
   * timeout — none of which is a reason to serve a deterministic fallback when
   * a second model would have answered. A failing model is put on a cooldown so
   * the next refresh does not pay its timeout again, and comes back on its own
   * once the cooldown lapses, because a rate limit is temporary and pinning the
   * chain to a survivor would quietly demote the model the operator chose.
   *
   * Groups are generated concurrently, so several calls can discover the same
   * dead model before the first cooldown is written. That costs one round of
   * requests and is self-correcting on the next refresh.
   *
   * The worst case is one timeout per model, so a long AI_ALERTS_TIMEOUT_MS
   * multiplies by the length of the chain — see server/.env.example.
   */
  const completeJson = async (request) => {
    const now = Date.now();
    const ready = models.filter((model) => (cooldowns.get(model) ?? 0) <= now);
    // Everything is cooling down: try the whole chain anyway rather than
    // failing on a stale verdict about models that may well have recovered.
    const order = ready.length ? ready : models;
    let lastError = null;

    for (const model of order) {
      try {
        const payload = await attempt(model, request);
        cooldowns.delete(model);
        activeModel = model;
        return payload;
      } catch (error) {
        lastError = error;
        if (!shouldTryNextModel(error)) throw error;
        // Cooled down whether or not there is another model to try: the last
        // one in the chain failing is exactly as much a reason to skip it next
        // time. When that leaves every model cooling, the next call falls back
        // to the whole chain above rather than giving up on all of them.
        cooldowns.set(model, Date.now() + MODEL_COOLDOWN_MS);
        if (model === order.at(-1)) throw error;
        logger?.warn?.(`AI model ${model} failed (${error.message}); trying the next one`);
      }
    }

    throw lastError ?? new AiProviderError('AI provider has no model to try', 'disabled');
  };

  return {
    enabled: true,
    name: providerName,
    status: { enabled: true, provider: providerName, reason: null },
    models,
    /** The model that last answered — what /health and the dashboard report. */
    get activeModel() {
      return activeModel;
    },
    completeJson,
  };
};

module.exports = {
  AiProviderError,
  MODEL_COOLDOWN_MS,
  createAiProvider,
  parseJsonObject,
  parseModelList,
};
