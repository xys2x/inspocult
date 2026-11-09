/* =========================================================================
   inspocult — content planner (with accounts + cloud sync)

   Local-first: everything is saved in this browser (IndexedDB) straight away,
   then synced to the user's account in Supabase in the background.
     - Cloud gets the post details + a SMALL preview per slide (~50 KB JPEG).
     - Full-size files stay only on the device where the post was made
       (the user already has the originals; the planner is for organising).
   Loaded after the studio's main script and the supabase-js UMD build.
   Studio globals used: canvas, W, H, draw, selectedId, anyVideoAnywhere,
   runExportAd, recordCanvasVideo, setProgress, fitStage.
   ========================================================================= */
(() => {
'use strict';

// ---------- Supabase project (public values, safe to ship in website code) ----------
const SUPABASE_URL = 'https://tpjvspalsxdbutjqhovo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ql_qLrRQV5zc4cSZoZ0gOw_-qhPTvDv';
const PREVIEW_BUCKET = 'previews';
// Ads: the planner shares the studio's bottom banner (#siteAdBar in template-studio.html).
const PREVIEW_MAX = 720;        // longest side of preview images, px
const PREVIEW_QUALITY = 0.8;

// ---------- small helpers ----------
const $  = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const pad = n => String(n).padStart(2,'0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fromIso = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const startOfWeek = d => { const x = new Date(d.getFullYear(),d.getMonth(),d.getDate()); return addDays(x,-((x.getDay()+6)%7)); };
const DN = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const MN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const dayName = k => DN[(fromIso(k).getDay()+6)%7];
const dayLabel = k => `${dayName(k)} ${fromIso(k).getDate()}`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const today = () => { const t = new Date(); t.setHours(0,0,0,0); return t; };
const extFor = mime => ({ 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/gif':'gif', 'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov' }[mime] || (mime||'').split('/')[1] || 'bin');
const fmtDur = s => s ? `${Math.floor(s/60)}:${pad(Math.round(s%60))}` : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let toastTimer;
function toast(msg, err=false){
  const t = $('#plToast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), err ? 5000 : 2600);
}

// ---------- platform formats ----------
// One place to update when Instagram / TikTok / YouTube change their specs.
// accepts = extra width/height ratios the platform also takes without cropping.
const PLATFORMS = { ig:'Instagram', tt:'TikTok', yt:'YouTube' };
const FORMATS = {
  'ig-post':  { plat:'ig', name:'Post',   short:'IG Post',   w:1080, h:1350, caption:2200, carousel:20, media:'any',   accepts:[1, 1.91] },
  'ig-story': { plat:'ig', name:'Story',  short:'IG Story',  w:1080, h:1920, caption:0,    carousel:0,  media:'any' },
  'ig-reel':  { plat:'ig', name:'Reel',   short:'IG Reel',   w:1080, h:1920, caption:2200, carousel:0,  media:'video' },
  'tt-video': { plat:'tt', name:'Video',  short:'TikTok',    w:1080, h:1920, caption:4000, carousel:0,  media:'video' },
  'tt-photo': { plat:'tt', name:'Photos', short:'TT Photos', w:1080, h:1920, caption:4000, carousel:35, media:'image' },
  'yt-video': { plat:'yt', name:'Video',  short:'YT Video',  w:1920, h:1080, caption:5000, carousel:0,  media:'video', thumb:true, title:100 },
  'yt-short': { plat:'yt', name:'Short',  short:'YT Short',  w:1080, h:1920, caption:5000, carousel:0,  media:'video', title:100 },
};
const YT_THUMB = { w:1280, h:720 };
const MAX_HASHTAGS = 30;
const GRID_FMTS = { ig:['ig-post','ig-reel'], tt:['tt-video','tt-photo'] };
const gcd = (a,b) => b ? gcd(b, a%b) : a;
const ratioTxt = f => { const g = gcd(f.w,f.h); return `${f.w/g}:${f.h/g}`; };
const ratioOf = f => f.w / f.h;
const ratioIcon = f => { const r = ratioOf(f), h = r > 1 ? Math.round(16/r) : 11, w = r > 1 ? 16 : Math.round(11*r); return `<span class="r" style="width:${w}px;height:${h}px"></span>`; };
const fits = (f, w, h) => [ratioOf(f), ...(f.accepts||[])].some(r => Math.abs(w/h - r) < 0.04);
const STATUS_DOT = { draft:'#c9c1a8', ready:'#A8BFA0', posted:'#2f6f62' };
const HASHTAG_SETS = {
  'aesthetic pack':'#aesthetic #moodboard #pinterestinspired #softaesthetic #inspo',
  'daily vlog':'#dayinmylife #vlog #routine #thatgirl',
  'cozy':'#cozyvibes #slowliving #homecafe #autumnaesthetic',
};

// ---------- local storage (IndexedDB) ----------
// posts store: every post on this device, for any account (field `owner`).
// A slide: { id, type, mime, w, h, name, duration, blob?(full, this device only), preview?(small JPEG), previewPath?(cloud) }
let db = null;
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('inspocult-planner', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if(!d.objectStoreNames.contains('posts')) d.createObjectStore('posts', { keyPath:'id' });
      if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const r = fn(t.objectStore(store));
  t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
});
const storageFail = err => { console.error(err); toast(err && err.name==='QuotaExceededError' ? 'This browser’s storage is full. Delete old posts or big videos and try again.' : 'Could not save on this computer.', true); };
const putLocal = p => db ? req('posts','readwrite', s => s.put(p)).catch(storageFail) : Promise.resolve();
const delLocal = id => db ? req('posts','readwrite', s => s.delete(id)).catch(storageFail) : Promise.resolve();
const kvSet = (k, v) => db ? req('kv','readwrite', s => s.put(v, k)).catch(storageFail) : Promise.resolve();
const kvGet = k => db ? req('kv','readonly', s => s.get(k)).catch(()=>undefined) : Promise.resolve(undefined);

// Every edit goes through here: save on this device now, sync to the cloud soon.
function touch(p){ p.updatedAt = Date.now(); p.dirty = true; putLocal(p); schedulePush(); }
const saveTimers = {};
function touchSoon(p){ p.updatedAt = Date.now(); p.dirty = true; clearTimeout(saveTimers[p.id]); saveTimers[p.id] = setTimeout(()=>{ putLocal(p); schedulePush(); }, 500); }

// Object URLs for blobs (full files and previews)
const urls = new Map();
const blobURL = (key, blob) => { if(!blob) return ''; if(!urls.has(key)) urls.set(key, URL.createObjectURL(blob)); return urls.get(key); };
const fullURL = s => s && s.blob ? blobURL(s.id+':f', s.blob) : '';
const prevURL = s => s && s.preview ? blobURL(s.id+':p', s.preview) : '';
function forgetURLs(s){ if(!s) return; ['f','p'].forEach(k => { const key = `${s.id}:${k}`; if(urls.has(key)){ URL.revokeObjectURL(urls.get(key)); urls.delete(key); } }); }
// When a slide leaves a post, its cloud preview must be deleted on the next sync
function dropSlide(p, s){ if(!s) return; forgetURLs(s); if(s.previewPath){ (p.orphans = p.orphans || []).push(s.previewPath); } }

// ---------- previews ----------
async function previewFromSource(src, sw, sh){
  const scale = Math.min(1, PREVIEW_MAX / Math.max(sw, sh));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw*scale)); c.height = Math.max(1, Math.round(sh*scale));
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0,0,c.width,c.height); x.drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', PREVIEW_QUALITY));
}
// Reads a file/blob: its size, video length, and a small preview image.
function analyse(blob, type){
  return new Promise(res => {
    const url = URL.createObjectURL(blob);
    const finish = async (el, w, h, duration=null) => {
      let preview = null;
      try{ if(w && h) preview = await previewFromSource(el, w, h); }catch(e){ console.warn('preview failed', e); }
      URL.revokeObjectURL(url); res({ w, h, duration, preview });
    };
    if(type==='video'){
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
      const t = setTimeout(() => finish(v, v.videoWidth, v.videoHeight, v.duration||null), 8000);
      v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration||1)/3); };
      v.onseeked = () => { clearTimeout(t); finish(v, v.videoWidth, v.videoHeight, isFinite(v.duration) ? v.duration : null); };
      v.onerror = () => { clearTimeout(t); URL.revokeObjectURL(url); res({ w:null, h:null, duration:null, preview:null }); };
      v.src = url;
    } else {
      const i = new Image();
      i.onload = () => finish(i, i.naturalWidth, i.naturalHeight);
      i.onerror = () => { URL.revokeObjectURL(url); res({ w:null, h:null, duration:null, preview:null }); };
      i.src = url;
    }
  });
}
async function slideFromFile(f){
  const type = f.type.startsWith('video') ? 'video' : 'image';
  const a = await analyse(f, type);
  return { id:uid(), type, mime:f.type || (type==='video'?'video/mp4':'image/png'), blob:f, name:f.name, w:a.w, h:a.h, duration:a.duration, preview:a.preview };
}

// ---------- state ----------
let store = [];                // all posts on this device (any account)
let me = null;                 // logged-in user { id, email }
let oldPosts = { ig:[], tt:[] };   // feed preview: images of the user's already-published posts
let view = 'week', feedPlat = 'ig';
let cursor = today();
let selId = null, slideIdx = 0;
let pendingDate = null, uploadMode = null;   // 'new' | 'append' | 'replace' | 'thumb' | 'old'

