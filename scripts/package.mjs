import {packager} from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const root=process.cwd();
const binary=path.join(root,'native/capture-helper/.build/release/meeting-loop-capture');
if(!fs.existsSync(binary))throw new Error('Build native helper first with npm run native:build');
fs.copyFileSync(binary,path.join(root,'native/meeting-loop-capture'));
fs.chmodSync(path.join(root,'native/meeting-loop-capture'),0o755);
const result=await packager({dir:root,out:path.join(root,'release'),name:'Meeting Loop',platform:'darwin',arch:'arm64',overwrite:true,asar:false,appBundleId:'com.meetingloop.local',appVersion:'0.1.0',appCopyright:'Meeting Loop — local personal build',icon:fs.existsSync('desktop/icon.icns')?'desktop/icon.icns':undefined,extendInfo:{NSMicrophoneUsageDescription:'Meeting Loop records your microphone only after you start a consented meeting.',NSScreenCaptureUsageDescription:'Meeting Loop records system audio or a screen region only when you explicitly request it.',NSAudioCaptureUsageDescription:'Meeting Loop captures system audio for your consented meeting.',NSHighResolutionCapable:true,LSMinimumSystemVersion:'13.0'},ignore:[/^\/release/,/^\/\.git($|\/)/,/^\/\.tmp/,/^\/native\/capture-helper\/.build/,/^\/tests/,/^\/docs\/screenshots/,/^\/server\/providers\/smoke-results.json/,/^\/node_modules\/\.cache/],prune:true});
for(const dir of result){const bundle=path.join(dir,'Meeting Loop.app');const notices=path.join(bundle,'Contents/Resources/ThirdPartyNotices');fs.mkdirSync(notices,{recursive:true});for(const name of ['LICENSE','LICENSES.chromium.html']){const source=path.join(dir,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(notices,name));}for(const name of ['LICENSES.md','docs/dependency-licenses.json'])if(fs.existsSync(name))fs.copyFileSync(name,path.join(notices,path.basename(name)));execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});console.log(bundle)}
