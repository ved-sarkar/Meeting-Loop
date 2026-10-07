#!/usr/bin/env node
/** Explicit one-time public model provisioning. No inference API keys, purchases, or account extraction. */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createOllamaProvider, getWhisperStatus, WHISPER_MODEL, WHISPER_MODEL_SHA256 } from '../server/providers/index.mjs';

const MODEL = 'qwen3:4b-instruct';
const MODEL_DIGEST = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0';
const ASR_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin';
const args = new Set(process.argv.slice(2));
if ([...args].some(x => !['--download','--install-runtime','--help'].includes(x))) throw new Error('Supported options: --download, --install-runtime, --help');
if (args.has('--help')) {
  console.log('node scripts/model-setup.mjs                     Check readiness\nnode scripts/model-setup.mjs --download          Download pinned local models (~2.65 GB)\nnode scripts/model-setup.mjs --install-runtime   Install whisper.cpp using Homebrew\n\nInstall/start Ollama using its official application first. Public downloads need internet; inference stays local.');
  process.exit(0);
}
async function digest(filename) { const hash=createHash('sha256'); for await(const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
async function run(binary, args) { await new Promise((resolve,reject)=>{const child=spawn(binary,args,{stdio:'inherit',env:{...process.env,HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1'}});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`${binary} exited ${code}`)));}); }
if (args.has('--install-runtime')) {
  const current=await getWhisperStatus();
  if (!current.binaryInstalled) await run('/opt/homebrew/bin/brew',['install','whisper.cpp']);
  if (!current.ffmpegInstalled) await run('/opt/homebrew/bin/brew',['install','ffmpeg']);
}
if (args.has('--download')) {
  const provider=createOllamaProvider(); const status=await provider.status();
  if (!status.available) throw new Error(status.error);
  if (!status.models.some(m=>m.id===MODEL&&m.digest===MODEL_DIGEST)) {
    console.log(`Downloading ${MODEL} from the public Ollama registry. License: Apache-2.0.`);
    const response=await fetch('http://127.0.0.1:11434/api/pull',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,stream:true})});
    if(!response.ok) throw new Error(`Ollama download failed (${response.status})`);
    let buffer='';let lastStatus='';let lastProgress=0;
    for await(const chunk of response.body){buffer+=Buffer.from(chunk).toString('utf8');let newline;while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line)continue;const event=JSON.parse(line);if(event.error)throw new Error('Ollama could not download the model.');if(event.status!==lastStatus||Date.now()-lastProgress>5000){console.log(event.status,event.total?`${Math.round(100*(event.completed||0)/event.total)}%`:'');lastStatus=event.status;lastProgress=Date.now();}}}
    const models=await provider.listModels();const installed=models.find(m=>m.id===MODEL);
    if(installed?.digest!==MODEL_DIGEST)throw new Error('The registry model digest changed. Review the new model provenance before using it.');
  }
  let valid=false;try{valid=(await stat(WHISPER_MODEL)).size===147964211&&await digest(WHISPER_MODEL)===WHISPER_MODEL_SHA256;}catch{}
  if(!valid){
    await mkdir(path.dirname(WHISPER_MODEL),{recursive:true,mode:0o700});const temporary=`${WHISPER_MODEL}.partial`;
    console.log('Downloading whisper base.en from the pinned public revision. License: MIT.');
    try{const response=await fetch(ASR_URL);if(!response.ok||!response.body)throw new Error(`Speech model download failed (${response.status}).`);await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{mode:0o600}));if(await digest(temporary)!==WHISPER_MODEL_SHA256)throw new Error('Speech model checksum did not match.');await rename(temporary,WHISPER_MODEL);}catch(error){await rm(temporary,{force:true});throw error;}
  }
}
console.log(JSON.stringify({ollama:await createOllamaProvider().status(),speech:await getWhisperStatus()},null,2));