// Everything this account owns on this device. Inspo items share the posts store/table (kind:'inspo').
const owned = () => me ? store.filter(p => p.owner===me.id && !p.deleted) : [];
const mine = () => owned().filter(p => !p.kind || p.kind==='post');   // planner posts (not inspo items / sticky note)
const inspos = () => owned().filter(p => p.kind==='inspo');    // inspo board items
const postsOn = k => mine().filter(p=>p.date===k).sort((a,b)=>a.time.localeCompare(b.time));
const isCarousel = p => p.slides.length > 1;
const fmtsOf = p => p.formats.map(k=>FORMATS[k]).filter(Boolean);
const mainFmt = p => fmtsOf(p)[0] || FORMATS['ig-post'];
const kindOf = p => isCarousel(p) ? 'carousel' : (p.slides[0] ? p.slides[0].type : 'image');
const captionLimit = p => { const l = fmtsOf(p).map(f=>f.caption).filter(Boolean); return l.length ? Math.min(...l) : 0; };
const tagCount = p => (p.tags.match(/#[^\s#]+/g)||[]).length;
const capLen = p => p.caption.length + (p.tags ? p.tags.length + 2 : 0);
const selected = () => mine().find(p=>p.id===selId);

// Small picture for calendars / grids: the preview if we have one, else the full file
function thumbHTML(s){
  if(!s) return '';
  if(s.preview) return `<img src="${prevURL(s)}" alt="">`;
  if(s.blob) return s.type==='video' ? `<video src="${fullURL(s)}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="${fullURL(s)}" alt="">`;
  return '';
}
// Big view in the editor: full file on the device that made it, preview elsewhere
function viewerHTML(s){
  if(!s) return '';
  if(s.blob) return s.type==='video' ? `<video src="${fullURL(s)}" muted playsinline controls></video>` : `<img src="${fullURL(s)}" alt="">`;
  if(s.preview) return `<img src="${prevURL(s)}" alt=""><span class="preview-only">preview only${s.type==='video'&&s.duration?` · ▶ ${fmtDur(s.duration)}`:''}</span>`;
  return '<span class="preview-only">loading preview…</span>';
}

function warningsFor(p){
  const out = [], fs = fmtsOf(p), n = p.slides.length;
  if(!fs.length) out.push({ msg:'Pick at least one platform format' });
  if(!n) out.push({ msg:'No media yet' });
  fs.forEach(f => {
    const nm = `${PLATFORMS[f.plat]} ${f.name}`;
    if(n > 1 && !f.carousel) out.push({ msg:`${nm} can’t be a carousel; it’s a single ${f.media==='video'?'video':'item'}` });
    if(n > 1 && f.carousel && n > f.carousel) out.push({ msg:`${nm} allows max ${f.carousel} slides (you have ${n})` });
    if(f.media==='video' && p.slides.some(s=>s.type!=='video')) out.push({ msg:`${nm} needs a video` });
    if(f.media==='image' && p.slides.some(s=>s.type==='video')) out.push({ msg:`${nm} carousels can’t include videos` });
  });
  return out;
}

// =========================================================================
//  ACCOUNTS (Supabase Auth) + CLOUD SYNC
// =========================================================================
let sb = null;                       // Supabase client (null if the library didn't load, e.g. offline)
let syncState = 'idle';              // idle | syncing | synced | offline | setup | error
let syncMsg = '';
let pushTimer = null, pushing = false, pushAgain = false, lastPull = 0;
const LAST_USER_KEY = 'inspocult-last-user';

function setSync(state, msg=''){
  syncState = state; syncMsg = msg;
  const label = { idle:'', syncing:'Syncing…', synced:'✓ Synced', offline:'Offline · saved on this computer', setup:'Cloud not set up yet', error:'Sync problem' }[state] || '';
  ['#plSync', '#insSync'].forEach(sel => { const el = $(sel); if(el){ el.textContent = label; el.className = 'sync-pill ' + state; el.title = msg || label; } });
  const dot = $('#plAcctDot'); if(dot) dot.className = 'acct-dot ' + state;
  const line = $('#plAcctSync'); if(line) line.textContent = msg || label || 'Up to date';
}
function syncError(err, where){
  console.error('sync', where, err);
  const m = (err && (err.message || err.error_description || err.code)) || String(err);
  if(!navigator.onLine || /Failed to fetch|NetworkError|network/i.test(m)) return setSync('offline', 'You’re offline. Changes are saved on this computer and will sync when you’re back online.');
  if(/relation .* does not exist|Could not find the table|PGRST205|42P01|Bucket not found/i.test(m)) return setSync('setup', 'Cloud sync isn’t set up yet: run supabase-setup.sql in the Supabase SQL Editor.');
  setSync('error', 'Sync problem: ' + m);
}

const remoteSlide = s => s ? { id:s.id, type:s.type, mime:s.mime, w:s.w, h:s.h, name:s.name||null, duration:s.duration||null, previewPath:s.previewPath||null } : null;
const USER_TZ = (() => { try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }catch(e){ return 'UTC'; } })();
function dueAtOf(p){ const d = new Date(`${p.date}T${p.time || '18:00'}`); return isNaN(d) ? null : d.toISOString(); }   // local date+time → UTC
const remoteData = p => ({ kind:p.kind||'post', note:p.note||'', date:p.date, time:p.time, dueAt: p.kind && p.kind!=='post' ? null : dueAtOf(p), tz:USER_TZ,
  formats:p.formats, caption:p.caption, tags:p.tags, title:p.title, status:p.status,
  created:p.created, updatedAt:p.updatedAt, slides:p.slides.map(remoteSlide), thumb:remoteSlide(p.thumb) });

async function uploadPreview(s, prefix=''){
  if(!s || s.previewPath || !s.preview) return;
  const path = `${me.id}/${prefix}${s.id}.jpg`;
  const { error } = await sb.storage.from(PREVIEW_BUCKET).upload(path, s.preview, { upsert:true, contentType:'image/jpeg' });
  if(error) throw error;
  s.previewPath = path;
}

function schedulePush(){ if(!me || !sb) return; clearTimeout(pushTimer); pushTimer = setTimeout(pushAll, 1200); }

// Send every changed post (and deletions) to the cloud
async function pushAll(){
  if(!me || !sb) return;
  if(pushing){ pushAgain = true; return; }
  pushing = true; pushAgain = false;
  const todo = store.filter(p => p.owner===me.id && p.dirty);
  if(!todo.length && !oldPostsDirty){ pushing = false; return; }   // nothing to send: keep the current status (e.g. "not set up")
  setSync('syncing');
  try{
    for(const p of todo){
      if(p.deleted){
        const paths = [...p.slides.map(s=>s.previewPath), p.thumb && p.thumb.previewPath, ...(p.orphans||[])].filter(Boolean);
        const { error } = await sb.from('planner_posts').delete().eq('id', p.id);
        if(error) throw error;
        if(paths.length) await sb.storage.from(PREVIEW_BUCKET).remove(paths);
        store = store.filter(x => x!==p); await delLocal(p.id);
        continue;
      }
      for(const s of p.slides) await uploadPreview(s);
      await uploadPreview(p.thumb);
      const sentAt = p.updatedAt;
      const { error } = await sb.from('planner_posts').upsert({ user_id:me.id, id:p.id, data:remoteData(p), updated_at:new Date(p.updatedAt).toISOString() }, { onConflict:'user_id,id' });
      if(error) throw error;
      if(p.orphans && p.orphans.length){ await sb.storage.from(PREVIEW_BUCKET).remove(p.orphans); p.orphans = []; }
      p.synced = true;
      if(p.updatedAt === sentAt) p.dirty = false;   // edited again while sending → stays dirty for the next round
      await putLocal(p);
    }
    if(oldPostsDirty) await pushOldPosts();
    setSync('synced');
  } catch(err){ syncError(err, 'push'); }
  pushing = false;
  if(pushAgain) schedulePush();
}

// Fetch the account's posts and merge them with this device
async function pullAll(force=false){
  if(!me || !sb) return;
  if(!force && Date.now() - lastPull < 20000) return;
  lastPull = Date.now();
  setSync('syncing');
  try{
    const { data:rows, error } = await sb.from('planner_posts').select('id,data,updated_at');
    if(error) throw error;
    const remoteIds = new Set(rows.map(r=>r.id));
    let changed = false;
    for(const r of rows){
      const d = r.data || {};
      const local = store.find(p => p.id===r.id && p.owner===me.id);
      if(local && (local.dirty || (local.updatedAt||0) >= (d.updatedAt||0))) continue;   // ours is newer / unsent
      const keep = new Map(); if(local){ [...local.slides, local.thumb].filter(Boolean).forEach(s => keep.set(s.id, s)); }
      const merge = m => m ? { ...m, blob:(keep.get(m.id)||{}).blob || null, preview:(keep.get(m.id)||{}).preview || null } : null;
      const p = { id:r.id, owner:me.id, kind:d.kind||'post', note:d.note||'', date:d.date, time:d.time||'18:00', formats:d.formats||[], caption:d.caption||'', tags:d.tags||'', title:d.title||'',
        status:d.status||'draft', created:d.created||Date.now(), updatedAt:d.updatedAt||Date.now(), slides:(d.slides||[]).map(merge), thumb:merge(d.thumb),
        dirty:false, synced:true };
      if(local) Object.assign(local, p); else store.push(p);
      await putLocal(local || p); changed = true;
    }
    // removed on another device → remove here too (only posts that were synced before and have no unsent edits)
    for(const p of store.filter(p => p.owner===me.id && p.synced && !p.dirty && !remoteIds.has(p.id))){
      store = store.filter(x => x!==p); await delLocal(p.id); changed = true;
      if(selId===p.id) selId = null;
    }
    await pullOldPosts();
    await loadReminders();
    setSync(store.some(p=>p.owner===me.id && p.dirty) ? 'syncing' : 'synced');
    if(changed){ render(); renderInspo(); }
    fetchMissingPreviews();
    schedulePush();
  } catch(err){ syncError(err, 'pull'); }
}

// Download previews this device doesn't have yet (e.g. posts made on another computer)
let fetchingPreviews = false;
async function fetchMissingPreviews(){
  if(fetchingPreviews || !me || !sb) return; fetchingPreviews = true;
  try{
    const need = [];
    owned().forEach(p => [...p.slides, p.thumb].forEach(s => { if(s && !s.preview && !s.blob && s.previewPath) need.push([p,s]); }));
    for(let i=0; i<need.length; i+=4){
      await Promise.all(need.slice(i,i+4).map(async ([p,s]) => {
        const { data, error } = await sb.storage.from(PREVIEW_BUCKET).download(s.previewPath);
        if(!error && data){ s.preview = data; await putLocal(p); }
      }));
      renderView(); if(selId) renderDrawer(); renderInspo();
    }
  } catch(err){ console.warn('preview download', err); }
  fetchingPreviews = false;
}

// Feed preview "current posts" (preview images only) live in planner_kv + storage
let oldPostsDirty = false;
async function saveOldPosts(){ await kvSet('oldPosts:'+me.id, oldPosts); oldPostsDirty = true; schedulePush(); }
async function pushOldPosts(){
  for(const k of ['ig','tt']) for(const s of oldPosts[k]) await uploadPreview(s, 'old-');
  const meta = { ig:oldPosts.ig.map(remoteSlide), tt:oldPosts.tt.map(remoteSlide), layout:oldPosts.layout || {} };
  const { error } = await sb.from('planner_kv').upsert({ user_id:me.id, key:'oldPosts', value:meta, updated_at:new Date().toISOString() }, { onConflict:'user_id,key' });
  if(error) throw error;
  oldPostsDirty = false; await kvSet('oldPosts:'+me.id, oldPosts);
}
async function pullOldPosts(){
  if(oldPostsDirty) return;
  const { data, error } = await sb.from('planner_kv').select('value').eq('key','oldPosts').maybeSingle();
  if(error) throw error;
  if(!data || !data.value) return;
  const byId = new Map([...oldPosts.ig, ...oldPosts.tt].map(s=>[s.id,s]));
  const next = { ig:[], tt:[] };
  for(const k of ['ig','tt']) for(const m of (data.value[k]||[])){
    const have = byId.get(m.id);
    let preview = have && have.preview;
    if(!preview && m.previewPath){ const r = await sb.storage.from(PREVIEW_BUCKET).download(m.previewPath); if(!r.error) preview = r.data; }
    next[k].push({ ...m, preview });
  }
  next.layout = data.value.layout || oldPosts.layout || {};
  oldPosts = next; await kvSet('oldPosts:'+me.id, oldPosts);
}

// Make previews for posts saved before previews existed (or uploaded while offline)
async function ensurePreviews(){
  for(const p of owned()){
    let changed = false;
    for(const s of [...p.slides, p.thumb]){
      if(s && s.blob && !s.preview){
        const a = await analyse(s.blob, s.type); s.preview = a.preview; s.w = s.w || a.w; s.h = s.h || a.h; s.duration = s.duration || a.duration; changed = true;
      }
    }
    if(changed){ p.dirty = true; await putLocal(p); }
  }
  schedulePush();
}

// ----- auth -----
function rememberUser(u){ try{ localStorage.setItem(LAST_USER_KEY, JSON.stringify(u ? { id:u.id, email:u.email } : null)); }catch(e){} }
function cachedUser(){ try{ return JSON.parse(localStorage.getItem(LAST_USER_KEY) || 'null'); }catch(e){ return null; } }

async function onSignedIn(user){
  const firstTime = !me || me.id !== user.id;
  me = { id:user.id, email:user.email };
  rememberUser(me);
  if(firstTime){
    // Posts made on this device before logging in (no owner yet) join this account
    const unowned = store.filter(p => !p.owner);
    unowned.forEach(p => { p.owner = me.id; p.dirty = true; p.updatedAt = p.updatedAt || Date.now(); putLocal(p); });
    const legacyOld = await kvGet('oldPosts');
    oldPosts = (await kvGet('oldPosts:'+me.id)) || { ig:[], tt:[] };
    if(legacyOld && (legacyOld.ig||[]).length + (legacyOld.tt||[]).length && !oldPosts.ig.length && !oldPosts.tt.length){
      oldPosts = legacyOld; await kvSet('oldPosts', undefined); oldPostsDirty = true;
      for(const k of ['ig','tt']) for(const s of oldPosts[k]) if(s.blob && !s.preview){ s.preview = (await analyse(s.blob, s.type)).preview; delete s.blob; }
      await kvSet('oldPosts:'+me.id, oldPosts);
    }
    if(unowned.length) toast(`${unowned.length} post${unowned.length>1?'s':''} from this computer added to your account`);
  }
  renderAccount();
  render();
  ensurePreviews();
  pullAll(true);
}

// ----- email reminders (sent by the post-reminders function on Supabase) -----
let reminders = { emailReminders:true, leadMin:0 };   // reminders are always on; people only choose when
function renderRemPill(){
  const b = $('#plRemPill'); if(!b) return;
  b.textContent = reminders.emailReminders ? `✉ reminders on${reminders.leadMin ? ` · ${reminders.leadMin===60 ? '1 h' : reminders.leadMin+' min'} before` : ''}` : '✉ reminders off';
  b.classList.toggle('on', !!reminders.emailReminders);
}
async function loadReminders(){
  if(!me) return;
  const local = await kvGet('settings:'+me.id); if(local) reminders = { ...reminders, ...local };
  let serverOn = false;
  if(sb){ try{ const { data } = await sb.from('planner_kv').select('value').eq('key','settings').maybeSingle(); if(data && data.value){ reminders = { ...reminders, ...data.value }; serverOn = !!data.value.emailReminders; } }catch(e){} }
  if(!serverOn){ reminders.emailReminders = false; await saveReminders({ emailReminders:true }, true); }   // switch on for everyone, quietly
  renderRemPill();
}
async function saveReminders(change, quiet){
  const turningOn = change.emailReminders === true && !reminders.emailReminders;
  reminders = { ...reminders, ...change };
  await kvSet('settings:'+me.id, reminders);
  renderRemPill(); renderAccount();
  if(turningOn){
    // make sure every upcoming post has its posting time on the server
    mine().filter(p => fromIso(p.date) >= today() && p.status!=='posted').forEach(p => { p.dirty = true; putLocal(p); });
    schedulePush();
  }
  try{
    const { error } = await sb.from('planner_kv').upsert({ user_id:me.id, key:'settings', value:reminders, updated_at:new Date().toISOString() }, { onConflict:'user_id,key' });
    if(error) throw error;
    if(!quiet) toast(`✓ We'll email ${me.email} ${reminders.leadMin ? (reminders.leadMin===60 ? '1 hour' : reminders.leadMin+' minutes')+' before' : 'when'} each post is due`);
  } catch(err){ console.error(err); if(!quiet) toast('Couldn’t save the reminder setting. Check your connection and try again.', true); }
}

function onSignedOut(){
  reminders = { emailReminders:true, leadMin:0 };
  me = null; selId = null; oldPosts = { ig:[], tt:[] };
  rememberUser(null); setSync('idle'); renderAccount();
  if(inPlanner() || inInspo()) switchTab('studio');
  updateDueBadge();
}

async function logOut(){
  const wipe = $('#plLogoutWipe').checked;
  const btn = $('#plLogoutGo'); btn.disabled = true; btn.textContent = 'Syncing…';
  // make sure nothing unsent is lost
  if(sb && navigator.onLine){ clearTimeout(pushTimer); await pushAll(); }
  const unsent = store.filter(p => me && p.owner===me.id && p.dirty).length;
  if(unsent && wipe && !(await askConfirm(`${unsent} change${unsent>1?'s':''} couldn’t be synced yet (offline?). Removing this computer’s copy would lose ${unsent>1?'them':'it'}. Remove anyway?`, 'Remove anyway', true))){ btn.disabled=false; btn.textContent='Log out'; return; }
  if(wipe && me){
    const gone = store.filter(p => p.owner===me.id);
    for(const p of gone){ p.slides.forEach(forgetURLs); forgetURLs(p.thumb); await delLocal(p.id); }
    store = store.filter(p => p.owner!==me.id);
    await kvSet('oldPosts:'+me.id, undefined);
  }
  try{ if(sb) await sb.auth.signOut(); }catch(e){ console.warn(e); }
  btn.disabled = false; btn.textContent = 'Log out';
  closeModals(); onSignedOut();
  toast(wipe ? 'Logged out and removed from this computer' : 'Logged out');
}

// ----- delete account -----
// 1) delete the preview images (Storage API), 2) call the delete_my_account()
// database function (supabase-delete-account.sql), which removes the posts,
// settings and the login, 3) remove everything from this computer, 4) sign out.
function openDeleteAccount(){
  $('#plDelEmail').textContent = me.email;
  $('#plDelConfirm').value = ''; $('#plDelGo').disabled = true;
  $('#plDelErr').textContent = ''; $('#plDelGo').textContent = 'Delete my account';
  $('#plDeleteScrim').classList.add('open');
  setTimeout(()=>$('#plDelConfirm').focus(), 50);
}
async function deleteAccount(){
  if(!me || !sb) return;
  const btn = $('#plDelGo'), err = $('#plDelErr');
  err.textContent = ''; btn.disabled = true;
  const step = t => { btn.textContent = t; };
  const uid = me.id;
  clearTimeout(pushTimer);
  try{
    // 1) preview images: everything in this person's folder (paged, 100 at a time)
    step('Deleting images…');
    for(;;){
      const { data:files, error } = await sb.storage.from(PREVIEW_BUCKET).list(uid, { limit:100 });
      if(error) throw error;
      if(!files || !files.length) break;
      const { error:rmErr } = await sb.storage.from(PREVIEW_BUCKET).remove(files.map(f => `${uid}/${f.name}`));
      if(rmErr) throw rmErr;
      if(files.length < 100) break;
    }
    // 2) posts, settings and the login itself
    step('Deleting account…');
    const { error } = await sb.rpc('delete_my_account');
    if(error) throw error;
  } catch(ex){
    console.error('delete account', ex);
    const m = (ex && ex.message) || String(ex);
    err.textContent = /delete_my_account|Could not find the function|PGRST202/i.test(m)
      ? 'Account deletion isn’t switched on yet (the site owner needs to run supabase-delete-account.sql). Nothing was deleted from your planner.'
      : /Failed to fetch|network/i.test(m) ? 'Can’t reach the server. Check your internet connection and try again.'
      : 'Something went wrong: ' + m;
    btn.textContent = 'Delete my account'; btn.disabled = $('#plDelConfirm').value.trim().toUpperCase() !== 'DELETE';
    return;
  }
  // 3) this computer's copy
  step('Cleaning up…');
  for(const p of store.filter(p => p.owner===uid)){ p.slides.forEach(forgetURLs); forgetURLs(p.thumb); await delLocal(p.id); }
  store = store.filter(p => p.owner!==uid);
  await kvSet('oldPosts:'+uid, undefined); await kvSet('lastBackup:'+uid, undefined);
  // 4) sign out locally (the login no longer exists on the server)
  try{ await sb.auth.signOut({ scope:'local' }); }catch(e){}
  closeModals(); onSignedOut();
  toast('Your account and planner have been deleted.');
}

let afterLogin = null;   // what to do once the user logs in (open planner / add to planner)
function requireLogin(then){
  if(me){ then(); return; }
  afterLogin = then;
  openLogin('login');
}
function openLogin(mode){
  setLoginMode(mode);
  $('#plLoginErr').textContent = ''; $('#plLoginMsg').textContent = '';
  if(!sb){ $('#plLoginErr').textContent = 'Can’t reach the login service right now. Check your internet connection and reload the page.'; }
  $('#plLoginScrim').classList.add('open');
  setTimeout(()=>$('#plEmail').focus(), 50);
}
let loginMode = 'login';
function setLoginMode(m){   // 'login' | 'signup' | 'reset'
  loginMode = m;
  $$('#plLoginTabs button').forEach(b => b.classList.toggle('on', b.dataset.lm===m));
  $('#plLoginTabs').hidden = m==='reset';
  $('#plPwLabel').hidden = m==='reset';
  $('#plForgot').hidden = m==='signup';
  $('#plForgot').textContent = m==='reset' ? '\u2190 Back to log in' : 'Forgot password?';
  $('#plLoginGo').textContent = { login:'Log in', signup:'Create account', reset:'Email me a reset link' }[m];
  $('#plPassword').autocomplete = m==='login' ? 'current-password' : 'new-password';
  $('#plLoginHint').textContent = m==='signup' ? 'At least 8 characters.' : m==='reset' ? 'Enter the email you signed up with and we\u2019ll send you a link to choose a new password.' : '';
  $('#plLoginErr').textContent = '';
}
async function submitLogin(e){
  e.preventDefault();
  if(!sb) return;
  const email = $('#plEmail').value.trim(), password = $('#plPassword').value;
  const err = $('#plLoginErr'), msg = $('#plLoginMsg'), btn = $('#plLoginGo');
  err.textContent = ''; msg.textContent = '';
  if(loginMode==='reset'){ await sendResetLink(email); return; }
  if(!email || !password){ err.textContent = 'Enter your email and a password.'; return; }
  if(loginMode==='signup' && password.length < 8){ err.textContent = 'Use at least 8 characters for your password.'; return; }
  btn.disabled = true; const label = btn.textContent; btn.textContent = loginMode==='login' ? 'Logging in…' : 'Creating account…';
  try{
    if(loginMode==='login'){
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if(error) throw error;
    } else {
      const { data, error } = await sb.auth.signUp({ email, password });
      if(error) throw error;
      if(!data.session){ msg.textContent = 'Account created. Check your email to confirm it, then log in here.'; setLoginMode('login'); btn.disabled=false; btn.textContent='Log in'; return; }
    }
    $('#plPassword').value = '';
    closeModals();
    toast(loginMode==='login' ? 'Welcome back ✓' : 'Account created ✓ Your planner now syncs to it');
    const next = afterLogin; afterLogin = null; if(next) setTimeout(next, 50);
  } catch(ex){
    const m = (ex && ex.message) || 'Something went wrong';
    err.textContent = /Invalid login credentials/i.test(m) ? 'Wrong email or password.'
      : /already registered|already exists/i.test(m) ? 'There’s already an account with this email. Log in instead.'
      : /Email not confirmed/i.test(m) ? 'Please confirm your email first (check your inbox).'
      : /Failed to fetch|network/i.test(m) ? 'Can’t reach the server. Check your internet connection.'
      : m;
  }
  btn.disabled = false; btn.textContent = label;
}

// ----- forgot password -----
// 1) email a reset link (Supabase sends it through the SMTP sender set up in the dashboard),
// 2) the link opens the studio already logged in with a PASSWORD_RECOVERY event,
// 3) we ask for a new password and save it.
async function sendResetLink(email){
  const err = $('#plLoginErr'), msg = $('#plLoginMsg'), btn = $('#plLoginGo');
  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent = 'Enter the email address you signed up with.'; return; }
  btn.disabled = true; btn.textContent = 'Sending\u2026';
  try{
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if(error) throw error;
    // same message whether or not the account exists, so emails can't be checked for accounts
    msg.textContent = 'If there\u2019s an account for this email, a reset link is on its way. Check your inbox (and spam folder); the link works for one hour.';
  } catch(ex){
    const m = (ex && ex.message) || '';
    err.textContent = /rate limit|too many|seconds/i.test(m) ? 'Please wait a minute before asking for another link.'
      : /Failed to fetch|network/i.test(m) ? 'Can\u2019t reach the server. Check your internet connection.'
      : 'We couldn\u2019t send the email right now. Please try again later, or contact shopinspocult@gmail.com.';
    console.warn('reset email', ex);
  }
  btn.disabled = false; btn.textContent = 'Email me a reset link';
}
function openNewPassword(){
  closeModals();
  $('#plNewPw').value = ''; $('#plNewPwErr').textContent = '';
  $('#plNewPwScrim').classList.add('open');
  setTimeout(()=>$('#plNewPw').focus(), 50);
}
async function saveNewPassword(e){
  e.preventDefault();
  const pw = $('#plNewPw').value, err = $('#plNewPwErr'), btn = $('#plNewPwGo');
  err.textContent = '';
  if(pw.length < 8){ err.textContent = 'Use at least 8 characters.'; return; }
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  try{
    const { error } = await sb.auth.updateUser({ password: pw });
    if(error) throw error;
    $('#plNewPw').value = '';
    $('#plNewPwScrim').classList.remove('open');
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);
    toast('Password changed ✓ You\u2019re logged in');
  } catch(ex){
    const m = (ex && ex.message) || 'Something went wrong';
    err.textContent = /different from the old/i.test(m) ? 'Choose a password that\u2019s different from your old one.'
      : /session|expired|invalid/i.test(m) ? 'This reset link has expired. Ask for a new one from the login window.'
      : m;
  }
  btn.disabled = false; btn.textContent = 'Save new password';
}

