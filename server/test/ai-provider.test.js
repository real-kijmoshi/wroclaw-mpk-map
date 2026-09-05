'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');

const {
  AiProviderError,
  createAiProvider,
  parseJsonObject,
} = require('../src/ai-provider');

const originalFetch = global.fetch;
const aiEnvNames = [
  'AI_ALERTS_ENABLED',
  'AI_ALERTS_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
];
const originalAiEnv = Object.fromEntries(aiEnvNames.map((name) => [name, process.env[name]]));

const loadConfig = () => {
  const path = require.resolve('../src/config');
  delete require.cache[path];
  return require('../src/config');
};

const baseConfig = (provider) => ({
  enabled: true,
  provider,
  timeoutMs: 1000,
  temperature: 0.1,
  openrouter: {
    apiKey: 'test-openrouter-key',
    baseUrl: 'https://openrouter.test/v1',
    model: 'test-model',
  },
  cmdc: {
    apiKey: 'test-cmd-key',
    baseUrl: 'https://cmdc.test/v1',
    model: 'test-model',
  },
  ollama: {
    baseUrl: 'http://ollama.test',
    model: 'test-model',
  },
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const name of aiEnvNames) {
    if (originalAiEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalAiEnv[name];
  }
  delete require.cache[require.resolve('../src/config')];
});

