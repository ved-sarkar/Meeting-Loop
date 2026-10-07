/** Local-only Ollama adapter. No API key support, remote URL, auto-pull or cloud fallback. */
export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const MAX_PROMPT_CHARACTERS = 24_000;
let busy = false;

export class ProviderError extends Error {
  constructor(code, message) { super(message); this.name = 'ProviderError'; this.code = code; }
}

export function assertLocalModelName(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model) || /cloud|https?:|@/i.test(model)) {
    throw new ProviderError('LOCAL_MODEL_REQUIRED', 'Choose a downloaded local model. Cloud models are disabled.');
  }
  return model;
}

function localMetadata(model) {
  return model && !model.remote_host && !model.remote_model && model.details?.format === 'gguf' && model.size > 1_000_000;
}

function boundedSignal(signal, timeoutMs) {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
}

function safeError(error) {
  if (error instanceof ProviderError || ['AbortError', 'TimeoutError'].includes(error?.name)) return error;
  return new ProviderError('OLLAMA_UNAVAILABLE', 'Local Ollama is unavailable. Start Ollama and check local model setup.');
}

export function createOllamaProvider({ baseUrl = OLLAMA_URL, fetchImpl = fetch } = {}) {
  if (baseUrl !== OLLAMA_URL) throw new ProviderError('REMOTE_ENDPOINT_DISABLED', 'Meeting Loop only connects to Ollama at 127.0.0.1:11434.');
  async function request(path, { signal, body } = {}) {
    const response = await fetchImpl(`${OLLAMA_URL}${path}`, {
      method: body ? 'POST' : 'GET', signal, redirect: 'error', credentials: 'omit',
      headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new ProviderError('OLLAMA_REQUEST_FAILED', `Local model request failed (${response.status}). Check Ollama diagnostics.`);
    return response;
  }
  async function listModels({ signal } = {}) {
    try {
      const data = await (await request('/api/tags', { signal: boundedSignal(signal, 5000) })).json();
      return (data.models || []).filter(localMetadata).filter(m => { try { assertLocalModelName(m.name); return true; } catch { return false; } }).map(m => ({
        id: m.name, name: m.name, size: m.size, digest: m.digest, parameterSize: m.details.parameter_size,
        quantization: m.details.quantization_level, capabilities: m.capabilities || ['completion'], local: true,
      }));
    } catch (error) { throw safeError(error); }
  }
  async function status() {
    try {
      const [models, version] = await Promise.all([listModels(), request('/api/version', { signal: AbortSignal.timeout(5000) }).then(r => r.json())]);
      return { available: true, provider: 'ollama', baseUrl: OLLAMA_URL, version: version.version, models,
        defaultModel: models.find(m => m.id === 'qwen3:4b-instruct')?.id || models.find(m => m.id === 'qwen3:4b')?.id || models[0]?.id || null, busy, localOnly: true };
    } catch (error) { return { available: false, provider: 'ollama', baseUrl: OLLAMA_URL, models: [], defaultModel: null, error: safeError(error).message, localOnly: true }; }
  }
  async function generate({ model = 'qwen3:4b-instruct', prompt, system = '', signal, onToken, format, maxTokens = 700, timeoutMs = 120_000 } = {}) {
    assertLocalModelName(model);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ProviderError('PROMPT_REQUIRED', 'A question or transcript is required.');
    if (typeof system !== 'string' || prompt.length + system.length > MAX_PROMPT_CHARACTERS) throw new ProviderError('CONTEXT_TOO_LARGE', `Select less context (maximum ${MAX_PROMPT_CHARACTERS} characters).`);
    if (format !== undefined && format !== 'json' && (typeof format !== 'object' || format === null || Array.isArray(format))) throw new ProviderError('INVALID_FORMAT', 'Structured output must be json or a JSON schema.');
    if (!Number.isFinite(maxTokens) || !Number.isFinite(timeoutMs)) throw new ProviderError('INVALID_LIMIT', 'Response limits must be finite numbers.');
    if (busy) throw new ProviderError('PROVIDER_BUSY', 'The local model is answering another request. Cancel it or try again shortly.');
    busy = true;
    const requestSignal = boundedSignal(signal, Math.min(300_000, Math.max(100, timeoutMs)));
    const started = performance.now(); let firstTokenMs = null; let text = ''; let completed = null; let reader;
    try {
      const models = await listModels({ signal: requestSignal });
      if (!models.some(m => m.id === model)) throw new ProviderError('MODEL_NOT_INSTALLED', 'This local model is not installed. Run local model setup first.');
      const details = await (await request('/api/show', { signal: requestSignal, body: { model } })).json();
      if (details.remote_host || details.remote_model || details.details?.format !== 'gguf') throw new ProviderError('LOCAL_MODEL_REQUIRED', 'The chosen model is not verified as a local GGUF model.');
      const response = await request('/api/generate', { signal: requestSignal, body: {
        model, prompt, system, stream: true, think: Boolean(details.capabilities?.includes('thinking')), keep_alive: '2m', ...(format ? { format } : {}),
        options: { num_ctx: 8192, num_predict: Math.min(2048, Math.max(16, Math.floor(maxTokens))), temperature: 0.3 },
      } });
      if (!response.body) throw new ProviderError('EMPTY_STREAM', 'The local model returned no response.');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      const consume = line => {
        if (!line.trim()) return;
        let event; try { event = JSON.parse(line); } catch { throw new ProviderError('INVALID_STREAM', 'The local model returned an invalid response.'); }
        if (event.error) throw new ProviderError('MODEL_ERROR', 'The local model could not finish. Check the model runtime.');
        if (event.response) { if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started); text += event.response; onToken?.(event.response); }
        if (event.done) completed = event;
      };
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1_000_000 || text.length > 500_000) throw new ProviderError('OUTPUT_TOO_LARGE', 'The local model response exceeded the safe output size.');
        let newline; while ((newline = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      }
      buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
      if (!completed) throw new ProviderError('INCOMPLETE_STREAM', 'The model response was interrupted. The saved recording is unaffected.');
      if (completed.done_reason === 'length' || !text.trim()) throw new ProviderError('OUTPUT_LIMIT', 'The local model ran out of response space. Try a shorter question or less context.');
      return { text: text.trim(), model, provider: 'ollama', local: true, firstTokenMs, elapsedMs: Math.round(performance.now() - started),
        usage: { inputTokens: completed.prompt_eval_count ?? null, outputTokens: completed.eval_count ?? null, vendorCostUsd: 0 }, finishReason: completed.done_reason || 'stop' };
    } catch (error) { throw safeError(error); }
    finally { try { await reader?.cancel(); } catch {} busy = false; }
  }
  return { status, listModels, generate };
}