function renderAccount(){
  const box = $('#plAccount');
  if(!me){
    box.innerHTML = `<button class="btn small" id="plLoginBtn">Log in</button>`;
    $('#plLoginBtn').onclick = () => openLogin('login');
    return;
  }
  box.innerHTML = `<button class="acct-chip" id="plAcctBtn" title="${esc(me.email)}"><span class="acct-av">${esc((me.email||'?')[0].toUpperCase())}</span><span class="acct-dot ${syncState}" id="plAcctDot"></span></button>
    <div class="acct-menu" id="plAcctMenu" hidden>
      <div class="acct-email">${esc(me.email)}</div>
      <div class="acct-sync" id="plAcctSync"></div>
      <div class="acct-rem">
        <label class="acct-rem-lbl" for="plRemLead">✉ Email reminder</label>
        <select id="plRemLead">
          <option value="0" ${reminders.leadMin==0?'selected':''}>at the posting time</option>
          <option value="15" ${reminders.leadMin==15?'selected':''}>15 minutes before</option>
          <option value="60" ${reminders.leadMin==60?'selected':''}>1 hour before</option>
        </select>
      </div>
      <button class="btn small" id="plSyncNow">⟳ Sync now</button>
      <button class="btn small" id="plLogoutBtn">Log out</button>
      <button class="acct-delete" id="plDeleteAcctBtn">Delete account…</button>
    </div>`;
  setSync(syncState, syncMsg);
  $('#plDeleteAcctBtn').onclick = () => { $('#plAcctMenu').hidden = true; openDeleteAccount(); };
  $('#plAcctBtn').onclick = e => { e.stopPropagation(); $('#plAcctMenu').hidden = !$('#plAcctMenu').hidden; };
  $('#plSyncNow').onclick = async () => { $('#plAcctMenu').hidden = true; await pushAll(); await pullAll(true); };
  $('#plRemLead').onchange = e => saveReminders({ leadMin: +e.target.value });
  $('#plLogoutBtn').onclick = () => { $('#plAcctMenu').hidden = true; $('#plLogoutWipe').checked = false; $('#plLogoutEmail').textContent = me.email; $('#plLogoutScrim').classList.add('open'); };
}

