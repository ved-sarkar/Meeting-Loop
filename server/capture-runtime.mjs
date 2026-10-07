import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const MAX_ASR_QUEUE = 120;
const asrBase = job => `meetings/${job.meetingId}/asr/${path.basename(job.file)}`;
const pendingFile = job => `${asrBase(job)}.pending.json`;

export async function diagnostics(app) {
  try {
    const [status, devices] = await Promise.all([
      exec(app.helper, ['diagnostics'], { timeout: 10_000 }),
      exec(app.helper, ['devices'], { timeout: 10_000 })
    ]);
    return { available: true, ...JSON.parse(status.stdout), microphones: JSON.parse(devices.stdout).microphones || [],
      recoveryWarnings: app.recoveryWarnings || [] };
  } catch {
    return { available: false, error: fs.existsSync(app.helper) ? 'Native diagnostics unavailable' : 'Build the native helper first.' };
  }
}

export function captureState(app) {
  const c = app.capture;
  return c ? { meetingId: c.meetingId, startedAt: c.startedAt, paused: c.paused,
    ready: c.ready, state: c.ready ? c.paused ? 'paused' : 'recording' : 'starting',
    pendingCommand: c.pendingCommand, levels: { ...c.levels },
    asrBacklog: app.asrQueue.length + (app.asrDeferredCount || 0) + (app.asrRunning ? 1 : 0) } : null;
}

function checkedChunk(app, meetingId, directory, event) {
  if (!['mic', 'system'].includes(event.track) || typeof event.file !== 'string' ||
      !new RegExp(`^chunks/${event.track}-[0-9]{6}\\.caf$`).test(event.file) ||
      !Number.isFinite(event.start) || !Number.isFinite(event.end) || event.start < 0 || event.end <= event.start) {
    throw new Error('Invalid native audio chunk metadata.');
  }
  const absolute = path.join(directory, event.file);
  const relativePath = path.relative(app.vault.root, absolute);
  if (!relativePath.startsWith(`meetings/${meetingId}/audio/capture/chunks/`)) throw new Error('Audio source escaped its recording directory.');
  app.vault.safePath(relativePath);
  if (!fs.statSync(absolute).isFile()) throw new Error('Committed audio chunk is missing.');
  return { ...event, relativePath, duration: event.end - event.start };
}

export function recoverAudio(app) {
  app.recoveryWarnings = [];
  for (const meeting of app.vault.snapshot().meetings) {
    const directory = app.vault.safePath(`meetings/${meeting.id}/audio/capture`);
    let state = ['recording', 'paused'].includes(meeting.recordingStatus) ? 'interrupted' : meeting.recordingStatus;
    if (fs.existsSync(directory)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        if (manifest.status === 'recording' && !manifest.complete) state = 'interrupted';
      } catch { /* Missing/corrupt manifest does not prevent journal recovery. */ }
      const journal = path.join(directory, 'events.jsonl');
      const known = new Set(meeting.audio.map(audio => audio.relativePath));
      if (fs.existsSync(journal)) for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== 'chunk') continue;
          const chunk = checkedChunk(app, meeting.id, directory, event);
          if (!known.has(chunk.relativePath)) {
            app.vault.addAudioChunk(meeting.id, chunk);
            known.add(chunk.relativePath);
          }
        } catch { app.recoveryWarnings.push(`Some audio metadata for ${meeting.id} needs recovery review; original files were retained.`); }
      }
      const chunkDirectory = path.join(directory, 'chunks');
      if (fs.existsSync(chunkDirectory) && fs.readdirSync(chunkDirectory).some(name => name.endsWith('.partial.caf'))) {
        app.recoveryWarnings.push(`An unfinished audio chunk was retained for ${meeting.id}; only committed chunks are played and transcribed.`);
      }
    }
    // addAudioChunk updates recordingStatus; restore the actual session status after recovery.
    if (['recording', 'paused', 'stopped', 'failed', 'interrupted', 'not_recording'].includes(state)) app.vault.updateRecordingStatus(meeting.id, state);
    for (const audio of app.vault.getMeeting(meeting.id).audio) {
      const job = { meetingId: meeting.id, file: audio.relativePath, start: audio.start || 0,
        end: audio.end, track: audio.source === 'microphone' ? 'mic' : audio.source };
      if (!fs.existsSync(app.vault.safePath(`${asrBase(job)}.json`))) queueASR(app, job);
    }
  }
  app.recoveryWarnings = [...new Set(app.recoveryWarnings)];
}

