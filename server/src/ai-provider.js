'use strict';

class AiProviderError extends Error {
  constructor(message, code = 'provider_error') {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
  }
}

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

const safeStatus = (response) => {
  const status = Number.isInteger(response?.status) ? response.status : 'unknown';
  const text = String(response?.statusText || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 80);
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
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

  const completeJson = async ({ system, user, schemaName: _schemaName }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const isOllama = providerName === 'ollama';
    const url = isOllama
      ? `${stripTrailingSlash(settings.baseUrl)}/api/chat`
      : `${stripTrailingSlash(settings.baseUrl)}/chat/completions`;
    const body = isOllama
      ? {
          model: settings.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          format: 'json',
          options: { temperature },
        }
      : {
          model: settings.model,
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
          `AI provider request failed: ${safeStatus(response)}`,
          'http_error',
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

  return {
    enabled: true,
    name: providerName,
    status: { enabled: true, provider: providerName, reason: null },
    completeJson,
  };
};

module.exports = {
  AiProviderError,
  createAiProvider,
  parseJsonObject,
};
