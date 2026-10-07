import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import readline from 'node:readline';
import { ProviderError } from './ollama.mjs';

const execFileAsync = promisify(execFile);
export const CODEX_SCHEMA_VERSION = '0.154.0-alpha.6.2';
const SAFE_METHODS = new Set(['initialize', 'account/read', 'model/list', 'account/rateLimits/read']);
const GATE_REASON = 'Cloud answers stay disabled: the supported interface does not establish a per-turn guarantee of zero paid-credit consumption. Local answers remain available.';

async function locateCodex() {
  for (const path of ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
    try { await access(path); return path; } catch {}
  }
  return null;
}

/** This client exposes an allowlist of metadata requests, never thread/turn or auth mutation methods. */
class ReadOnlyCodexClient {
  constructor(executable, signal) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/i.test(key)) delete env[key];
    this.child = spawn(executable, ['app-server', '--stdio', '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1; this.pending = new Map(); this.closed = false;
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => this.close(new ProviderError('CODEX_START_FAILED', 'The official Codex helper could not start.')));
    this.child.on('exit', () => this.close(new ProviderError('CODEX_EXITED', 'The official Codex helper stopped.')));
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Meeting Loop only supports metadata inspection.' } }) + '\n');
        return;
      }
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new ProviderError('CODEX_REQUEST_FAILED', `Official Codex metadata request failed (${message.error.code ?? 'unknown'}).`));
      else pending.resolve(message.result);
    });
    this.signal = signal; this.onAbort = () => this.close(signal.reason || new DOMException('Cancelled', 'AbortError'));
    if (signal?.aborted) this.onAbort(); else signal?.addEventListener('abort', this.onAbort, { once: true });
  }
  request(method, params = {}) {
    if (!SAFE_METHODS.has(method)) return Promise.reject(new ProviderError('CODEX_READ_ONLY', 'Only official account and model metadata requests are permitted.'));
    if (this.closed) return Promise.reject(new ProviderError('CODEX_CLOSED', 'Codex metadata connection is closed.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ProviderError('CODEX_TIMEOUT', 'Codex metadata lookup timed out.')); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'meeting_loop', title: 'Meeting Loop', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return result;
  }
  close(error = new ProviderError('CODEX_CLOSED', 'Codex metadata connection closed.')) {
    if (this.closed) return; this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lines.close(); this.child.stdin.end();
    if (this.child.exitCode === null) { this.child.kill('SIGTERM'); const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 2000); timer.unref(); }
  }
}

function quotaWindow(window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return { usedPercent: window.usedPercent, remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)), windowDurationMins: window.windowDurationMins ?? null, resetsAt: window.resetsAt ?? null };
}
function normalizeLimits(response) {
  const entries = response?.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
    ? Object.entries(response.rateLimitsByLimitId) : response?.rateLimits ? [[response.rateLimits.limitId || 'codex', response.rateLimits]] : [];
  return entries.map(([id, bucket]) => ({ id, name: bucket.limitName || id, primary: quotaWindow(bucket.primary), secondary: quotaWindow(bucket.secondary),
    credits: bucket.credits ? { hasCredits: bucket.credits.hasCredits, unlimited: bucket.credits.unlimited, balance: bucket.credits.balance ?? null } : null,
    limitReached: bucket.rateLimitReachedType ?? null, spendControlReached: bucket.spendControlReached ?? null }));
}

/** Call only on a user's explicit connection check: account/model/quota metadata can contact OpenAI. */
export async function getCodexStatus({ allowNetwork = false, signal } = {}) {
  const executable = await locateCodex();
  const base = { provider: 'codex', installed: !!executable, connected: false, generationEnabled: false, automaticCloudEnabled: false, paidApiEnabled: false,
    additionalVendorBudgetUsd: 0, models: [], quotas: [], gateReason: GATE_REASON };
  if (!executable) return { ...base, status: 'not_installed', message: 'Install the official Codex app or CLI to inspect subscription access.' };
  let version;
  try { const result = await execFileAsync(executable, ['--version'], { timeout: 5000 }); version = result.stdout.trim().replace(/^codex-cli\s+/, ''); }
  catch { return { ...base, status: 'unavailable', message: 'The official Codex helper could not be checked.' }; }
  if (version !== CODEX_SCHEMA_VERSION) return { ...base, version, status: 'schema_mismatch', message: `Codex version changed. Regenerate and review the metadata schema for ${version} before connecting.` };
  if (!allowNetwork) return { ...base, version, status: 'not_checked', message: 'Check subscription access to read official Codex account, model, and quota metadata. No meeting content is sent.' };
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25_000)]);
  const client = new ReadOnlyCodexClient(executable, boundedSignal);
  try {
    await client.initialize();
    const accountResponse = await client.request('account/read', { refreshToken: false });
    if (!accountResponse || typeof accountResponse.requiresOpenaiAuth !== 'boolean') throw new ProviderError('CODEX_SCHEMA_MISMATCH', 'Unexpected official Codex account response.');
    const account = accountResponse.account ? { type: accountResponse.account.type, plan: accountResponse.account.planType || null } : null;
    if (account?.type !== 'chatgpt') return { ...base, version, account, status: account ? 'subscription_required' : 'sign_in_required', message: 'Use official Codex ChatGPT sign-in. API-key accounts are disabled in this zero-spend build.' };
    const models = []; let cursor = null;
    for (let page = 0; page < 5; page++) {
      const modelResponse = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(modelResponse?.data)) throw new ProviderError('CODEX_SCHEMA_MISMATCH', 'Unexpected official Codex model response.');
      models.push(...modelResponse.data.map(m => ({ id: m.model || m.id, name: m.displayName || m.model || m.id, default: !!m.isDefault, modalities: m.inputModalities || [], reasoningEfforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort) })));
      cursor = modelResponse.nextCursor; if (!cursor) break;
    }
    let quotas = []; let quotaError = null; let ordinaryUsageAllowed = null;
    try { const raw = await client.request('account/rateLimits/read'); quotas = normalizeLimits(raw); ordinaryUsageAllowed = raw?.ordinaryUsageAllowed ?? null; }
    catch (error) { quotaError = error.message; }
    return { ...base, version, connected: true, status: 'connected_metadata_only', account, models, quotas, quotaError, ordinaryUsageAllowed, checkedAt: new Date().toISOString(), message: 'Official subscription connection verified. Cloud generation remains gated by the zero-credit policy.' };
  } catch (error) { return { ...base, version, status: 'unavailable', message: error instanceof ProviderError ? error.message : 'The official Codex connection check was cancelled or unavailable.' }; }
  finally { client.close(); }
}

export async function generateWithCodex() { throw new ProviderError('CLOUD_ZERO_SPEND_GATE', GATE_REASON); }
