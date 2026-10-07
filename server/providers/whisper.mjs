import { access, stat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderError } from './ollama.mjs';

export const WHISPER_MODEL = path.join(homedir(), 'Library', 'Application Support', 'Meeting Loop', 'models', 'ggml-base.en.bin');
export const WHISPER_MODEL_SHA256 = 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002';
export const WHISPER_MODEL_SIZE = 147964211;
const LOCAL_BINARIES = { whisper: ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'], ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'] };
let transcriptionBusy = false;

async function locate(kind) {
  for (const filename of LOCAL_BINARIES[kind]) { try { await access(filename); return filename; } catch {} }
  return null;
}

export async function getWhisperStatus() {
  const [binary, ffmpeg] = await Promise.all([locate('whisper'), locate('ffmpeg')]);
  let modelReady = false; try { modelReady = (await stat(WHISPER_MODEL)).size === WHISPER_MODEL_SIZE; } catch {}
  return { provider: 'whisper.cpp', available: !!binary && !!ffmpeg && modelReady, binaryInstalled: !!binary, ffmpegInstalled: !!ffmpeg, modelInstalled: modelReady,
    model: 'base.en', modelPath: WHISPER_MODEL, local: true, language: 'en', busy: transcriptionBusy,
    message: !binary ? 'Install whisper.cpp to transcribe recordings locally.' : !ffmpeg ? 'Install FFmpeg for local audio conversion.' : !modelReady ? 'Download and verify the base.en speech model using local model setup.' : 'Local English transcription is ready.' };
}

function runLocal(binary, args, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false; let stdout = ''; let stderr = ''; let forceKill;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve({ stdout, stderr }); };
    const stop = error => { child.kill('SIGTERM'); forceKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); forceKill.unref(); finish(error); };
    const abort = () => stop(signal.reason || new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => stop(new ProviderError('ASR_TIMEOUT', 'Local transcription timed out. The original audio is still saved.')), timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_000); });
    child.once('error', () => finish(new ProviderError('ASR_START_FAILED', 'The local audio tool could not start.')));
    child.once('close', code => { clearTimeout(forceKill); finish(code === 0 ? null : new ProviderError('ASR_FAILED', `The local audio tool exited (${code ?? 'signal'}). Your recording is preserved.`)); });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Convert a caller-authorized local audio file and transcribe it. Caller must enforce vault path permissions. */
export async function transcribeAudio({ audioPath, signal, offsetSeconds = 0, speaker = 'Unknown', timeoutMs = 180_000 } = {}) {
  if (typeof audioPath !== 'string' || !path.isAbsolute(audioPath)) throw new ProviderError('LOCAL_AUDIO_REQUIRED', 'Select a local recording from this meeting.');
  if (!/\.(wav|mp3|m4a|mp4|webm|ogg|flac|aiff|aif|aac|caf)$/i.test(audioPath)) throw new ProviderError('INVALID_AUDIO_FORMAT', 'Choose a supported audio file.');
  if (!Number.isFinite(timeoutMs)) throw new ProviderError('INVALID_TIMEOUT', 'Transcription timeout must be a finite number.');
  const info = await stat(audioPath);
  if (!info.isFile() || info.size > 2_000_000_000) throw new ProviderError('INVALID_AUDIO', 'Choose a local audio file smaller than 2 GB.');
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) throw new ProviderError('INVALID_OFFSET', 'The audio offset must be nonnegative.');
  if (transcriptionBusy) throw new ProviderError('ASR_BUSY', 'Another local transcription is running. Try again when it finishes.');
  const status = await getWhisperStatus(); if (!status.available) throw new ProviderError('ASR_NOT_READY', status.message);
  if (transcriptionBusy) throw new ProviderError('ASR_BUSY', 'Another local transcription is running.');
  transcriptionBusy = true; const started = performance.now(); let scratch;
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'meeting-loop-asr-'));
    const [binary, ffmpeg] = await Promise.all([locate('whisper'), locate('ffmpeg')]);
    const wave = path.join(scratch, 'input.wav'); const output = path.join(scratch, 'transcript');
    const boundedTimeout = Math.max(1000, Math.min(1_800_000, timeoutMs));
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(boundedTimeout)]);
    await runLocal(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', audioPath, '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wave], { signal: bounded, timeoutMs: boundedTimeout });
    await runLocal(binary, ['-m', WHISPER_MODEL, '-f', wave, '-l', 'en', '-t', '4', '-oj', '-of', output, '-np'], { signal: bounded, timeoutMs: boundedTimeout });
    const raw = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    if (!Array.isArray(raw.transcription)) throw new ProviderError('ASR_INVALID_OUTPUT', 'The local speech model returned an unreadable transcript.');
    const segments = raw.transcription.map(segment => ({
      start: offsetSeconds + Number(segment.offsets?.from ?? 0) / 1000,
      end: offsetSeconds + Number(segment.offsets?.to ?? 0) / 1000,
      text: String(segment.text || '').trim(), speaker: String(speaker).slice(0, 100), provisional: false,
      source: 'whisper.cpp', confidence: null,
    })).filter(segment => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
    return { provider: 'whisper.cpp', model: 'base.en', local: true, text: segments.map(s => s.text).join(' '), segments, elapsedMs: Math.round(performance.now() - started), language: 'en' };
  } finally { transcriptionBusy = false; if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
