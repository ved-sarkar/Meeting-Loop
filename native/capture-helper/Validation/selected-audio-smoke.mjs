// Opt-in only: requires a separately built, visible synthetic NSApplication fixture.
// This never falls back from its own application PID to broad system capture.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { transcribeAudio } from '../../../server/providers/whisper.mjs';

if (process.env.MEETING_LOOP_RUN_SELECTED_AUDIO_SMOKE !== '1') throw new Error('This audible native test is opt-in only.');
const directory = path.resolve(process.argv[2]);
const helper = path.resolve(import.meta.dirname, '../.build/release/meeting-loop-capture');
const exec = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const diagnostics = JSON.parse((await exec(helper, ['diagnostics'])).stdout);
if (diagnostics.screenRecordingPermission !== 'authorized') throw new Error('Permission is not already available; aborting without capture.');
const fixtureExecutable = path.join(directory, 'Synthetic Audio.app/Contents/MacOS/synthetic-audio');
const fixture = spawn(fixtureExecutable, [path.join(directory, 'synthetic-speech.aiff')], { stdio: ['pipe', 'pipe', 'pipe'] });
let capture;
const events = [], signals = new EventEmitter();
const recordingDirectory = path.join(directory, 'selected-app-recording');
const transcript = [];
function eventWhere(predicate, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signals.off('event', listener); reject(new Error('Timed out waiting for native capture acknowledgement.')); }, timeout);
    function listener(event) {
      if (event.type === 'error') { clearTimeout(timer); signals.off('event', listener); reject(new Error(event.message)); }
      else if (predicate(event)) { clearTimeout(timer); signals.off('event', listener); resolve(event); }
    }
    signals.on('event', listener);
  });
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic app did not launch')), 10_000);
    fixture.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    fixture.once('error', reject);
  });
  await wait(800);
  capture = spawn(helper, ['record', '--directory', recordingDirectory, '--consent', '--mic', 'false',
    '--system', 'true', '--application-pid', String(fixture.pid)], { stdio: ['pipe', 'pipe', 'pipe'] });
  capture.stderr.on('data', data => process.stderr.write(data));
  readline.createInterface({ input: capture.stdout }).on('line', line => {
    try { const event = JSON.parse(line); events.push(event); signals.emit('event', event); } catch {}
  });
  const exited = new Promise(resolve => capture.once('close', code => resolve(code)));
  await eventWhere(event => event.type === 'ready');
  const source = events.find(event => event.type === 'source' && event.track === 'system');
  if (source?.scope !== 'application' || source?.pid !== fixture.pid) throw new Error('Own-application selection was not verified.');
  fixture.stdin.write('play\n');
  await wait(5_200);
  const paused = eventWhere(event => event.type === 'state' && event.state === 'paused');
  capture.stdin.write('pause\n'); await paused;
  await wait(2_000);
  const resumed = eventWhere(event => event.type === 'state' && event.state === 'recording');
  capture.stdin.write('resume\n'); await resumed;
  await wait(5_200);
  capture.stdin.write('stop\n');
  const code = await exited;
  fixture.stdin.write('stop\n');
  if (code !== 0) throw new Error('Native capture failed. Original synthetic test files were retained.');
  const chunks = events.filter(event => event.type === 'chunk');
  const privateGap = events.find(event => event.type === 'gap' && event.reason === 'private_pause');
  if (!chunks.length || chunks.some(chunk => chunk.track !== 'system')) throw new Error('Expected system-only chunks.');
  if (!privateGap || privateGap.end - privateGap.start < 1.9) throw new Error('Private-pause gap is missing.');
  if (chunks.some(chunk => chunk.start < privateGap.end && chunk.end > privateGap.start + 0.04)) throw new Error('A saved chunk overlaps the private pause.');
  const levels = events.filter(event => event.type === 'level').map(event => event.rms);
  if (!levels.some(level => level > 0.00001)) throw new Error('Selected application audio was silent.');
  for (const chunk of chunks) {
    const result = await transcribeAudio({ audioPath: path.join(recordingDirectory, chunk.file), offsetSeconds: chunk.start,
      speaker: 'Synthetic test source' });
    transcript.push(...result.segments);
  }
  const result = { passed: true, scope: 'own synthetic application PID only', microphone: false, fixturePid: fixture.pid,
    chunkCount: chunks.length, recordedSeconds: chunks.reduce((total, chunk) => total + chunk.end - chunk.start, 0),
    privateGap, maxRMS: Math.max(...levels), transcript };
  fs.writeFileSync(path.join(directory, 'selected-app-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (capture && capture.exitCode === null) { capture.stdin.write('stop\n'); await wait(300); capture.kill('SIGTERM'); }
  if (fixture.exitCode === null) { fixture.stdin.write('stop\n'); await wait(300); fixture.kill('SIGTERM'); }
}