// =========================================================================
//  UI
// =========================================================================
function injectUI(){
  // Studio | Planner switch + account in the top bar
  $('#brand').insertAdjacentHTML('afterend', `<div class="pl-switch" id="plSwitch">
    <button data-tab="studio" class="on">Studio</button>
    <button data-tab="planner">Planner<span class="due" id="plDue" hidden></span></button>
    <button data-tab="inspo">Inspo</button></div>`);
  $('#topbar').insertAdjacentHTML('beforeend', `<div class="pl acct" id="plAccount"></div>`);
  const aspectGroup = $('#aspect') && $('#aspect').closest('.top-group'); if(aspectGroup) aspectGroup.classList.add('studio-only');

  $('#main').insertAdjacentHTML('afterend', `<div id="inspo" class="pl">
    <div class="p-head">
      <div class="p-title">Inspo board<small>inspo it · save it · recreate it</small></div>
      <div class="stats" id="insStats"></div>
      <span class="sync-pill" id="insSync"></span>
      <div class="spacer"></div>
      <div class="seg" id="insFilter"><button data-f="all" class="on">All</button><button data-f="todo">To recreate</button><button data-f="done">Recreated</button></div>
      <button class="btn primary" id="insAddBtn">+ Save an idea</button>
    </div>
    <div class="ins-body">
      <div class="view" id="insView"></div>
      <aside class="ins-side">
        <div class="sticky">
          <span class="sticky-tape"></span>
          <div class="sticky-head">remember ✎</div>
          <textarea id="insMemo" spellcheck="true" placeholder="things to remember for later…&#10;&#10;– props to buy&#10;– golden hour is at 17:40&#10;– ask Ana to take the photo"></textarea>
          <div class="sticky-foot" id="insMemoState">saved to your account</div>
        </div>
      </aside>
    </div>
  </div>`);
  $('#main').insertAdjacentHTML('afterend', `<div id="planner" class="pl">
    <div class="p-head">
      <div class="p-title" id="plTitle"></div>
      <div class="stats" id="plStats"></div>
      <span class="sync-pill" id="plSync"></span>
      <div class="spacer"></div>
      <div class="seg" id="plViewSwitch">
        <button data-view="week" class="on">Week</button><button data-view="month">Month</button><button data-view="feed">Feed preview</button>
      </div>
      <span class="nav-btns" id="plNav">
        <button class="btn icon" id="plPrev" title="Previous">‹</button>
        <button class="btn" id="plToday">Today</button>
        <button class="btn icon" id="plNext" title="Next">›</button>
      </span>
      <button class="btn" id="plBackupBtn" title="Download or restore a backup file">⛁ Backup</button>
      <button class="btn primary" id="plNewBtn">+ New post</button>
    </div>
    <div class="p-body" id="plBody">
      <div class="view" id="plView"></div>
      <aside class="drawer" id="plDrawer">
        <div id="plDrawerIn"></div>
      </aside>
    </div>
  </div>`);

  $('#expMp4').closest('.exportgrid').insertAdjacentHTML('afterend', `<button class="btn primary" id="addToPlannerBtn">📅 Add to planner</button>`);

  document.body.insertAdjacentHTML('beforeend', `
  <div class="pl-scrim pl" id="plLoginScrim"><div class="modal login-modal">
    <h3>Your content planner</h3>
    <p>Log in to plan your posts. Everything syncs to your account, so you can pick up where you left off on any computer.</p>
    <div class="seg" id="plLoginTabs" style="width:100%"><button data-lm="login" class="on" style="flex:1">Log in</button><button data-lm="signup" style="flex:1">Create account</button></div>
    <form id="plLoginForm" class="login-form" novalidate>
      <label>Email<input type="email" id="plEmail" autocomplete="email" required></label>
      <label id="plPwLabel">Password<input type="password" id="plPassword" autocomplete="current-password" required></label>
      <button type="button" class="link-btn" id="plForgot">Forgot password?</button>
      <div class="hint" id="plLoginHint"></div>
      <div class="hint warn" id="plLoginErr" role="alert"></div>
      <div class="hint ok" id="plLoginMsg"></div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Not now</button><button type="submit" class="btn primary" id="plLoginGo">Log in</button></div>
    </form>
    <p class="fine">The studio stays free to use without an account. Your account only stores your planner: post details and small preview images.</p>
  </div></div>

  <div class="pl-scrim pl" id="plNewPwScrim"><div class="modal login-modal">
    <h3>Choose a new password</h3>
    <p>You opened a password reset link. Pick a new password for your account.</p>
    <form id="plNewPwForm" class="login-form" novalidate>
      <label>New password<input type="password" id="plNewPw" autocomplete="new-password" required></label>
      <div class="hint">At least 8 characters.</div>
      <div class="hint warn" id="plNewPwErr" role="alert"></div>
      <div class="modal-foot"><button type="submit" class="btn primary" id="plNewPwGo">Save new password</button></div>
    </form>
  </div></div>

  <div class="pl-scrim pl" id="plDeleteScrim"><div class="modal">
    <h3>Delete your account?</h3>
    <p>This permanently deletes the account <b id="plDelEmail"></b>, every post in your planner, and all its preview images, on every device. <b style="color:var(--paper)">It can’t be undone.</b></p>
    <p>Want to keep a copy of your plans first? <button class="btn tiny" id="plDelBackup">⬇ Download a backup</button></p>
    <label class="del-confirm"><span>Type <b>DELETE</b> to confirm</span><input type="text" id="plDelConfirm" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
    <div class="hint warn" id="plDelErr" role="alert"></div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary danger-solid" id="plDelGo" disabled>Delete my account</button></div>
  </div></div>

  <div class="pl-scrim pl" id="plLogoutScrim"><div class="modal">
    <h3>Log out?</h3>
    <p>You’re logged in as <b id="plLogoutEmail"></b>. Your planner is saved in your account; log back in any time to see it.</p>
    <label class="check"><input type="checkbox" id="plLogoutWipe"> Also remove my planner and full-size files from this computer <span>(use this on a shared or public computer)</span></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="plLogoutGo">Log out</button></div>
  </div></div>

  <div class="pl-scrim pl" id="plNewScrim"><div class="modal">
    <h3>New post</h3><p id="plNewFor"></p>
    <div class="pick">
      <button id="plPickUpload"><b>⬆ Upload</b><span>Photos or videos you already have. Pick several at once to make a carousel. The format is guessed from the file’s shape.</span></button>
      <button id="plPickStudio"><b>✦ Design it</b><span>Open the studio, then press “Add to planner” under the export buttons</span></button>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button></div>
  </div></div>

  <div class="pl-scrim pl" id="plAtpScrim"><div class="modal">
    <h3>Add to planner</h3>
    <div class="seg" id="plAtpMode" style="width:100%">
      <button data-mode="new" class="on" style="flex:1">New post</button>
      <button data-mode="slide" style="flex:1">Add as next slide</button>
      <button data-mode="thumb" style="flex:1">YouTube thumbnail</button>
    </div>
    <div id="plAtpNew">
      <div class="lbl">Day</div><div class="qdays" id="plQdays"></div>
      <div style="margin-top:14px"><div class="lbl">Post as <span id="plFrameNote"></span></div><div id="plAtpFormats"></div></div>
      <div style="margin-top:12px"><div class="lbl">Time</div><input type="time" id="plAtpTime" value="18:00" style="max-width:160px"></div>
      <div style="margin-top:12px"><div class="lbl">Caption <span>optional</span></div>
        <textarea id="plAtpCap" rows="2" placeholder="Write it now, or leave it for your caption pass later…"></textarea></div>
    </div>
    <div id="plAtpSlide" hidden>
      <p style="margin-bottom:12px">Adds this design to the end of an existing post, turning it into a carousel (or growing one).</p>
      <div class="lbl">Which post?</div><select id="plAtpTarget"></select>
    </div>
    <div id="plAtpThumb" hidden>
      <p style="margin-bottom:12px">Uses this design as the thumbnail of a planned YouTube video. Set the studio frame to 16:9 first.</p>
      <div class="lbl">Which video?</div><select id="plAtpThumbTarget"></select>
    </div>
    <div>
      <div class="lbl">Save as</div>
      <div class="seg" id="plAtpFile" style="width:100%">
        <button data-ft="png" class="on" style="flex:1">PNG</button><button data-ft="jpeg" style="flex:1">JPEG</button><button data-ft="mp4" style="flex:1">Video</button>
      </div>
      <div class="hint" id="plAtpFileHint"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="plAtpSave">Add to planner</button></div>
  </div></div>

  <div class="pl-scrim pl" id="plBackupScrim"><div class="modal">
    <h3>Backup file</h3>
    <p>Your planner is saved in your account. A backup file is an extra copy you keep yourself, and the only way to keep the <b>full-size</b> files together with your plans (the account stores small previews).</p>
    <div class="backup-row"><button class="btn primary" id="plDoBackup" style="flex:1">⬇ Download backup</button><button class="btn" id="plDoRestore" style="flex:1">⬆ Restore from file</button></div>
    <p id="plBackupInfo" style="font-size:11.5px"></p>
    <div class="modal-foot"><button class="btn" data-close>Close</button></div>
  </div></div>

  <div class="pl-scrim pl" id="plPickScrim"><div class="modal">
    <h3>Add from your planner</h3>
    <p>Click a post to put it in the feed preview.</p>
    <div class="pick-grid" id="plPickGrid"></div>
    <div class="modal-foot"><button class="btn" data-close>Done</button></div>
  </div></div>

  <div class="pl-scrim pl" id="plConfirmScrim"><div class="modal confirm-modal" role="alertdialog" aria-modal="true">
    <p id="plConfirmMsg"></p>
    <div class="modal-foot"><button class="btn" id="plConfirmCancel">Cancel</button><button class="btn primary" id="plConfirmOk">OK</button></div>
  </div></div>

  <div class="pl-toast" id="plToast"></div>
  <input type="file" id="plFileIn" accept="image/*,video/*" multiple hidden>
  <input type="file" id="plRestoreIn" accept="application/json,.json" hidden>`);
}

// ---------- tabs ----------
function switchTab(t){   // 'studio' | 'planner' | 'inspo'
  if((t==='planner' || t==='inspo') && !me){ requireLogin(() => switchTab(t)); return; }
  $$('#plSwitch button').forEach(b => b.classList.toggle('on', b.dataset.tab===t));
  const app = $('#app');
  app.classList.toggle('planner-mode', t!=='studio');   // hides the studio (name kept: the studio's shortcuts check it)
  app.classList.toggle('tab-planner', t==='planner');
  app.classList.toggle('tab-inspo', t==='inspo');
  if(t==='planner'){ render(); pullAll(); }
  else if(t==='inspo'){ renderInspo(); pullAll(); }
  else { requestAnimationFrame(()=>{ try{ fitStage(); draw(); }catch(e){} }); }
}
const inPlanner = () => $('#app').classList.contains('tab-planner');
const inInspo = () => $('#app').classList.contains('tab-inspo');

function updateDueBadge(){
  const k = iso(today()), n = mine().filter(p => p.date===k && p.status!=='posted').length;
  const b = $('#plDue'); b.hidden = !n; b.textContent = n; b.title = `${n} post${n>1?'s':''} to publish today`;
}

// ---------- rendering ----------
function cardHTML(p){
  const s = p.slides[0], k = kindOf(p), f = mainFmt(p);
  const badge = k==='carousel' ? `<span class="kind">▣ ${p.slides.length}</span>` : k==='video' ? `<span class="kind">▶ ${s && s.duration ? fmtDur(s.duration) : 'video'}</span>` : '';
  const hasWarn = warningsFor(p).length > 0;
  const capText = p.title || p.caption;
  return `<div class="card ${isCarousel(p)?'multi':''} ${p.id===selId?'sel':''} ${p.status==='posted'?'posted':''}" draggable="true" data-id="${p.id}">
    <div class="twrap"><div class="thumb" style="aspect-ratio:${f.w}/${f.h}">${badge}${hasWarn?'<span class="warnflag" title="Needs attention">!</span>':''}${thumbHTML(s)}</div></div>
    <div class="meta">
      <div class="pl-row"><span class="time">${esc(p.time)}</span>${fmtsOf(p).map(x=>`<span class="plat ${x.plat}">${x.short}</span>`).join('')}<span class="status ${p.status}">${p.status}</span></div>
      <div class="cap ${capText?'':'empty'}">${capText?esc(capText):(captionLimit(p)?'no caption yet':'story · no caption')}</div>
    </div></div>`;
}

