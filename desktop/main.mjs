import {app,BrowserWindow,ipcMain,dialog,shell,globalShortcut,protocol,net,session,Menu,clipboard} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Application} from '../server/application.mjs';
import {getCodexStatus} from '../server/providers/index.mjs';
const exec=promisify(execFile);const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
app.setName('Meeting Loop');
protocol.registerSchemesAsPrivileged([{scheme:'loop',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
let main,overlay,core,closing=false;const mediaTokens=new Map();const indexUrl=pathToFileURL(path.join(root,'dist/index.html')).href;
if(!app.requestSingleInstanceLock()){app.quit()}else{
app.on('second-instance',()=>{main?.show();main?.focus()});
function windowOptions(extra={}){return {width:1390,height:970,minWidth:880,minHeight:620,title:'Meeting Loop',backgroundColor:'#f9faf7',titleBarStyle:'hiddenInset',trafficLightPosition:{x:17,y:13},webPreferences:{preload:path.join(root,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged},...extra}}
function secureWindow(win){win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith(indexUrl))e.preventDefault()});win.webContents.on('will-attach-webview',e=>e.preventDefault());}
function createMain(){main=new BrowserWindow(windowOptions());secureWindow(main);main.loadFile(path.join(root,'dist/index.html'));main.on('closed',()=>{main=null})}
function toggleOverlay(){if(overlay){overlay.close();overlay=null;return false}overlay=new BrowserWindow(windowOptions({width:420,height:600,minWidth:350,minHeight:400,alwaysOnTop:true,skipTaskbar:true,titleBarStyle:'hidden',title:'Meeting Loop · Copilot'}));secureWindow(overlay);overlay.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});overlay.loadFile(path.join(root,'dist/index.html'),{query:{overlay:'1'}});overlay.on('closed',()=>{overlay=null});return true;}
async function pickFile(filters){const result=await dialog.showOpenDialog(main,{properties:['openFile'],filters});return result.canceled?null:result.filePaths[0]}
async function pickFolder(title){const result=await dialog.showOpenDialog(main,{title,properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0]}
function trusted(event){const url=event.senderFrame?.url;if(!url||!url.startsWith(indexUrl)||![main?.webContents.id,overlay?.webContents.id].includes(event.sender.id))throw new Error('Untrusted IPC source.');}
app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!['file:','loop:','devtools:'].some(prefix=>details.url.startsWith(prefix))}));
 core=new Application({root:process.env.MEETING_LOOP_VAULT||path.join(os.homedir(),'MeetingLoopVault'),appRoot:root});
 core.on('event',event=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('loop:event',event)});
 protocol.handle('loop',async request=>{const key=new URL(request.url).hostname;const file=mediaTokens.get(key);if(!file)return new Response('Unavailable',{status:404});try{core.vault.safePath(path.relative(core.vault.root,file));return net.fetch(pathToFileURL(file).href)}catch{return new Response('Unavailable',{status:403})}});
 ipcMain.handle('loop:call',async(event,method,args)=>{trusted(event);if(typeof method!=='string'||!Array.isArray(args)||args.length>4)throw new Error('Invalid request.');const v=core.vault;let result;switch(method){
 case 'copyText':if(typeof args[0]!=='string'||args[0].length>100000)throw new Error('Text is too large to copy.');clipboard.writeText(args[0]);return true;case 'snapshot':return core.snapshot();case 'getMeeting':return v.getMeeting(args[0]);case 'createProject':result=v.createProject(args[0]);break;case 'createMeeting':result=v.createMeeting(args[0]);break;
 case 'saveManualNotes':v.saveManualNotes(...args);result=v.getMeeting(args[0]);break;case 'addSegment':result=v.addSegment(...args);break;case 'correctSegment':result=v.correctSegment(...args);break;
 case 'finalizeMeeting':if(core.capture?.meetingId===args[0]||core.asrRunning)throw new Error('Finish recording and transcription before preparing the handoff.');result=v.finalizeMeeting(args[0]);break;
 case 'generateNotes':return core.generateNotes(args[0]);case 'ask':return core.ask(...args);case 'cancelInference':return core.cancelInference();case 'search':return v.search(args[0],{projectId:args[1]||undefined});
 case 'approveTask':result=v.approveTask(args[0]);break;case 'cancelTask':result=v.cancelTask(args[0]);break;case 'runTask':return core.runTask(args[0]);case 'brief':return v.readProjectBrief(args[0]).text;
 case 'updateSettings':result=v.updateSettings(args[0]);break;case 'diagnostics':return core.diagnostics();case 'codexStatus':return getCodexStatus({allowNetwork:true});
 case 'startCapture':return core.startCapture(...args);case 'captureCommand':return core.captureCommand(args[0]);case 'audioFiles':return core.audioFiles(args[0]);
 case 'playback':{const file=await core.playback(...args);const token=crypto.randomUUID();mediaTokens.set(token,file);return{url:`loop://${token}/audio`};}
 case 'importTranscript':{const file=await pickFile([{name:'Transcript',extensions:['txt','md','vtt','srt']}]);if(!file)return null;return core.importTranscript(file,args[0]||v.snapshot().projects[0].id);}
 case 'importAudio':{const m=v.getMeeting(args[0]);if(m.status!=='active')throw new Error('Create a new notes-only meeting to import audio.');const file=await pickFile([{name:'Audio',extensions:['wav','m4a','mp3','caf','aiff','flac','ogg']}]);if(!file)return null;const confirmation=await dialog.showMessageBox(main,{type:'question',buttons:['Cancel','Import locally'],defaultId:1,cancelId:0,message:'Import this recording?',detail:'Confirm that you are authorized to store and transcribe this audio. The original is copied into your local vault.'});if(confirmation.response!==1)return null;return core.importAudio(args[0],file);}
 case 'addReference':{const file=await pickFile([{name:'Text and PDF documents',extensions:['txt','md','csv','json','pdf']}]);if(!file)return null;if(fs.statSync(file).size>10_000_000)throw new Error('Choose a reference smaller than 10 MB.');let text;if(path.extname(file).toLowerCase()==='.pdf'){try{text=(await exec('/opt/homebrew/bin/pdftotext',[file,'-'],{maxBuffer:10_000_000})).stdout}catch{throw new Error('PDF text extraction is unavailable. Export the document as text or Markdown.')}}else text=fs.readFileSync(file,'utf8');return core.importReference(args[0],file,text);}
 case 'retryTranscription':return core.retryTranscription(args[0]);case 'listReferences':return core.listReferences(args[0]);case 'screenshot':{const result=await core.screenshot(args[0]);if(result.saved){const token=crypto.randomUUID();core.vault.safePath(path.relative(core.vault.root,result.file));mediaTokens.set(token,result.file);return{...result,imageUrl:`loop://${token}/image`};}return result;}case 'openVault':{const relative=args[0]?`meetings/${v.getMeeting(args[0]).id}`:'';const error=await shell.openPath(v.safePath(relative));if(error)throw new Error(error);return true;}
 case 'openArtifact':{const dir=v.artifactPath(args[0]);if(!fs.existsSync(dir))throw new Error('No saved deliverables yet.');const error=await shell.openPath(dir);if(error)throw new Error(error);return true;}
 case 'exportMeeting':{if(core.capture)throw new Error('Stop recording before exporting.');const folder=await pickFolder('Choose a folder for the meeting export');if(!folder)return null;return v.exportMeeting(args[0],path.join(folder,`Meeting-${args[0]}`));}
 case 'backup':{if(core.capture||core.asrRunning)throw new Error('Wait for capture and transcription to finish before backing up.');const folder=await pickFolder('Choose a private local backup folder');if(!folder)return null;return v.backup(path.join(folder,`MeetingLoopBackup-${new Date().toISOString().replaceAll(':','-')}`));}
 case 'deleteMeeting':if(core.capture||core.asrRunning)throw new Error('Stop recording and wait for transcription before deleting a meeting.');result=v.deleteMeeting(args[0]);break;
 case 'createDemo':result=v.createSyntheticDemo();break;case 'toggleOverlay':return toggleOverlay();default:throw new Error('Unsupported application command.');}
 core.changed();return result??true;
 });
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Meeting Loop',submenu:[{role:'about'},{type:'separator'},{label:'Floating copilot',accelerator:'CommandOrControl+Shift+L',click:toggleOverlay},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},{label:'Window',submenu:[{role:'minimize'},{role:'close'}]}]));
 globalShortcut.register('CommandOrControl+Shift+L',toggleOverlay);createMain();
});
app.on('activate',()=>{if(!main&&!closing)createMain()});
app.on('window-all-closed',()=>{if(!closing)app.quit()});
app.on('before-quit',event=>{
 // Keep every quit request paused until committed audio and the vault are closed.
 // Re-entering app.quit() after an asynchronous before-quit handler can leave
 // this Electron/macOS runtime waiting indefinitely during native teardown.
 event.preventDefault();if(closing)return;closing=true;globalShortcut.unregisterAll();
 Promise.resolve().then(()=>core?.close()).then(()=>app.exit(0)).catch(error=>{
  closing=false;
  console.error('Meeting Loop could not finish shutdown:',error.message);
  dialog.showErrorBox('Meeting Loop could not safely quit','Local work could not finish closing. Your saved recordings remain in the vault. Please stop recording and try Quit again.');
 });
});
}
