import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const string = (value, label, max = 200000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be text, at most ${max} characters.`);
  return value;
};
const nonempty = (value, label, max) => {
  const result = string(value, label, max).trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
};
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value)) throw new Error('Invalid record ID.');
  return value;
};
const normal = (value) => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const hashFile = (filename) => sha256(fs.readFileSync(filename));

function assertNoSymlinks(absolute) {
  const resolved = path.resolve(absolute);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed in vault paths: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

/** Resolve a vault-relative path and reject traversal and existing symlink components. */
export function safePath(root, relative = '') {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) throw new Error('Expected a safe relative vault path.');
  if (relative.split('/').some((part) => part === '..')) throw new Error('Path traversal is not allowed.');
  const base = assertNoSymlinks(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Path is outside the vault.');
  return assertNoSymlinks(target);
}

function atomicWrite(filename, content) {
  assertNoSymlinks(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, filename); } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
}

function treeFiles(root, skip = new Set()) {
  const entries = [];
  function walk(relative) {
    const absolute = safePath(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Backups and deletion refuse symbolic links.');
    if (stat.isFile()) { entries.push(relative); return; }
    if (!stat.isDirectory()) throw new Error('Only regular files and directories are allowed in a vault.');
    for (const name of fs.readdirSync(absolute).sort()) {
      const next = relative ? `${relative}/${name}` : name;
      if (!skip.has(next)) walk(next);
    }
  }
  walk('');
  return entries;
}

const STATES = new Set(['PROPOSED', 'NEEDS_REVIEW', 'READY', 'RUNNING', 'DRAFTED', 'AWAITING_APPROVAL', 'COMPLETED_VERIFIED', 'BLOCKED', 'FAILED', 'CANCELLED']);
const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION, allowPaidApi: false, allow_paid_api: false,
  additionalVendorBudgetUsd: 0, additional_vendor_budget_usd: 0,
  automaticCloud: false, privacyMode: 'LOCAL_ONLY', theme: 'light', userName: 'Alex',
  timeZone: 'America/Los_Angeles', retainAudio: true, fontScale: 1,
});

export class Vault {
  constructor(root = path.join(os.homedir(), 'MeetingLoopVault'), { readOnly = false, recoverRunningTasks = false } = {}) {
    this.root = assertNoSymlinks(path.resolve(root));
    this.readOnly = readOnly;
    if (readOnly) {
      this.db = new DatabaseSync(safePath(this.root, '.state/state.sqlite'), { readOnly: true });
      this.db.exec('PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schemaVersion');
      if (!version || Number(version.value) !== SCHEMA_VERSION) { this.db.close(); throw new Error('Unsupported vault schema.'); }
      return;
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(safePath(this.root, '.git'))) throw new Error('Choose a private vault outside a Git repository.');
    fs.mkdirSync(safePath(this.root, '.state'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(safePath(this.root, '.state/conflicts'), { recursive: true, mode: 0o700 });
    const dbPath = safePath(this.root, '.state/state.sqlite');
    this.db = new DatabaseSync(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, unique_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_search (meeting_id TEXT NOT NULL, project_id TEXT NOT NULL, segment_id TEXT PRIMARY KEY, text TEXT NOT NULL, normalized TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transcript_search_project ON transcript_search(project_id);
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schemaVersion');
    if (version && Number(version.value) !== SCHEMA_VERSION) { this.db.close(); throw new Error('Unsupported vault schema. Restore or migrate explicitly before opening.'); }
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('schemaVersion', String(SCHEMA_VERSION));
    if (!this._get('settings', 'settings')) this._put('settings', { ...DEFAULT_SETTINGS, id: 'settings' });
    this.write('VAULT.md', '# Meeting Loop Vault\n\nLocal meeting evidence and readable exports. SQLite in `.state/state.sqlite` is authoritative for mutable records and task status. Do not edit database files directly. Transcript revisions, human notes, audio and artifacts remain here. Backups may contain deleted meetings until independently removed. Local storage is not itself encryption.\n');
    if (recoverRunningTasks) this._recoverRuns();
    this._recoverHandoffs();
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
  safePath(relative = '') { return safePath(this.root, relative); }
  write(relative, content) { if (this.readOnly) throw new Error('This vault connection is read-only.'); atomicWrite(this.safePath(relative), typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + '\n'); return this.safePath(relative); }
  _get(kind, id) { const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.data) : null; }
  _all(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map((row) => JSON.parse(row.data)); }
  _put(kind, record) { this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, record.id, JSON.stringify(record)); return record; }
  _require(kind, id) { const record = this._get(kind, identifier(id)); if (!record) throw new Error(`${kind} not found.`); return record; }
  _transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  _audit(action, recordId, details = {}) {
    const record = { id: uid('audit'), at: now(), action, recordId, ...details };
    this._put('audit', record);
    const auditPath = this.safePath('.state/audit.jsonl');
    fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  _checkRevision(record, expected) { if (expected !== undefined && expected !== record.revision) throw new Error('This record changed since it was opened. Reload before saving.'); }
  _recoverRuns() {
    for (const task of this._all('task').filter((item) => item.state === 'RUNNING')) {
      task.state = task.status = 'BLOCKED'; task.blocker = 'The application stopped during this run. Review its artifacts before retrying.';
      task.revision++; task.updatedAt = now(); this._put('task', task);
      if (task.currentRunId) {
        const run = this._get('run', task.currentRunId);
        if (run && !run.finishedAt) this._put('run', { ...run, outcome: 'INTERRUPTED', finishedAt: now() });
      }
    }
  }
  recoverInterruptedRuns() { this._recoverRuns(); return this.listTasks({ state: 'BLOCKED' }); }
  _recoverHandoffs() { for (const handoff of this._all('handoff')) this._exportHandoff(handoff); }

  snapshot() {
    return {
      projects: this._all('project'), meetings: this._all('meeting').map((meeting) => ({ ...meeting, segmentCount: this._segments(meeting.id).length })),
      tasks: this._all('task'), settings: this.getSettings(), vaultPath: this.root,
    };
  }
  getSettings() { return { ...this._get('settings', 'settings'), allowPaidApi: false, allow_paid_api: false, additionalVendorBudgetUsd: 0, additional_vendor_budget_usd: 0, automaticCloud: false }; }
  updateSettings(changes) {
    for (const key of ['allowPaidApi', 'allow_paid_api', 'automaticCloud']) if (changes[key] === true) throw new Error('Paid APIs and automatic cloud execution are disabled in this zero-spend build.');
    for (const key of ['additionalVendorBudgetUsd', 'additional_vendor_budget_usd']) if (changes[key] !== undefined && changes[key] !== 0) throw new Error('The additional vendor budget is fixed at $0.');
    const settings = this.getSettings();
    for (const key of ['theme', 'userName', 'timeZone', 'fontScale', 'retainAudio', 'notesTemplate', 'model', 'autoNotes']) if (Object.hasOwn(changes, key)) settings[key] = changes[key];
    if (!['light', 'dark', 'system'].includes(settings.theme)) throw new Error('Unknown theme.');
    nonempty(settings.userName, 'Your name', 120);
    try { new Intl.DateTimeFormat('en-US', { timeZone: settings.timeZone }); } catch { throw new Error('Choose a valid time zone.'); }
    if (typeof settings.fontScale !== 'number' || settings.fontScale < 0.8 || settings.fontScale > 1.6) throw new Error('Font scale must be between 0.8 and 1.6.');
    this._put('settings', settings); this._audit('settings.updated', settings.id); return settings;
  }

  createProject({ name, color = '#8b7cff' } = {}) {
    nonempty(name, 'Project name', 160);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Project color must be a six-digit hex color.');
    const project = { id: uid('project'), name: name.trim(), color, privacyMode: 'LOCAL_ONLY', cloudText: false, cloudImages: false, allowLocalExecution: true, createdAt: now(), updatedAt: now(), revision: 1 };
    this._put('project', project); this._exportProject(project.id); this._audit('project.created', project.id); return project;
  }
  getProject(id) { return this._require('project', id); }
  updateProject(id, changes) {
    const project = this.getProject(id); this._checkRevision(project, changes.expectedRevision);
    if (changes.name !== undefined) project.name = nonempty(changes.name, 'Project name', 160);
    if (changes.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(changes.color)) throw new Error('Invalid color.'); project.color = changes.color; }
    if (changes.cloudText !== undefined) project.cloudText = changes.cloudText === true;
    if (changes.cloudImages !== undefined) project.cloudImages = changes.cloudImages === true;
    project.privacyMode = project.cloudText || project.cloudImages ? 'SUBSCRIPTION_ASSISTED' : 'LOCAL_ONLY';
    project.updatedAt = now(); project.revision++; this._put('project', project); this._exportProject(id); this._audit('project.updated', id); return project;
  }

  createMeeting({ title, projectId, consent = false, source = 'manual', timeZone } = {}) {
    this.getProject(projectId);
    if (!['manual', 'synthetic', 'capture'].includes(source)) throw new Error('Unknown meeting source.');
    const consentGiven = consent === true || consent?.confirmed === true;
    if (source === 'capture' && !consentGiven) throw new Error('Recording consent is required before capture.');
    const meeting = {
      id: uid('meeting'), projectId, title: nonempty(title || 'Untitled meeting', 'Meeting title', 250),
      source, isDemo: source === 'synthetic', consent: { confirmed: consentGiven, recordedAt: consentGiven ? now() : null },
      status: 'active', revision: 1, transcriptRevision: 0, manualNotesRevision: 0, createdAt: now(), updatedAt: now(),
      timeZone: timeZone || this.getSettings().timeZone, audio: [], recordingStatus: source === 'synthetic' ? 'synthetic_text_only' : 'not_recording',
    };
    this._put('meeting', meeting); this.write(`meetings/${meeting.id}/manual-notes.md`, ''); this._exportMeeting(meeting.id); this._audit('meeting.created', meeting.id, { source }); return this.getMeeting(meeting.id);
  }
  _segments(id) { return this._all('segment').filter((segment) => segment.meetingId === id).sort((a, b) => a.sequence - b.sequence); }
  getMeeting(id) {
    const meeting = this._require('meeting', id);
    return { ...meeting, segments: this._segments(id), manualNotes: this._get('manual', id)?.text || '',
      notesVersions: this._all('notes').filter((notes) => notes.meetingId === id).map((notes) => ({ ...notes, markdown: this._notesMarkdown(meeting, notes) })), tasks: this._all('task').filter((task) => task.meetingId === id),
      handoff: this._all('handoff').filter((item) => item.meetingId === id).at(-1) || null };
  }
  addSegment(meetingId, { text, speaker = 'Unknown speaker', start = 0, end, id } = {}) {
    const meeting = this._require('meeting', meetingId);
    if (meeting.status !== 'active') throw new Error('This transcript is finalized. Use correction to preserve revision history.');
    nonempty(text, 'Transcript text', 100000); nonempty(speaker, 'Speaker', 120);
    if (typeof start !== 'number' || start < 0 || !Number.isFinite(start) || (end !== undefined && (typeof end !== 'number' || !Number.isFinite(end) || end < start))) throw new Error('Invalid transcript timestamps.');
    const segmentId = id ? identifier(id) : uid('segment');
    const existing = this._get('segment', segmentId);
    if (existing) {
      if (existing.meetingId === meetingId && existing.originalText === text && existing.start === start && existing.speaker === speaker) return existing;
      throw new Error('Segment ID already exists with different evidence.');
    }
    const segment = { id: segmentId, meetingId, projectId: meeting.projectId, text, originalText: text, speaker, originalSpeaker: speaker, start, end: end ?? start, sequence: this._segments(meetingId).length, revision: 1, createdAt: now(), corrected: false };
    this._transaction(() => { this._put('segment', segment); this._indexSegment(segment); meeting.transcriptRevision++; meeting.revision++; meeting.updatedAt = now(); this._put('meeting', meeting); });
    this._saveTranscriptRevision(meeting); this._exportMeeting(meetingId); return segment;
  }
  correctSegment(meetingId, segmentId, changes) {
    const meeting = this._require('meeting', meetingId); const segment = this._require('segment', segmentId);
    if (segment.meetingId !== meetingId) throw new Error('Segment is not part of this meeting.');
    this._checkRevision(segment, changes.expectedRevision);
    this._put('segmentHistory', { ...segment, id: `${segment.id}_r${segment.revision}`, segmentId: segment.id });
    if (changes.text !== undefined) segment.text = nonempty(changes.text, 'Correction', 100000);
    if (changes.speaker !== undefined) segment.speaker = nonempty(changes.speaker, 'Speaker', 120);
    segment.revision++; segment.corrected = true; segment.updatedAt = now();
    this._transaction(() => { this._put('segment', segment); this._indexSegment(segment); meeting.transcriptRevision++; meeting.revision++; meeting.updatedAt = now(); this._put('meeting', meeting); });
    this._saveTranscriptRevision(meeting); this._exportMeeting(meetingId); this._audit('transcript.corrected', segmentId); this._exportProject(meeting.projectId); return segment;
  }
  _indexSegment(segment) {
    this.db.prepare('DELETE FROM transcript_search WHERE segment_id=?').run(segment.id);
    this.db.prepare('INSERT INTO transcript_search(meeting_id,project_id,segment_id,text,normalized) VALUES(?,?,?,?,?)').run(segment.meetingId, segment.projectId, segment.id, segment.text, normal(segment.text));
  }
  _saveTranscriptRevision(meeting) { this.write(`meetings/${meeting.id}/transcript-revisions/${String(meeting.transcriptRevision).padStart(6, '0')}.json`, { meetingId: meeting.id, transcriptRevision: meeting.transcriptRevision, segments: this._segments(meeting.id) }); }
  saveManualNotes(meetingId, text, expectedRevision) {
    const meeting = this._require('meeting', meetingId); string(text, 'Manual notes');
    const current = this._get('manual', meetingId) || { id: meetingId, text: '', revision: 0 };
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      const conflict = `.state/conflicts/${meetingId}-${Date.now()}-${crypto.randomUUID()}.md`; this.write(conflict, text);
      throw new Error(`Manual notes changed. Your edit was preserved at ${conflict}; reload and merge it.`);
    }
    const filename = this.safePath(`meetings/${meetingId}/manual-notes.md`);
    if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') !== current.text) {
      const conflict = `.state/conflicts/${meetingId}-external-${Date.now()}.md`; this.write(conflict, fs.readFileSync(filename));
      throw new Error(`Manual notes were edited outside Meeting Loop. The external edit was preserved at ${conflict}; import it before saving.`);
    }
    const notes = { id: meetingId, text, revision: current.revision + 1, updatedAt: now() };
    this._put('manual', notes); meeting.manualNotesRevision = notes.revision; meeting.updatedAt = now(); meeting.revision++; this._put('meeting', meeting);
    this.write(`meetings/${meetingId}/manual-notes.md`, text); this._exportMeeting(meetingId); return notes;
  }

  _evidence(meetingId, claim, label) {
    const ids = claim.segmentIds || claim.sourceSegmentIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 30) throw new Error(`${label} needs one or more source segment IDs.`);
    const segments = ids.map((id) => this._require('segment', id));
    if (segments.some((segment) => segment.meetingId !== meetingId)) throw new Error(`${label} references another meeting or project.`);
    const claimText = nonempty(claim.text ?? claim.title, label, 10000);
    const needle = normal(claimText);
    if (needle.length < 3 || !segments.some((segment) => normal(segment.text).includes(needle))) throw new Error(`${label} must quote its cited evidence. Paraphrases require user review.`);
    return { text: claimText, segmentIds: [...new Set(ids)], sourceRevision: this._require('meeting', meetingId).transcriptRevision };
  }
  _validatedOwner(owner, evidence) {
    if (owner === undefined || owner === null || owner === 'unknown' || owner.kind === 'unknown') return { kind: 'unknown', name: null, confirmed: false };
    const data = typeof owner === 'string' ? { kind: owner === 'user' ? 'user' : 'other', name: owner === 'user' ? this.getSettings().userName : owner } : owner;
    if (!['user', 'other'].includes(data.kind)) throw new Error('Unknown owner kind.');
    const name = nonempty(data.name || (data.kind === 'user' ? this.getSettings().userName : ''), 'Owner name', 120);
    const segments = evidence.segmentIds.map((id) => this._require('segment', id));
    const ownerName = normal(name);
    const explicit = segments.some((segment) => {
      const sentences = segment.text.split(/(?<=[.!?])\s+/);
      const wholeSource = normal(segment.text) === normal(evidence.text);
      const relevant = sentences.filter((sentence) => normal(sentence).includes(normal(evidence.text)) || wholeSource && /\b(will|shall|must|assigned to|i'll|am going to)\b/i.test(sentence));
      return relevant.length > 0 && relevant.every((sentence) => {
      const words = normal(sentence);
      const escaped = ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped} (?:will|shall|must) not\\b`).test(words) || /\bi (?:will|shall) not\b/.test(words)) return false;
      return new RegExp(`\\b${escaped} (?:will|shall|must|is assigned to|to)\\b`).test(words)
        || new RegExp(`\\b(?:assigned to|owner is|owner) ${escaped}\\b`).test(words)
        || (normal(segment.speaker) === ownerName && /\bi (?:will|ll|shall|am going to)\b/.test(words));
      });
    });
    if (!explicit) throw new Error('Task ownership is not explicitly supported by the cited transcript. Use unknown owner until the user confirms.');
    return { kind: data.kind, name, confirmed: false, explicitInTranscript: true };
  }
  saveGeneratedNotes(meetingId, input) {
    const meeting = this._require('meeting', meetingId);
    if (input.expectedTranscriptRevision !== undefined && input.expectedTranscriptRevision !== meeting.transcriptRevision) throw new Error('The transcript changed during generation. Regenerate notes.');
    const decisions = (input.decisions || []).map((item) => {
      const evidence = this._evidence(meetingId, item, 'Decision');
      const supported = evidence.segmentIds.some((id) => this._require('segment', id).text.split(/(?<=[.!?])\s+/).some((sentence) => (normal(sentence).includes(normal(evidence.text)) || normal(evidence.text).includes(normal(sentence))) && /\b(decided|agreed|decision|approved|selected|we chose|will use)\b/i.test(sentence) && !/\b(?:not|never) (?:decided|agreed|approved|selected)\b/i.test(sentence)));
      if (!supported) throw new Error('A decision needs explicit decision wording in its cited evidence. Keep uncertain statements as facts.');
      return evidence;
    });
    const questions = (input.questions || []).map((item) => this._evidence(meetingId, item, 'Question'));
    const facts = (input.facts || []).map((item) => this._evidence(meetingId, item, 'Fact'));
    const candidates = (input.tasks || []).map((candidate) => {
      const evidence = this._evidence(meetingId, candidate, 'Task');
      const owner = this._validatedOwner(candidate.owner, evidence);
      if (candidate.dueText && !evidence.segmentIds.some((id) => normal(this._require('segment', id).text).includes(normal(candidate.dueText)))) throw new Error('The due date is not present in the cited evidence.');
      return { ...candidate, title: evidence.text, sourceSegmentIds: evidence.segmentIds, sourceRevision: evidence.sourceRevision, owner };
    });
    const summary = string(input.summary || '', 'Summary', 30000);
    const revision = this._all('notes').filter((record) => record.meetingId === meetingId).length + 1;
    const notes = { id: uid('notes'), meetingId, projectId: meeting.projectId, revision, sourceRevision: meeting.transcriptRevision,
      summary, summaryStatus: 'interpretation_not_independently_verified', decisions, questions, facts, createdAt: now(),
      provider: input.provider || 'local-extractive', promptVersion: input.promptVersion || 'notes-v1',
      sourceHashes: this._segments(meetingId).map((segment) => ({ id: segment.id, revision: segment.revision, sha256: sha256(segment.text) })), taskIds: [],
    };
    this._transaction(() => {
      for (const candidate of candidates) notes.taskIds.push(this._createTaskRecord({ ...candidate, meetingId, projectId: meeting.projectId }, false).id);
      notes.taskProposals = notes.taskIds.map((id) => this._get('task', id));
      this._put('notes', notes);
      meeting.updatedAt = now(); meeting.revision++; this._put('meeting', meeting);
    });
    this._exportMeeting(meetingId); this._exportProject(meeting.projectId);
    for (const handoff of this._all('handoff').filter((record) => record.meetingId === meetingId)) this._exportHandoff(handoff);
    this._audit('notes.generated', notes.id, { sourceRevision: meeting.transcriptRevision }); return notes;
  }

  createTask(input) { const task = this._createTaskRecord(input, true); this._refreshTaskExports(task); return task; }
  _refreshTaskExports(task) {
    this._exportMeeting(task.meetingId); this._exportProject(task.projectId);
    for (const handoff of this._all('handoff').filter((record) => record.meetingId === task.meetingId)) this._exportHandoff(handoff);
  }
  _taskSourceClaimKey(title, sourceIds) {
    const needle = normal(title);
    if (!sourceIds.length) return `manual:${needle}`;
    const sentences = sourceIds.flatMap((id) => this._require('segment', id).text.split(/(?<=[.!?])\s+/).map((text) => ({ id, text: normal(text) })));
    // A short quote and its complete source sentence identify the same claim.
    // Separate sentences in one ASR segment can still propose separate tasks.
    let matches = sentences.filter((sentence) => sentence.text.includes(needle));
    if (!matches.length) {
      const containedAssignments = sentences.filter((sentence) => needle.includes(sentence.text) && /\b(will|shall|must|assigned to|i ll|am going to)\b/.test(sentence.text));
      if (containedAssignments.length === 1) matches = containedAssignments;
    }
    if (!matches.length) return `quote:${needle}`;
    return sha256(JSON.stringify([...new Set(matches.map((sentence) => JSON.stringify([sentence.id, sentence.text])))].sort()));
  }
  _createTaskRecord(input, audit) {
    const meeting = this._require('meeting', input.meetingId);
    if (input.projectId && input.projectId !== meeting.projectId) throw new Error('Task project does not match its meeting.');
    const title = nonempty(input.title, 'Task title', 2000);
    const ids = input.sourceSegmentIds || input.segmentIds || [];
    if (ids.some((id) => this._require('segment', id).meetingId !== meeting.id)) throw new Error('Task evidence belongs to another meeting.');
    const kind = ['report', 'email', 'analysis', 'code', 'research'].includes(input.kind) ? input.kind : /\bemail\b/i.test(title) ? 'email' : 'report';
    const sourceKey = [...new Set(ids)].sort();
    const sourceClaimKey = this._taskSourceClaimKey(title, sourceKey);
    const dedup = sha256(JSON.stringify([meeting.id, kind, sourceKey, sourceClaimKey]));
    const existing = this._all('task').find((task) => task.dedupKey === dedup || (task.meetingId === meeting.id && task.kind === kind && JSON.stringify([...task.sourceSegmentIds].sort()) === JSON.stringify(sourceKey) && (task.sourceClaimKey || this._taskSourceClaimKey(task.title, task.sourceSegmentIds)) === sourceClaimKey));
    if (existing) return existing;
    const owner = input.owner && typeof input.owner === 'object' ? { ...input.owner, confirmed: false } : { kind: 'unknown', name: null, confirmed: false };
    if (!['user', 'other', 'unknown'].includes(owner.kind)) throw new Error('Unknown owner kind.');
    const task = { id: uid('task'), meetingId: meeting.id, projectId: meeting.projectId, title,
      kind,
      owner, sourceRevision: meeting.transcriptRevision, sourceSegmentIds: [...new Set(ids)], segmentIds: [...new Set(ids)], dueText: input.dueText || null, due: { iso: null, originalText: input.dueText || null, interpretation: 'unresolved' },
      state: 'PROPOSED', status: 'PROPOSED', riskClass: 'local_reversible', privacyMode: 'LOCAL_ONLY', executionAdapter: 'local',
      approvalRequiredFor: /\bemail|send|publish|upload|post\b/i.test(title) ? ['external_write'] : [],
      expectedOutputs: [], dependencies: [], revision: 1, createdAt: now(), updatedAt: now(), dedupKey: dedup, sourceClaimKey, artifacts: [], runs: [],
      externalStatus: /\bemail\b/i.test(title) ? 'not_sent' : null,
    };
    this._put('task', task); if (audit) this._audit('task.proposed', task.id); return task;
  }
  readTask(id) { const task = this._require('task', id); return { ...task, runResults: this._all('run').filter((run) => run.taskId === id) }; }
  getTask(id) { return this.readTask(id); }
  listTasks({ projectId, state, includeCancelled = false } = {}) {
    if (projectId) this.getProject(projectId);
    return this._all('task').filter((task) => (!projectId || task.projectId === projectId) && (!state || task.state === state) && (includeCancelled || task.state !== 'CANCELLED'));
  }
  approveTask(id, { expectedRevision, owner = 'user' } = {}) {
    const task = this._require('task', id); this._checkRevision(task, expectedRevision);
    if (!['PROPOSED', 'NEEDS_REVIEW', 'BLOCKED', 'FAILED'].includes(task.state)) throw new Error('This task cannot be approved in its current state.');
    if (owner !== 'user') throw new Error('Only work explicitly accepted by the user can enter this executor.');
    task.owner = { kind: 'user', name: this.getSettings().userName, confirmed: true, confirmedAt: now() };
    task.state = task.status = 'READY'; task.approvedAt = now(); task.revision++; task.updatedAt = now();
    this._put('task', task); this._audit('task.approved', id, { scope: 'local_reversible', externalWrites: false }); this._refreshTaskExports(task); return task;
  }
  updateTask(id, changes = {}) {
    const task = this._require('task', id); this._checkRevision(task, changes.expectedRevision);
    const target = changes.state || changes.status;
    if (target === 'CANCELLED') return this.cancelTask(id, changes.expectedRevision);
    if (target && !['PROPOSED', 'NEEDS_REVIEW', 'BLOCKED', 'FAILED'].includes(target)) throw new Error('Approval, execution and evidence are required for this state transition.');
    if (task.state === 'RUNNING' && changes.title !== undefined) throw new Error('Cancel the active run before changing its scope.');
    if (changes.title !== undefined) {
      task.title = nonempty(changes.title, 'Task title', 2000);
      task.state = task.status = 'NEEDS_REVIEW'; task.owner.confirmed = false;
    }
    if (changes.blocker !== undefined) task.blocker = string(changes.blocker, 'Blocker', 5000);
    if (target) task.state = task.status = target;
    task.revision++; task.updatedAt = now(); this._put('task', task); this._audit('task.updated', id); this._refreshTaskExports(task); return task;
  }
  cancelTask(id, expectedRevision) {
    const task = this._require('task', id); this._checkRevision(task, expectedRevision);
    if (task.state === 'CANCELLED') return task;
    task.state = task.status = 'CANCELLED'; task.cancelledAt = now(); task.updatedAt = now(); task.revision++;
    this._put('task', task); this._audit('task.cancelled', id); this._refreshTaskExports(task); return task;
  }
  startTask(id, { expectedRevision, provider = 'local', runtime = 'local-deterministic' } = {}) {
    const task = this._require('task', id); this._checkRevision(task, expectedRevision);
    if (task.state !== 'READY' || task.owner.kind !== 'user' || !task.owner.confirmed) throw new Error('Review and approve this task before running it.');
    if (this._all('task').some((item) => item.state === 'RUNNING')) throw new Error('A task is already running. This build uses one execution worker.');
    if (provider !== 'local') throw new Error('Task execution is local-only. Interactive cloud assistance does not authorize unattended cloud execution.');
    const run = { id: uid('run'), taskId: id, projectId: task.projectId, provider, runtime, startedAt: now(), finishedAt: null, outcome: 'RUNNING',
      inputHashes: this._segments(task.meetingId).map((segment) => ({ id: segment.id, sha256: sha256(segment.text) })),
      transcriptRevision: this._require('meeting', task.meetingId).transcriptRevision, manualNotesHash: sha256(this._get('manual', task.meetingId)?.text || ''),
      artifacts: [], tests: [], citations: [], pendingApprovals: [], unresolvedItems: [], externalConfirmations: [] };
    task.state = task.status = 'RUNNING'; task.currentRunId = run.id; task.revision++; task.updatedAt = now(); run.expectedTaskRevision = task.revision;
    this._transaction(() => { this._put('run', run); this._put('task', task); });
    const relativeOutputDirectory = this.artifactRelativePath(id, `runs/${run.id}`); const outputDirectory = this.safePath(relativeOutputDirectory);
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 }); this._refreshTaskExports(task); this._audit('task.started', id, { runId: run.id }); return { task, run, outputDirectory, relativeOutputDirectory };
  }
  artifactRelativePath(taskId, filename = '') { const task = this._require('task', taskId); const relative = `projects/${task.projectId}/artifacts/${task.id}${filename ? '/' + filename : ''}`; this.safePath(relative); return relative; }
  artifactPath(taskId, filename = '') { return this.safePath(this.artifactRelativePath(taskId, filename)); }
  writeArtifact(taskId, filename, content, mediaType = 'text/markdown') {
    const task = this._require('task', taskId);
    if (task.state !== 'RUNNING') throw new Error('Artifacts can only be written inside an approved active run.');
    const relativePath = this.artifactRelativePath(taskId, `runs/${task.currentRunId}/${filename}`);
    const prefix = this.artifactRelativePath(taskId) + '/';
    if (!relativePath.startsWith(prefix) || !filename || filename.includes('/')) throw new Error('Use a simple filename for an artifact.');
    this.write(relativePath, content); return { relativePath, sha256: hashFile(this.safePath(relativePath)), mediaType, size: fs.statSync(this.safePath(relativePath)).size };
  }
  completeRun(taskId, result) {
    const task = this._require('task', taskId);
    const runId = result.runId || result.run_id || task.currentRunId;
    const run = this._require('run', runId);
    if (run.taskId !== taskId || task.currentRunId !== run.id) throw new Error('Run does not belong to this task.');
    if (run.finishedAt) {
      if (run.outcome === 'COMPLETED_VERIFIED' || run.outcome === 'DRAFTED') return this.readTask(taskId);
      throw new Error('This run has already ended.');
    }
    if (task.state !== 'RUNNING') throw new Error('The task is no longer running; completion was refused.');
    this._checkRevision(task, result.expectedTaskRevision ?? result.expected_task_revision ?? run.expectedTaskRevision);
    if (!Array.isArray(result.artifacts) || !result.artifacts.length) throw new Error('A successful run must have at least one actual artifact.');
    const artifacts = result.artifacts.map((artifact) => {
      const relativePath = artifact.relativePath || artifact.relative_path;
      if (typeof relativePath !== 'string' || !relativePath.startsWith(this.artifactRelativePath(taskId, `runs/${run.id}`) + '/')) throw new Error('Artifact is outside this run’s output directory.');
      const absolute = this.safePath(relativePath);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error('An artifact is missing.');
      const actualHash = hashFile(absolute);
      if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 || '') || actualHash !== artifact.sha256) throw new Error('Artifact hash mismatch.');
      return { relativePath, sha256: actualHash, mediaType: artifact.mediaType || artifact.media_type || 'application/octet-stream', size: fs.statSync(absolute).size };
    });
    for (const input of run.inputHashes) if (sha256(this._require('segment', input.id).text) !== input.sha256) throw new Error('Source evidence changed during execution. Review before accepting this result.');
    if (run.transcriptRevision !== this._require('meeting', task.meetingId).transcriptRevision || run.manualNotesHash !== sha256(this._get('manual', task.meetingId)?.text || '')) throw new Error('Meeting context changed during execution. Review before accepting this result.');
    const tests = result.tests || [];
    if (!Array.isArray(tests)) throw new Error('Test evidence must be a list.');
    for (const test of tests) {
      if (!Number.isInteger(test.exitCode ?? test.exit_code) || !test.command) throw new Error('Each test needs a command and actual exit code.');
      const logRef = test.logRef || test.log_ref;
      if (!logRef || !logRef.startsWith(this.artifactRelativePath(taskId) + '/') || !fs.existsSync(this.safePath(logRef))) throw new Error('Test evidence needs a scoped, saved execution log.');
    }
    if (tests.some((test) => (test.exitCode ?? test.exit_code) !== 0) && result.outcome !== 'DRAFTED') throw new Error('Failed tests cannot produce a verified completion.');
    if ((result.externalConfirmations || result.external_confirmations || []).length) throw new Error('External writes are not supported by this local executor; no send confirmation can be accepted.');
    const emailArtifact = task.kind === 'email' || artifacts.some((artifact) => /\.eml$|email|mail-draft/i.test(artifact.relativePath));
    const outcome = emailArtifact || result.outcome === 'DRAFTED' ? 'DRAFTED' : 'COMPLETED_VERIFIED';
    const completed = { ...run, finishedAt: now(), outcome, artifacts, tests,
      citations: Array.isArray(result.citations) ? result.citations : [], pendingApprovals: emailArtifact ? ['send_email'] : (result.pendingApprovals || []),
      unresolvedItems: result.unresolvedItems || result.unresolved_items || [], externalConfirmations: [],
      nextMeetingBrief: string(result.nextMeetingBrief || result.next_meeting_brief || 'Local artifacts were saved. Review them before relying on their content.', 'Completion brief', 20000),
    };
    task.state = task.status = outcome; task.artifacts = artifacts; task.runs.push(run.id); task.revision++; task.updatedAt = now(); task.completedAt = now();
    task.externalStatus = emailArtifact ? 'draft_unsent' : null; task.pendingApprovals = completed.pendingApprovals;
    this._transaction(() => { this._put('run', completed); this._put('task', task); });
    this.write(`${this.artifactRelativePath(taskId, `runs/${run.id}`)}/run-result.json`, completed); this._refreshTaskExports(task); this._audit('task.result_verified', taskId, { runId: run.id, outcome, artifactCount: artifacts.length }); return this.readTask(taskId);
  }
  failRun(taskId, message) {
    const task = this._require('task', taskId);
    if (task.state !== 'RUNNING') return task;
    const run = this._require('run', task.currentRunId); run.outcome = 'FAILED'; run.finishedAt = now(); run.unresolvedItems = [string(message, 'Failure', 5000)];
    task.state = task.status = 'FAILED'; task.blocker = message; task.revision++; task.updatedAt = now(); this._transaction(() => { this._put('run', run); this._put('task', task); }); this._refreshTaskExports(task); return task;
  }

  finalizeMeeting(id) {
    const meeting = this._require('meeting', id);
    this._saveTranscriptRevision(meeting);
    const uniqueKey = `${id}:${meeting.transcriptRevision}:handoff-v1`;
    const existingEvent = this.db.prepare('SELECT data FROM events WHERE unique_key=?').get(uniqueKey);
    if (existingEvent) {
      const event = JSON.parse(existingEvent.data); const handoff = this._require('handoff', event.handoffId); this._exportHandoff(handoff);
      return { meeting: this.getMeeting(id), event, handoff, alreadyFinalized: true };
    }
    const event = { id: uid('event'), type: 'meeting.finalized', meetingId: id, projectId: meeting.projectId, transcriptRevision: meeting.transcriptRevision, workflowVersion: 'handoff-v1', createdAt: now(), handoffId: uid('handoff') };
    const handoff = { id: event.handoffId, eventId: event.id, meetingId: id, projectId: meeting.projectId, sourceRevision: meeting.transcriptRevision, status: 'PREPARED', createdAt: now(), taskIds: this._all('task').filter((task) => task.meetingId === id).map((task) => task.id) };
    this._transaction(() => {
      meeting.status = 'finalized'; meeting.finalizedAt = now(); meeting.updatedAt = now(); meeting.revision++; this._put('meeting', meeting);
      this._put('handoff', handoff); this.db.prepare('INSERT INTO events(id,unique_key,data) VALUES(?,?,?)').run(event.id, uniqueKey, JSON.stringify(event));
    });
    this._exportMeeting(id); this._exportHandoff(handoff); this._exportProject(meeting.projectId); this._audit('meeting.finalized', id, { eventId: event.id, handoffId: handoff.id });
    return { meeting: this.getMeeting(id), event, handoff, alreadyFinalized: false };
  }
  getEvents() { return this.db.prepare('SELECT data FROM events ORDER BY rowid').all().map((row) => JSON.parse(row.data)); }

  search(query = '', options = {}) {
    if (typeof query === 'object') { options = query; query = options.query || ''; }
    string(query, 'Search query', 500); const { projectId, limit = 30 } = options;
    if (projectId) this.getProject(projectId);
    const count = Math.max(1, Math.min(100, Number(limit) || 30));
    const scopedMeetings = this._all('meeting').filter((meeting) => !projectId || meeting.projectId === projectId);
    if (!query.trim()) return scopedMeetings.slice(-count).reverse().map((meeting) => ({ meetingId: meeting.id, projectId: meeting.projectId, title: meeting.title, excerpt: '', segmentId: null, start: 0, sourceRevision: meeting.transcriptRevision }));
    const terms = query.match(/[\p{L}\p{N}_]+/gu) || [];
    if (!terms.length) return [];
    // The installed Node SQLite build lacks FTS5. A normalized, bound lexical
    // index keeps offline search correct without native dependency installation.
    const clauses = terms.map(() => "instr(' ' || normalized || ' ', ?) > 0");
    const params = terms.map((word) => ` ${normal(word)} `);
    if (projectId) { clauses.unshift('project_id=?'); params.unshift(projectId); }
    const rows = this.db.prepare(`SELECT meeting_id,project_id,segment_id,text FROM transcript_search WHERE ${clauses.join(' AND ')} LIMIT ?`).all(...params, count);
    const results = rows.map((row) => {
      const meeting = this._require('meeting', row.meeting_id); const segment = this._require('segment', row.segment_id);
      return { meetingId: meeting.id, projectId: meeting.projectId, title: meeting.title, segmentId: segment.id, excerpt: segment.text.slice(0, 450), start: segment.start, end: segment.end, speaker: segment.speaker, sourceRevision: meeting.transcriptRevision };
    });
    for (const meeting of scopedMeetings) if (normal(meeting.title).includes(normal(query)) && !results.some((result) => result.meetingId === meeting.id)) results.push({ meetingId: meeting.id, projectId: meeting.projectId, title: meeting.title, segmentId: null, excerpt: '', start: 0, sourceRevision: meeting.transcriptRevision });
    return results.slice(0, count);
  }
  readTranscript(meetingId, { revision, offset = 0, limit = 100, projectId } = {}) {
    const meeting = this._require('meeting', meetingId);
    if (projectId && projectId !== meeting.projectId) throw new Error('Meeting is outside the selected project.');
    if (revision !== undefined && revision !== meeting.transcriptRevision) throw new Error('Transcript revision changed. Read current meeting metadata first.');
    const start = Math.max(0, Number(offset) || 0); const size = Math.max(1, Math.min(200, Number(limit) || 100)); const segments = this._segments(meetingId);
    return { meetingId, projectId: meeting.projectId, revision: meeting.transcriptRevision, audio: meeting.audio, total: segments.length, segments: segments.slice(start, start + size), nextOffset: start + size < segments.length ? start + size : null };
  }
  readProjectBrief(projectId) {
    const project = this.getProject(projectId); const tasks = this.listTasks({ projectId });
    const deliverables = [];
    for (const task of tasks.filter((task) => ['COMPLETED_VERIFIED', 'DRAFTED', 'AWAITING_APPROVAL'].includes(task.state))) {
      const artifactChecks = task.artifacts.map((artifact) => {
        let verified = false;
        try { verified = hashFile(this.safePath(artifact.relativePath)) === artifact.sha256; } catch { /* A missing artifact must not count as complete. */ }
        let excerpt = null;
        if (verified && /^(text\/|message\/rfc822)/.test(artifact.mediaType)) {
          const content = fs.readFileSync(this.safePath(artifact.relativePath), 'utf8'); excerpt = content.slice(0, 2000);
        }
        return { ...artifact, verified, excerpt };
      });
      const verified = artifactChecks.length > 0 && artifactChecks.every((artifact) => artifact.verified);
      const run = task.currentRunId ? this._get('run', task.currentRunId) : null;
      deliverables.push({ taskId: task.id, title: task.title, state: verified ? task.state : 'EVIDENCE_CHANGED', verified,
        artifacts: artifactChecks, externalStatus: task.externalStatus, pendingApprovals: task.pendingApprovals || [],
        brief: verified ? `${artifactChecks.length} local artifact${artifactChecks.length === 1 ? '' : 's'} saved and hash-verified: ${artifactChecks.map((artifact) => path.basename(artifact.relativePath)).join(', ')}. ${task.externalStatus === 'draft_unsent' ? 'Email has not been sent.' : 'No external action was performed.'}` : 'Saved output is missing or changed. Re-verify before claiming completion.',
        runCommentary: run?.nextMeetingBrief || '', runCommentaryStatus: 'unverified_interpretation', tests: run?.tests || [], unresolvedItems: run?.unresolvedItems || [] });
    }
    const decisions = [];
    for (const meeting of this._all('meeting').filter((item) => item.projectId === projectId)) {
      const notes = this._all('notes').filter((item) => item.meetingId === meeting.id).at(-1);
      if (notes && notes.sourceRevision === meeting.transcriptRevision) decisions.push(...notes.decisions.map((decision) => ({ ...decision, meetingId: meeting.id })));
    }
    const activeTasks = tasks.filter((task) => !['COMPLETED_VERIFIED', 'DRAFTED', 'AWAITING_APPROVAL'].includes(task.state));
    return { projectId, projectName: project.name, generatedAt: now(), privacyMode: project.privacyMode, deliverables, activeTasks, decisions,
      text: [`# ${project.name}`, '', '## Verified deliverables', ...(deliverables.length ? deliverables.map((item) => `- ${item.title}: ${item.verified ? item.state : 'evidence changed'}${item.externalStatus === 'draft_unsent' ? ' — email draft saved; UNSENT' : ''}. ${item.brief}`) : ['No verified deliverables yet.']), '', '## Outstanding work', ...(activeTasks.length ? activeTasks.map((task) => `- ${task.title} — ${task.state}; owner: ${task.owner.name || 'unknown'}`) : ['No active commitments.']), '', '## Decisions supported by the current transcript', ...(decisions.length ? decisions.map((decision) => `- ${decision.text} [${decision.segmentIds.join(', ')}]`) : ['No current verified decisions.'])].join('\n') };
  }
  getProjectBrief(projectId) { return this.readProjectBrief(projectId); }
  brief(projectId) { return this.readProjectBrief(projectId); }
  _exportProject(id) { const project = this.getProject(id); this.write(`projects/${id}/project.json`, project); this.write(`projects/${id}/brief.md`, this.readProjectBrief(id).text + '\n'); }
  _notesMarkdown(meeting, notes) {
    const proposals = notes.taskProposals || notes.taskIds.map((id) => this._get('task', id)).filter(Boolean);
    return `# ${meeting.title}\n\nTranscript revision: ${notes.sourceRevision}. Provider: ${notes.provider}.\n\n## Summary — generated interpretation\n${notes.summary}\n\n## Decisions (quoted evidence)\n${notes.decisions.map((item) => `- ${item.text} [${item.segmentIds.join(', ')}]`).join('\n') || 'None extracted.'}\n\n## Open questions\n${notes.questions.map((item) => `- ${item.text} [${item.segmentIds.join(', ')}]`).join('\n') || 'None extracted.'}\n\n## Task proposals when these notes were generated\n${proposals.map((task) => `- ${task.title} — ${task.owner.name || 'owner unknown'}; ${task.state}`).join('\n')}\n\nHuman notes are kept separately in manual-notes.md. Current task status is authoritative in the task queue and project brief.\n`;
  }
  _exportMeeting(id) {
    const meeting = this.getMeeting(id); const { segments, manualNotes, notesVersions, tasks, handoff, ...manifest } = meeting;
    this.write(`meetings/${id}/manifest.json`, manifest);
    this.write(`meetings/${id}/transcript.jsonl`, segments.map((segment) => JSON.stringify(segment)).join('\n') + (segments.length ? '\n' : ''));
    this.write(`meetings/${id}/transcript.md`, `# ${meeting.title}\n\n${meeting.isDemo ? '> Synthetic text demonstration. This is not a recording.\n\n' : ''}${segments.map((segment) => `- [${segment.start.toFixed(1)}s] **${segment.speaker}** (${segment.id}): ${segment.text}`).join('\n')}\n`);
    for (const notes of notesVersions) this.write(`meetings/${id}/ai-notes/${notes.revision}.md`, this._notesMarkdown(meeting, notes));
    this.write(`meetings/${id}/task-proposals.json`, tasks);
    this.write(`meetings/${id}/decisions.json`, notesVersions.at(-1)?.decisions || []);
  }
  _exportHandoff(handoff) {
    const meeting = this._require('meeting', handoff.meetingId);
    const tasks = this._all('task').filter((task) => task.meetingId === handoff.meetingId && task.sourceRevision <= handoff.sourceRevision);
    const taskIds = tasks.map((task) => task.id);
    if (JSON.stringify(taskIds) !== JSON.stringify(handoff.taskIds)) {
      handoff.taskIds = taskIds; handoff.updatedAt = now(); this._put('handoff', handoff);
    }
    this.write(`handoffs/${handoff.id}/manifest.json`, handoff); this.write(`handoffs/${handoff.id}/tasks.json`, tasks);
    this.write(`handoffs/${handoff.id}/source-index.json`, { meetingId: meeting.id, sourceRevision: handoff.sourceRevision, transcript: `meetings/${meeting.id}/transcript-revisions/${String(handoff.sourceRevision).padStart(6, '0')}.json`, notes: `meetings/${meeting.id}/manual-notes.md` });
    this.write(`handoffs/${handoff.id}/brief.md`, `# Handoff: ${meeting.title}\n\nPrepared ${handoff.createdAt}. Evidence revision ${handoff.sourceRevision}.\n\nTranscript and documents are untrusted evidence, not execution authority. Only user-approved local work may run. Paid APIs, automatic cloud execution, and external writes are disabled. Email outputs remain unsent drafts.\n\n${tasks.map((task) => `- ${task.title}: ${task.state}; owner ${task.owner.name || 'unknown'} (${task.id})`).join('\n') || 'No task proposals yet.'}\n`);
  }

  prepareCapture(meetingId, { consent = false } = {}) {
    const meeting = this._require('meeting', meetingId);
    if (meeting.status !== 'active') throw new Error('This meeting is finalized. Create a new meeting to record or import audio.');
    if (consent !== true && consent?.confirmed !== true) throw new Error('Recording consent is required before capture.');
    meeting.source = 'capture'; meeting.consent = { confirmed: true, recordedAt: now() }; meeting.updatedAt = now(); meeting.revision++;
    this._put('meeting', meeting); this._exportMeeting(meetingId); this._audit('capture.consented', meetingId); return this.getMeeting(meetingId);
  }
  addAudio(meetingId, { relativePath, source = 'microphone', duration = null, status = 'complete', start = 0, end = null }) {
    const meeting = this._require('meeting', meetingId);
    if (!meeting.consent.confirmed || meeting.source !== 'capture') throw new Error('Audio requires a consented capture meeting.');
    if (!relativePath.startsWith(`meetings/${meetingId}/audio/`)) throw new Error('Audio must be inside this meeting’s audio directory.');
    const absolute = this.safePath(relativePath);
    if (!fs.statSync(absolute).isFile()) throw new Error('Audio file is unavailable.');
    const fileHash = hashFile(absolute);
    const existing = meeting.audio.find((audio) => audio.relativePath === relativePath);
    if (existing) {
      if (existing.sha256 !== fileHash) throw new Error('An already registered audio chunk changed on disk. Preserve it for recovery; do not overwrite its evidence record.');
      return existing;
    }
    const item = { id: uid('audio'), relativePath, file: relativePath, source, duration, start, end: end ?? (duration === null ? null : start + duration), status, sha256: fileHash, createdAt: now() };
    meeting.audio.push(item); meeting.recordingStatus = status; meeting.updatedAt = now(); meeting.revision++; this._put('meeting', meeting); this._exportMeeting(meetingId); return item;
  }
  addAudioChunk(meetingId, event) {
    const relativePath = event.relativePath || event.path || event.file;
    const relative = path.isAbsolute(relativePath) ? path.relative(this.root, relativePath) : relativePath;
    return this.addAudio(meetingId, { ...event, relativePath: relative, source: event.source || event.track || 'microphone', duration: event.duration ?? event.durationSeconds ?? null });
  }
  updateRecordingStatus(meetingId, status) {
    const meeting = this._require('meeting', meetingId);
    if (!['recording', 'paused', 'stopped', 'failed', 'interrupted', 'not_recording'].includes(status)) throw new Error('Invalid recording state.');
    if (status === 'recording' && !meeting.consent.confirmed) throw new Error('Recording consent is required.');
    meeting.recordingStatus = status; meeting.updatedAt = now(); this._put('meeting', meeting); this._exportMeeting(meetingId); return meeting;
  }

  backup(destination) {
    const id = uid('backup'); const target = destination ? assertNoSymlinks(path.resolve(destination)) : this.safePath(`.state/backups/${id}`);
    if (target === this.root || (target.startsWith(this.root + path.sep) && !target.startsWith(this.safePath('.state/backups') + path.sep))) throw new Error('A backup must be outside the vault or inside its dedicated backups folder.');
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Backup destination must be empty. Existing files will not be overwritten.');
    const files = treeFiles(this.root, new Set(['.state/backups', '.state/state.sqlite', '.state/state.sqlite-wal', '.state/state.sqlite-shm']));
    fs.mkdirSync(target, { recursive: true, mode: 0o700 }); fs.mkdirSync(safePath(target, '.state'), { recursive: true, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(safePath(target, '.state/state.sqlite'));
    fs.chmodSync(safePath(target, '.state/state.sqlite'), 0o600);
    for (const relative of files) { const to = safePath(target, relative); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(this.safePath(relative), to, fs.constants.COPYFILE_EXCL); }
    const manifest = { schemaVersion: SCHEMA_VERSION, id, createdAt: now(), encryption: 'not_verified', files: treeFiles(target).map((relativePath) => ({ relativePath, sha256: hashFile(safePath(target, relativePath)) })) };
    atomicWrite(safePath(target, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); this._audit('vault.backup', id, { fileCount: manifest.files.length });
    return { id, path: target, fileCount: manifest.files.length, encryption: 'not_verified' };
  }
  exportVault(destination) { return this.backup(destination); }
  static restoreBackup(source, destination) {
    const from = assertNoSymlinks(path.resolve(source)); const target = assertNoSymlinks(path.resolve(destination));
    if (from === target || target.startsWith(from + path.sep) || from.startsWith(target + path.sep)) throw new Error('Restore into a separate empty directory.');
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Restore destination must be empty.');
    const manifest = JSON.parse(fs.readFileSync(safePath(from, 'backup-manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.files)) throw new Error('Unsupported or corrupt backup manifest.');
    treeFiles(from);
    if (!manifest.files.some((item) => item.relativePath === '.state/state.sqlite')) throw new Error('Backup has no state database.');
    for (const item of manifest.files) if (hashFile(safePath(from, item.relativePath)) !== item.sha256) throw new Error(`Backup integrity check failed: ${item.relativePath}`);
    for (const item of manifest.files) {
      const to = safePath(target, item.relativePath); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(safePath(from, item.relativePath), to, fs.constants.COPYFILE_EXCL);
    }
    const restored = new Vault(target); restored._audit('vault.restored', manifest.id); restored.close(); return { path: target, fileCount: manifest.files.length };
  }
  exportMeeting(meetingId, destination) {
    this.getMeeting(meetingId); const source = this.safePath(`meetings/${meetingId}`); const target = assertNoSymlinks(path.resolve(destination));
    if (target === this.root || target.startsWith(this.root + path.sep)) throw new Error('Export meetings outside the managed vault.');
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Export destination must be empty.');
    const files = treeFiles(source);
    for (const relative of files) { const to = safePath(target, relative); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(safePath(source, relative), to, fs.constants.COPYFILE_EXCL); }
    return { path: target, fileCount: files.length };
  }
  deleteMeeting(meetingId) {
    const meeting = this._require('meeting', meetingId); const tasks = this._all('task').filter((task) => task.meetingId === meetingId); const taskIds = new Set(tasks.map((task) => task.id));
    if (tasks.some((task) => task.state === 'RUNNING')) throw new Error('Stop the active task before deleting its meeting.');
    const handoffs = this._all('handoff').filter((handoff) => handoff.meetingId === meetingId);
    const paths = [`meetings/${meetingId}`, ...tasks.map((task) => this.artifactRelativePath(task.id)), ...handoffs.map((handoff) => `handoffs/${handoff.id}`)];
    for (const relative of paths) if (fs.existsSync(this.safePath(relative))) treeFiles(this.safePath(relative));
    this._transaction(() => {
      for (const kind of ['meeting', 'manual', 'segment', 'segmentHistory', 'notes', 'task', 'run', 'handoff']) for (const record of this._all(kind)) {
        if ((kind === 'meeting' || kind === 'manual') && record.id === meetingId || record.meetingId === meetingId || kind === 'run' && taskIds.has(record.taskId)) this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, record.id);
      }
      this.db.prepare('DELETE FROM transcript_search WHERE meeting_id=?').run(meetingId);
      for (const event of this.getEvents().filter((item) => item.meetingId === meetingId)) this.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
    });
    for (const relative of paths) fs.rmSync(this.safePath(relative), { recursive: true, force: true });
    for (const name of fs.readdirSync(this.safePath('.state/conflicts')).filter((name) => name.startsWith(meetingId))) fs.rmSync(this.safePath(`.state/conflicts/${name}`), { force: true });
    this._exportProject(meeting.projectId); this._audit('meeting.deleted', meetingId);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return { deleted: true, meetingId, notice: 'Independent backups, exports, and any previously approved cloud requests have separate retention.' };
  }
  deleteProject(projectId) {
    this.getProject(projectId);
    const projectDirectory = this.safePath(`projects/${projectId}`);
    if (fs.existsSync(projectDirectory)) treeFiles(projectDirectory);
    const meetings = this._all('meeting').filter((meeting) => meeting.projectId === projectId);
    if (this._all('task').some((task) => task.projectId === projectId && task.state === 'RUNNING')) throw new Error('Stop running tasks before deleting this project.');
    for (const meeting of meetings) this.deleteMeeting(meeting.id);
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('project', projectId);
    fs.rmSync(projectDirectory, { recursive: true, force: true });
    this._audit('project.deleted', projectId); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return { deleted: true, projectId, notice: 'Independent backups, exports, and previous cloud requests have separate retention.' };
  }

  createSyntheticDemo() {
    const existing = this._all('meeting').find((meeting) => meeting.demoFixture === 'report-email-v1');
    if (existing) return this.getMeeting(existing.id);
    const project = this.createProject({ name: 'Product studio', color: '#a99bff' });
    const meeting = this.createMeeting({ title: 'Design review · sample meeting', projectId: project.id, source: 'synthetic' });
    const segments = [
      { speaker: 'Maya', start: 0, end: 12, text: 'For the first release, we decided to keep meeting recordings and transcripts on this Mac.' },
      { speaker: 'Alex', start: 13, end: 25, text: 'I will draft the design report describing the local vault, consent, task approvals, and evidence-based project memory.' },
      { speaker: 'Maya', start: 26, end: 39, text: 'Alex will draft the follow-up email summarizing this plan. Save it as an unsent draft for review; do not send it.' },
      { speaker: 'Alex', start: 40, end: 52, text: 'We decided that the additional vendor budget is zero dollars. Paid API calls and automatic cloud jobs will stay disabled.' },
      { speaker: 'Maya', start: 53, end: 61, text: 'How will we verify both microphone and system audio before using real meetings?' },
    ].map((segment) => this.addSegment(meeting.id, segment));
    this.saveManualNotes(meeting.id, 'Keep the flow calm and easy to scan. Original audio stays local. Review every draft before sharing.');
    this.saveGeneratedNotes(meeting.id, { summary: 'This synthetic design review covers a local-first meeting assistant, a zero-dollar additional vendor budget, and two draft deliverables. Audio capture still requires native validation.',
      decisions: [{ text: 'keep meeting recordings and transcripts on this Mac', segmentIds: [segments[0].id] }, { text: 'the additional vendor budget is zero dollars', segmentIds: [segments[3].id] }],
      questions: [{ text: segments[4].text, segmentIds: [segments[4].id] }],
      tasks: [{ title: 'draft the design report describing the local vault, consent, task approvals, and evidence-based project memory', kind: 'report', owner: { kind: 'user', name: 'Alex' }, segmentIds: [segments[1].id] }, { title: 'draft the follow-up email summarizing this plan', kind: 'email', owner: { kind: 'user', name: 'Alex' }, segmentIds: [segments[2].id] }],
    });
    const record = this._require('meeting', meeting.id); record.demoFixture = 'report-email-v1'; this._put('meeting', record); this.finalizeMeeting(meeting.id); return this.getMeeting(meeting.id);
  }
}

export { SCHEMA_VERSION, STATES };