function render(){
  updateDueBadge();
  if(!inPlanner() || !me) return;
  let from, to;
  if(view==='week'){
    from = startOfWeek(cursor); to = addDays(from,6);
    const sameM = from.getMonth()===to.getMonth();
    $('#plTitle').innerHTML = `${from.getDate()}${sameM?'':' '+MN[from.getMonth()].slice(0,3)} – ${to.getDate()} ${MN[to.getMonth()].slice(0,3)} ${to.getFullYear()}<small>week · drag cards to move them</small>`;
  } else if(view==='month'){
    from = new Date(cursor.getFullYear(), cursor.getMonth(), 1); to = new Date(cursor.getFullYear(), cursor.getMonth()+1, 0);
    $('#plTitle').innerHTML = `${MN[from.getMonth()]} ${from.getFullYear()}<small>month · click a day to open its week</small>`;
  } else {
    from = today(); to = new Date(2999,0,1);
    $('#plTitle').innerHTML = `Feed preview<small>your profile once everything is posted</small>`;
  }
  $('#plNav').style.visibility = view==='feed' ? 'hidden' : 'visible';
  const inRange = mine().filter(p=>{ const d=fromIso(p.date); return d>=from && d<=to; });
  const c = s => inRange.filter(p=>p.status===s).length;
  $('#plStats').innerHTML = `<span class="stat"><b>${inRange.length}</b> planned</span><span class="stat"><b>${c('draft')}</b> drafts</span><span class="stat"><b>${c('ready')}</b> ready</span><span class="stat"><b>${c('posted')}</b> posted</span>`;
  renderView(); renderDrawer();
}
function renderView(){
  if(!inPlanner() || !me) return;
  const v = $('#plView'), st = v.scrollTop;
  if(view==='week') renderWeek(startOfWeek(cursor));
  else if(view==='month') renderMonth(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  else renderFeed();
  v.scrollTop = st;
}
const emptyBanner = () => mine().length ? '' : `<div class="empty-banner">📅 <div><b>Your planner is empty.</b> Design something in the <b>Studio</b> and press <b>Add to planner</b> under the export buttons, or use <b>+ New post</b> to upload photos and videos you already have.</div></div>`;

function renderWeek(from){
  const T = today();
  let html = emptyBanner() + '<div class="week">';
  for(let i=0;i<7;i++){
    const d = addDays(from,i), k = iso(d), isToday = +d===+T;
    html += `<div class="day ${isToday?'today':''} ${d<T?'past':''}" data-date="${k}">
      <div class="day-h"><span class="dn">${DN[i]}</span><span class="dd">${d.getDate()}</span>${isToday?'<span class="tbadge">today</span>':''}</div>
      <div class="day-posts">${postsOn(k).map(cardHTML).join('')}</div>
      <button class="add-slot" data-add="${k}">+ add post</button></div>`;
  }
  $('#plView').innerHTML = html + '</div>';
}
function renderMonth(first){
  const T = today(), start = startOfWeek(first), last = new Date(first.getFullYear(), first.getMonth()+1, 0);
  const cells = Math.ceil(((first.getDay()+6)%7 + last.getDate())/7)*7;
  let html = emptyBanner() + '<div class="month">' + DN.map(d=>`<div class="mh">${d}</div>`).join('');
  for(let i=0;i<cells;i++){
    const d = addDays(start,i), k = iso(d), list = postsOn(k);
    const out = d.getMonth()!==first.getMonth(), gap = !out && d>=T && !list.length;
    html += `<div class="mcell ${out?'out':''} ${+d===+T?'today':''}" data-date="${k}">
      <div class="n">${d.getDate()}${list.length?`<span>${list.length} post${list.length>1?'s':''}</span>`:''}</div>
      <div class="mthumbs">${list.map(p=>{ const f = mainFmt(p); return `<div class="mthumb ${isCarousel(p)?'multi':''}" draggable="true" data-id="${p.id}" style="width:${Math.round(38*f.w/f.h)}px;--dot:${STATUS_DOT[p.status]}" title="${esc(p.time)} · ${fmtsOf(p).map(x=>x.short).join(' + ')} · ${p.status}">${thumbHTML(p.slides[0])}</div>`; }).join('')}</div>
      ${gap?'<div class="gap">nothing planned</div>':''}</div>`;
  }
  $('#plView').innerHTML = html + '</div>';
}

// The grid mixes two sources: posts from the planner and photos added straight to the
// preview. Their order is free (drag to move) and kept in oldPosts.layout[plat].
function feedLayout(plat){
  oldPosts.layout = oldPosts.layout || {};
  const L = oldPosts.layout[plat] = oldPosts.layout[plat] || {};
  L.order = L.order || []; L.hidden = L.hidden || []; L.extra = L.extra || [];
  return L;
}
function feedItems(plat){
  const L = feedLayout(plat);
  const planner = mine().filter(p => !L.hidden.includes(p.id) && (p.formats.some(k => GRID_FMTS[plat].includes(k)) || L.extra.includes(p.id)))
                        .sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));   // newest = top-left
  const byKey = new Map([...planner.map(p => ['p:'+p.id, { key:'p:'+p.id, kind:'plan', p }]),
                         ...oldPosts[plat].map(o => ['a:'+o.id, { key:'a:'+o.id, kind:'added', o }])]);
  const placed = L.order.filter(k => byKey.has(k));
  const newPlan = planner.map(p => 'p:'+p.id).filter(k => !placed.includes(k));      // new planner posts go on top
  const newAdded = oldPosts[plat].map(o => 'a:'+o.id).filter(k => !placed.includes(k));   // new photos go at the end
  L.order = [...newPlan, ...placed, ...newAdded];
  return L.order.map(k => byKey.get(k));
}
function renderFeed(){
  const ig = feedPlat==='ig';
  const items = feedItems(feedPlat);
  const tile = it => {
    if(it.kind==='added') return `<div class="tile added" draggable="true" data-key="${it.key}" title="Added photo · drag to move">
      ${thumbHTML(it.o)}<span class="src">added</span><button class="rm" data-rmkey="${it.key}" title="Remove from the preview">×</button></div>`;
    const p = it.p, s = p.slides[0], planned = p.status!=='posted';
    const icon = isCarousel(p) ? '▣' : (s && s.type==='video' && ig) ? '▶' : '';
    return `<div class="tile from-plan ${p.id===selId?'sel':''}" draggable="true" data-key="${it.key}" data-id="${p.id}" title="From planner · ${dayLabel(p.date)} · ${esc(p.time)} · ${p.status}">
      ${thumbHTML(s)}${icon?`<span class="ic">${icon}</span>`:''}<span class="src">planner</span>${planned?`<span class="when">${dayLabel(p.date)}</span>`:''}
      <button class="rm" data-rmkey="${it.key}" title="Hide from the preview (the post stays in your planner)">×</button></div>`;
  };
  const fill = items.length < 9 ? Array.from({length:9-items.length}, () => '<div class="tile old empty"></div>').join('') : '';
  $('#plView').innerHTML = `<div class="feed-wrap">
    <div class="feed-side">
      <div class="seg" style="width:100%">
        <button data-fp="ig" class="${ig?'on':''}" style="flex:1">Instagram</button><button data-fp="tt" class="${ig?'':'on'}" style="flex:1">TikTok</button>
      </div>
      <h4>${ig?'Instagram':'TikTok'} profile grid</h4>
      <p>${ig
        ? 'Posts and reels in the order they’ll go out, newest top-left. Stories don’t appear on the grid. The profile grid crops everything to 3:4, so keep key text away from the top and bottom edges.'
        : 'Videos and photo carousels, newest top-left. TikTok shows a 3:4 cover of each video, so make sure the middle of your first frame reads well.'}</p>
      <div class="legend">
        <span><i class="lg-plan"></i>From planner (date shown)</span>
        <span><i class="lg-added"></i>Added photos</span>
      </div>
      <p><b style="color:var(--paper)">Drag any tile to move it.</b> Swapping two planner posts swaps their posting days too, so the calendar stays in sync. × removes a tile from the preview only.</p>
      <div class="feed-btns">
        <button class="btn" id="plAddOld">＋ Add photos</button>
        <button class="btn" id="plFromPlan">📅 From planner</button>
      </div>
      <p style="font-size:11px">Add photos of your current ${ig?'posts':'videos'} or ideas to see how they sit together. Planner posts for ${ig?'Instagram':'TikTok'} show up here automatically; use <b>From planner</b> to bring back others.</p>
    </div>
    <div class="phone">
      <div class="ph-top">your profile</div>
      <div class="ph-prof"><div class="ph-av"></div>
        <div class="ph-stats"><div><b>${items.length}</b>${ig?'posts':'videos'}</div><div><b>—</b>followers</div><div><b>—</b>following</div></div></div>
      <div class="ph-tabs">${ig?'<div class="on">▦ Posts</div><div>▶ Reels</div><div>☺ Tagged</div>':'<div class="on">▦ Videos</div><div>♡ Liked</div>'}</div>
      <div class="grid">${items.map(tile).join('')}${fill}</div>
    </div>
  </div>`;
  $$('[data-fp]').forEach(b => b.onclick = () => { feedPlat = b.dataset.fp; renderFeed(); });
  $('#plAddOld').onclick = () => { uploadMode='old'; $('#plFileIn').click(); };
  $('#plFromPlan').onclick = openFromPlanner;
  $$('[data-rmkey]').forEach(b => b.onclick = e => { e.stopPropagation(); removeFeedTile(b.dataset.rmkey); });
}
async function saveFeed(){ if(me) await saveOldPosts(); }
async function removeFeedTile(key){
  const L = feedLayout(feedPlat), id = key.slice(2);
  if(key.startsWith('a:')){
    if(!(await askConfirm('Remove this photo from the feed preview?', 'Remove'))) return;
    oldPosts[feedPlat] = oldPosts[feedPlat].filter(o => o.id !== id);
  } else {
    L.hidden.push(id); L.extra = L.extra.filter(x => x !== id);
    toast('Hidden from the preview. It’s still in your planner; use From planner to bring it back.');
  }
  L.order = L.order.filter(k => k !== key);
  await saveFeed(); renderFeed();
}
function moveFeedTile(fromKey, toKey){
  const L = feedLayout(feedPlat), o = L.order, i = o.indexOf(fromKey), j = o.indexOf(toKey);
  if(i < 0 || j < 0 || i === j) return;
  [o[i], o[j]] = [o[j], o[i]];
  if(fromKey.startsWith('p:') && toKey.startsWith('p:')){   // two planner posts: swap their posting slots too
    const a = mine().find(x => 'p:'+x.id === fromKey), b = mine().find(x => 'p:'+x.id === toKey);
    if(a && b){ [a.date,b.date] = [b.date,a.date]; [a.time,b.time] = [b.time,a.time]; touch(a); touch(b); toast(`Swapped: now ${dayLabel(a.date)} ↔ ${dayLabel(b.date)}`); }
  }
  saveFeed(); render();
}
function openFromPlanner(){
  const inGrid = new Set(feedItems(feedPlat).filter(x => x.kind==='plan').map(x => x.p.id));
  const rest = mine().filter(p => !inGrid.has(p.id) && p.slides.length).sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
  $('#plPickGrid').innerHTML = rest.length
    ? rest.map(p => `<button class="pick" data-pick="${p.id}" title="${dayLabel(p.date)} · ${esc(p.time)}">${thumbHTML(p.slides[0])}<span>${dayLabel(p.date)}</span></button>`).join('')
    : '<p>All your planner posts are already in the grid.</p>';
  $$('[data-pick]').forEach(b => b.onclick = async () => {
    const L = feedLayout(feedPlat), id = b.dataset.pick;
    L.hidden = L.hidden.filter(x => x !== id); if(!L.extra.includes(id)) L.extra.push(id);
    b.remove(); await saveFeed(); renderFeed();
    if(!$('#plPickGrid [data-pick]')) $('#plPickGrid').innerHTML = '<p>All your planner posts are already in the grid.</p>';
  });
  $('#plPickScrim').classList.add('open');
}

// ---------- editor drawer ----------
function renderDrawer(){
  const p = selected();
  $('#plBody').classList.toggle('drawer-open', !!p);
  if(!p){ $('#plDrawerIn').innerHTML=''; return; }
  slideIdx = Math.max(0, Math.min(slideIdx, p.slides.length-1));
  const s = p.slides[slideIdx], multi = isCarousel(p), n = p.slides.length, f = mainFmt(p), fs = fmtsOf(p);
  const capLim = captionLimit(p), hasYt = fs.some(x=>x.plat==='yt'), hasThumb = fs.some(x=>x.thumb);
  const warns = warningsFor(p);
  const uniqueSizes = [...new Map(fs.map(x=>[`${x.w}x${x.h}`, x])).values()];
  const showStrip = multi || fs.some(x=>x.carousel);
  const fullHere = p.slides.length && p.slides.every(x=>x.blob);
  const names = [...p.slides, hasThumb ? p.thumb : null].filter(x=>x && x.name).map(x=>x.name);

  $('#plDrawerIn').innerHTML = `<div class="drawer-in">
    <div class="d-head"><h3>${dayLabel(p.date)} · ${esc(p.time)}</h3><button class="btn icon" id="plCloseD" title="Close (Esc)">✕</button></div>

    <div>
      <div class="lbl">Where & format</div>
      ${Object.keys(PLATFORMS).map(pl => `<div class="fmt-group"><span class="pn">${PLATFORMS[pl]}</span><div class="fmt-opts">
        ${Object.entries(FORMATS).filter(([,x])=>x.plat===pl).map(([k,x])=>`<button class="pf ${pl} ${p.formats.includes(k)?'on':''}" data-fmt="${k}" title="${x.w} × ${x.h} · ${ratioTxt(x)}">${ratioIcon(x)}${x.name}</button>`).join('')}
      </div></div>`).join('')}
      <div class="sizes">${uniqueSizes.map(x=>`<div>${fs.filter(y=>y.w===x.w&&y.h===x.h).map(y=>y.short).join(' + ')}<span>${x.w} × ${x.h} px · ${ratioTxt(x)}</span></div>`).join('')}
        ${hasThumb?`<div>YT Thumbnail<span>${YT_THUMB.w} × ${YT_THUMB.h} px · 16:9</span></div>`:''}</div>
    </div>

    <div>
      <div class="lbl">${multi?`Carousel · ${n} slides`:(s && s.type==='video'?`Video${s.duration?' · '+fmtDur(s.duration):''}`:'Image')}${multi?`<span>${slideIdx+1} / ${n}</span>`:''}</div>
      <div class="viewer">
        <div class="d-media" style="aspect-ratio:${f.w}/${f.h};${f.w>f.h?'width:100%':'height:250px'}">${viewerHTML(s)}<span class="sz">${f.w} × ${f.h}</span></div>
        ${multi?`<button class="nav prev" id="plPrevS" title="Previous slide">‹</button><button class="nav next" id="plNextS" title="Next slide">›</button>`:''}
      </div>
      ${multi?`<div class="dots">${p.slides.map((_,i)=>`<i class="${i===slideIdx?'on':''}"></i>`).join('')}</div>`:''}
      ${showStrip ? `
      <div class="lbl" style="margin-top:14px">${multi?'Slide order':'Make it a carousel'}<span>${multi?'drag to reorder':''}</span></div>
      <div class="strip" id="plStrip">
        ${p.slides.map((x,i)=>`<div class="slide ${i===slideIdx?'on':''}" draggable="true" data-i="${i}" title="Slide ${i+1}">${thumbHTML(x)}<span class="no">${i+1}</span>${multi?`<button class="x" data-rm="${i}" title="Remove slide">×</button>`:''}</div>`).join('')}
        <button class="slide add" id="plAddSlide" title="Add slides">+</button>
      </div>` : ''}
      ${warns.map(w=>`<div class="hint warn">⚠ ${esc(w.msg)}${w.split?' <button class="btn tiny" id="plSplit">Split into one post per size</button>':''}</div>`).join('')}
      <div class="d-media-actions">
        <button class="btn small" id="plReplace">⬆ Replace ${multi?'this slide':'media'}</button>
        <button class="btn small" id="plUseStudio" title="Replace with whatever is on the studio canvas right now">✦ Use current studio design</button>
      </div>
    </div>

    ${hasThumb?`<div>
      <div class="lbl">YouTube thumbnail</div>
      <div class="thumb-slot">
        <div class="tbox">${p.thumb?thumbHTML(p.thumb):'1280 × 720'}</div>
        <div class="tinfo">${p.thumb?'Thumbnail ready':'No thumbnail yet. Design one in the studio at 16:9, or upload one.'}
          <div style="display:flex;gap:6px"><button class="btn tiny" id="plThumbUp">⬆ Upload</button><button class="btn tiny" id="plThumbStudio">✦ Design</button>${p.thumb?'<button class="btn tiny danger" id="plThumbRm">Remove</button>':''}</div></div>
      </div>
    </div>`:''}

    <div class="two">
      <div><div class="lbl">Day</div><input type="date" id="plFDate" value="${p.date}"></div>
      <div><div class="lbl">Time</div><input type="time" id="plFTime" value="${esc(p.time)}"></div>
    </div>

    ${hasYt?`<div>
      <div class="lbl">YouTube title <span><span id="plTitleCount" class="${p.title.length>100?'warn':''}">${p.title.length} / 100</span> <button class="btn tiny" id="plCopyTitle">⧉ copy</button></span></div>
      <input type="text" id="plFTitle" value="${esc(p.title)}" placeholder="Video title">
    </div>`:''}

    ${capLim ? `
    <div>
      <div class="lbl">${hasYt && fs.every(x=>x.plat==='yt') ? 'Description' : 'Caption'} <span class="${capLen(p)>capLim?'warn':''}" id="plCapCount">${capLen(p)} / ${capLim}</span></div>
      <textarea id="plFCap" rows="6" placeholder="Write your caption…">${esc(p.caption)}</textarea>
    </div>
    <div>
      <div class="lbl">Hashtags <span class="${tagCount(p)>MAX_HASHTAGS?'warn':''}" id="plTagCount">${tagCount(p)} / ${MAX_HASHTAGS}</span></div>
      <textarea id="plFTags" rows="2" placeholder="#aesthetic #moodboard">${esc(p.tags)}</textarea>
      <div class="chips">${Object.keys(HASHTAG_SETS).map(k=>`<button class="chip" data-set="${k}">+ ${k}</button>`).join('')}</div>
    </div>` : `
    <div class="no-cap">📌 Stories don’t have captions or hashtags. Put any text, stickers or links on the design itself.</div>`}

    <div class="post-block">
      <div class="lbl">Posting time</div>
      <p class="quality-note">✦ For the best quality, post the <b>original file</b> from your camera roll or folder. The planner is for organising and reference.</p>
      <p>${!fullHere && n ? `The full-size file${n>1?'s are':' is'} on the computer you made this post on${names.length?`: <b>${names.map(esc).join(', ')}</b>`:''}. Here you have the preview, caption and hashtags.`
          : multi?`Slides download numbered 01–${pad(n)} so they stay in order.`:hasThumb?'Downloads the video and its thumbnail.':'Download, copy, paste into the app, then mark it posted.'}</p>
      <div class="three">
        <button class="btn" id="plDl" ${p.slides.some(x=>x.blob)?'':'disabled title="Full file is on another computer"'}>⬇ ${multi?`Media (${n})`:'Media'}</button>
        <button class="btn primary" id="plCopyCap" ${capLim?'':'disabled'}>⧉ Caption</button>
        <button class="btn primary" id="plCopyTags" ${capLim?'':'disabled'}>⧉ Hashtags</button>
      </div>
    </div>

    <div>
      <div class="lbl">Status</div>
      <div class="seg" style="width:100%">${['draft','ready','posted'].map(st=>`<button data-st="${st}" class="${p.status===st?'on':''}" style="flex:1">${st}</button>`).join('')}</div>
    </div>

    <div class="d-foot">
      <button class="btn" id="plDup">⎘ Duplicate</button>
      <div class="spacer"></div>
      <button class="btn danger" id="plDel">Delete</button>
    </div>
  </div>`;
  bindDrawer(p);
}

