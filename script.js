(async () => {
  // Dynamically import JSZip and pako so a failing import won't stop handlers from attaching
  let JSZip = null;
  let pako = null;
  try {
    const mod = await import("jszip");
    JSZip = mod && (mod.default || mod);
  } catch (e) {
    console.warn('JSZip failed to load, zipping will be unavailable:', e);
  }
  try {
    const mod = await import("pako");
    pako = mod && (mod.default || mod);
  } catch (e) {
    console.warn('pako failed to load, compression will be unavailable:', e);
  }

  // --- Minimal IndexedDB helper to store large payloads locally and reference by id ---
  const DB_NAME = 'sharealink-db';
  const STORE = 'files';
  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = ()=> {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
  }
  async function idbPut(key, value){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const r = store.put(value, key);
      r.onsuccess = ()=> resolve(true);
      r.onerror = ()=> reject(r.error);
    });
  }
  async function idbGet(key){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const r = store.get(key);
      r.onsuccess = ()=> resolve(r.result);
      r.onerror = ()=> reject(r.error);
    });
  }

  const $ = sel => document.querySelector(sel);
  const fileInput = $('#file-input');
  const serverUploadChk = $('#server-upload');
  const filesList = $('#files-list');
  const createBtn = $('#create-btn');
  const linkArea = $('#link-area');
  const shareLinkInput = $('#share-link');
  const copyBtn = $('#copy-btn');
  const openBtn = $('#open-btn');
  const downloadBtn = $('#download-btn');
  const downloadQrBtn = $('#download-qr-btn');

  const receiveSection = $('#receive');
  const receiveInfo = $('#receive-info');
  const dlBtn = $('#dl-btn');
  const rawLink = $('#raw-link');

  let currentFiles = []; // File objects or File-like
  let lastPayloadJson = null; // store generated payload JSON so Download can reuse it

  function formatBytes(n){
    if(n<1024) return n+' B';
    if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
    if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
    return (n/1024/1024/1024).toFixed(2)+' GB';
  }

  fileInput.addEventListener('change', (ev)=>{
    currentFiles = Array.from(ev.target.files || []);
    renderFileList();
    if(currentFiles.length > 0){
      setTimeout(()=> { if(!createBtn.disabled) createBtn.click(); }, 220);
    }
  });

  function renderFileList(){
    if(currentFiles.length===0){
      filesList.textContent = 'No files selected';
      createBtn.disabled = true;
      return;
    }
    createBtn.disabled = false;
    if(currentFiles.length===1){
      const f = currentFiles[0];
      filesList.innerHTML = `<strong>${escapeHtml(f.name)}</strong> · ${formatBytes(f.size)}`;
    } else {
      const total = currentFiles.reduce((s,f)=>s+f.size,0);
      filesList.innerHTML = `${currentFiles.length} files · ${formatBytes(total)}`;
    }
  }

  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function createPayload(){
    if(currentFiles.length===0) throw new Error('No files');

    if(currentFiles.length===1){
      const f = currentFiles[0];
      const arr = new Uint8Array(await f.arrayBuffer());
      const meta = {
        type: 'single',
        name: f.name,
        mime: f.type || 'application/octet-stream',
        size: f.size
      };
      const payload = {
        meta,
        data: arrayBufferToBase64(arr)
      };
      return JSON.stringify(payload);
    } else {
      if(!JSZip) throw new Error('Zipping not available in this environment');
      const zip = new JSZip();
      for(const f of currentFiles){
        const path = f.webkitRelativePath && f.webkitRelativePath.length ? f.webkitRelativePath : f.name;
        zip.file(path, await f.arrayBuffer());
      }
      const content = await zip.generateAsync({type:'uint8array', compression:'DEFLATE'});
      const meta = {
        type: 'zip',
        name: 'archive.zip',
        size: content.length
      };
      const payload = {
        meta,
        data: arrayBufferToBase64(content)
      };
      return JSON.stringify(payload);
    }
  }

  function arrayBufferToBase64(u8){
    let CHUNK = 0x8000;
    let index = 0;
    let length = u8.length;
    let result = '';
    while(index < length){
      let slice = u8.subarray(index, Math.min(index + CHUNK, length));
      result += String.fromCharCode.apply(null, slice);
      index += CHUNK;
    }
    return btoa(result);
  }

  function base64ToUint8Array(b64){
    const bin = atob(b64);
    const len = bin.length;
    const u8 = new Uint8Array(len);
    for(let i=0;i<len;i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /* Progress helpers */
  const progressWrap = $('#progress-wrap');
  const progressLabel = progressWrap.querySelector('.progress-label');
  const progressTrack = progressWrap.querySelector('.progress-track');
  const progressBar = progressWrap.querySelector('.progress-bar');

  function showProgress(label){
    progressLabel.textContent = label || 'Uploading…';
    progressWrap.classList.remove('hidden');
    progressTrack.classList.add('active');
    updateProgress(2);
  }
  function hideProgress(){
    progressTrack.classList.remove('active');
    setTimeout(()=> progressWrap.classList.add('hidden'), 250);
  }
  function updateProgress(pct){
    const n = Math.max(0, Math.min(100, Math.round(pct)));
    progressBar.style.width = n + '%';
    progressTrack.setAttribute('aria-valuenow', String(n));
  }

  /* Create button: show uploading progress and hook JSZip onProgress */
  createBtn.addEventListener('click', async ()=>{
    try{
      createBtn.disabled = true;
      createBtn.textContent = 'Preparing…';
      linkArea.classList.add('hidden');

      showProgress('Packing files…');

      const originalFiles = currentFiles.slice();
      let lastReported = 0;
      const json = await (async () => {
        if(originalFiles.length === 0) throw new Error('No files');

        if(originalFiles.length === 1){
          showProgress('Reading file…');
          updateProgress(6);
          const f = originalFiles[0];

          const CHUNK = 1024 * 256;
          const size = f.size;
          let offset = 0;
          const parts = [];
          while(offset < size){
            const slice = f.slice(offset, offset + CHUNK);
            const buf = await slice.arrayBuffer();
            parts.push(new Uint8Array(buf));
            offset += CHUNK;
            const pct = Math.min(80, Math.floor((offset / size) * 80));
            updateProgress(pct);
          }
          let totalLen = parts.reduce((s,p)=>s+p.length,0);
          const combined = new Uint8Array(totalLen);
          let pos = 0;
          for(const p of parts){ combined.set(p, pos); pos += p.length; }

          const meta = {
            type: 'single',
            name: f.name,
            mime: f.type || 'application/octet-stream',
            size: f.size
          };
          updateProgress(86);
          const payload = {
            meta,
            data: arrayBufferToBase64(combined)
          };
          return JSON.stringify(payload);

        } else {
          if(!JSZip) throw new Error('Zipping not available in this environment');
          const zip = new JSZip();
          for(const f of originalFiles){
            const path = f.webkitRelativePath && f.webkitRelativePath.length ? f.webkitRelativePath : f.name;
            zip.file(path, await f.arrayBuffer());
          }
          const content = await zip.generateAsync({type:'uint8array', compression:'DEFLATE'}, (meta) => {
            const pct = Math.min(95, Math.floor(5 + (meta.percent * 0.85)));
            if(pct !== lastReported){
              updateProgress(pct);
              lastReported = pct;
            }
          });
          updateProgress(92);
          const meta = {
            type: 'zip',
            name: 'archive.zip',
            size: content.length
          };
          const payload = {
            meta,
            data: arrayBufferToBase64(content)
          };
          return JSON.stringify(payload);
        }
      })();

      updateProgress(96);
      await new Promise(r => setTimeout(r, 120)); // tiny pause for UX

      // If the compressed payload would be very large to embed in URL, store it in IndexedDB and create a compact reference.
      let finalUrl;
      let storeReference = false;
      let refId = null;

      // Prepare compressed blob (if pako available) or raw JSON blob
      if(pako){
        const compressed = pako.deflate(json);
        // If compressed size is larger than safe threshold for URL fragments (e.g. 1800 bytes), store in IDB
        if(compressed.length > 1800){
          storeReference = true;
        }
        if(!storeReference){
          const b64 = arrayBufferToBase64(new Uint8Array(compressed));
          const b64url = b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
          finalUrl = location.origin + location.pathname + '#file=v2!' + b64url;
        } else {
          // store blob in IDB and make a short ref: ref!<id>
          refId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
          const blob = new Blob([compressed], {type: 'application/octet-stream'});
          await idbPut(refId, {blob, meta: null}); // meta not needed because payload has meta inside json when inflated
          finalUrl = location.origin + location.pathname + '#file=ref!' + refId;
        }
      } else {
        // no pako: check JSON length
        if(json.length > 1800){
          storeReference = true;
        }
        if(!storeReference){
          const enc = encodeURIComponent(json);
          finalUrl = location.origin + location.pathname + '#file=v1!' + enc;
        } else {
          refId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
          const blob = new Blob([json], {type: 'application/json'});
          await idbPut(refId, {blob, meta: null});
          finalUrl = location.origin + location.pathname + '#file=ref!' + refId;
        }
      }

      // If user chose Server upload, send the payload blob to the server (websim.upload available) and create a short landing URL on this page.
      if(serverUploadChk && serverUploadChk.checked){
        showProgress('Uploading to server…');
        updateProgress(97);
        try{
          // create a blob: prefer compressed payload if possible
          let payloadBlob;
          if(pako){
            const compressed = pako.deflate(json);
            payloadBlob = new Blob([compressed], {type: 'application/octet-stream'});
          } else {
            payloadBlob = new Blob([json], {type: 'application/json'});
          }
          // websim.upload should return a URL to the uploaded file
          const uploadedUrl = await window.websim.upload(payloadBlob);
          // create a landing link on this origin that points to our page and includes a pointer to the uploaded URL
          const landing = `${location.origin}${location.pathname}?s=1&u=${encodeURIComponent(uploadedUrl)}`;
          finalUrl = landing;
          // store full
          shareLinkInput.dataset.full = finalUrl;
          shareLinkInput.value = compactLink(finalUrl);
        }catch(e){
          console.error('Server upload failed', e);
          // fallback to previous finalUrl
        }
      } else {
        // store full URL separately and show compact preview in the input
        shareLinkInput.dataset.full = finalUrl;
        shareLinkInput.value = compactLink(finalUrl);
      }

      linkArea.classList.remove('hidden');
      lastPayloadJson = json;
      downloadBtn.disabled = false;

      updateProgress(100);
      setTimeout(()=> hideProgress(), 400);

      downloadQrBtn.onclick = ()=> {
        const full = shareLinkInput.dataset.full || finalUrl;
        const qrUrl = `https://chart.googleapis.com/chart?cht=qr&chs=300x300&chld=L|1&chl=${encodeURIComponent(full)}`;
        fetch(qrUrl).then(r => r.blob()).then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'link-qr.png';
          a.click();
          URL.revokeObjectURL(a.href);
        });
      };

      downloadBtn.onclick = ()=>{
        try{
          if(!lastPayloadJson) throw new Error('No payload available');
          const p = JSON.parse(lastPayloadJson);
          const u8 = base64ToUint8Array(p.data);
          const blob = new Blob([u8], {type: (p.meta && p.meta.mime) || 'application/octet-stream'});
          const a = document.createElement('a');
          const filename = (p.meta && p.meta.type==='zip') ? (p.meta.name || 'archive.zip') : (p.meta && p.meta.name) || 'download';
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          a.click();
          setTimeout(()=> URL.revokeObjectURL(a.href), 5000);
        }catch(e){
          alert('Download failed: '+e.message);
        }
      };

    }catch(err){
      hideProgress();
      alert('Error: '+err.message);
    }finally{
      createBtn.disabled = false;
      createBtn.textContent = 'Create link';
    }
  });

  copyBtn.addEventListener('click', async ()=>{
    try{
      const full = shareLinkInput.dataset.full || shareLinkInput.value;
      await navigator.clipboard.writeText(full);
      copyBtn.textContent = 'Copied';

      try {
        location.assign(full);
      } catch(e) {
        try { window.open(full, '_blank'); } catch(e) {/* ignore */}
      }

      setTimeout(()=> copyBtn.textContent = 'Copy', 1500);
    }catch(e){
      alert('Copy failed. You can select the link and copy manually.');
    }
  });

  shareLinkInput.addEventListener('click', ()=>{
    const full = shareLinkInput.dataset.full;
    if(!full) return;
    const prev = shareLinkInput.value;
    shareLinkInput.value = full;
    shareLinkInput.select();
    setTimeout(()=> { shareLinkInput.value = prev; }, 600);
  });

  function compactLink(u){
    try{
      const hashIdx = u.indexOf('#');
      let base = (hashIdx>=0)? u.slice(0, hashIdx) : u;
      let frag = (hashIdx>=0)? u.slice(hashIdx) : '';
      if(frag.length <= 48) return base + frag;
      const start = frag.slice(0, 12);
      const end = frag.slice(-10);
      return base + start + '…' + end;
    }catch(e){
      return u;
    }
  }

  openBtn.addEventListener('click', ()=>{
    const u = shareLinkInput.dataset.full || shareLinkInput.value;
    window.open(u, '_blank');
  });


  // Receiving path: support v2 (inline), v1, ref!<id> which loads from IndexedDB, and server landing links (?s=1&u=<uploadedUrl>)
  async function parseFragment(){
    // server landing link handling via search params
    try{
      const params = new URLSearchParams(location.search);
      if(params.get('s') === '1' && params.get('u')){
        // fetch the uploaded file URL and try to parse as compressed or JSON
        const uploaded = params.get('u');
        try{
          const resp = await fetch(uploaded);
          const buf = await resp.arrayBuffer();
          // try pako inflate if available
          if(pako){
            try{
              const inflated = pako.inflate(new Uint8Array(buf), { to: 'string' });
              return JSON.parse(inflated);
            }catch(e){
              // try as text JSON
              try{
                const txt = new TextDecoder().decode(buf);
                return JSON.parse(txt);
              }catch(err){
                console.error('Failed to parse uploaded payload', err);
                return null;
              }
            }
          } else {
            try{
              const txt = new TextDecoder().decode(buf);
              return JSON.parse(txt);
            }catch(err){
              console.error('Failed to parse uploaded payload', err);
              return null;
            }
          }
        }catch(e){
          console.error('Failed to fetch uploaded URL', e);
          return null;
        }
      }
    }catch(e){
      console.warn('Search param handling failed', e);
    }

    const frag = location.hash || '';
    if(!frag.startsWith('#file=')) return null;
    const payload = frag.slice(6);
    if(payload.startsWith('ref!')){
      const id = payload.slice(4);
      try{
        const rec = await idbGet(id);
        if(!rec) return null;
        const blob = rec.blob;
        const buf = await blob.arrayBuffer();
        if(pako){
          try{
            const inflated = pako.inflate(new Uint8Array(buf), { to: 'string' });
            return JSON.parse(inflated);
          }catch(e){
            try{
              const txt = new TextDecoder().decode(buf);
              return JSON.parse(txt);
            }catch(err){
              console.error('Failed to parse stored payload', err);
              return null;
            }
          }
        } else {
          try{
            const txt = new TextDecoder().decode(buf);
            return JSON.parse(txt);
          }catch(err){
            console.error('Failed to parse stored payload', err);
            return null;
          }
        }
      }catch(e){
        console.error('Failed to load reference from storage', e);
        return null;
      }
    }

    if(payload.startsWith('v2!') && pako){
      const b64url = payload.slice(3);
      try{
        let b64 = b64url.replace(/-/g,'+').replace(/_/g,'/');
        while(b64.length % 4) b64 += '=';
        const u8 = base64ToUint8Array(b64);
        const json = pako.inflate(u8, { to: 'string' });
        return JSON.parse(json);
      }catch(e){
        console.error('Failed to parse v2 payload', e);
        return null;
      }
    } else if(payload.startsWith('v1!')){
      const enc = payload.slice(3);
      try{
        const json = decodeURIComponent(enc);
        return JSON.parse(json);
      }catch(e){
        console.error('Failed to parse payload', e);
        return null;
      }
    } else {
      try{
        return JSON.parse(decodeURIComponent(payload));
      }catch(e){
        return null;
      }
    }
  }

  async function prepareReceive(){
    const p = await parseFragment();
    if(!p) return;
    receiveSection.classList.remove('hidden');
    document.querySelector('#upload').classList.add('hidden');
    if(!p.meta || !p.data){ receiveInfo.textContent = 'Malformed payload'; return; }
    receiveInfo.innerHTML = `${escapeHtml(p.meta.name || 'file')} · ${formatBytes(p.meta.size || 0)}`;
    rawLink.href = location.href;
    rawLink.textContent = 'Open raw link';

    dlBtn.onclick = ()=>{
      try{
        const u8 = base64ToUint8Array(p.data);
        const blob = new Blob([u8], {type: (p.meta && p.meta.mime) || 'application/octet-stream'});
        const a = document.createElement('a');
        const filename = (p.meta && p.meta.type==='zip') ? (p.meta.name || 'archive.zip') : (p.meta && p.meta.name) || 'download';
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(()=> URL.revokeObjectURL(a.href), 5000);
      }catch(e){
        alert('Failed to construct download: '+e.message);
      }
    };
  }

  // Run receive check on load and when the fragment/hash or search params changes
  window.addEventListener('hashchange', prepareReceive);
  window.addEventListener('popstate', prepareReceive);
  prepareReceive();

})();