const {contextBridge,ipcRenderer} = require('electron');
const methods=['copyText','snapshot','getMeeting','createProject','createMeeting','saveManualNotes','addSegment','correctSegment','finalizeMeeting','generateNotes','ask','cancelInference','search','approveTask','cancelTask','runTask','brief','updateSettings','diagnostics','codexStatus','startCapture','captureCommand','audioFiles','playback','importTranscript','importAudio','retryTranscription','addReference','listReferences','screenshot','openVault','openArtifact','exportMeeting','backup','deleteMeeting','createDemo','toggleOverlay'];
const api=Object.fromEntries(methods.map(name=>[name,(...args)=>ipcRenderer.invoke('loop:call',name,args)]));
api.onEvent=callback=>{const fn=(_e,data)=>callback(data);ipcRenderer.on('loop:event',fn);return ()=>ipcRenderer.removeListener('loop:event',fn);};
contextBridge.exposeInMainWorld('loop',Object.freeze(api));