async function copyText(txt, what){
  if(!txt.trim()){ toast(`No ${what} yet`); return; }
  try{ await navigator.clipboard.writeText(txt.trim()); toast(`${what[0].toUpperCase()+what.slice(1)} copied ✓`); }
  catch{ toast('Your browser blocked copying. Select the text and copy it manually.', true); }
}

function bindDrawer(p){
  const n = p.slides.length, on = (id, ev, fn) => { const el = $('#'+id); if(el) el[ev] = fn; };
  const changed = () => { touch(p); render(); };
  on('plCloseD','onclick', () => { selId=null; render(); });
  on('plPrevS','onclick', () => { slideIdx = (slideIdx-1+n)%n; renderDrawer(); });
  on('plNextS','onclick', () => { slideIdx = (slideIdx+1)%n; renderDrawer(); });

  $$('[data-fmt]', $('#plDrawer')).forEach(b => b.onclick = () => {
    const k = b.dataset.fmt;
    p.formats = p.formats.includes(k) ? p.formats.filter(x=>x!==k) : [...p.formats, k];
    changed();
  });
  on('plSplit','onclick', () => {
    const groups = {}; p.formats.forEach(k => { const r = ratioTxt(FORMATS[k]); (groups[r] = groups[r] || []).push(k); });
    const [first, ...rest] = Object.values(groups);
    p.formats = first; touch(p);
    rest.forEach(fmts => { const c = clonePost(p, { formats:fmts }); store.push(c); touch(c); });
    render(); toast(`Split into ${rest.length+1} posts, one per size. Swap in a design at the right size for each.`);
  });

  let from = null;
  $$('#plStrip .slide[data-i]').forEach(el => {
    const i = +el.dataset.i;
    el.onclick = e => { if(e.target.dataset.rm!==undefined) return; slideIdx = i; renderDrawer(); };
    el.ondragstart = e => { from = i; e.dataTransfer.effectAllowed='move'; e.stopPropagation(); };
    el.ondragover = e => { if(from===null) return; e.preventDefault(); el.classList.add('over'); };
    el.ondragleave = () => el.classList.remove('over');
    el.ondrop = e => { e.preventDefault(); e.stopPropagation(); if(from===null||from===i) return;
      const [m] = p.slides.splice(from,1); p.slides.splice(i,0,m); slideIdx = i; from=null; changed(); toast(`Moved to slide ${i+1}`); };
  });
  $$('[data-rm]', $('#plDrawer')).forEach(b => b.onclick = e => {
    e.stopPropagation(); const [gone] = p.slides.splice(+b.dataset.rm,1); dropSlide(p, gone);
    slideIdx = Math.max(0, slideIdx-1); changed(); toast(p.slides.length>1?'Slide removed':'Back to a single post');
  });
  on('plAddSlide','onclick', () => { uploadMode='append'; $('#plFileIn').click(); });
  on('plReplace','onclick', () => { uploadMode='replace'; $('#plFileIn').click(); });
  on('plUseStudio','onclick', () => openAtp({ mode:'replace', postId:p.id }));
  on('plThumbUp','onclick', () => { uploadMode='thumb'; $('#plFileIn').click(); });
  on('plThumbStudio','onclick', () => { switchTab('studio'); toast('Set the frame to 16:9, design it, then Add to planner → YouTube thumbnail'); });
  on('plThumbRm','onclick', () => { dropSlide(p, p.thumb); p.thumb = null; changed(); });

  const refresh = () => {
    const lim = captionLimit(p), len = capLen(p);
    const cc = $('#plCapCount'); if(cc){ cc.textContent = `${len} / ${lim}`; cc.className = len>lim?'warn':''; }
    const tc = $('#plTagCount'); if(tc){ tc.textContent = `${tagCount(p)} / ${MAX_HASHTAGS}`; tc.className = tagCount(p)>MAX_HASHTAGS?'warn':''; }
    const ti = $('#plTitleCount'); if(ti){ ti.textContent = `${p.title.length} / 100`; ti.className = p.title.length>100?'warn':''; }
  };
  on('plFCap','oninput', e => { p.caption = e.target.value; refresh(); touchSoon(p); renderView(); });
  on('plFTags','oninput', e => { p.tags = e.target.value; refresh(); touchSoon(p); });
  on('plFTitle','oninput', e => { p.title = e.target.value; refresh(); touchSoon(p); renderView(); });
  on('plFDate','onchange', e => { if(e.target.value){ p.date = e.target.value; cursor = fromIso(p.date); changed(); } });
  on('plFTime','onchange', e => { if(e.target.value){ p.time = e.target.value; changed(); } });
  $$('[data-set]', $('#plDrawer')).forEach(b => b.onclick = () => { p.tags = (p.tags.trim()+' '+HASHTAG_SETS[b.dataset.set]).trim(); changed(); });

  on('plCopyCap','onclick', () => copyText(p.caption, 'caption'));
  on('plCopyTags','onclick', () => copyText(p.tags, 'hashtags'));
  on('plCopyTitle','onclick', () => copyText(p.title, 'title'));
  on('plDl','onclick', () => downloadPost(p));

  $$('[data-st]', $('#plDrawer')).forEach(b => b.onclick = () => { p.status = b.dataset.st; changed(); if(p.status==='posted') toast('Marked as posted ✓'); });
  on('plDup','onclick', () => { const c = clonePost(p); store.push(c); touch(c); selId=c.id; slideIdx=0; render(); toast('Duplicated: switch its format for another platform'); });
  on('plDel','onclick', async () => {
    if(!(await askConfirm('Delete this post from your planner on every device? This can’t be undone.', 'Delete', true))) return;
    p.slides.forEach(forgetURLs); forgetURLs(p.thumb);
    p.deleted = true; selId = null;
    if(p.synced){ touch(p); } else { store = store.filter(x=>x!==p); delLocal(p.id); }
    render();
  });
}

function clonePost(p, extra={}){
  // new ids → previews get re-uploaded for the copy, so deleting one post never breaks the other
  const cs = s => s ? { ...s, id:uid(), previewPath:null } : null;
  return { ...p, id:uid(), status:'draft', created:Date.now(), updatedAt:Date.now(), synced:false, dirty:true, orphans:[],
           slides:p.slides.map(cs), thumb:cs(p.thumb), formats:[...p.formats], ...extra };
}

function downloadPost(p){
  const items = p.slides.map((s,i) => ({ s, name:`inspocult-${p.date}-${p.slides.length>1?pad(i+1):'post'}` }));
  if(p.thumb && fmtsOf(p).some(f=>f.thumb)) items.push({ s:p.thumb, name:`inspocult-${p.date}-thumbnail` });
  const real = items.filter(o => o.s && o.s.blob);
  if(!real.length){ toast('The full-size files are on the computer you made this post on.', true); return; }
  runExportAd(() => {
    real.forEach((o, i) => setTimeout(() => {
      const a = document.createElement('a'); a.href = fullURL(o.s); a.download = o.s.name || `${o.name}.${extFor(o.s.mime)}`;
      document.body.appendChild(a); a.click(); a.remove();
    }, i * 350));
    if(real.length > 1) toast(`Downloading ${real.length} files. If your browser asks, allow multiple downloads.`);
    if(real.length < items.length) toast(`${items.length - real.length} file(s) are only on the computer that made them.`, true);
  });
}

