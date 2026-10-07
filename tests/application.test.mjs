import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../server/application.mjs';

function fixture(t, generate) {
  const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'meeting-loop-application-test-'));
  const provider={status:async()=>({available:true,defaultModel:'synthetic-local-provider',models:[{id:'synthetic-local-provider'}]}),generate};
  const app=new Application({root:path.join(temp,'vault'),provider});
  t.after(async()=>{await app.close();fs.rmSync(temp,{recursive:true,force:true});});
  return app;
}

test('untrusted model classifications cannot turn policy, questions, or suggestions into assignments',async t=>{
  let segmentIds=[];
  const app=fixture(t,async()=>({model:'synthetic-local-provider',text:JSON.stringify({summary:'Generated interpretation.',decisions:segmentIds,questions:segmentIds,tasks:segmentIds.map(segmentId=>({segmentId,owner:'user',kind:'report'}))})}));
  const project=app.vault.snapshot().projects[0];
  const meeting=app.vault.createMeeting({projectId:project.id,title:'Assignment precision',source:'synthetic'});
  const evidence=[
    {speaker:'Alex',text:'I will write the design report.'},
    {speaker:'Maya',text:'I will review the design report.'},
    {speaker:'Alex',text:'We decided to keep the vendor budget at zero. Paid API calls and automatic cloud jobs will stay disabled.'},
    {speaker:'Maya',text:'How will we verify the microphone and system audio?'},
    {speaker:'Alex',text:'We could prepare an additional analysis.'},
    {speaker:'Alex',text:'I will not send the email.'},
    {speaker:'Maya',text:'We have not approved a cloud deployment.'},
  ].map((segment,i)=>app.vault.addSegment(meeting.id,{...segment,start:i*5,end:i*5+4}));
  segmentIds=evidence.map(s=>s.id);app.vault.saveManualNotes(meeting.id,'Human notes must remain intact.');app.vault.finalizeMeeting(meeting.id);
  const notes=await app.generateNotes(meeting.id);const after=app.vault.getMeeting(meeting.id);
  assert.equal(after.tasks.length,2);assert.deepEqual(after.tasks.map(task=>task.title).sort(),['I will review the design report.','I will write the design report.']);
  assert.equal(after.tasks.find(task=>task.owner.name==='Alex').owner.kind,'user');assert.equal(after.tasks.find(task=>task.owner.name==='Maya').owner.kind,'other');
  assert.equal(notes.decisions.length,1);assert.match(notes.decisions[0].text,/vendor budget/);
  assert.equal(notes.questions.length,1);assert.match(notes.questions[0].text,/How will/);
  assert.equal(after.manualNotes,'Human notes must remain intact.');assert.ok(after.tasks.every(task=>task.state==='PROPOSED'));
  const userTask=after.tasks.find(task=>task.owner.kind==='user');app.vault.cancelTask(userTask.id);
  await app.generateNotes(meeting.id);assert.equal(app.vault.getMeeting(meeting.id).tasks.length,2);assert.equal(app.vault.readTask(userTask.id).state,'CANCELLED');
});

test('email executor creates only a recipient-free unsent draft from source evidence',async t=>{
  let generationCalls=0;
  const app=fixture(t,async()=>{generationCalls++;throw new Error('Email rendering must not request invented prose.');});
  const meeting=app.vault.createSyntheticDemo();const task=meeting.tasks.find(task=>task.kind==='email');app.vault.approveTask(task.id);
  const result=await app.runTask(task.id);assert.equal(generationCalls,0);assert.equal(result.state,'DRAFTED');assert.equal(result.externalStatus,'draft_unsent');
  const content=fs.readFileSync(app.vault.safePath(result.artifacts[0].relativePath),'utf8');
  assert.match(content,/^X-Unsent: 1/m);assert.doesNotMatch(content,/^(?:To|Cc|Bcc):|^(?:Hi|Dear|Hello)\s+Maya[,!]/im);assert.match(content,/No recipient has been selected/);assert.match(content,/has not been sent/);
  assert.deepEqual(result.runResults.at(-1).tests,[]);assert.deepEqual(result.runResults.at(-1).externalConfirmations,[]);
});

