#!/usr/bin/env node
/** Actual local-model meeting-to-draft-to-next-meeting workflow. Synthetic data only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Application } from '../server/application.mjs';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'meeting-loop-workflow-'));
const app=new Application({root:path.join(temp,'vault'),appRoot});
const report={checkedAt:new Date().toISOString(),mode:'synthetic-local-model-integration',vendorCostUsd:0,cloudTurns:0,externalMessagesSent:0,stages:[],warnings:[],limitations:['Synthetic text fixtures only; this workflow does not exercise native two-sided capture.','Generated artifacts remain drafts requiring human content review.','No external delivery or code execution is available to this executor.']};
report.generations=[];
const originalGenerate=app.provider.generate.bind(app.provider);
app.provider.generate=async params=>{const result=await originalGenerate(params);report.generations.push({format:params.format?'structured':'text',text:result.text,model:result.model,elapsedMs:result.elapsedMs,usage:result.usage});return result;};
app.on('event',event=>{if(event.type==='warning')report.warnings.push(event.message);});
async function stage(name,fn){const started=performance.now();try{const evidence=await fn();const result={name,passed:true,elapsedMs:Math.round(performance.now()-started),evidence};report.stages.push(result);console.log(`${name}: PASS (${result.elapsedMs} ms)`);return evidence;}catch(error){report.stages.push({name,passed:false,elapsedMs:Math.round(performance.now()-started),error:error.message});console.log(`${name}: FAIL — ${error.message}`);return null;}}
try{
  const status=await app.provider.status();assert.ok(status.available&&status.defaultModel,'Local model is unavailable');
  app.vault.updateSettings({model:status.defaultModel,userName:'Alex'});report.model=status.models.find(m=>m.id===status.defaultModel);report.ollamaVersion=status.version;
  const demo=app.vault.createSyntheticDemo();const initialTaskIds=demo.tasks.map(t=>t.id).sort();const manual=demo.manualNotes;
  await stage('Create deduplicated synthetic demo',async()=>{assert.equal(demo.tasks.length,2);assert.equal(app.vault.createSyntheticDemo().id,demo.id);assert.equal(demo.isDemo,true);return {meetingId:demo.id,taskIds:initialTaskIds};});
  await stage('Generate grounded notes with actual local model',async()=>{
    const notes=await app.generateNotes(demo.id);const meeting=app.vault.getMeeting(demo.id);assert.equal(meeting.manualNotes,manual);assert.ok(notes.summary.length>0);assert.equal(notes.taskIds.length,2);assert.equal(meeting.tasks.length,2,'Regeneration duplicated an existing commitment');assert.deepEqual(meeting.tasks.map(t=>t.id).sort(),initialTaskIds);return {notesRevision:notes.revision,summary:notes.summary,taskIds:notes.taskIds,decisionCount:notes.decisions.length};
  });
  await stage('Regenerated notes preserve task IDs and human notes',async()=>{
    const before=app.vault.getMeeting(demo.id);const notes=await app.generateNotes(demo.id);const after=app.vault.getMeeting(demo.id);assert.equal(after.tasks.length,2,'Repeated regeneration must retain exactly two commitments');assert.deepEqual(after.tasks.map(t=>t.id).sort(),initialTaskIds);assert.equal(after.manualNotes,manual);assert.equal(after.notesVersions.length,before.notesVersions.length+1);return {notesRevision:notes.revision,taskIds:after.tasks.map(t=>t.id)};
  });
  for(const original of demo.tasks){
    await stage(`Approve and draft ${original.kind}`,async()=>{
      const ready=app.vault.approveTask(original.id);assert.equal(ready.state,'READY');const completion=await app.runTask(original.id);assert.equal(completion.state,'DRAFTED');assert.ok(completion.artifacts.length>0);assert.equal(completion.runResults.at(-1).tests.length,0);assert.equal(completion.runResults.at(-1).externalConfirmations.length,0);
      const artifacts=completion.artifacts.map(artifact=>{const absolute=app.vault.safePath(artifact.relativePath);const bytes=fs.readFileSync(absolute);const hash=crypto.createHash('sha256').update(bytes).digest('hex');assert.equal(hash,artifact.sha256);const content=bytes.toString('utf8');assert.ok(content.length>150);if(original.kind==='email'){assert.match(content,/^X-Unsent: 1/m);assert.equal(completion.externalStatus,'draft_unsent');assert.ok(completion.pendingApprovals.includes('send_email'));assert.doesNotMatch(content,/^(To|Cc|Bcc):\s*.+/im);assert.doesNotMatch(content,/^(?:Hi|Dear|Hello)\s+Maya[,!]/im,'Email must not infer a recipient from a participant name');}if(original.kind==='report'){assert.match(content,/proposed.*unverified|unverified.*propos/i,'Generated design ideas must be explicitly unverified proposals');assert.doesNotMatch(content,/Date:\s*2024/i,'A source-free historical date must not be invented');const confirmed=content.split(/#{1,4}[^\n]*(?:proposed|unverified)/i)[0];assert.doesNotMatch(confirmed,/files are encrypted at rest|password.protected directories/i,'Unverified security properties must not appear as confirmed facts');}return {filename:path.basename(artifact.relativePath),sha256:hash,size:bytes.length,content};});
      return {taskId:completion.id,state:completion.state,externalStatus:completion.externalStatus,artifacts};
    });
  }
  await stage('Project memory verifies actual saved artifact hashes and unsent state',async()=>{
    const brief=app.vault.readProjectBrief(demo.projectId);assert.equal(brief.deliverables.length,2);assert.ok(brief.deliverables.every(d=>d.verified));assert.match(brief.text,/UNSENT/);assert.ok(brief.deliverables.every(d=>d.state==='DRAFTED'));return {brief:brief.text,deliverables:brief.deliverables.map(({taskId,state,verified,externalStatus})=>({taskId,state,verified,externalStatus}))};
  });
  const next=app.vault.createMeeting({projectId:demo.projectId,title:'Next meeting · synthetic status review',source:'synthetic'});app.vault.addSegment(next.id,{speaker:'Maya',start:0,end:9,text:'Before this next meeting, what work was actually saved, and has the follow-up email been sent?'});app.vault.finalizeMeeting(next.id);
  await stage('Next meeting answers from completed draft evidence',async()=>{
    const answer=await app.ask(next.id,'What work from our previous meeting was actually saved? Has the email been sent, and is any work externally verified?');assert.match(answer.text,/report/i);assert.match(answer.text,/email/i);assert.match(answer.text,/unsent|not.{0,12}sent|hasn.t been sent/i);assert.match(answer.text,/draft|review/i);assert.doesNotMatch(answer.text,/email (?:has been|was|is) sent|tests (?:have )?passed|code (?:was|has been) (?:tested|executed)/i);return {text:answer.text,elapsedMs:answer.elapsedMs,usage:answer.usage};
  });
  await stage('Completed drafts stay deduplicated after notes regeneration',async()=>{
    await app.generateNotes(demo.id);const meeting=app.vault.getMeeting(demo.id);assert.equal(meeting.tasks.length,2);assert.deepEqual(meeting.tasks.map(t=>t.id).sort(),initialTaskIds);assert.ok(meeting.tasks.every(t=>t.state==='DRAFTED'));return {taskCount:meeting.tasks.length,states:meeting.tasks.map(t=>t.state)};
  });
  await stage('Changed artifact cannot retain verified completion evidence',async()=>{
    const task=app.vault.readTask(initialTaskIds[0]);assert.ok(task.artifacts.length);const artifact=task.artifacts[0];fs.appendFileSync(app.vault.safePath(artifact.relativePath),'\nSynthetic integrity-check modification.\n');const brief=app.vault.readProjectBrief(demo.projectId);const changed=brief.deliverables.find(d=>d.taskId===task.id);assert.equal(changed.verified,false);assert.equal(changed.state,'EVIDENCE_CHANGED');return {taskId:task.id,state:changed.state,verified:changed.verified};
  });
}catch(error){report.stages.push({name:'Workflow setup',passed:false,error:error.message});}
finally{await app.close();fs.rmSync(temp,{recursive:true,force:true});report.passed=report.stages.length>0&&report.stages.every(s=>s.passed);report.finishedAt=new Date().toISOString();const output=path.join(appRoot,'docs','benchmarks','application-workflow.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(`Evidence: ${output}`);if(!report.passed)process.exitCode=1;}