// ---------- calendar interactions ----------
function bindView(){
  const v = $('#plView');
  v.addEventListener('click', e => {
    const add = e.target.closest('[data-add]'); if(add){ openNew(add.dataset.add); return; }
    const card = e.target.closest('.card, .mthumb, .tile[data-id]');
    if(card){ selId = card.dataset.id; slideIdx = 0; if(view==='month'){ const p = selected(); if(p) cursor = fromIso(p.date); } render(); return; }
    const cell = e.target.closest('.mcell'); if(cell){ cursor = fromIso(cell.dataset.date); setView('week'); }
  });
  let dragId = null, dragKey = null;
  v.addEventListener('dragstart', e => {
    const t = e.target.closest('.tile[data-key]');
    if(t){ dragKey = t.dataset.key; dragId = null; t.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', dragKey); return; }
    const c = e.target.closest('[data-id]'); if(c){ dragId = c.dataset.id; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', dragId); }
  });
  v.addEventListener('dragover', e => {
    if(dragKey){ const t = e.target.closest('.tile[data-key]'); if(t){ e.preventDefault(); $$('.tile.over').forEach(x=>x!==t&&x.classList.remove('over')); if(t.dataset.key!==dragKey) t.classList.add('over'); } return; }
    if(!dragId) return;
    const t = e.target.closest('.tile[data-id]');
    if(t){ e.preventDefault(); $$('.tile.over').forEach(x=>x!==t&&x.classList.remove('over')); t.classList.add('over'); return; }
    const d = e.target.closest('.day,.mcell');
    if(d){ e.preventDefault(); $$('.pl .drop').forEach(x=>x!==d&&x.classList.remove('drop')); d.classList.add('drop'); }
  });
  v.addEventListener('dragleave', e => { const d = e.target.closest('.day,.mcell,.tile'); if(d && !d.contains(e.relatedTarget)) d.classList.remove('drop','over'); });
  v.addEventListener('drop', e => {
    if(dragKey){ const t = e.target.closest('.tile[data-key]'); const k = dragKey; dragKey = null; if(t){ e.preventDefault(); moveFeedTile(k, t.dataset.key); } return; }
    if(!dragId) return;
    const t = e.target.closest('.tile[data-id]');
    if(t){
      e.preventDefault(); const a = mine().find(x=>x.id===dragId), b = mine().find(x=>x.id===t.dataset.id); dragId=null;
      if(a && b && a!==b){ [a.date,b.date] = [b.date,a.date]; [a.time,b.time] = [b.time,a.time]; touch(a); touch(b); render(); toast(`Swapped: now ${dayLabel(a.date)} ↔ ${dayLabel(b.date)}`); }
      else render();
      return;
    }
    const d = e.target.closest('.day,.mcell');
    if(d){ e.preventDefault(); const p = mine().find(x=>x.id===dragId); dragId=null; if(p && p.date!==d.dataset.date){ p.date = d.dataset.date; touch(p); toast(`Moved to ${dayLabel(p.date)}`); } render(); }
  });
  v.addEventListener('dragend', () => { dragId=null; dragKey=null; $$('.pl .drop, .pl .tile.over, .pl .tile.dragging').forEach(x=>x.classList.remove('drop','over','dragging')); });
}
function setView(v){ view = v; $$('#plViewSwitch button').forEach(b=>b.classList.toggle('on', b.dataset.view===v)); render(); }

// ---------- uploads ----------
function guessFormats(w, h, isVideo, count=1){
  const r = w && h ? w/h : 0.8;
  if(r > 1.2) return isVideo ? ['yt-video'] : ['ig-post'];
  if(r < 0.7) return count>1 ? ['tt-photo'] : isVideo ? ['ig-reel','tt-video'] : ['ig-story'];
  return ['ig-post'];
}
function nextEmptyDay(){ const T = today(); for(let i=0;i<90;i++){ const k = iso(addDays(T,i)); if(!postsOn(k).length) return k; } return iso(T); }
function openNew(date){
  pendingDate = date || nextEmptyDay();
  $('#plNewFor').textContent = `For ${fromIso(pendingDate).toDateString()}`;
  $('#plNewScrim').classList.add('open');
}
const newPost = (date, formats, slides, extra={}) => ({ id:uid(), owner:me ? me.id : null, date, time:'18:00', formats, slides, caption:'', tags:'', title:'', thumb:null,
  status:'draft', created:Date.now(), updatedAt:Date.now(), dirty:true, synced:false, orphans:[], ...extra });

async function onFiles(e){
  const files = [...e.target.files]; e.target.value=''; if(!files.length) return;
  toast(files.length>1 ? `Preparing ${files.length} files…` : 'Preparing…');
  const slides = await Promise.all(files.map(slideFromFile));
  if(uploadMode==='inspo'){ addInspoItems(slides); return; }
  if(uploadMode==='inspoMine'){ setMyVersion(slides[0]); return; }
  const p = selected();
  if(uploadMode==='old'){
    // only small previews are kept for these: they're just for the feed preview
    oldPosts[feedPlat].push(...slides.map(s => ({ id:s.id, type:s.type, mime:'image/jpeg', w:s.w, h:s.h, preview:s.preview })));
    await saveFeed(); renderFeed(); toast(`${slides.length} photo${slides.length>1?'s':''} added to the preview · drag to place ${slides.length>1?'them':'it'}`); return;
  }
  if(uploadMode==='append' && p){ p.slides.push(...slides); slideIdx = p.slides.length - slides.length; touch(p); toast(`${slides.length} slide${slides.length>1?'s':''} added · now ${p.slides.length}`); }
  else if(uploadMode==='replace' && p){ dropSlide(p, p.slides[slideIdx]); p.slides[slideIdx] = slides[0]; touch(p); toast('Replaced'); }
  else if(uploadMode==='thumb' && p){ dropSlide(p, p.thumb); p.thumb = slides[0]; touch(p); toast('Thumbnail added'); }
  else {
    const s0 = slides[0], fm = guessFormats(s0.w, s0.h, s0.type==='video', slides.length);
    const np = newPost(pendingDate || nextEmptyDay(), fm, slides);
    store.push(np); touch(np); selId = np.id; slideIdx = 0; cursor = fromIso(np.date);
    toast(`Added as ${fm.map(k=>FORMATS[k].short).join(' + ')}${slides.length>1?` carousel (${slides.length})`:''}. Change it under “Where & format”`);
  }
  closeModals(); render();
}

// ---------- "Add to planner" from the studio ----------
let atp = { mode:'new', date:null, formats:['ig-post'], file:'png', replaceId:null };
function frameFormats(){
  const vid = anyVideoAnywhere();
  return Object.keys(FORMATS).filter(k => fits(FORMATS[k], W, H) && !(FORMATS[k].media==='video' && !vid) && !(FORMATS[k].media==='image' && vid));
}
function setAtpMode(m){
  atp.mode = m;
  $$('#plAtpMode button').forEach(b=>b.classList.toggle('on', b.dataset.mode===m));
  $('#plAtpNew').hidden = m!=='new'; $('#plAtpSlide').hidden = m!=='slide'; $('#plAtpThumb').hidden = m!=='thumb';
  $('#plAtpMode').hidden = m==='replace';
  $('#plAtpSave').textContent = { new:'Add to planner', slide:'Add as next slide', thumb:'Set as thumbnail', replace:'Replace with this design' }[m];
  if(m==='thumb') setAtpFile('png');
}
function setAtpFile(ft){
  atp.file = ft; $$('#plAtpFile button').forEach(b=>b.classList.toggle('on', b.dataset.ft===ft));
  const animated = anyVideoAnywhere();
  $('#plAtpFileHint').textContent = ft==='mp4'
    ? (animated ? 'Records your design with its video playing (takes as long as the video).' : 'Records a short 3-second animated clip of your design.')
    : ft==='jpeg' ? 'Smaller file, best for photos.' : 'Sharpest quality.';
}
function renderAtpFormats(){
  const good = frameFormats();
  $('#plFrameNote').textContent = `your frame is ${W} × ${H}`;
  $('#plAtpFormats').innerHTML = Object.keys(PLATFORMS).map(pl => `<div class="fmt-group"><span class="pn">${PLATFORMS[pl]}</span><div class="fmt-opts">
    ${Object.entries(FORMATS).filter(([,x])=>x.plat===pl).map(([k,x])=>`<button class="pf ${pl} ${atp.formats.includes(k)?'on':''} ${good.includes(k)?'':'faded'}" data-af="${k}" title="${good.includes(k)?'Matches your frame':'Different size or media type from your design'}">${ratioIcon(x)}${x.name}</button>`).join('')}
  </div></div>`).join('') + '<div class="hint">Faded options don’t match your current frame size (or need a video).</div>';
  $$('[data-af]').forEach(b => b.onclick = () => { const k=b.dataset.af; atp.formats = atp.formats.includes(k)?atp.formats.filter(x=>x!==k):[...atp.formats,k]; renderAtpFormats(); });
}
function postLabel(p){ return `${dayLabel(p.date)} · ${p.time} · ${fmtsOf(p).map(f=>f.short).join(' + ') || 'no format'}${p.title?` · ${p.title.slice(0,30)}`:p.caption?` · ${p.caption.slice(0,30)}`:''}`; }

function openAtp(opts={}){
  atp.replaceId = opts.postId || null;
  const T = today(), box = $('#plQdays'); box.innerHTML = ''; atp.date = nextEmptyDay();
  for(let i=0;i<14;i++){
    const d = addDays(T,i), k = iso(d), n = postsOn(k).length;
    box.insertAdjacentHTML('beforeend', `<button class="qd ${k===atp.date?'on':''}" data-k="${k}">${DN[(d.getDay()+6)%7]} ${d.getDate()}<small>${n?n+' post'+(n>1?'s':''):'empty'}</small></button>`);
  }
  $$('.qd', box).forEach(b => b.onclick = () => { atp.date = b.dataset.k; $$('.qd', box).forEach(x=>x.classList.toggle('on', x===b)); });

  const vid = anyVideoAnywhere(), r = W/H, good = frameFormats();
  atp.formats = (r < 0.7 ? (vid ? ['ig-reel','tt-video'] : ['ig-story']) : r > 1.2 ? (vid ? ['yt-video'] : []) : ['ig-post']).filter(k => good.includes(k));
  if(!atp.formats.length && good.length) atp.formats = [good[0]];
  renderAtpFormats();

  const upcoming = mine().filter(p => fromIso(p.date) >= T && p.status!=='posted').sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  const carouselable = upcoming.filter(p => !fmtsOf(p).length || fmtsOf(p).some(f=>f.carousel));
  const recent = carouselable.reduce((a,b)=> !a || (b.created||0) > (a.created||0) ? b : a, null);
  $('#plAtpTarget').innerHTML = carouselable.length
    ? carouselable.map(p=>`<option value="${p.id}" ${recent && p.id===recent.id?'selected':''}>${esc(postLabel(p))} (${p.slides.length} slide${p.slides.length>1?'s':''})</option>`).join('')
    : '<option value="">No upcoming posts that can be carousels</option>';
  const ytVids = upcoming.filter(p=>p.formats.includes('yt-video'));
  $('#plAtpThumbTarget').innerHTML = ytVids.length
    ? ytVids.map(p=>`<option value="${p.id}">${esc(postLabel(p))}${p.thumb?' · has a thumbnail':''}</option>`).join('')
    : '<option value="">No YouTube videos planned yet</option>';

  $('#plAtpCap').value = '';
  setAtpFile(vid ? 'mp4' : 'png');
  setAtpMode(opts.mode || (r > 1.2 && !vid && ytVids.length ? 'thumb' : 'new'));
  $('#plAtpScrim').classList.add('open');
}

async function captureStudio(kind){
  selectedId = null; draw();
  const preview = await previewFromSource(canvas, W, H);   // first frame, before any recording
  const stamp = new Date(), base = `inspocult-${iso(stamp)}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  if(kind==='mp4'){
    const { blob, mime, ext } = await recordCanvasVideo();
    const dur = anyVideoAnywhere() ? null : 3;
    return { id:uid(), type:'video', mime, blob, w:W, h:H, duration:dur, preview, name:`${base}.${ext}` };
  }
  const mime = kind==='jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Canvas could not be saved')), mime, 0.94));
  return { id:uid(), type:'image', mime, blob, w:W, h:H, preview, name:`${base}.${extFor(mime)}` };
}

async function saveFromStudio(){
  const btn = $('#plAtpSave');
  let target = null;
  if(atp.mode==='new' && !atp.formats.length){ toast('Pick at least one format', true); return; }
  if(atp.mode==='slide'){ target = mine().find(x=>x.id===$('#plAtpTarget').value); if(!target){ toast('Plan a post first, then add slides to it', true); return; } }
  if(atp.mode==='thumb'){ target = mine().find(x=>x.id===$('#plAtpThumbTarget').value); if(!target){ toast('Plan a YouTube video first', true); return; } }
  if(atp.mode==='replace'){ target = mine().find(x=>x.id===atp.replaceId); if(!target){ closeModals(); return; } }

  btn.disabled = true; const label = btn.textContent; btn.textContent = atp.file==='mp4' && atp.mode!=='thumb' ? 'Recording…' : 'Saving…';
  let slide;
  try{ slide = await captureStudio(atp.mode==='thumb' ? 'png' : atp.file); }
  catch(err){ console.error(err); toast('Could not capture the design. Try PNG instead.', true); btn.disabled = false; btn.textContent = label; return; }
  finally{ try{ setProgress(0); }catch(e){} }
  btn.disabled = false; btn.textContent = label;

  let p;
  if(atp.mode==='new'){
    p = newPost(atp.date, [...atp.formats], [slide], { time:$('#plAtpTime').value || '18:00', caption:$('#plAtpCap').value });
    store.push(p); slideIdx = 0; toast('Added to planner ✓');
  } else if(atp.mode==='slide'){
    p = target; p.slides.push(slide); slideIdx = p.slides.length-1;
    if(!p.formats.length) p.formats = ['ig-post'];
    toast(`Added as slide ${p.slides.length} ✓`);
  } else if(atp.mode==='thumb'){
    p = target; dropSlide(p, p.thumb); p.thumb = slide; toast('Thumbnail set ✓');
  } else {
    p = target; dropSlide(p, p.slides[slideIdx]); if(p.slides.length) p.slides[slideIdx] = slide; else p.slides = [slide]; toast('Replaced with your studio design ✓');
  }
  touch(p);
  closeModals();
  if(atp.mode==='replace'){ render(); return; }
  updateDueBadge();
  selId = p.id; cursor = fromIso(p.date);
}

// ---------- backup / restore ----------
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const dataURLToBlob = async d => (await fetch(d)).blob();
async function packSlide(s){ return s ? { ...s, blob:undefined, preview:undefined, data: s.blob ? await blobToDataURL(s.blob) : null, previewData: s.preview ? await blobToDataURL(s.preview) : null } : null; }
async function unpackSlide(s){ return s ? { id:uid(), type:s.type, mime:s.mime, w:s.w, h:s.h, name:s.name||null, duration:s.duration||null,
  blob: s.data ? await dataURLToBlob(s.data) : null, preview: s.previewData ? await dataURLToBlob(s.previewData) : null } : null; }

async function doBackup(){
  const btn = $('#plDoBackup'); btn.disabled = true; btn.textContent = 'Preparing…';
  try{
    const out = { app:'inspocult-planner', version:2, exported:new Date().toISOString(), posts:[] };
    for(const p of mine()) out.posts.push({ id:p.id, date:p.date, time:p.time, formats:p.formats, caption:p.caption, tags:p.tags, title:p.title, status:p.status, created:p.created,
      slides: await Promise.all(p.slides.map(packSlide)), thumb: await packSlide(p.thumb) });
    const blob = new Blob([JSON.stringify(out)], { type:'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `inspocult-planner-backup-${iso(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
    kvSet('lastBackup:'+me.id, Date.now()); toast(`Backup saved (${(blob.size/1048576).toFixed(1)} MB)`);
  } catch(err){ console.error(err); toast('Backup failed: '+err.message, true); }
  btn.disabled = false; btn.textContent = '⬇ Download backup';
}
async function doRestore(e){
  const f = e.target.files[0]; e.target.value=''; if(!f) return;
  let data;
  try{ data = JSON.parse(await f.text()); } catch{ toast('That file isn’t an inspocult planner backup', true); return; }
  if(!data || data.app!=='inspocult-planner' || !Array.isArray(data.posts)){ toast('That file isn’t an inspocult planner backup', true); return; }
  if(!(await askConfirm(`Add ${data.posts.length} posts from this backup to your planner? Posts already in your planner stay; anything in the backup is added as new posts.`, 'Add posts'))) return;
  try{
    let n = 0;
    for(const p of data.posts){
      const slides = (await Promise.all((p.slides||[]).map(unpackSlide))).filter(Boolean);
      for(const s of slides) if(s.blob && !s.preview) s.preview = (await analyse(s.blob, s.type)).preview;
      const np = newPost(p.date, p.formats||[], slides, { time:p.time||'18:00', caption:p.caption||'', tags:p.tags||'', title:p.title||'', status:p.status||'draft', thumb: await unpackSlide(p.thumb) });
      store.push(np); touch(np); n++;
    }
    closeModals(); render(); toast(`Restored ${n} posts ✓ Syncing to your account…`);
  } catch(err){ console.error(err); toast('Restore failed: '+err.message, true); }
}
async function openBackup(){
  const last = await kvGet('lastBackup:'+me.id);
  const fullCount = mine().reduce((n,p)=>n + p.slides.filter(s=>s.blob).length, 0);
  $('#plBackupInfo').textContent = `${mine().length} post${mine().length===1?'':'s'} in your planner, ${fullCount} full-size file${fullCount===1?'':'s'} on this computer. ${last ? 'Last backup: '+new Date(last).toLocaleDateString()+'.' : 'No backup made yet.'}`;
  $('#plBackupScrim').classList.add('open');
}

// ---------- modals, keyboard ----------
function closeModals(){ $$('.pl-scrim:not(#plConfirmScrim)').forEach(s=>s.classList.remove('open')); }

// Our own "Are you sure?" window. The browser's built-in confirm() is blocked
// silently in some browsers and in-app web views, which made Delete do nothing.
let confirmResolve = null;
function askConfirm(message, okLabel='OK', danger=false){
  if(confirmResolve) confirmResolve(false);
  $('#plConfirmMsg').textContent = message;
  const ok = $('#plConfirmOk'); ok.textContent = okLabel; ok.classList.toggle('danger-solid', danger);
  $('#plConfirmScrim').classList.add('open');
  setTimeout(()=>ok.focus(), 30);
  return new Promise(res => { confirmResolve = res; });
}
window.plAskConfirm = askConfirm;   // the studio's Clear buttons use this too
function answerConfirm(yes){
  $('#plConfirmScrim').classList.remove('open');
  const r = confirmResolve; confirmResolve = null; if(r) r(yes);
}

function bindGlobal(){
  $$('#plSwitch button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $$('#plViewSwitch button').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#plPrev').onclick = () => { cursor = view==='week' ? addDays(cursor,-7) : new Date(cursor.getFullYear(), cursor.getMonth()-1, 1); render(); };
  $('#plNext').onclick = () => { cursor = view==='week' ? addDays(cursor,7) : new Date(cursor.getFullYear(), cursor.getMonth()+1, 1); render(); };
  $('#plToday').onclick = () => { cursor = today(); render(); };
  $('#plNewBtn').onclick = () => openNew(null);
  $('#plBackupBtn').onclick = openBackup;
  $('#plDoBackup').onclick = doBackup;
  $('#plDoRestore').onclick = () => $('#plRestoreIn').click();
  $('#plRestoreIn').onchange = doRestore;
  $('#plPickUpload').onclick = () => { uploadMode='new'; $('#plFileIn').click(); };
  $('#plPickStudio').onclick = () => { closeModals(); switchTab('studio'); toast('Design it, then press “Add to planner” under the export buttons'); };
  $('#plFileIn').onchange = onFiles;
  $('#addToPlannerBtn').onclick = () => requireLogin(() => openAtp());
  $$('#plAtpMode button').forEach(b => b.onclick = () => setAtpMode(b.dataset.mode));
  $$('#plAtpFile button').forEach(b => b.onclick = () => setAtpFile(b.dataset.ft));
  $('#plAtpSave').onclick = saveFromStudio;
  $$('#plLoginTabs button').forEach(b => b.onclick = () => setLoginMode(b.dataset.lm));
  $('#plLoginForm').onsubmit = submitLogin;
  $('#plForgot').onclick = () => { $('#plLoginMsg').textContent = ''; setLoginMode(loginMode==='reset' ? 'login' : 'reset'); $('#plEmail').focus(); };
  $('#plNewPwForm').onsubmit = saveNewPassword;
  $('#plLogoutGo').onclick = logOut;
  $('#plDelConfirm').oninput = e => { $('#plDelGo').disabled = e.target.value.trim().toUpperCase() !== 'DELETE'; };
  $('#plDelConfirm').onkeydown = e => { if(e.key==='Enter' && !$('#plDelGo').disabled){ e.preventDefault(); deleteAccount(); } };
  $('#plDelGo').onclick = deleteAccount;
  $('#plDelBackup').onclick = doBackup;
  $('#plConfirmOk').onclick = () => answerConfirm(true);
  $('#plConfirmCancel').onclick = () => answerConfirm(false);
  $('#plConfirmScrim').addEventListener('click', e => { if(e.target.id==='plConfirmScrim') answerConfirm(false); });
  $$('[data-close]').forEach(b => b.onclick = () => { afterLogin = null; closeModals(); });
  $$('.pl-scrim:not(#plConfirmScrim)').forEach(s => s.addEventListener('click', e => { if(e.target===s){ afterLogin = null; closeModals(); } }));
  document.addEventListener('click', e => { const m = $('#plAcctMenu'); if(m && !m.hidden && !e.target.closest('#plAccount')) m.hidden = true; });
  document.addEventListener('keydown', e => {
    if(confirmResolve && (e.key==='Escape' || e.key==='Enter')){ e.preventDefault(); answerConfirm(e.key==='Enter'); return; }
    if(e.key==='Escape' && $('.pl-scrim.open')){ afterLogin = null; closeModals(); return; }
    if(!inPlanner()) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if(e.key==='Escape' && selId && !typing){ selId=null; render(); }
    const p = selected();
    if(p && !typing && p.slides.length>1 && (e.key==='ArrowRight' || e.key==='ArrowLeft')){
      slideIdx = (slideIdx + (e.key==='ArrowRight'?1:-1) + p.slides.length) % p.slides.length; renderDrawer();
    }
  });
  bindView();
  // keep data fresh: back online → send changes; return to the tab → fetch changes from other devices
  window.addEventListener('online', () => { pushAll(); pullAll(true); });
  window.addEventListener('offline', () => me && setSync('offline', 'You’re offline. Changes are saved on this computer and will sync when you’re back online.'));
  window.addEventListener('focus', () => { if(me && (inPlanner() || inInspo())) pullAll(); });
  document.addEventListener('visibilitychange', () => { if(document.visibilityState==='hidden' && me) pushAll(); });
  setInterval(() => { updateDueBadge(); if(me && (inPlanner() || inInspo()) && document.visibilityState==='visible') pullAll(); }, 60*1000);
}

// =========================================================================
//  INSPO BOARD
//  A feed of pictures/videos to recreate later. "Mark as recreated" toggles an
//  item done (butter ✓ over it, tap again to undo). "+ add my version" attaches
//  what they made; hover (laptop) or tap (phone) on the picture reveals it.
//  Items: { kind:'inspo', slides:[inspo, mine?], note, status:'todo'|'done' }
//  stored with the planner posts (same IndexedDB store / Supabase table).
// =========================================================================
let inspoFilter = 'all';
let mineFor = null;     // which item "+ add my version" is uploading for
const HOVER = window.matchMedia && matchMedia('(hover: hover)').matches;   // laptop mouse vs. phone touch

function renderInspo(){
  if(!inInspo() || !me) return;
  renderMemo();
  const all = inspos().sort((a,b) => (b.created||0) - (a.created||0));
  const todo = all.filter(p => p.status!=='done'), done = all.filter(p => p.status==='done');
  const list = inspoFilter==='todo' ? todo : inspoFilter==='done' ? done : all;
  $('#insStats').innerHTML = `<span class="stat"><b>${todo.length}</b> to recreate</span><span class="stat"><b>${done.length}</b> recreated</span>`;
  $$('#insFilter button').forEach(b => b.classList.toggle('on', b.dataset.f===inspoFilter));
  const v = $('#insView');
  if(!all.length){
    v.innerHTML = `<div class="ins-empty">
      <div class="ins-empty-art"><span></span><span></span><span></span></div>
      <h3>Save ideas now, recreate them later</h3>
      <p>Spotted a look you love on Pinterest, Instagram or in your camera roll? Save it here so the idea never gets lost. Once you've recreated it, mark it as recreated and add your version to see them together.</p>
      <button class="btn primary" id="insEmptyAdd">+ Save your first idea</button></div>`;
    $('#insEmptyAdd').onclick = () => { uploadMode='inspo'; $('#plFileIn').click(); };
    return;
  }
  if(!list.length){
    v.innerHTML = `<div class="ins-empty small"><p>${inspoFilter==='done'
      ? 'Nothing recreated yet. When you’ve made one, tap <b>Mark as recreated</b> on its card.'
      : 'Everything here is recreated ✨ Save more ideas with <b>+ Save an idea</b>.'}</p></div>`;
    return;
  }
  // as many columns as there are ideas, up to 5, so a small board doesn't look empty and stretched
  v.innerHTML = `<div class="ins-grid" style="--n:${Math.min(list.length, 5)}">${list.map(insCard).join('')}</div>`;
}

function insCard(p){
  const a = p.slides[0], b = p.slides[1], done = p.status==='done';
  // sensible card shapes: very tall uploads show 3:5, very wide 3:2; the picture fills the frame (cropped, never squashed)
  const r = a && a.w && a.h ? Math.min(1.5, Math.max(0.6, a.w / a.h)) : 0.8;
  const reveal = done && b;
  return `<div class="ins-card ${done?'done':''}" data-id="${p.id}">
    <div class="ins-one ${reveal ? 'has-mine' : ''}" style="aspect-ratio:${r.toFixed(3)}"${reveal && !HOVER ? ` data-reveal="${p.id}"` : ''}>
      ${thumbHTML(a)}${a && a.type==='video' ? '<span class="ins-play">▶</span>' : ''}
      ${reveal ? `<div class="ins-mine">${thumbHTML(b)}<span class="ins-tag me">me</span></div><span class="ins-hint">${HOVER ? 'hover' : 'tap'} to see yours</span>` : ''}
      ${done ? '<div class="ins-ck" aria-label="Recreated"><span>✓</span></div>' : ''}
    </div>
    <div class="ins-meta">
      <input class="ins-note" data-note="${p.id}" value="${esc(p.note||'')}" placeholder="idea note… (what to recreate, where it's from)" maxlength="140">
      <button class="ins-toggle ${done?'on':''}" data-toggle="${p.id}" aria-pressed="${done}" title="${done ? 'Recreated: click to undo' : 'Tick this once you\u2019ve recreated it'}">
        <span class="box">${done ? '✓' : ''}</span><span>${done ? 'Recreated' : 'Mark as recreated'}</span>
      </button>
      <div class="ins-sub"><span>saved ${savedAgo(p.created)}</span>
        <span class="ins-links">${done ? `<button class="ins-link" data-mine="${p.id}">${b ? 'change mine' : '+ my version'}</button>` : ''}<button class="ins-link del" data-del="${p.id}">remove</button></span></div>
    </div></div>`;
}

function savedAgo(t){
  if(!t) return '';
  const days = Math.floor((today() - new Date(new Date(t).setHours(0,0,0,0))) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : days < 14 ? 'last week' : days < 60 ? `${Math.floor(days/7)} weeks ago` : `${Math.floor(days/30)} months ago`;
}

function addInspoItems(slides){
  const now = Date.now();
  slides.forEach((s, i) => {
    const it = { id:uid(), owner:me.id, kind:'inspo', note:'', status:'todo', date:iso(today()), time:'00:00', formats:[], caption:'', tags:'', title:'',
      slides:[s], thumb:null, created:now + i, updatedAt:now, dirty:true, synced:false, orphans:[] };
    store.push(it); touch(it);
  });
  if(inspoFilter==='done') inspoFilter = 'all';
  renderInspo();
  toast(slides.length > 1 ? `${slides.length} ideas saved ✨` : 'Idea saved ✨ Recreate it whenever you’re ready');
}

function toggleRecreated(id){
  const p = inspos().find(x => x.id===id); if(!p) return;
  const nowDone = p.status!=='done';
  p.status = nowDone ? 'done' : 'todo'; touch(p); renderInspo();
  toast(nowDone ? (p.slides[1] ? '✓ Recreated!' : '✓ Recreated! Add your version from the card if you like') : 'Moved back to “to recreate”');
}

function setMyVersion(slide){
  const p = inspos().find(x => x.id===mineFor); mineFor = null;
  if(!p || !slide) return;
  if(p.slides[1]) dropSlide(p, p.slides[1]);
  p.slides = [p.slides[0], slide];
  p.status = 'done'; touch(p); renderInspo();
  toast(`Your version is added ✓ ${HOVER ? 'Hover over' : 'Tap'} the picture to see it`);
}

// ---- sticky note ("remember") ----
const memoRec = () => owned().filter(p => p.kind==='memo').sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0))[0];
function renderMemo(){
  const ta = $('#insMemo'); if(!ta || document.activeElement===ta) return;   // never overwrite while typing
  const r = memoRec(); ta.value = r ? (r.note || '') : '';
}
let memoTimer = null;
function onMemoInput(e){
  let r = memoRec();
  if(!r){
    r = { id:`notes-${me.id}`, owner:me.id, kind:'memo', note:'', status:'', date:iso(today()), time:'00:00', formats:[], caption:'', tags:'', title:'',
      slides:[], thumb:null, created:Date.now(), updatedAt:Date.now(), dirty:true, synced:false, orphans:[] };
    store.push(r);
  }
  r.note = e.target.value; touchSoon(r);
  const st = $('#insMemoState'); st.textContent = 'saving\u2026';
  clearTimeout(memoTimer); memoTimer = setTimeout(() => { st.textContent = 'saved to your account'; }, 1400);
}

function bindInspo(){
  $('#insMemo').addEventListener('input', onMemoInput);
  $('#insAddBtn').onclick = () => { uploadMode='inspo'; $('#plFileIn').click(); };
  $$('#insFilter button').forEach(b => b.onclick = () => { inspoFilter = b.dataset.f; renderInspo(); });
  const v = $('#insView');
  v.addEventListener('click', async e => {
    const t = e.target.closest('[data-toggle]'); if(t){ toggleRecreated(t.dataset.toggle); return; }
    const m = e.target.closest('[data-mine]'); if(m){ mineFor = m.dataset.mine; uploadMode='inspoMine'; $('#plFileIn').click(); return; }
    const x = e.target.closest('[data-del]');
    if(x){
      const p = inspos().find(i => i.id===x.dataset.del); if(!p) return;
      if(!(await askConfirm('Remove this idea from your board?', 'Remove', true))) return;
      p.slides.forEach(forgetURLs); p.deleted = true;
      if(p.synced) touch(p); else { store = store.filter(i => i!==p); delLocal(p.id); }
      renderInspo(); return;
    }
    const rv = e.target.closest('[data-reveal]'); if(rv) rv.classList.toggle('reveal');   // phones: tap to see yours
  });
  v.addEventListener('input', e => {
    const n = e.target.closest('[data-note]'); if(!n) return;
    const p = inspos().find(i => i.id===n.dataset.note); if(p){ p.note = n.value; touchSoon(p); }
  });
}

// ---------- boot ----------
async function boot(){
  injectUI(); bindGlobal(); bindInspo();
  if(today().getDay()===0) cursor = addDays(today(), 1);   // Sundays (batch day) open on next week
  try{
    db = await openDB();
    store = ((await req('posts','readonly', s => s.getAll())) || []).map(p => ({ orphans:[], ...p, owner: p.owner || null }));
    if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  } catch(err){
    console.error(err);
    toast('This browser can’t store planner data on this computer (private window?).', true);
  }

  if(window.supabase && window.supabase.createClient){
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
    sb.auth.onAuthStateChange((event, session) => {
      // run outside the auth callback (supabase-js recommends not awaiting other calls inside it)
      setTimeout(() => {
        if(event==='PASSWORD_RECOVERY') openNewPassword();   // arrived from a reset-password email
        if(session && session.user){ if(!me || me.id!==session.user.id) onSignedIn(session.user); }
        else if(event==='SIGNED_OUT'){ if(me) onSignedOut(); }
      }, 0);
    });
    try{
      const { data:{ session } } = await sb.auth.getSession();
      if(session && session.user) await onSignedIn(session.user);
    } catch(err){ console.warn(err); }
  } else {
    // login library unavailable (offline): let the last user keep working locally
    const u = cachedUser();
    if(u){ me = u; oldPosts = (await kvGet('oldPosts:'+me.id)) || { ig:[], tt:[] }; setSync('offline', 'You’re offline. Changes are saved on this computer and will sync when you’re back online.'); }
  }
  renderAccount();
  renderRemPill();
  render();
  // links like template-studio.html#planner (from the home page) open straight on the Planner
  if(location.hash === '#planner') switchTab('planner');
  if(location.hash === '#inspo') switchTab('inspo');
}
boot();
})();