describe('createAiProvider', () => {
  it('defaults both the switch and provider to off', () => {
    // Empty values exercise application defaults while preventing dotenv from
    // reloading a developer's enabled local configuration into this test.
    process.env.AI_ALERTS_ENABLED = '';
    process.env.AI_ALERTS_PROVIDER = '';
    const config = loadConfig().aiAlerts;

    assert.equal(config.enabled, false);
    assert.equal(config.provider, 'off');
    assert.equal(createAiProvider(config).enabled, false);
  });

  it('stays disabled when AI_ALERTS_ENABLED is false', async () => {
    process.env.AI_ALERTS_ENABLED = 'false';
    process.env.AI_ALERTS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'unused-key';
    process.env.OPENROUTER_MODEL = 'unused-model';
    const config = loadConfig().aiAlerts;
    const provider = createAiProvider(config);

    assert.equal(config.enabled, false);
    assert.equal(config.provider, 'off');
    assert.equal(provider.enabled, false);
    assert.equal(provider.name, 'off');
    assert.match(provider.status.reason, /disabled/i);
    await assert.rejects(
      () => provider.completeJson({ system: '', user: '', schemaName: 'timeline' }),
      (error) => error instanceof AiProviderError && error.code === 'disabled',
    );
  });

  it('disables a hosted provider when its key is missing', () => {
    process.env.AI_ALERTS_ENABLED = 'true';
    process.env.AI_ALERTS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = '';
    process.env.OPENROUTER_MODEL = 'test-model';
    const config = loadConfig().aiAlerts;

    const provider = createAiProvider(config);
    assert.equal(config.enabled, false);
    assert.equal(config.provider, 'off');
    assert.equal(provider.enabled, false);
    assert.match(provider.status.reason, /OPENROUTER_API_KEY/);
  });

  it('parses an OpenAI-compatible response', async () => {
    let request;
    global.fetch = async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: '{"timeline":[{"event":"Objazd"}]}' } }],
        }),
      };
    };

    const provider = createAiProvider(baseConfig('openrouter'));
    const result = await provider.completeJson({
      system: 'Return JSON.',
      user: 'Build a timeline.',
      schemaName: 'incident_timeline',
    });

    assert.deepEqual(result, { timeline: [{ event: 'Objazd' }] });
    assert.equal(request.url, 'https://openrouter.test/v1/chat/completions');
    assert.equal(request.init.headers.Authorization, 'Bearer test-openrouter-key');
    assert.equal(request.init.headers.Accept, 'application/json');
    assert.equal(JSON.parse(request.init.body).stream, false);
    assert.deepEqual(JSON.parse(request.init.body).response_format, { type: 'json_object' });
  });

  it('reports the reason the provider gave, not just the status code', async () => {
    // Observed live: AI was enabled and configured, incidents were silently
    // deterministic, and /health said only "HTTP 404" — which sends you
    // hunting through config for something the response had already named.
    global.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () =>
        JSON.stringify({ error: { message: 'No endpoints found that support JSON mode', code: 404 } }),
    });

    const provider = createAiProvider(baseConfig('openrouter'));
    await assert.rejects(
      () => provider.completeJson({ system: '', user: '', schemaName: 'timeline' }),
      (error) => {
        assert.match(error.message, /HTTP 404/);
        assert.match(error.message, /No endpoints found that support JSON mode/);
        return error instanceof AiProviderError && error.code === 'http_error';
      },
    );
  });

  it('still reports something useful when the error body is not JSON', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'User not found.',
    });

    const provider = createAiProvider(baseConfig('openrouter'));
    await assert.rejects(
      () => provider.completeJson({ system: '', user: '', schemaName: 'timeline' }),
      (error) => /HTTP 401 .*User not found/.test(error.message),
    );
  });

  it('falls back to the status line when the body cannot be read', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => {
        throw new Error('socket hang up');
      },
    });

    const provider = createAiProvider(baseConfig('openrouter'));
    await assert.rejects(
      () => provider.completeJson({ system: '', user: '', schemaName: 'timeline' }),
      (error) => /HTTP 500 Internal Server Error/.test(error.message),
    );
  });

  it('accepts an unexpected hosted SSE response without retrying the generation', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => [
        ': OPENROUTER PROCESSING',
        '',
        'data: {"choices":[{"delta":{"content":"{\\"timeline\\":"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"[]}"}}]}',
        '',
        'data: [DONE]',
      ].join('\n'),
    });

    const provider = createAiProvider(baseConfig('openrouter'));
    const result = await provider.completeJson({ system: '', user: '', schemaName: 'timeline' });
    assert.deepEqual(result, { timeline: [] });
  });

  it('parses an Ollama response', async () => {
    let request;
    global.fetch = async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: '{"locations":["Rynek"]}' } }),
      };
    };

    const provider = createAiProvider(baseConfig('ollama'));
    const result = await provider.completeJson({
      system: 'Return JSON.',
      user: 'Find stop hints.',
      schemaName: 'incident_timeline',
    });

    assert.deepEqual(result, { locations: ['Rynek'] });
    assert.equal(request.url, 'http://ollama.test/api/chat');
    assert.equal(request.init.headers.Authorization, undefined);
    assert.equal(JSON.parse(request.init.body).format, 'json');
  });

  it('fails cleanly on timeout', async () => {
    global.fetch = async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });

    const config = baseConfig('openrouter');
    config.timeoutMs = 10;
    const provider = createAiProvider(config);

    await assert.rejects(
      () => provider.completeJson({ system: 'JSON', user: 'Wait', schemaName: 'timeline' }),
      (error) => error instanceof AiProviderError && error.code === 'timeout' && /10ms/.test(error.message),
    );
  });
});

describe('parseJsonObject', () => {
  it('accepts pure JSON objects and fenced JSON objects', () => {
    assert.deepEqual(parseJsonObject('{"ok":true}'), { ok: true });
    assert.deepEqual(parseJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  });

  it('rejects non-object JSON', () => {
    for (const value of ['[]', 'null', '"text"', '42']) {
      assert.throws(
        () => parseJsonObject(value),
        (error) => error instanceof AiProviderError && error.code === 'invalid_json',
      );
    }
  });

  it('rejects generated coordinate fields', () => {
    assert.throws(
      () => parseJsonObject('{"location":{"name":"Rynek","lat":51.11,"lon":17.03}}'),
      (error) => error instanceof AiProviderError && /not coordinates/.test(error.message),
    );
  });
});