test('report separates actual source quotations from unverified model proposals and does not invent a date',async t=>{
  const app=fixture(t,async()=>({model:'synthetic-local-provider',text:JSON.stringify({proposals:['Consider encryption after confirming operating-system settings.','Implement a review process on 2024-04-27.'],validationNeeded:['Confirm FileVault status before claiming encryption at rest.']})}));
  const meeting=app.vault.createSyntheticDemo();const task=meeting.tasks.find(task=>task.kind==='report');app.vault.approveTask(task.id);
  const result=await app.runTask(task.id);assert.equal(result.state,'DRAFTED');
  const content=fs.readFileSync(app.vault.safePath(result.artifacts[0].relativePath),'utf8');
  assert.match(content,/Confirmed source evidence/);assert.match(content,/Proposed approach — unverified/);assert.match(content,/not statements about the current system/);assert.match(content,/\[date not established\]/);assert.doesNotMatch(content,/2024-04-27/);
  assert.match(content,/No commands, tests, external research, messages, deployments or configuration changes were executed/);
  assert.ok(app.vault.readProjectBrief(meeting.projectId).deliverables.every(item=>item.verified));
});

test('long transcript summaries cover every bounded part and preserve early and late commitments',async t=>{
 const prompts=[];const app=fixture(t,async options=>{prompts.push(options.prompt);return{model:'synthetic-local-provider',text:JSON.stringify({summary:'Part interpreted from source.'})}});
 const project=app.vault.snapshot().projects[0],meeting=app.vault.createMeeting({projectId:project.id,title:'Long transcript',source:'synthetic'});
 app.vault.addSegment(meeting.id,{speaker:'Alex',text:'I will write the early report.',start:0,end:3});
 for(let i=0;i<28;i++)app.vault.addSegment(meeting.id,{speaker:'Maya',text:`Topic ${i}. `+'We discussed local document organization and storage preferences. '.repeat(12),start:i*5+4,end:i*5+8});
 app.vault.addSegment(meeting.id,{speaker:'Alex',text:'I will draft the final email.',start:150,end:154});
 const notes=await app.generateNotes(meeting.id);
 assert.ok(prompts.length>1);assert.ok(prompts[0].includes('early report'));assert.ok(prompts.at(-1).includes('final email'));
 assert.ok(prompts.every(p=>p.length<18000));assert.equal(app.vault.getMeeting(meeting.id).tasks.length,2);assert.match(notes.summary,/Part 1/);
});

test('cancelled requests are supplied explicitly to the next-meeting assistant',async t=>{
 let prompt='';const app=fixture(t,async options=>{prompt=options.prompt;return{model:'synthetic-local-provider',text:'The request was cancelled.'}});
 const m=app.vault.createSyntheticDemo(),task=m.tasks[0];app.vault.cancelTask(task.id);
 const next=app.vault.createMeeting({projectId:m.projectId,title:'Next meeting',source:'synthetic'});
 await app.ask(next.id,'What remains to do?');assert.match(prompt,/Cancelled requests/);assert.match(prompt,/CANCELLED:/);assert.ok(prompt.includes(task.title));
});

test('edited reference metadata cannot read another project or a changed reference',async t=>{
 const app=fixture(t,async()=>({model:'fixture',text:'unused'}));const p=app.vault.snapshot().projects[0];
 const ref=app.importReference(p.id,'test.txt','Selected context');
 app.vault.write(ref.textPath,'Changed content');assert.throws(()=>app.listReferences(p.id),/changed/);
 app.vault.write(ref.textPath,'Selected context');
 const other=app.vault.createProject({name:'Unrelated'}),foreign=`projects/${other.id}/references/secret.txt`;app.vault.write(foreign,'Unrelated context');
 app.vault.write(`projects/${p.id}/references/${ref.id}.reference.json`,{...ref,textPath:foreign});assert.throws(()=>app.listReferences(p.id),/outside this project/);
});

test('streamed answers carry the selected meeting scope for window isolation',async t=>{
 const events=[];const app=fixture(t,async options=>{options.onToken?.('Scoped answer');return{model:'fixture',text:'Scoped answer'}});
 const first=app.vault.createSyntheticDemo(),other=app.vault.createProject({name:'Separate project'});
 app.vault.createMeeting({projectId:other.id,title:'Unrelated context',source:'synthetic'});
 app.on('event',event=>events.push(event));await app.ask(first.id,'What did we discuss?');
 const tokens=events.filter(event=>event.type==='token');assert.equal(tokens.length,1);assert.equal(tokens[0].meetingId,first.id);assert.equal(tokens[0].text,'Scoped answer');
});
