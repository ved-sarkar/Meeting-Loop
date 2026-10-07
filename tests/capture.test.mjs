import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Application } from '../server/application.mjs';
import { MAX_ASR_QUEUE } from '../server/capture-runtime.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const appRoot = path.resolve(import.meta.dirname, '..');
const nativeHelper = path.join(appRoot, 'native/capture-helper/.build/release/meeting-loop-capture');

async function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'meeting-loop-capture-test-'));
  const app = new Application({ root: path.join(temporary, 'vault'), appRoot,
    provider: { status: async () => ({ available: false, models: [] }) },
    transcriber: async () => ({ segments: [], model: 'synthetic-stub', elapsedMs: 0 }), ...options });
  const project = app.vault.snapshot().projects[0];
  const meeting = app.vault.createMeeting({ projectId: project.id, title: 'Synthetic integration test', source: 'manual' });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return { app, temporary, meeting };
}

function fakeHelper(temporary, { fail = false } = {}) {
  const file = path.join(temporary, 'fake-capture.mjs');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
const args=process.argv.slice(2);const emit=event=>process.stdout.write(JSON.stringify(event)+'\\n');
if(args[0]==='screenshot'){emit({type:'cancelled',operation:'screenshot'});process.exit(0)}
if(${fail}){emit({type:'error',message:'Synthetic permission denial'});process.exit(1)}
const directory=args[args.indexOf('--directory')+1];fs.mkdirSync(path.join(directory,'chunks'));
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({status:'recording',complete:false}));
let paused=false,number=0;const journal=path.join(directory,'events.jsonl');
function chunk(){if(paused)return;number++;const name='chunks/mic-'+String(number).padStart(6,'0')+'.caf';fs.writeFileSync(path.join(directory,name),'synthetic fake PCM');const e={type:'chunk',track:'mic',file:name,start:(number-1)*0.04,end:number*0.04};fs.appendFileSync(journal,JSON.stringify(e)+'\\n');emit(e)}
setTimeout(()=>{emit({type:'ready',state:'recording'});emit({type:'state',state:'recording'});emit({type:'level',track:'mic',rms:0.25})},50);
const timer=setInterval(chunk,100);
readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='pause'||line==='resume')setTimeout(()=>{paused=line==='pause';emit({type:'state',state:paused?'paused':'recording'})},80);if(line==='stop'){clearInterval(timer);emit({type:'stopped',complete:true});process.exit(0)}});
`, { mode: 0o700 });
  return file;
}

test('native integration waits for readiness and pause acknowledgement, preserving true recording status', async t => {
  const { app, temporary, meeting } = await fixture(t);
  app.helper = fakeHelper(temporary);
  const starting = app.startCapture(meeting.id, { consent: true, mic: true, system: false });
  assert.equal(app.captureState().ready, false);
  const ready = await starting;
  assert.equal(ready.ready, true);
  await sleep(160);
  assert.equal(app.vault.getMeeting(meeting.id).recordingStatus, 'recording');
  assert.equal(app.captureState().levels.mic, 0.25);
  const pausing = app.captureCommand('pause');
  assert.equal(app.captureState().paused, false, 'Private pause must not be advertised before native acknowledgement');
  assert.equal(app.captureState().pendingCommand, 'pause');
  await pausing;
  assert.equal(app.captureState().paused, true);
  assert.equal(app.vault.getMeeting(meeting.id).recordingStatus, 'paused');
  const savedDuringPause = app.vault.getMeeting(meeting.id).audio.length;
  await sleep(150);
  assert.equal(app.vault.getMeeting(meeting.id).audio.length, savedDuringPause);
  await app.captureCommand('resume');
  assert.equal(app.captureState().paused, false);
  await app.captureCommand('stop');
  assert.equal(app.capture, null);
  assert.equal(app.vault.getMeeting(meeting.id).recordingStatus, 'stopped');
  assert.equal(app.vault.getMeeting(meeting.id).status, 'finalized');
});

test('explicit consent gates spawning and startup failures reject without claiming recording', async t => {
  const { app, temporary, meeting } = await fixture(t);
  app.helper = fakeHelper(temporary, { fail: true });
  await assert.rejects(app.startCapture(meeting.id, { consent: 'false' }), /consent/);
  assert.equal(app.capture, null);
  assert.equal(app.vault.getMeeting(meeting.id).consent.confirmed, false);
  await assert.rejects(app.startCapture(meeting.id, { consent: true }), /Synthetic permission denial/);
  assert.equal(app.capture, null);
  assert.equal(app.vault.getMeeting(meeting.id).recordingStatus, 'failed');
});

test('cancelling the screenshot picker does not claim a saved screenshot', async t => {
  const { app, temporary, meeting } = await fixture(t);
  app.helper = fakeHelper(temporary);
  const result = await app.screenshot(meeting.id);
  assert.equal(result.saved, false);
  assert.equal(result.cancelled, true);
});

test('native synthetic CAF journal recovers idempotently and plays locally without capture permissions', {
  skip: !fs.existsSync(nativeHelper)
}, async t => {
  const { app, meeting } = await fixture(t);
  app.vault.prepareCapture(meeting.id, { consent: true });
  const directory = app.vault.safePath(`meetings/${meeting.id}/audio/capture`);
  const { stdout } = await exec(nativeHelper, ['self-test', '--directory', directory], { maxBuffer: 4 * 1024 * 1024 });
  assert.ok(stdout.includes('"checksPassed":7'));
  app.recoverAudio(); await app.waitASR();
  assert.equal(app.audioFiles(meeting.id).length, 6);
  app.recoverAudio(); await app.waitASR();
  assert.equal(app.audioFiles(meeting.id).length, 6);
  const audio = app.audioFiles(meeting.id)[0];
  assert.ok(['mic', 'system'].includes(audio.track));
  assert.equal(audio.end - audio.start, 5);
  if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
    const wav = await app.playback(meeting.id, audio.file);
    assert.equal(fs.readFileSync(wav).subarray(0, 4).toString(), 'RIFF');
    assert.equal(fs.statSync(wav).mode & 0o777, 0o600);
  }
});

test('derived playback paths reject symlinks before reading a cached WAV', async t => {
  const { app, temporary, meeting } = await fixture(t);
  app.vault.prepareCapture(meeting.id, { consent: true });
  const relative = `meetings/${meeting.id}/audio/source.caf`;
  app.vault.write(relative, 'synthetic');
  app.vault.addAudio(meeting.id, { relativePath: relative, duration: 1 });
  const outside = path.join(temporary, 'outside.txt'); fs.writeFileSync(outside, 'do not read or change');
  fs.symlinkSync(outside, app.vault.safePath(relative + '.playback.wav'));
  await assert.rejects(app.playback(meeting.id, relative), /[Ss]ymbolic|symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not read or change');
});

test('ASR backlog stays bounded in memory and durable spillover drains after transcription catches up', async t => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve; }); let calls = 0;
  const { app, meeting } = await fixture(t, { transcriber: async () => {
    calls++; if (calls === 1) await gate;
    return { segments: [], model: 'synthetic-stub', elapsedMs: 0 };
  } });
  app.vault.prepareCapture(meeting.id, { consent: true });
  for (let index = 0; index < MAX_ASR_QUEUE + 5; index++) {
    const file = `meetings/${meeting.id}/audio/queued-${index}.caf`;
    app.vault.write(file, 'synthetic'); app.vault.addAudio(meeting.id, { relativePath: file, duration: 1 });
    app.queueASR({ meetingId: meeting.id, file, start: index, end: index + 1, track: 'mic' });
  }
  assert.ok(app.asrQueue.length <= MAX_ASR_QUEUE);
  assert.ok(app.asrDeferredCount > 0);
  unblock(); await app.waitASR();
  assert.equal(calls, MAX_ASR_QUEUE + 5);
  assert.equal(app.asrQueue.length, 0);
  assert.equal(app.asrDeferredCount, 0);
  assert.equal(fs.readdirSync(app.vault.safePath(`meetings/${meeting.id}/asr`)).filter(file => file.endsWith('.pending.json')).length, 0);
});

test('restart resumes missing ASR output without duplicating segments or overwriting human corrections', async t => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'meeting-loop-asr-restart-'));
  const root = path.join(temporary, 'vault');
  let calls = 0;
  const options = { root, appRoot, provider: { status: async () => ({ available: false, models: [] }) },
    transcriber: async ({ audioPath, offsetSeconds, speaker }) => {
      calls++;
      return { segments: [{ text: audioPath.endsWith('second.caf') ? 'The second saved chunk.' : 'Original recognized words.',
        speaker, start: offsetSeconds, end: offsetSeconds + 1 }], model: 'synthetic-stub', elapsedMs: 0 };
    } };
  let app = new Application(options);
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const meeting = app.vault.createMeeting({ projectId: app.vault.snapshot().projects[0].id, title: 'Interrupted ASR fixture', source: 'manual' });
  app.vault.prepareCapture(meeting.id, { consent: true });
  const first = `meetings/${meeting.id}/audio/first.caf`;
  const second = `meetings/${meeting.id}/audio/second.caf`;
  app.vault.write(first, 'synthetic'); app.vault.addAudio(meeting.id, { relativePath: first, duration: 1 });
  app.queueASR({ meetingId: meeting.id, file: first, start: 0, end: 1, track: 'mic' });
  await app.waitASR();
  const segment = app.vault.getMeeting(meeting.id).segments[0];
  app.vault.correctSegment(meeting.id, segment.id, { text: 'Human-corrected evidence.', expectedRevision: segment.revision });
  // Simulate a crash after transcript insertion but before the final ASR result was registered.
  fs.unlinkSync(app.vault.safePath(`meetings/${meeting.id}/asr/first.caf.json`));
  app.vault.write(second, 'synthetic'); app.vault.addAudio(meeting.id, { relativePath: second, start: 5, duration: 1 });
  await app.close();
  app = new Application(options);
  await app.waitASR();
  const recovered = app.vault.getMeeting(meeting.id);
  assert.equal(calls, 3);
  assert.equal(recovered.segments.length, 2);
  assert.equal(recovered.segments.find(item => item.id === segment.id).text, 'Human-corrected evidence.');
  assert.equal(recovered.segments.find(item => item.id === segment.id).revision, 2);
  assert.ok(recovered.segments.some(item => item.text === 'The second saved chunk.' && item.start === 5));
  assert.ok(fs.existsSync(app.vault.safePath(`meetings/${meeting.id}/asr/first.caf.json`)));
});

test('failed ASR keeps a stopped meeting editable and explicit retry repairs it before handoff', async t => {
  const { app, temporary, meeting } = await fixture(t, { transcriber: async () => { throw new Error('Synthetic missing speech model'); } });
  app.helper = fakeHelper(temporary);
  await app.startCapture(meeting.id, { consent: true });
  await sleep(130);
  await assert.rejects(app.captureCommand('stop'), /Transcription is pending/);
  assert.equal(app.vault.getMeeting(meeting.id).recordingStatus, 'stopped');
  assert.equal(app.vault.getMeeting(meeting.id).status, 'active');
  app.transcriber = async ({ offsetSeconds, speaker }) => ({ segments: [
    { text: 'Recovered synthetic words.', start: offsetSeconds, end: offsetSeconds + 0.01, speaker }
  ], model: 'synthetic-stub', elapsedMs: 0 });
  assert.ok(app.retryTranscription(meeting.id).queued > 0);
  await app.waitASR();
  const restored = app.vault.getMeeting(meeting.id);
  assert.equal(restored.segments.length, restored.audio.length);
  assert.equal(restored.status, 'active', 'Recovery should leave the final handoff to the user');
  app.vault.finalizeMeeting(meeting.id);
  assert.equal(app.vault.getMeeting(meeting.id).status, 'finalized');
});

test('application shutdown waits for tracked background writes before closing its vault', async t => {
  const { app } = await fixture(t);
  const output = app.vault.safePath('shutdown-check.txt');
  app.background = new Set([sleep(40).then(() => app.vault.write('shutdown-check.txt', 'finished before close'))]);
  await app.close();
  assert.equal(fs.readFileSync(output, 'utf8'), 'finished before close');
});