export async function startCapture(app, meetingId, { consent, mic = true, system = false, deviceId } = {}) {
  if (consent !== true) throw new Error('Recording requires participant consent.');
  if (typeof mic !== 'boolean' || typeof system !== 'boolean' || (!mic && !system)) throw new Error('Choose at least one audio source.');
  if (app.capture) throw new Error('A meeting is already recording.');
  if (app.inference) throw new Error('Finish or cancel current generation before recording.');
  if (!fs.existsSync(app.helper)) throw new Error('Build the native capture helper before recording.');
  const meeting = app.vault.getMeeting(meetingId);
  if (meeting.source === 'synthetic') throw new Error('Create a new meeting to record real audio.');
  const directory = app.vault.safePath(`meetings/${meetingId}/audio/capture`);
  if (['manifest.json', 'events.jsonl', 'chunks'].some(name => fs.existsSync(path.join(directory, name)))) {
    throw new Error('This meeting already has recording data. Create a new meeting to preserve it.');
  }
  if (deviceId !== undefined && !/^\d+$/.test(String(deviceId))) throw new Error('Invalid microphone device.');
  app.vault.prepareCapture(meetingId, { consent: true });
  // The native helper accepts an existing empty directory and creates its own chunks/journal.
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const args = ['record', '--directory', directory, '--consent', '--mic', String(mic), '--system', String(system)];
  if (deviceId !== undefined) args.push('--device-id', String(deviceId));
  const child = spawn(app.helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const c = { child, meetingId, directory, startedAt: Date.now(), paused: false, ready: false,
    stopRequested: false, pendingCommand: null, levels: {}, states: new EventEmitter(), nativeComplete: null };
  app.capture = c;
  let buffer = '', resolveReady, rejectReady, resolveClosed, finished = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  c.closed = new Promise(resolve => { resolveClosed = resolve; });
  const readyTimeout = setTimeout(() => {
    c.failure = 'Recording did not become ready. Check the macOS permission dialog and try again.';
    child.kill('SIGTERM'); rejectReady(new Error(c.failure));
  }, 120_000);
  readyTimeout.unref();
  const publish = () => app.emit('event', { type: 'capture', capture: captureState(app) });
  function finish(code, signal, error) {
    if (finished) return;
    finished = true;
    clearTimeout(readyTimeout);
    if (buffer.trim()) handleLine(buffer);
    const success = code === 0 && c.nativeComplete === true && !c.failure;
    app.vault.updateRecordingStatus(meetingId, success ? 'stopped' : 'failed');
    if (!c.ready) rejectReady(new Error(c.failure || error?.message || 'Recording could not start. Check microphone and system-audio permissions.'));
    if (app.capture === c) app.capture = null;
    c.states.emit('closed'); publish(); app.changed();
    if (!success) app.warning(c.failure || 'Recording stopped unexpectedly. Completed chunks are still saved.');
    resolveClosed({ success, code, signal });
  }
  function handleLine(line) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'chunk') {
        const chunk = checkedChunk(app, meetingId, directory, event);
        if (!app.vault.getMeeting(meetingId).audio.some(audio => audio.relativePath === chunk.relativePath)) {
          app.vault.addAudioChunk(meetingId, chunk);
          queueASR(app, { meetingId, file: chunk.relativePath, start: event.start, end: event.end, track: event.track });
        }
        app.vault.updateRecordingStatus(meetingId, c.ready ? c.paused ? 'paused' : 'recording' : 'not_recording');
        app.changed();
      } else if (event.type === 'ready') {
        c.ready = true; clearTimeout(readyTimeout);
        app.vault.updateRecordingStatus(meetingId, 'recording'); publish(); resolveReady(captureState(app));
      } else if (event.type === 'state' && ['recording', 'paused'].includes(event.state)) {
        c.paused = event.state === 'paused';
        if (c.pendingCommand === (c.paused ? 'pause' : 'resume')) c.pendingCommand = null;
        app.vault.updateRecordingStatus(meetingId, event.state);
        c.states.emit('state', event.state); publish(); app.changed();
      } else if (event.type === 'level' && ['mic', 'system'].includes(event.track)) {
        c.levels[event.track] = Math.max(0, Math.min(1, Number(event.rms) || 0)); publish();
      } else if (event.type === 'error') {
        c.failure = event.message || 'Native capture failed.'; app.warning(c.failure);
      } else if (event.type === 'warning') app.warning(event.message || 'Capture helper reported a problem.');
      else if (event.type === 'stopped') c.nativeComplete = event.complete === true;
      else if (event.type === 'gap') app.emit('event', { type: 'capture-gap', meetingId, gap: event });
    } catch (error) { app.warning('An audio event could not be saved: ' + error.message); }
  }
  child.on('error', error => { c.failure = error.message; finish(null, null, error); });
  child.on('close', (code, signal) => finish(code, signal));
  child.stdin.on('error', error => { c.failure = 'Recording command could not be delivered: ' + error.message; c.states.emit('command-error', new Error(c.failure)); });
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 1_000_000) { c.failure = 'Capture helper returned an oversized event.'; child.kill('SIGTERM'); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) handleLine(line);
    }
  });
  publish(); app.changed();
  return ready;
}

