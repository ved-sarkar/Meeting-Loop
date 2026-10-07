import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createOllamaProvider } from './ollama.mjs';
import { generateWithCodex, CODEX_SCHEMA_VERSION } from './codex.mjs';

const installed = { name: 'qwen3:4b-instruct', size: 2_497_293_931, digest: 'test', details: { format: 'gguf' } };
const encoder = new TextEncoder();
function fakeOllama({ cloud = false, lines, noDone = false, wait = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({url, options});
    assert.ok(url.startsWith('http://127.0.0.1:11434/'));
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/api/tags')) return Response.json({ models: [installed, { ...installed, name: 'large:cloud', remote_host: 'https://ollama.com' }] });
    if (url.endsWith('/api/show')) return Response.json({ details: { format: 'gguf' }, ...(cloud ? {remote_host:'https://example.com'} : {}) });
    if (url.endsWith('/api/version')) return Response.json({version:'test'});
    if (wait) return new Promise((resolve,reject) => { const abort = () => reject(options.signal.reason); if(options.signal.aborted) abort(); else options.signal.addEventListener('abort',abort,{once:true}); });
    const data = lines || [{ response:'The email is ' }, { response:'a draft.' }, ...(!noDone ? [{ done:true, eval_count:8, prompt_eval_count:15 }] : [])].map(x=>JSON.stringify(x)).join('\n');
    return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(data.slice(0,13)));c.enqueue(encoder.encode(data.slice(13)));c.close();}}));
  }};
}
test('remote endpoints and cloud models are refused before network use',async()=>{
  assert.throws(()=>createOllamaProvider({baseUrl:'https://api.openai.com'}), {code:'REMOTE_ENDPOINT_DISABLED'});
  const mock=fakeOllama(); const provider=createOllamaProvider(mock);
  await assert.rejects(provider.generate({model:'qwen:cloud',prompt:'hello'}),{code:'LOCAL_MODEL_REQUIRED'});
  assert.equal(mock.calls.length,0);
});
test('status lists only locally stored GGUF models',async()=>{
  const status=await createOllamaProvider(fakeOllama()).status();
  assert.equal(status.available,true); assert.deepEqual(status.models.map(x=>x.id),['qwen3:4b-instruct']);
});
test('streaming handles chunk boundaries, no final newline, callbacks and usage',async()=>{
  const mock=fakeOllama(); const tokens=[];
  const result=await createOllamaProvider(mock).generate({prompt:'What is its status?',onToken:x=>tokens.push(x)});
  assert.equal(result.text,'The email is a draft.'); assert.equal(tokens.join(''),result.text); assert.equal(result.usage.vendorCostUsd,0);
  const body=JSON.parse(mock.calls.at(-1).options.body); assert.equal(body.think,false); assert.equal(body.stream,true);
});
test('model metadata indicating a cloud alias fails closed',async()=>{
  const mock=fakeOllama({cloud:true});
  await assert.rejects(createOllamaProvider(mock).generate({prompt:'hello'}),{code:'LOCAL_MODEL_REQUIRED'});
  assert.ok(mock.calls.every(c=>!c.url.endsWith('/api/generate')));
});
test('interrupted and invalid streams are errors, never successful notes',async()=>{
  await assert.rejects(createOllamaProvider(fakeOllama({noDone:true})).generate({prompt:'hello'}),{code:'INCOMPLETE_STREAM'});
  await assert.rejects(createOllamaProvider(fakeOllama({lines:'not json\n'})).generate({prompt:'hello'}),{code:'INVALID_STREAM'});
});
test('aborting the local request frees the model slot',async()=>{
  const provider=createOllamaProvider(fakeOllama({wait:true})); const controller=new AbortController();
  const running=provider.generate({prompt:'hello',signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve,10));
  await assert.rejects(provider.generate({prompt:'second'}),{code:'PROVIDER_BUSY'});
  controller.abort(); await assert.rejects(running,{name:'AbortError'});
  assert.equal((await provider.status()).busy,false);
});
test('invalid limits and oversized context never occupy the provider',async()=>{
  const mock=fakeOllama(); const provider=createOllamaProvider(mock);
  await assert.rejects(provider.generate({prompt:'x'.repeat(24001)}),{code:'CONTEXT_TOO_LARGE'});
  await assert.rejects(provider.generate({prompt:'hello',timeoutMs:NaN}),{code:'INVALID_LIMIT'});
  assert.equal(mock.calls.length,0); await provider.generate({prompt:'hello'});
});
test('cloud generation cannot bypass the strict zero-spend gate',async()=>{
  await assert.rejects(generateWithCodex({allowNetwork:true,allowPaidApi:true,prompt:'hello'}),{code:'CLOUD_ZERO_SPEND_GATE'});
});
test('stored official protocol schemas match the audited installed version and checksums',async()=>{
  const manifest=JSON.parse(await readFile(new URL('./protocol/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.codexVersion,CODEX_SCHEMA_VERSION);
  for (const [filename,expected] of Object.entries(manifest.files)) {
    const content=await readFile(new URL(`./protocol/${filename}`,import.meta.url));
    assert.equal(createHash('sha256').update(content).digest('hex'),expected,filename);
    JSON.parse(content);
  }
});
test('thinking events stay private and schema output is forwarded',async()=>{
  const mock=fakeOllama({lines:[{thinking:'hidden model reasoning'},{response:'{"status":"draft"}'},{done:true,done_reason:'stop'}].map(x=>JSON.stringify(x)).join('\n')});
  const seen=[];const schema={type:'object',properties:{status:{type:'string'}}};
  const result=await createOllamaProvider(mock).generate({prompt:'Extract status',format:schema,onToken:x=>seen.push(x)});
  assert.equal(seen.join(''),'{"status":"draft"}');assert.equal(result.text,'{"status":"draft"}');
  assert.deepEqual(JSON.parse(mock.calls.at(-1).options.body).format,schema);
});
test('output-limit exhaustion is never reported as a completed answer',async()=>{
  const mock=fakeOllama({lines:[{response:'Partial'},{done:true,done_reason:'length'}].map(x=>JSON.stringify(x)).join('\n')});
  await assert.rejects(createOllamaProvider(mock).generate({prompt:'hello'}),{code:'OUTPUT_LIMIT'});
});
