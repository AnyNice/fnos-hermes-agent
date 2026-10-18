// The renderer consumes the same typed capability seam as Electron. No agent behavior lives here.
export function adminPageForHash(hash) {
  const route=new URL((hash||'').replace(/^#/, '')||'/', 'https://hermes.invalid');
  const destinations={'/messaging':'messaging','/cron':'cron','/profiles':'settings'};
  if(route.pathname==='/capabilities')return route.searchParams.get('tab')==='mcp'?'mcp':'tools';
  return destinations[route.pathname]||null;
}

export function createBrowserBridge({ hostRoot, browser = window }) {
  const root = new URL(hostRoot);
  const nativeBase = new URL('api/native/', root);
  const hostBase = new URL('api/host/', root);
  const subscription = () => () => {};
  const blobs = new Map();
  const filePaths = new WeakMap();
  let blobDatabase;
  let profile = new URLSearchParams(browser.location.search).get('profile') || 'default';
  const unavailable = name => async () => { throw new Error(`${name} 请在 Hermes Admin 中管理，或使用受支持的浏览器操作。`); };
  const checkConnection = id => { if (id && id !== 'local') throw new Error('This browser host serves only this NAS.'); };
  function rememberProfile(name) {
    profile=name||'default';
    if(browser.history&&browser.location.href){const url=new URL(browser.location.href);url.searchParams.set('profile',profile);browser.history.replaceState(browser.history.state,'',url);}
    return {profile};
  }
  const redirectManagement=()=>{
    const page=adminPageForHash(browser.location.hash);if(!page)return;
    const destination=new URL(root);destination.searchParams.set('profile',profile);destination.hash=`/${page}`;
    browser.location.assign(destination.href);
  };
  browser.addEventListener?.('hashchange',redirectManagement);
  if(browser.location.hash)queueMicrotask(redirectManagement);

  function database() {
    if (!blobDatabase) blobDatabase = new Promise((resolve,reject) => {
      const request=browser.indexedDB.open(`hermes-fnos-attachments:${root.pathname}`,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('files');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    return blobDatabase;
  }
  async function blobStore(mode,key,value) {
    const db=await database();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('files',mode);const store=transaction.objectStore('files');
      const request=mode==='readonly'?store.get(key):store.put(value,key);
      transaction.oncomplete=()=>resolve(request.result);transaction.onerror=()=>reject(transaction.error);
      transaction.onabort=()=>reject(transaction.error||new Error('附件缓存写入失败'));
    });
  }
  function storeBlob(blob,name) {
    if(blob.size>25*1024*1024)throw new Error('浏览器附件暂支持最大 25 MB 的单个文件。');
    const key=`browser-local:${encodeURIComponent(profile)}/${browser.crypto.randomUUID()}/${encodeURIComponent(name||'attachment')}`;
    const saved=blobStore('readwrite',key,{blob,at:Date.now()});
    // The synchronous File -> path bridge cannot await IDB; the later byte read awaits this exact write.
    saved.catch(()=>{});blobs.set(key,{blob,saved});if(blobs.size>32)blobs.delete(blobs.keys().next().value);return key;
  }
  async function readDataUrl(filePath) {
    if(!filePath.startsWith('browser-local:')){
      const result=await api({path:`/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`});
      return typeof result==='string'?result:result.dataUrl;
    }
    const cached=blobs.get(filePath);if(cached)await cached.saved;
    const blob=cached?.blob||(await blobStore('readonly',filePath))?.blob;
    if(!blob)throw new Error('附件缓存不可用，请重新选择文件。');
    return new Promise((resolve,reject)=>{const reader=new browser.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
  }

  async function json(url, options = {}) {
    const response = await browser.fetch(url, { credentials: 'same-origin', ...options });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : value.error || `HTTP ${response.status}`);
    return value;
  }

  async function api(request) {
    checkConnection(request.connectionId);
    if (!request.path.startsWith('/api/') || request.path.includes('\\')) throw new Error('Invalid native API path');
    const url = new URL(request.path.slice(1), nativeBase);
    if (!url.href.startsWith(nativeBase.href)) throw new Error('Invalid native API path');
    // Capture the owner at the call boundary. Never change Hermes' global active profile.
    if (request.profile != null) url.searchParams.set('profile', request.profile || 'default');
    else if (!url.searchParams.has('profile')) url.searchParams.set('profile', profile);
    const headers = {};
    let body;
    if (request.upload) {
      body = new FormData();
      body.append('file', new Blob([request.upload.bytes], { type: request.upload.contentType || 'application/octet-stream' }), request.upload.filename);
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    return json(url, { method: request.method || 'GET', headers, body,
      signal: AbortSignal.timeout(request.timeoutMs || 60_000) });
  }

  function connection(selected) {
    const owner = selected || profile;
    const socket = new URL('api/ws', nativeBase);
    socket.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
    socket.searchParams.set('profile', owner);
    return { baseUrl: nativeBase.href.replace(/\/$/, ''), wsUrl: socket.href, token: '', profile: owner,
      mode: 'remote', remoteKind: 'url', authMode: 'token', source: 'settings', connectionId: 'local',
      sharedPrimary: true, registryScoped: true, sharedRemote: true,
      isFullscreen: false, isMaximized: false, customWindowControls: false,
      nativeOverlayWidth: 0, windowButtonPosition: null, logs: [] };
  }

  const registry = { version: 2, primary: 'local', launchMode: 'primary', secureTokenStorage: false,
    connections: [{ id: 'local', kind: 'remote', label: 'Hermes NAS', url: nativeBase.href, tokenSet: false, tokenPreview: null }] };
  function openExternal(value) {
    const url = new URL(value, root);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP(S) links can be opened.');
    browser.open(url.href, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }

  return {
    api,
    getConnection: async selected => connection(selected),
    getConnectionFor: async ({ connectionId, profile: selected } = {}) => { checkConnection(connectionId); return connection(selected); },
    getGatewayWsUrl: async selected => ({ ok: true, wsUrl: connection(selected).wsUrl }),
    getGatewayWsUrlFor: async ({ connectionId, profile: selected } = {}) => { checkConnection(connectionId); return { ok: true, wsUrl: connection(selected).wsUrl }; },
    getProfileRoutes: async profiles => profiles.map(name => ({ connectionId: 'local', mode: 'remote', primary: true, profile: name, targetProfile: name })),
    revalidateConnection: async () => { await api({ path: '/api/status' }); return { ok: true, rebuilt: false }; },
    getBootProgress: async () => ({ phase: 'browser.connect', message: '连接 Hermes 原生后端', progress: 8, running: true, fakeMode: false, error: null, timestamp: Date.now() }),
    onBootProgress: subscription, onBackendExit: subscription, onPreviewFileChanged: subscription,
    onBrowserPopoutClosed: subscription, onBootstrapEvent: subscription,
    connections: { list: async () => registry, onChanged: subscription, setLastUsed: async id => { checkConnection(id); return { ok: true, registry }; } },
    profile: {
      get: async () => ({ profile }), remember: async name => rememberProfile(name),
      set: async name => rememberProfile(name),
      getDefault: async () => null,
      onDefaultChanged: subscription,
    },
    touchBackend: async () => { await api({ path: '/api/status' }); return { ok: true }; },
    openExternal, openPreviewInBrowser: openExternal,
    openWindow: async options => { const url = new URL('web/', root); if (options?.profile) url.searchParams.set('profile', options.profile); await openExternal(url.href); return { ok: true }; },
    openSessionWindow: async (id, options = {}) => {
      checkConnection(options.connectionId);
      const url = new URL('web/', root); url.searchParams.set('profile', options.profile || profile);
      url.searchParams.set('win', 'secondary'); url.searchParams.set('session', id);
      await openExternal(url.href); return { ok: true };
    },
    getBootstrapState: async () => ({ active: false, manifest: null, stages: {}, error: null, log: [], startedAt: null, completedAt: null, setupChoice: null }),
    probeLocalBackend: async () => ({ bootstrapNeeded: false }),
    getVersion: () => json(new URL('version', hostBase)),
    getSyncStatus: async () => null,
    requestMicrophoneAccess: async () => {
      const stream = await browser.navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); return true;
    },
    notify: async () => false,
    glassSupported: false, translucencySupported: false, localModelsEnabled: false,
    windowControls: { custom: false },
    logLine: () => {},
    readDir: filePath => api({ path: `/api/fs/list?path=${encodeURIComponent(filePath)}` }),
    readFileText: filePath => api({ path: `/api/fs/read-text?path=${encodeURIComponent(filePath)}` }),
    readFileDataUrl: readDataUrl, readFileDataUrlForAttach: readDataUrl,
    writeTextFile: (filePath, content) => api({ path: '/api/fs/write-text', method: 'POST', body: { path: filePath, content } }),
    sanitizeWorkspaceCwd: async cwd => { const value = await api({ path: '/api/fs/default-cwd' }); return { cwd: cwd || value.cwd, sanitized: !cwd }; },
    readClipboard: async () => browser.navigator.clipboard.readText(),
    writeClipboard: async text => {await browser.navigator.clipboard.writeText(text);return true;},
    getPathForFile: file => {let key=filePaths.get(file);if(!key){key=storeBlob(file,file.name);filePaths.set(file,key);}return key;},
    saveImageBuffer: async (data,ext,name) => {const key=storeBlob(new Blob([data],{type:`image/${ext==='jpg'?'jpeg':ext}`}),name||`image.${ext}`);await blobs.get(key).saved;return key;},
    savePastedText: async text => {const key=storeBlob(new Blob([text],{type:'text/plain'}),'pasted-text.txt');await blobs.get(key).saved;return key;},
    saveGatewayFile: async ({connectionId,path:filePath,profile:selected,suggestedName})=>{
      checkConnection(connectionId);const url=new URL('api/fs/download',nativeBase);url.searchParams.set('path',filePath);url.searchParams.set('profile',selected||profile);
      const anchor=browser.document.createElement('a');anchor.href=url.href;anchor.download=suggestedName||'';anchor.click();return {saved:true};
    },
    selectPaths: async options => {
      if(options?.properties?.includes('openDirectory'))throw new Error('请在 Hermes 的远程目录选择器中选择 NAS 工作区。');
      return new Promise((resolve,reject)=>{
        const input=browser.document.createElement('input');input.type='file';input.multiple=options?.properties?.includes('multiSelections')||false;
        input.onchange=()=>{try{resolve(Array.from(input.files||[]).map(file=>{const key=storeBlob(file,file.name);filePaths.set(file,key);return key;}));}catch(error){reject(error);}};
        input.oncancel=()=>resolve([]);input.click();
      });
    },
    revealLogs: () => openExternal(new URL('#/logs', root).href),
    revealPath: unavailable('打开 NAS 目录'),
    fetchLinkTitle: async () => '',
    // Native lifecycle/update actions are deliberately not claimed by the renderer.
    recycleBackend: unavailable('服务重启'),
  };
}