export async function captureCommand(app, command) {
  if (!['pause', 'resume', 'stop'].includes(command)) throw new Error('Unknown recording command.');
  const c = app.capture;
  if (!c) return true;
  if (command === 'stop') {
    c.stopRequested = true; c.pendingCommand = 'stop';
    if (!c.child.stdin.destroyed) c.child.stdin.write('stop\n');
    const watchdog = setTimeout(() => { c.failure = 'Recording stop did not respond; saved chunks were preserved.'; c.child.kill('SIGTERM'); }, 12_000);
    const hardStop = setTimeout(() => c.child.kill('SIGKILL'), 17_000);
    watchdog.unref(); hardStop.unref();
    const result = await c.closed;
    clearTimeout(watchdog); clearTimeout(hardStop);
    await app.waitASR();
    if (!result.success) throw new Error(c.failure || 'The recording ended incompletely. Completed audio chunks are saved.');
    const missing = app.vault.getMeeting(c.meetingId).audio.some(audio => !fs.existsSync(app.vault.safePath(
      `${asrBase({ meetingId: c.meetingId, file: audio.relativePath })}.json`)));
    if (missing) {
      app.warning('Recording is stopped and audio is saved. Transcription is incomplete; retry transcription before finalizing the meeting.');
      app.changed();
      throw new Error('Audio saved. Transcription is pending; fix the local speech engine and retry transcription.');
    }
    app.vault.finalizeMeeting(c.meetingId); app.changed();
    return true;
  }
  if (!c.ready) throw new Error('Wait for recording to become ready.');
  if (c.pendingCommand) throw new Error('Wait for the previous recording command to finish.');
  if ((command === 'pause') === c.paused) return true;
  c.pendingCommand = command;
  app.emit('event', { type: 'capture', capture: captureState(app) });
  await new Promise((resolve, reject) => {
    const target = command === 'pause' ? 'paused' : 'recording';
    const cleanup = () => { clearTimeout(timer); c.states.off('state', onState); c.states.off('closed', onClose); c.states.off('command-error', onError); };
    const onState = state => { if (state === target) { cleanup(); resolve(); } };
    const onClose = () => { cleanup(); reject(new Error('Recording stopped before the command was acknowledged.')); };
    const onError = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup(); c.failure = 'Recording did not acknowledge the privacy change; capture is being stopped.';
      c.child.kill('SIGTERM'); reject(new Error(c.failure));
    }, 5_000);
    c.states.on('state', onState); c.states.once('closed', onClose); c.states.once('command-error', onError);
    c.child.stdin.write(command + '\n');
  });
  return true;
}

export function queueASR(app, job) {
  if (app.activeASR?.file === job.file || app.asrQueue.some(item => item.file === job.file)) return;
  job = { ...job, attemptId: crypto.randomUUID() };
  app.vault.write(pendingFile(job), job);
  if (app.asrQueue.length >= MAX_ASR_QUEUE) {
    app.asrDeferredCount = (app.asrDeferredCount || 0) + 1;
    if (!app.asrBacklogWarning) { app.asrBacklogWarning = true; app.warning('Transcription is behind. Audio continues saving; queued transcription work is kept on disk.'); }
  } else app.asrQueue.push(job);
  void pumpASR(app);
}

export function retryTranscription(app, meetingId) {
  const meeting = app.vault.getMeeting(meetingId);
  if (meeting.status !== 'active') throw new Error('This transcript is finalized. Saved recordings can be imported into a new meeting to retry transcription.');
  let queued = 0;
  for (const audio of meeting.audio) {
    const job = { meetingId, file: audio.relativePath, start: audio.start || 0,
      end: audio.end, track: audio.source === 'microphone' ? 'mic' : audio.source };
    if (fs.existsSync(app.vault.safePath(`${asrBase(job)}.json`))) continue;
    queueASR(app, job); queued++;
  }
  app.changed();
  return { meetingId, queued, transcriptionState: queued ? 'queued' : 'ready' };
}

