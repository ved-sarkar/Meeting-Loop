/** Synthetic provider smoke: no real meeting content, no cloud generation. */
import { createOllamaProvider, transcribeAudio, getWhisperStatus } from './index.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const exec=promisify(execFile); const provider=createOllamaProvider(); const state=await provider.status();
assert.ok(state.available&&state.defaultModel,'Local model must be installed');
const fixture='This is a synthetic meeting. Alex will write the design report. Maya will review it. The email is a draft and has not been sent.';
const prompt=`Meeting evidence: ${fixture}\nQuestion: What is the email status? Answer in one sentence.`;
const outputs=[];
for(let run=0;run<3;run++){
  const result=await provider.generate({model:state.defaultModel,prompt,system:'Use only the supplied evidence. State the final answer concisely.',maxTokens:160});
  assert.match(result.text,/draft|not.{0,8}sent|unsent/i);assert.equal(result.finishReason,'stop');
  outputs.push(result);
}
const format={type:'object',properties:{emailStatus:{type:'string'},owner:{type:'string'},dueDate:{type:['string','null']}},required:['emailStatus','owner','dueDate'],additionalProperties:false};
const structured=await provider.generate({model:state.defaultModel,prompt:`Extract JSON from this evidence: ${fixture}\nUse null for absent due date. The owner is the person who will write the report.`,system:'Return only valid JSON following the schema. Never invent dates or sent status.',format,maxTokens:160});
const fields=JSON.parse(structured.text);assert.equal(fields.owner,'Alex');assert.equal(fields.dueDate,null);assert.match(fields.emailStatus,/draft|not.{0,8}sent|unsent/i);
const controller=new AbortController(); const cancellation=provider.generate({model:state.defaultModel,prompt:'Write a long discussion of meeting productivity.',signal:controller.signal,maxTokens:1000});setTimeout(()=>controller.abort(),150);await assert.rejects(cancellation,{name:'AbortError'});
let transcription=null;
if((await getWhisperStatus()).available){const temp=await mkdtemp(path.join(os.tmpdir(),'meeting-loop-smoke-'));try{const audio=path.join(temp,'synthetic.aiff');await exec('/usr/bin/say',['-o',audio,fixture]);transcription=await transcribeAudio({audioPath:audio,speaker:'Synthetic voice'});assert.match(transcription.text,/not been sent/i);assert.ok(transcription.segments.length>0);}finally{await rm(temp,{recursive:true,force:true});}}
const report={checkedAt:new Date().toISOString(),hardware:{platform:os.platform(),architecture:os.arch(),cpu:os.cpus()[0]?.model,totalMemoryBytes:os.totalmem()},fixture,fixtureSha256:createHash('sha256').update(fixture).digest('hex'),ollamaVersion:state.version,model:state.models.find(m=>m.id===state.defaultModel),answerRuns:outputs,structured,cancellationPassed:true,transcription,limitations:['Synthetic single-speaker fixture only. Not a real two-sided call.','Proper-name ASR accuracy requires correction and glossary evaluation.','Three answer samples are a smoke check, not a p95 latency benchmark.','No cloud generation, paid API, or competitor comparison was run.']};
await writeFile(new URL('./smoke-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