function refillASR(app) {
  let deferred = 0;
  for (const meeting of app.vault.snapshot().meetings) {
    const relative = `meetings/${meeting.id}/asr`;
    const directory = app.vault.safePath(relative);
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.pending.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(app.vault.safePath(`${relative}/${file}`), 'utf8'));
        if (job.meetingId !== meeting.id || !meeting.audio.some(audio => audio.relativePath === job.file)) continue;
        if (app.asrQueue.some(item => item.file === job.file)) continue;
        const errorFile = app.vault.safePath(`${asrBase(job)}.error.json`);
        const alreadyFailed = fs.existsSync(errorFile) && JSON.parse(fs.readFileSync(errorFile, 'utf8')).attemptId === job.attemptId;
        if (fs.existsSync(app.vault.safePath(`${asrBase(job)}.json`)) || alreadyFailed) {
          try { fs.unlinkSync(app.vault.safePath(`${relative}/${file}`)); } catch {}
          continue;
        }
        if (app.asrQueue.length < MAX_ASR_QUEUE) app.asrQueue.push(job); else deferred++;
      } catch { /* Keep malformed spool records for local recovery review. */ }
    }
  }
  app.asrDeferredCount = deferred;
}

export async function pumpASR(app) {
  if (app.asrRunning) return;
  app.asrRunning = true;
  try {
    while (true) {
      if (!app.asrQueue.length) refillASR(app);
      if (!app.asrQueue.length) break;
      const job = app.asrQueue.shift(); app.activeASR = job;
      try {
        const result = await app.transcriber({ audioPath: app.vault.safePath(job.file), offsetSeconds: job.start || 0,
          speaker: job.track === 'mic' ? app.vault.getSettings().userName : job.track === 'system' ? 'Remote audio' : 'Unknown speaker' });
        if (!Array.isArray(result.segments)) throw new Error('Transcriber returned invalid segments.');
        const existing = new Set(app.vault.getMeeting(job.meetingId).segments.map(segment => segment.id));
        for (const [index, segment] of result.segments.entries()) {
          const id = 'seg_' + crypto.createHash('sha256').update(job.file + ':' + index).digest('hex').slice(0, 32);
          if (typeof segment.text === 'string' && segment.text.trim() && !/^\s*\[.*\]\s*$/.test(segment.text) && !existing.has(id)) {
            app.vault.addSegment(job.meetingId, { ...segment, id }); existing.add(id);
          }
        }
        app.vault.write(`${asrBase(job)}.json`, { source: job.file, local: true, model: result.model,
          elapsedMs: result.elapsedMs, segments: result.segments });
        const priorError = app.vault.safePath(`${asrBase(job)}.error.json`);
        if (fs.existsSync(priorError)) fs.unlinkSync(priorError);
      } catch (error) {
        try { app.vault.write(`${asrBase(job)}.error.json`, { source: job.file, error: error.message, attemptId: job.attemptId }); }
        catch { /* Disk failure must not strand the ASR worker or block capture shutdown. */ }
        app.warning('Audio saved; transcription needs attention: ' + error.message);
      } finally {
        try { fs.unlinkSync(app.vault.safePath(pendingFile(job))); } catch {}
        app.activeASR = null; app.changed();
      }
    }
  } finally {
    app.asrRunning = false; app.asrBacklogWarning = false; app.asrFinished.emit('done');
  }
}

export async function screenshot(app, meetingId) {
  app.vault.getMeeting(meetingId);
  const directory = app.vault.safePath(`meetings/${meetingId}/screenshots`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = await exec(app.helper, ['screenshot', '--directory', directory, '--consent'], { timeout: 120_000 });
  const events = result.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const selected = events.find(event => event.type === 'screenshot');
  if (selected) {
    const relative = path.relative(app.vault.root, selected.file);
    if (!relative.startsWith(`meetings/${meetingId}/screenshots/`)) throw new Error('Screenshot escaped its selected directory.');
    app.vault.safePath(relative);
  }
  return { saved: !!selected, cancelled: !selected, file: selected?.file, visionEnabled: false, events };
}

export async function playback(app, meetingId, relative) {
  const source = app.ownedAudio(meetingId, relative);
  if (!source.endsWith('.caf')) return source;
  const target = app.vault.safePath(relative + '.playback.wav');
  if (!fs.existsSync(target)) {
    const temporary = app.vault.safePath(`${relative}.${crypto.randomUUID()}.playback.wav`);
    try {
      await exec('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', source, '-acodec', 'pcm_s16le', '-y', temporary], { timeout: 60_000 });
      fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return target;
}
