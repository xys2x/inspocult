/* =========================================================================
   inspocult — video editor for the template studio
   A timeline under the canvas: several clips in a row (videos or photos),
   trim, speed, colour filters, transitions between clips, text / stickers that
   appear at a set second (with entrance and exit effects), music, the video's
   own sound and built-in sound effects. MP4 export records all of it with
   sound; GIF export follows the same timeline (no sound in GIFs).

   Loaded after the studio's main script and uses its globals (elements, bg,
   draw, renderProps, W, H, canvas, ctx, setStatus…). It only wraps a few of
   the studio's functions, so the studio still works the same without it.

   Data it adds:
   - video holders (a background cell, a photo/video slot, a shape fill) get
     .clips = [{id, kind:'video'|'photo', el, src, in, out, speed, fx, sound}]
     and .trans ('cut'|'fade'|'flash'|'zoom'). The holder's normal el/fillEl is
     always the clip showing right now, so the studio's renderer is unchanged.
   - any element can get .tIn / .tOut (seconds), .enter and .exit effects.
   - music + sound effects are kept per template in audioByTpl.
   ========================================================================= */
(function(){
'use strict';

// ---------------------------------------------------------------- state
const TL = { t:0, playing:false, raf:0, t0:0, base:0, lastT:0, open:false, sel:null,
             exporting:false, onEnd:null, autoOpened:false, drag:null };
const audioByTpl = {};
function A(){ return audioByTpl[currentTplKey] || (audioByTpl[currentTplKey] = { music:null, sfx:[] }); }
let seq = 1;
const uid = p => p + (seq++) + '_' + Math.random().toString(36).slice(2,6);
const isVid = m => !!(m && m.tagName==='VIDEO');
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const fmt = s => { s = Math.max(0, s||0); const m = Math.floor(s/60); return m + ':' + (s - m*60).toFixed(1).padStart(4,'0'); };
const $ = id => document.getElementById(id);
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
const FX = [['','None'],['warm','Warm sunlight'],['cool','Cool blue'],['bw','Black & white'],['vintage','Vintage film'],
            ['dreamy','Dreamy pink'],['bright','Bright & airy'],['moody','Moody dark'],['butter','Butter glow']];
const TRANS = [['cut','Cut (no effect)'],['fade','Fade through black'],['flash','White flash'],['zoom','Zoom punch']];
const ENTER = [['','Just appears'],['fade','Fade in'],['pop','Pop in'],['up','Slide up'],['left','Slide in from left'],
               ['right','Slide in from right'],['zoom','Zoom in'],['type','Typewriter (text)']];
const EXIT = [['','Just disappears'],['fade','Fade out'],['pop','Pop out'],['down','Slide down']];
const SFX = [['pop','Pop'],['whoosh','Whoosh'],['ding','Ding'],['shutter','Camera click'],['sparkle','Sparkle'],
             ['boing','Boing'],['thud','Boom'],['swipe','Swipe'],['chime','Chime']];
const SFX_ICON = { pop:'💥', whoosh:'💨', ding:'🔔', shutter:'📸', sparkle:'✨', boing:'🪀', thud:'🥁', swipe:'👆', chime:'🎐' };

// ---------------------------------------------------------------- holders & clips
function holders(){
  const out = [], n = (LAYOUTS[bg.layout] || [0]).length;
  bg.cells.forEach((c,i) => { if(i < n) out.push({ key:'c'+i, obj:c, kind:'cell', sel:'__bg_'+i,
    label: n>1 ? 'Background '+(i+1) : 'Background' }); });
  elements.forEach(e => {
    if(e.type==='image' && !e.sticker) out.push({ key:'e'+e.id, obj:e, kind:'img', sel:e.id, label: e.label || 'Photo / video slot' });
    if(e.type==='rect' && e.fillType==='image') out.push({ key:'f'+e.id, obj:e, kind:'fill', sel:e.id, label:'Shape fill' });
  });
  return out;
}
function getM(h){ return h.kind==='fill' ? h.obj.fillEl : h.obj.el; }
function setM(h, m, src){
  const o = h.obj;
  if(h.kind==='fill'){ o.fillEl = m; if(src!==undefined) o.fillSrc = src; }
  else {
    o.el = m; if(src!==undefined) o.src = src;
    if(h.kind==='cell') o.type = m ? (isVid(m) ? 'video' : 'image') : 'none';
  }
  if(o.focalX===undefined){ o.focalX = .5; o.focalY = .5; o.zoom = 1; }
}
function ensureClips(h){
  const o = h.obj, m = getM(h);
  if(o.clips && o.clips.length && o.clips.some(c => c.el===m)) return o.clips;
  if(isVid(m)){ o.clips = [ newClip(m, h.kind==='fill' ? o.fillSrc : o.src) ]; return o.clips; }
  if(o.clips){ o.clips.forEach(c => { if(c.el) delete c.el._tl; }); delete o.clips; }
  return null;
}
function tlHolders(){ return holders().filter(h => ensureClips(h)); }
function findHolder(key){ return holders().find(h => h.key===key) || null; }

function newClip(m, src){
  const vid = isVid(m);
  const c = { id:uid('clip'), kind: vid ? 'video' : 'photo', el:m, src, in:0, out: vid ? vidDur(m, 5) : 3, speed:1, fx:'', sound:true };
  if(vid && !isFinite(m.duration)) scanDuration(m).then(d => { if(d && c.out===5) c.out = d; tlRender(); });
  return c;
}
function scanDuration(v){
  return new Promise(res => {
    if(isFinite(v.duration) && v.duration>0) return res(v.duration);
    const back = () => { v.removeEventListener('seeked', back); const d = v.duration;
      const h = () => { v.removeEventListener('seeked', h); res(isFinite(d) ? d : 0); };
      v.addEventListener('seeked', h); v.currentTime = 0; setTimeout(() => res(isFinite(d) ? d : 0), 1500); };
    v.addEventListener('seeked', back); v.currentTime = 1e9;
    setTimeout(() => res(isFinite(v.duration) ? v.duration : 0), 3500);
  });
}
const srcDur = c => c.kind==='video' ? vidDur(c.el, Math.max(c.out, 1)) : 15;
const clipLen = c => Math.max(0.1, c.out - c.in) / (c.speed || 1);
const holderDur = clips => clips.reduce((s,c) => s + clipLen(c), 0);
const hasTiming = e => e.tIn!=null;

function totalDur(){
  let T = 0;
  tlHolders().forEach(h => { T = Math.max(T, holderDur(h.obj.clips)); });
  elements.forEach(e => { if(hasTiming(e)) T = Math.max(T, e.tOut!=null ? e.tOut : e.tIn + 2); });
  A().sfx.forEach(s => { T = Math.max(T, s.t + 0.8); });
  const mu = A().music;
  if(T===0 && mu && mu.buf) T = Math.max(0, mu.buf.duration - (mu.offset||0));
  return Math.min(MP4_MAX_SECONDS, T);
}
function tlActive(){ return tlHolders().length>0 || elements.some(hasTiming) || A().sfx.length>0 || !!A().music; }

// which clip shows at time t (holders shorter than the whole video loop)
function clipAt(clips, t){
  const D = holderDur(clips);
  const L = D>0 ? ((t % D) + D) % D : 0;
  let off = 0;
  for(let i=0;i<clips.length;i++){
    const c = clips[i], len = clipLen(c);
    if(L < off + len || i===clips.length-1){
      const into = clamp(L - off, 0, len);
      return { i, c, off, into, src: c.in + into*c.speed,
               edgeIn: i>0 ? into : 9, edgeOut: i<clips.length-1 ? len - into : 9, next: clips[i+1] || null };
    }
    off += len;
  }
}

function seekTo(v, s){
  return new Promise(res => {
    if(Math.abs(v.currentTime - s) < 0.02) return res();
    const h = () => { v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h); v.currentTime = s; setTimeout(res, 1500);
  });
}
function playSafe(v){ v.muted = true; const p = v.play(); if(p && p.catch) p.catch(()=>{}); }

// put every holder at time t. mode 'play' keeps videos running; 'seek' pauses and
// lands exactly on the frame (resolves once all videos have seeked)
function applyTime(t, mode){
  const waits = [];
  tlHolders().forEach(h => {
    const clips = h.obj.clips, a = clipAt(clips, t), c = a.c;
    if(getM(h)!==c.el) setM(h, c.el);
    c.el._tl = { fx:c.fx, trans:h.obj.trans || 'cut', edgeIn:a.edgeIn, edgeOut:a.edgeOut };
    clips.forEach(o => { if(o.el!==c.el && isVid(o.el) && !o.el.paused) o.el.pause(); });
    clipSound(h, a, mode);
    if(c.kind!=='video') return;
    const v = c.el;
    v.loop = false; v.muted = true;
    if(v.playbackRate !== c.speed) v.playbackRate = c.speed;
    if(mode==='play'){
      if(Math.abs(v.currentTime - a.src) > 0.3 || v.ended) v.currentTime = a.src;
      if(v.paused) playSafe(v);
      // get the next clip ready so the cut is instant
      if(a.next && a.next.kind==='video' && a.next.el!==v && a.edgeOut < 0.7){
        const nv = a.next.el; if(nv.paused && Math.abs(nv.currentTime - a.next.in) > 0.05) nv.currentTime = a.next.in;
      }
    } else {
      if(!v.paused) v.pause();
      waits.push(seekTo(v, a.src));
    }
  });
  return Promise.all(waits);
}
function allClipMedia(){
  const out = [];
  holders().forEach(h => (h.obj.clips || []).forEach(c => out.push(c.el)));
  return out;
}

// ---------------------------------------------------------------- audio
let AC = null, master = null, spk = null, recDest = null;
function audio(){
  if(AC) return AC;
  const C = window.AudioContext || window.webkitAudioContext; if(!C) return null;
  try{
    AC = new C(); master = AC.createGain(); spk = AC.createGain();
    // a gentle limiter so a song + video sound + a sound effect never distort
    const lim = AC.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = .003; lim.release.value = .2;
    master.connect(lim); lim.connect(spk); spk.connect(AC.destination);
    if(AC.createMediaStreamDestination){ recDest = AC.createMediaStreamDestination(); lim.connect(recDest); }
  }catch(e){ AC = null; }
  return AC;
}
function unlockAudio(){ const a = audio(); if(a && a.state==='suspended') a.resume().catch(()=>{}); }

// Sound is decoded once per file and played with Web Audio in step with the
// timeline. The <video> elements themselves always stay muted, which keeps
// phones (iPhone Safari especially) happy to play them without a tap.
const bufs = new Map();          // src -> AudioBuffer | null (no sound / can't decode)
const bufLoading = new Map();
function loadBuf(src){
  if(!src || !AC) return null;
  if(bufs.has(src)) return bufs.get(src);
  if(!bufLoading.has(src)){
    bufLoading.set(src, fetch(src).then(r => r.arrayBuffer())
      .then(ab => new Promise(res => { try{ AC.decodeAudioData(ab, res, () => res(null)); }catch(e){ res(null); } }))
      .catch(() => null)
      .then(b => { bufs.set(src, b); return b; }));
  }
  return null;                    // not ready yet; the next frame tries again
}
const voices = new Map();        // key -> { id, node, gain, t0, s0, rate }
function stopVoice(key){
  const v = voices.get(key); if(!v) return;
  try{ v.node.stop(); }catch(e){}
  try{ v.node.disconnect(); v.gain.disconnect(); }catch(e){}
  voices.delete(key);
}
function stopAllVoices(){ [...voices.keys()].forEach(stopVoice); }
// keep one sound playing for `key`: buffer b from source second s at speed rate
function keepVoice(key, id, b, s, rate, vol){
  const cur = voices.get(key);
  if(cur && cur.id===id && cur.rate===rate){
    const expect = cur.s0 + (AC.currentTime - cur.t0)*rate;
    if(Math.abs(expect - s) < 0.25){ cur.gain.gain.value = vol; return; }
  }
  stopVoice(key);
  if(!b || s >= b.duration - 0.02 || s < 0) return;
  const node = AC.createBufferSource(), gain = AC.createGain();
  node.buffer = b; node.playbackRate.value = rate; gain.gain.value = vol;
  node.connect(gain); gain.connect(master);
  node.start(0, s);
  voices.set(key, { id, node, gain, t0: AC.currentTime, s0: s, rate });
}
function clipSound(h, a, mode){
  const key = 'h:' + h.key, c = a.c;
  if(mode!=='play' || !AC || c.kind!=='video' || !c.sound){ stopVoice(key); return; }
  const b = loadBuf(c.src);
  if(!b){ stopVoice(key); return; }
  keepVoice(key, c.id, b, a.src, c.speed, 1);
}
function musicSync(t, mode){
  const mu = A().music;
  if(!mu || mode!=='play' || !AC){ stopVoice('music'); return; }
  const T = totalDur();
  let vol = mu.vol!=null ? mu.vol : .8;
  if(T - t < 1.2) vol *= clamp((T - t)/1.2, 0, 1);              // fade out at the end
  keepVoice('music', 'music', mu.buf, (mu.offset||0) + t, 1, vol);
}

// sound effects are made on the fly (no audio files needed)
let noiseCache = null;
function noiseBuf(){
  if(noiseCache) return noiseCache;
  const b = AC.createBuffer(1, AC.sampleRate*1.5, AC.sampleRate), d = b.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i] = Math.random()*2 - 1;
  return (noiseCache = b);
}
function playSfx(kind){
  if(!AC) return;
  const when = AC.currentTime + 0.01, out = AC.createGain(); out.gain.value = .9; out.connect(master);
  const osc = (type, f0, f1, dur, vol, at=0) => {
    const o = AC.createOscillator(), g = AC.createGain(), t0 = when + at;
    o.type = type; o.frequency.setValueAtTime(f0, t0); if(f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dur + 0.05);
  };
  const noise = (dur, vol, ftype, f0, f1, q=1, at=0) => {
    const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain(), t0 = when + at;
    s.buffer = noiseBuf(); f.type = ftype; f.Q.value = q; f.frequency.setValueAtTime(f0, t0);
    if(f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(vol, t0 + dur*0.35); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(out); s.start(t0); s.stop(t0 + dur + 0.05);
  };
  switch(kind){
    case 'pop':     osc('sine', 950, 160, .13, .8); noise(.04, .25, 'highpass', 2500); break;
    case 'whoosh':  noise(.6, .7, 'bandpass', 250, 3200, 1.3); break;
    case 'ding':    osc('sine', 1318, 0, 1.3, .45); osc('sine', 2637, 0, .7, .12); break;
    case 'shutter': noise(.035, .9, 'highpass', 1800); noise(.05, .7, 'bandpass', 3200, 0, 2, .085); break;
    case 'sparkle': [0,.06,.12,.18,.24,.3].forEach((a,i) => osc('triangle', 1700 + i*380, 0, .28, .16, a)); break;
    case 'boing':   osc('sine', 140, 460, .18, .6); osc('sine', 460, 220, .3, .45, .18); break;
    case 'thud':    osc('sine', 130, 38, .55, 1); noise(.09, .45, 'lowpass', 700); break;
    case 'swipe':   noise(.22, .55, 'bandpass', 900, 5200, 2); break;
    case 'chime':   [0,.12,.24].forEach((a,i) => osc('sine', [1047,1319,1568][i], 0, 1.1, .3, a)); break;
  }
}

// ---------------------------------------------------------------- playback
function tick(){
  if(!TL.playing) return;
  const now = performance.now(), T = totalDur();
  let t = TL.base + (now - TL.t0)/1000;
  if(T<=0){ tlPause(); return; }
  if(t >= T){
    if(TL.exporting){
      TL.t = T; TL.playing = false; pauseAll(); draw(); updateHead();
      const f = TL.onEnd; TL.onEnd = null; if(f) f(); return;
    }
    t = 0; TL.base = 0; TL.t0 = now; TL.lastT = -0.001;
  }
  A().sfx.forEach(s => { if(s.t > TL.lastT && s.t <= t) playSfx(s.kind); });
  TL.t = t; TL.lastT = t;
  motionT = t;
  applyTime(t, 'play'); musicSync(t, 'play');
  draw(); updateHead();
  if(TL.exporting) setProgress(clamp(t/T*95, 1, 95));
  TL.raf = requestAnimationFrame(tick);
}
function pauseAll(){
  allClipMedia().forEach(m => { if(isVid(m) && !m.paused) m.pause(); });
  stopAllVoices();
}
function preloadSounds(){
  if(!AC) return Promise.resolve();
  const srcs = new Set();
  tlHolders().forEach(h => h.obj.clips.forEach(c => { if(c.kind==='video' && c.sound && c.src) srcs.add(c.src); }));
  return Promise.all([...srcs].map(src => { loadBuf(src); return bufLoading.get(src) || null; }));
}
function tlPlay(fromStart){
  const T = totalDur(); if(T<=0) return;
  preloadSounds();
  if(fromStart || TL.t >= T - 0.02) TL.t = 0;
  TL.playing = true; TL.base = TL.t; TL.t0 = performance.now(); TL.lastT = TL.t - 0.001;
  cancelAnimationFrame(TL.raf); TL.raf = requestAnimationFrame(tick); updateHead();
}
function tlPause(){
  TL.playing = false; cancelAnimationFrame(TL.raf); motionT = null; pauseAll(); updateHead();
}
async function tlSeek(t){
  TL.t = clamp(t, 0, totalDur()); TL.lastT = TL.t;
  if(TL.playing){ TL.base = TL.t; TL.t0 = performance.now(); updateHead(); return; }
  await applyTime(TL.t, 'seek'); musicSync(TL.t, 'seek');
  draw(); updateHead();
}
// quick visual seek while dragging (doesn't wait for video frames)
function scrubTo(t){
  TL.t = clamp(t, 0, totalDur()); TL.lastT = TL.t;
  if(TL.playing){ TL.base = TL.t; TL.t0 = performance.now(); }
  else { applyTime(TL.t, 'seek').then(() => draw()); musicSync(TL.t, 'seek'); draw(); }
  updateHead();
}

// ---------------------------------------------------------------- renderer hooks
function applyFx(c, fx, x, y, w, h){
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  const fill = (op, col, a) => { c.globalCompositeOperation = op; c.globalAlpha = a; c.fillStyle = col; c.fillRect(x, y, w, h); };
  const vignette = a => {
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    const g = c.createRadialGradient(x+w/2, y+h/2, Math.min(w,h)*.3, x+w/2, y+h/2, Math.max(w,h)*.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,'+a+')'); c.fillStyle = g; c.fillRect(x, y, w, h);
  };
  switch(fx){
    case 'warm':    fill('soft-light', '#ff9a3c', .45); fill('multiply', '#fff1d6', .25); break;
    case 'cool':    fill('soft-light', '#3c8cff', .42); fill('screen', '#0a1a3a', .12); break;
    case 'bw':      fill('saturation', '#808080', 1); fill('soft-light', '#000', .18); break;
    case 'vintage': fill('saturation', '#808080', .55); fill('soft-light', '#d9a35b', .55); fill('screen', '#3a2a1a', .22); vignette(.45); break;
    case 'dreamy':  fill('screen', '#ffc8d8', .26); fill('soft-light', '#ffd1dc', .4); break;
    case 'bright':  fill('screen', '#ffffff', .17); fill('saturation', '#808080', .1); break;
    case 'moody':   fill('multiply', '#2b2c3a', .38); fill('saturation', '#808080', .28); vignette(.6); break;
    case 'butter':  fill('soft-light', '#F5E3A3', .6); fill('screen', '#FCF3D3', .12); break;
  }
  c.restore();
}
const liveCtx = c => c===ctx || c===previewCtx;

const _cover = drawCoverTo;
drawCoverTo = function(tctx, image, dx, dy, dw, dh, opts){
  const s = image && image._tl;
  if(!s || !liveCtx(tctx)) return _cover(tctx, image, dx, dy, dw, dh, opts);
  let o = opts || {};
  if(s.trans==='zoom' && s.edgeIn < .35) o = Object.assign({}, o, { zoom:(o.zoom||1) * (1 + .2*(1 - s.edgeIn/.35)) });
  _cover(tctx, image, dx, dy, dw, dh, o);
  if(s.fx) applyFx(tctx, s.fx, dx, dy, dw, dh);
  const near = Math.min(s.edgeIn, s.edgeOut), win = .3;
  if(near < win && (s.trans==='fade' || s.trans==='flash')){
    tctx.save(); tctx.globalAlpha = (1 - near/win) * (s.trans==='flash' ? .9 : 1);
    tctx.fillStyle = s.trans==='flash' ? '#fff' : '#000'; tctx.fillRect(dx, dy, dw, dh); tctx.restore();
  }
};

const _drawEl = drawElementTo;
drawElementTo = function(tctx, tW, tH, el){
  if(!hasTiming(el) || !liveCtx(tctx)) return _drawEl(tctx, tW, tH, el);
  const t = TL.t, tin = el.tIn, tout = el.tOut!=null ? el.tOut : Infinity;
  if(t < tin || t > tout){
    // keep a faint ghost of the selected element so it can still be found and moved
    if(el.id===selectedId && !TL.playing && !TL.exporting && tctx===ctx){
      const o = el.opacity; el.opacity = (o==null ? 1 : o) * .28; _drawEl(tctx, tW, tH, el); el.opacity = o;
    }
    return;
  }
  const IN = .45, OUT = .35;
  const pin = el.enter ? clamp((t - tin)/IN, 0, 1) : 1;
  const pout = (el.exit && isFinite(tout)) ? clamp((tout - t)/OUT, 0, 1) : 1;
  const ease = p => 1 - Math.pow(1 - p, 3);
  const back = p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3*Math.pow(p - 1, 3) + c1*Math.pow(p - 1, 2); };
  let a = 1, s = 1, dx = 0, dy = 0;
  if(pin < 1){
    const e = ease(pin);
    if(el.enter==='fade') a *= pin;
    else if(el.enter==='pop'){ s *= Math.max(.01, back(pin)); a *= Math.min(1, pin*3); }
    else if(el.enter==='up'){ dy += (1 - e)*tH*.07; a *= pin; }
    else if(el.enter==='left') dx -= (1 - e)*tW*.6;
    else if(el.enter==='right') dx += (1 - e)*tW*.6;
    else if(el.enter==='zoom'){ s *= 1 + (1 - e)*1.4; a *= pin; }
  }
  if(pout < 1){
    const e = ease(pout);
    if(el.exit==='fade') a *= pout;
    else if(el.exit==='pop') s *= Math.max(.01, e);
    else if(el.exit==='down'){ dy += (1 - e)*tH*.07; a *= pout; }
  }
  const o = el.opacity, txt = el.text;
  if(el.enter==='type' && el.type==='text' && txt){
    const chars = [...txt], dur = Math.min(2.2, chars.length*.06), k = dur>0 ? clamp((t - tin)/dur, 0, 1) : 1;
    if(k < 1) el.text = chars.slice(0, Math.ceil(chars.length*k)).join('');
  }
  tctx.save();
  if(s!==1 || dx || dy){
    const cx = (el.x + el.w/2)*tW, cy = (el.y + el.h/2)*tH;
    tctx.translate(cx + dx, cy + dy); tctx.scale(s, s); tctx.translate(-cx, -cy);
  }
  if(a < 1) el.opacity = (o==null ? 1 : o) * a;
  try{ _drawEl(tctx, tW, tH, el); }
  finally{ el.opacity = o; if(el.type==='text') el.text = txt; tctx.restore(); }
};

// ---------------------------------------------------------------- studio hooks
videoLoop = function(){
  tlRender();
  if(tlHolders().length && !TL.autoOpened){ TL.autoOpened = true; openPanel(true); }
  if(!TL.playing && !TL.exporting && totalDur()>0) tlPlay();
};
const _load = loadTemplate;
loadTemplate = function(key, opts){
  if(TL.playing) tlPause();
  pauseAll(); TL.t = 0; TL.sel = null;
  _load(key, opts);
  tlRender();
  if(tlHolders().length) tlPlay(true); else { draw(); updateHead(); }
};
const _restore = restoreSnapshot;
restoreSnapshot = function(snap){ _restore(snap); tlRender(); if(!TL.playing) tlSeek(TL.t); };
const _clone = cloneElementData;
cloneElementData = function(el){
  const c = _clone(el);
  if(c.clips) c.clips = c.clips.map(x => Object.assign({}, x, { id:uid('clip') }));
  return c;
};

const _props = renderProps;
renderProps = function(){
  _props();
  const h = holderOfSelection();
  if(h && ensureClips(h) && !(TL.sel && TL.sel.hk===h.key)){
    TL.sel = { kind:'clip', hk:h.key, i: clipAt(h.obj.clips, TL.t).i };
  }
  appendTimingProps();
  tlRender();
};
function holderOfSelection(){
  if(!selectedId) return null;
  return holders().find(h => h.sel===selectedId) || null;
}

function appendTimingProps(){
  const el = elements.find(x => x.id===selectedId);
  const body = $('propsBody'); if(!el || !body) return;
  const sel = (id, list, v) => `<select id="${id}" class="tlp-sel">${list.map(([k,l]) => `<option value="${k}" ${(v||'')===k?'selected':''}>${l}</option>`).join('')}</select>`;
  const box = document.createElement('div');
  box.className = 'tlp';
  if(!hasTiming(el)){
    box.innerHTML = `<label class="field">On the video timeline</label>
      <button class="btn small" id="tlp_on" style="width:100%;justify-content:center;">⏱ Show it only at a set time</button>
      <p class="tlp-note">Make it pop in at a chosen second and leave again — great for captions on a video.</p>`;
  } else {
    box.innerHTML = `<label class="field">On the video timeline</label>
      <div class="row"><div><label class="field">Appears at (s)</label><input type="number" id="tlp_in" min="0" step="0.1" value="${(+el.tIn).toFixed(1)}"></div>
        <div><label class="field">Leaves at (s)</label><input type="number" id="tlp_out" min="0" step="0.1" value="${el.tOut!=null ? (+el.tOut).toFixed(1) : ''}" placeholder="end"></div></div>
      <div class="row" style="gap:6px;"><button class="btn small" id="tlp_inph" style="flex:1;">Start here ⏵</button><button class="btn small" id="tlp_outph" style="flex:1;">End here ⏹</button></div>
      <div class="row"><div><label class="field">Entrance</label>${sel('tlp_enter', ENTER, el.enter)}</div><div><label class="field">Exit</label>${sel('tlp_exit', EXIT, el.exit)}</div></div>
      <button class="btn small" id="tlp_off" style="width:100%;justify-content:center;">Show it the whole time</button>`;
  }
  body.appendChild(box);
  const on = (id, ev, fn) => { const n = $(id); if(n) n.addEventListener(ev, fn); };
  const done = () => { draw(); tlRender(); };
  on('tlp_on', 'click', () => timeElement(el));
  on('tlp_in', 'change', e => { el.tIn = Math.max(0, parseFloat(e.target.value) || 0); if(el.tOut!=null && el.tOut <= el.tIn) el.tOut = el.tIn + .5; done(); renderProps(); });
  on('tlp_out', 'change', e => { const v = parseFloat(e.target.value); if(isNaN(v)) delete el.tOut; else el.tOut = Math.max(el.tIn + .2, v); done(); renderProps(); });
  on('tlp_inph', 'click', () => { el.tIn = +TL.t.toFixed(2); if(el.tOut!=null && el.tOut <= el.tIn) el.tOut = el.tIn + 1; done(); renderProps(); });
  on('tlp_outph', 'click', () => { el.tOut = Math.max(el.tIn + .2, +TL.t.toFixed(2)); done(); renderProps(); });
  on('tlp_enter', 'change', e => { if(e.target.value) el.enter = e.target.value; else delete el.enter; replayFrom(el.tIn); });
  on('tlp_exit', 'change', e => { if(e.target.value) el.exit = e.target.value; else delete el.exit; replayFrom(Math.max(0, (el.tOut||0) - 1)); });
  on('tlp_off', 'click', () => { delete el.tIn; delete el.tOut; delete el.enter; delete el.exit; done(); renderProps(); });
}
function timeElement(el){
  const T = totalDur();
  el.tIn = +TL.t.toFixed(2);
  el.tOut = +(Math.min(Math.max(T, TL.t + 3), TL.t + 3)).toFixed(2);
  if(!el.enter) el.enter = el.type==='text' ? 'pop' : 'fade';
  if(!TL.open) openPanel(true);
  draw(); renderProps();
  setStatus('It now shows from ' + fmt(el.tIn) + ' to ' + fmt(el.tOut) + '. Drag its bar on the timeline to move it.');
}
function replayFrom(t){ draw(); tlRender(); tlSeek(Math.max(0, t - .3)).then(() => tlPlay()); }

// ---------------------------------------------------------------- UI
function injectUI(){
  const css = document.createElement('style');
  css.textContent = `
  #tlToggle{ position:absolute; top:10px; left:10px; z-index:6; }
  #tlToggle.on{ border-color:var(--gold); color:var(--gold-dim); }
  #stage-wrap.tl-open #stageCaption{ display:none; }
  #tlPanel{ position:absolute; left:0; right:0; bottom:0; z-index:5; background:#141210; border-top:1px solid var(--panel-line);
    max-height:58%; overflow:auto; font-family:var(--mono); font-size:11px; color:#cfc8b2; box-shadow:0 -12px 30px rgba(0,0,0,.35); }
  #tlPanel[hidden]{ display:none; }
  .tl-top{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid var(--panel-line); position:sticky; top:0; background:#141210; z-index:3; }
  .tl-top .btn{ padding:6px 9px; font-size:11px; }
  .tl-top select{ background:#0e0d0a; color:#fff; border:1px solid var(--panel-line); border-radius:5px; padding:6px; font-family:var(--mono); font-size:11px; }
  #tlPlayBtn{ min-width:38px; justify-content:center; background:var(--gold); color:var(--ink); border-color:var(--gold); font-weight:700; }
  #tlTime{ color:var(--gold-dim); min-width:110px; }
  .tl-sp{ flex:1; }
  #tlTracks{ position:relative; padding:4px 10px 8px; user-select:none; -webkit-user-select:none; touch-action:none; }
  .tl-row{ display:flex; align-items:stretch; height:30px; margin-top:4px; }
  .tl-row.ruler{ height:18px; margin-top:0; }
  .tl-lab{ width:92px; flex:none; padding-right:8px; display:flex; align-items:center; color:#8b856f; font-size:10px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .tl-lane{ position:relative; flex:1; background:#1c1a14; border:1px solid #29261c; border-radius:6px; overflow:hidden; cursor:pointer; }
  .tl-row.ruler .tl-lane{ background:none; border:none; overflow:visible; }
  .tl-tick{ position:absolute; top:2px; bottom:0; border-left:1px solid #3d3828; padding-left:3px; font-size:9px; color:#6f6852; }
  .tl-clip, .tl-el, .tl-music{ position:absolute; top:2px; bottom:2px; border-radius:5px; overflow:hidden; display:flex; align-items:center; padding:0 10px;
    font-size:10px; white-space:nowrap; cursor:grab; box-sizing:border-box; border:1.5px solid transparent; }
  .tl-clip{ background:#3a3424; color:var(--gold-dim); }
  .tl-clip:nth-child(even){ background:#463e29; }
  .tl-clip.photo{ background:#2f3a33; color:#d6e6d0; }
  .tl-el{ background:#5c2035; color:#FFD1DC; }
  .tl-music{ background:#2c2a46; color:#d8d4ff; left:0; right:0; }
  .tl-clip.sel, .tl-el.sel, .tl-music.sel, .tl-sfx.sel{ border-color:var(--gold); }
  .tl-h{ position:absolute; top:0; bottom:0; width:9px; cursor:ew-resize; background:rgba(245,227,163,.25); }
  .tl-h.l{ left:0; } .tl-h.r{ right:0; }
  .tl-sfx{ position:absolute; top:3px; width:22px; height:22px; margin-left:-11px; border-radius:50%; background:#F5E3A3; color:#16140f;
    display:grid; place-items:center; font-size:12px; cursor:grab; border:1.5px solid transparent; z-index:2; }
  #tlHead{ position:absolute; top:0; bottom:0; width:2px; background:#ff4d6d; pointer-events:none; z-index:4; margin-left:-1px; }
  #tlHead::before{ content:''; position:absolute; top:0; left:-5px; border:6px solid transparent; border-top-color:#ff4d6d; }
  #tlInsp{ padding:8px 10px 12px; border-top:1px solid var(--panel-line); display:flex; flex-wrap:wrap; gap:10px 14px; align-items:flex-end; }
  #tlInsp .f{ display:flex; flex-direction:column; gap:4px; min-width:120px; flex:1 1 140px; }
  #tlInsp .f label{ font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:#8b856f; }
  #tlInsp select, #tlInsp input[type=number]{ background:#0e0d0a; color:#fff; border:1px solid var(--panel-line); border-radius:5px; padding:6px; font-family:var(--mono); font-size:11px; }
  #tlInsp .btn{ padding:6px 9px; font-size:11px; }
  #tlInsp .ttl{ flex-basis:100%; color:var(--gold-dim); font-size:11px; }
  #tlInsp .hint{ color:#8b856f; flex-basis:100%; line-height:1.5; }
  .tl-empty{ color:#6f6852; font-size:10px; display:flex; align-items:center; padding-left:8px; height:100%; }
  .tlp{ margin-top:12px; padding-top:10px; border-top:1px dashed var(--panel-line); }
  .tlp-note{ margin:6px 0 0; font-size:11.5px; color:#8b856f; }
  .tlp-sel{ width:100%; background:#0e0d0a; color:#fff; border:1px solid var(--panel-line); border-radius:5px; padding:7px; }
  .tlp input[type=number]{ width:100%; }
  @media (max-width:860px){
    .tl-lab{ width:64px; font-size:9px; }
    #tlPanel{ max-height:52%; }
    .tl-top .btn, .tl-top select{ padding:8px 9px; }
    #tlToggle{ top:8px; left:8px; }
  }`;
  document.head.appendChild(css);

  const wrap = $('stage-wrap');
  const tog = document.createElement('button');
  tog.className = 'btn small'; tog.id = 'tlToggle'; tog.type = 'button'; tog.textContent = '🎬 Video editor';
  wrap.appendChild(tog);

  const p = document.createElement('div');
  p.id = 'tlPanel'; p.hidden = true;
  p.innerHTML = `
    <div class="tl-top">
      <button class="btn small" id="tlPlayBtn" title="Play / pause (space)">▶</button>
      <span id="tlTime">0:00.0 / 0:00.0</span>
      <span class="tl-sp"></span>
      <button class="btn small" id="tlAddClip" title="Add videos or photos after the selected clip">+ Clips</button>
      <button class="btn small" id="tlSplit" title="Cut the clip in two at the red line">✂ Split</button>
      <button class="btn small" id="tlMusic" title="Add a song or sound from your phone / computer">♪ Music</button>
      <select id="tlSfx" title="Add a sound effect at the red line"><option value="">+ Sound effect</option>${SFX.map(([k,l]) => `<option value="${k}">${SFX_ICON[k]} ${l}</option>`).join('')}</select>
      <button class="btn small" id="tlTimeEl" title="Make the selected text / sticker show only from the red line">⏱ Time it</button>
      <button class="btn small" id="tlClose" title="Hide the video editor">✕</button>
    </div>
    <div id="tlTracks"></div>
    <div id="tlInsp"></div>
    <input type="file" id="tlClipInput" accept="image/*,video/*" multiple hidden>
    <input type="file" id="tlMusicInput" accept="audio/*,video/*" hidden>`;
  wrap.appendChild(p);

  tog.onclick = () => openPanel(!TL.open);
  $('tlClose').onclick = () => openPanel(false);
  $('tlPlayBtn').onclick = () => { unlockAudio(); TL.playing ? tlPause() : tlPlay(); };
  $('tlAddClip').onclick = () => { unlockAudio(); $('tlClipInput').click(); };
  $('tlClipInput').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if(fs.length) addClipFiles(fs); });
  $('tlMusic').onclick = () => { unlockAudio(); $('tlMusicInput').click(); };
  $('tlMusicInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if(f) addMusic(f); });
  $('tlSfx').onchange = e => { const k = e.target.value; e.target.value = ''; if(k) addSfx(k); };
  $('tlSplit').onclick = splitAtHead;
  $('tlTimeEl').onclick = () => {
    const el = elements.find(x => x.id===selectedId);
    if(!el){ setStatus('Select a text, sticker or photo on the canvas first, then press ⏱ Time it.'); return; }
    timeElement(el);
  };
  bindTrackPointer();
  let padQueued = false;
  if(window.ResizeObserver) new ResizeObserver(() => {
    if(padQueued) return; padQueued = true;
    requestAnimationFrame(() => { padQueued = false; fitPadding(); });
  }).observe(p);

  window.addEventListener('keydown', e => {
    if(!TL.open || e.key!==' ') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if(tag==='TEXTAREA' || tag==='INPUT' || tag==='SELECT' || tag==='BUTTON') return;
    if(document.getElementById('app').classList.contains('planner-mode')) return;
    e.preventDefault(); unlockAudio(); TL.playing ? tlPause() : tlPlay();
  });
}

function fitPadding(){
  const wrap = $('stage-wrap'), p = $('tlPanel');
  const want = (TL.open && !p.hidden) ? (p.offsetHeight + 14) + 'px' : '';
  if(wrap.style.paddingBottom !== want){ wrap.style.paddingBottom = want; fitStage(); }
}
function openPanel(on){
  TL.open = !!on;
  $('tlPanel').hidden = !TL.open;
  $('tlToggle').classList.toggle('on', TL.open);
  $('tlToggle').textContent = TL.open ? '🎬 Hide editor' : '🎬 Video editor';
  $('stage-wrap').classList.toggle('tl-open', TL.open);
  tlRender(); fitPadding();
}

function laneGeom(){
  const lane = document.querySelector('#tlTracks .tl-row.ruler .tl-lane');
  const r = lane ? lane.getBoundingClientRect() : { left:0, width:1 };
  return { left:r.left, width:Math.max(1, r.width), T: Math.max(totalDur(), 1) };
}
function updateHead(){
  if(!TL.open) return;
  const T = Math.max(totalDur(), 1), head = $('tlHead'), tracks = $('tlTracks');
  const lane = document.querySelector('#tlTracks .tl-row.ruler .tl-lane');
  if(head && lane){
    const tr = tracks.getBoundingClientRect(), lr = lane.getBoundingClientRect();
    head.style.left = (lr.left - tr.left + clamp(TL.t/T, 0, 1)*lr.width) + 'px';
  }
  const tt = $('tlTime'); if(tt) tt.textContent = fmt(TL.t) + ' / ' + fmt(totalDur());
  const pb = $('tlPlayBtn'); if(pb) pb.textContent = TL.playing ? '❚❚' : '▶';
}

function tlRender(){
  if(!TL.open || !$('tlTracks')) return;
  const T = Math.max(totalDur(), 1), pct = s => (s/T*100) + '%';
  let html = '';
  // ruler
  const step = T > 30 ? 5 : T > 12 ? 2 : 1;
  let ticks = '';
  for(let s=0; s<=T+1e-6; s+=step) ticks += `<div class="tl-tick" style="left:${pct(s)}">${s}s</div>`;
  html += `<div class="tl-row ruler"><div class="tl-lab"></div><div class="tl-lane" data-lane="ruler">${ticks}</div></div>`;
  // video holders
  const hs = tlHolders();
  hs.forEach(h => {
    let off = 0, blocks = '';
    h.obj.clips.forEach((c,i) => {
      const len = clipLen(c), isSel = TL.sel && TL.sel.kind==='clip' && TL.sel.hk===h.key && TL.sel.i===i;
      const tag = (c.kind==='photo' ? '🖼 ' : '') + (i+1) + ' · ' + len.toFixed(1) + 's' + (c.speed!==1 ? ' · ' + c.speed + '×' : '') + (c.fx ? ' · ✦' : '') + (c.kind==='video' && !c.sound ? ' · 🔇' : '');
      blocks += `<div class="tl-clip ${c.kind==='photo'?'photo':''} ${isSel?'sel':''}" data-hk="${h.key}" data-i="${i}" style="left:${pct(off)};width:${pct(len)}"><i class="tl-h l"></i><span>${tag}</span><i class="tl-h r"></i></div>`;
      off += len;
    });
    html += `<div class="tl-row"><div class="tl-lab" title="${esc(h.label)}">🎞 ${esc(h.label)}</div><div class="tl-lane" data-lane="v">${blocks}</div></div>`;
  });
  if(!hs.length){
    html += `<div class="tl-row"><div class="tl-lab">🎞 Video</div><div class="tl-lane" data-lane="v"><div class="tl-empty">Press “+ Clips” to add videos or photos in a row</div></div></div>`;
  }
  // timed elements, one row each
  elements.filter(hasTiming).sort((a,b) => a.tIn - b.tIn).forEach(e => {
    const end = e.tOut!=null ? e.tOut : T, isSel = (TL.sel && TL.sel.kind==='el' && TL.sel.id===e.id) || selectedId===e.id;
    const name = e.type==='text' ? (e.text||'text') : e.type==='emoji' ? (e.emoji||'icon') : (e.label || e.type);
    html += `<div class="tl-row"><div class="tl-lab" title="${esc(name)}">T ${esc(String(name).slice(0,14))}</div><div class="tl-lane" data-lane="e">
      <div class="tl-el ${isSel?'sel':''}" data-el="${e.id}" style="left:${pct(e.tIn)};width:${pct(Math.max(.15, end - e.tIn))}"><i class="tl-h l"></i><span>${esc(String(name).slice(0,24))}</span><i class="tl-h r"></i></div></div></div>`;
  });
  // audio
  const au = A();
  let aud = '';
  if(au.music) aud += `<div class="tl-music ${TL.sel && TL.sel.kind==='music'?'sel':''}" data-music="1"><span>♪ ${esc(au.music.name)}</span></div>`;
  au.sfx.forEach(s => { aud += `<div class="tl-sfx ${TL.sel && TL.sel.kind==='sfx' && TL.sel.id===s.id?'sel':''}" data-sfx="${s.id}" style="left:${pct(s.t)}" title="${esc(s.kind)} at ${fmt(s.t)}">${SFX_ICON[s.kind]||'♪'}</div>`; });
  if(!aud) aud = `<div class="tl-empty">Music and sound effects show here</div>`;
  html += `<div class="tl-row"><div class="tl-lab">♪ Sound</div><div class="tl-lane" data-lane="a">${aud}</div></div>`;
  html += `<div id="tlHead"></div>`;
  $('tlTracks').innerHTML = html;
  renderInspector();
  updateHead();
}

function renderInspector(){
  const box = $('tlInsp'); if(!box) return;
  const s = TL.sel;
  const opts = (list, v) => list.map(([k,l]) => `<option value="${k}" ${String(v)===String(k)?'selected':''}>${l}</option>`).join('');
  if(s && s.kind==='clip'){
    const h = findHolder(s.hk); const clips = h && ensureClips(h); const c = clips && clips[s.i];
    if(!c){ TL.sel = null; return renderInspector(); }
    const max = srcDur(c);
    box.innerHTML = `<div class="ttl">🎞 ${esc(h.label)} · clip ${s.i+1} of ${clips.length} · ${c.kind==='photo'?'photo':'video'} · shows for ${clipLen(c).toFixed(1)}s</div>
      ${c.kind==='video' ? `
      <div class="f"><label>Start at ${c.in.toFixed(1)}s</label><input type="range" id="ti_in" min="0" max="${max.toFixed(2)}" step="0.05" value="${c.in}"></div>
      <div class="f"><label>End at ${c.out.toFixed(1)}s</label><input type="range" id="ti_out" min="0" max="${max.toFixed(2)}" step="0.05" value="${c.out}"></div>
      <div class="f"><label>Speed</label><select id="ti_speed">${opts(SPEEDS.map(v => [v, v===1 ? 'Normal (1×)' : v<1 ? v+'× slow-mo' : v+'× fast']), c.speed)}</select></div>
      <div class="f"><label>Video sound</label><select id="ti_sound">${opts([['1','🔊 On'],['0','🔇 Off']], c.sound?'1':'0')}</select></div>` : `
      <div class="f"><label>Show photo for ${(c.out - c.in).toFixed(1)}s</label><input type="range" id="ti_out" min="0.5" max="15" step="0.1" value="${c.out - c.in}"></div>`}
      <div class="f"><label>Filter</label><select id="ti_fx">${opts(FX, c.fx)}</select></div>
      <div class="f"><label>Between clips</label><select id="ti_trans">${opts(TRANS, h.obj.trans||'cut')}</select></div>
      <div class="f" style="flex-direction:row;flex-wrap:wrap;gap:6px;min-width:0;flex-basis:100%;">
        <button class="btn small" id="ti_left" ${s.i===0?'disabled':''}>◀ Move</button>
        <button class="btn small" id="ti_right" ${s.i===clips.length-1?'disabled':''}>Move ▶</button>
        <button class="btn small" id="ti_dup">⧉ Duplicate</button>
        <button class="btn small" id="ti_del" style="border-color:#5a3a2f;color:#e08a70;">🗑 Delete clip</button>
      </div>`;
    const sync = () => { draw(); tlRender(); };
    const on = (id, ev, fn) => { const n = $(id); if(n) n.addEventListener(ev, fn); };
    const startOf = i => clips.slice(0, i).reduce((a,x) => a + clipLen(x), 0);
    on('ti_in', 'input', e => { c.in = clamp(parseFloat(e.target.value), 0, c.out - .2); scrubTo(startOf(s.i)); updateLabels(); });
    on('ti_out', 'input', e => {
      if(c.kind==='video') c.out = clamp(parseFloat(e.target.value), c.in + .2, max);
      else c.out = c.in + parseFloat(e.target.value);
      scrubTo(startOf(s.i) + Math.max(0, clipLen(c) - .05)); updateLabels();
    });
    on('ti_in', 'change', sync); on('ti_out', 'change', sync);
    on('ti_speed', 'change', e => { c.speed = parseFloat(e.target.value); sync(); });
    on('ti_sound', 'change', e => { c.sound = e.target.value==='1'; unlockAudio(); sync(); });
    on('ti_fx', 'change', e => { c.fx = e.target.value; applyTime(TL.t, TL.playing ? 'play' : 'seek').then(sync); });
    on('ti_trans', 'change', e => { h.obj.trans = e.target.value; sync(); if(clips.length>1){ tlSeek(Math.max(0, startOf(Math.max(1, s.i)) - .8)).then(() => tlPlay()); } });
    on('ti_left', 'click', () => { [clips[s.i-1], clips[s.i]] = [clips[s.i], clips[s.i-1]]; s.i--; sync(); });
    on('ti_right', 'click', () => { [clips[s.i+1], clips[s.i]] = [clips[s.i], clips[s.i+1]]; s.i++; sync(); });
    on('ti_dup', 'click', () => { clips.splice(s.i+1, 0, Object.assign({}, c, { id:uid('clip') })); s.i++; sync(); });
    on('ti_del', 'click', () => deleteClip(h, s.i));
    function updateLabels(){
      const ls = box.querySelectorAll('.f label');
      if(c.kind==='video'){ ls[0].textContent = 'Start at ' + c.in.toFixed(1) + 's'; ls[1].textContent = 'End at ' + c.out.toFixed(1) + 's'; }
      else ls[0].textContent = 'Show photo for ' + (c.out - c.in).toFixed(1) + 's';
      box.querySelector('.ttl').textContent = '🎞 ' + h.label + ' · clip ' + (s.i+1) + ' of ' + clips.length + ' · ' + c.kind + ' · shows for ' + clipLen(c).toFixed(1) + 's';
      updateHead();
    }
    return;
  }
  if(s && s.kind==='sfx'){
    const fx = A().sfx.find(x => x.id===s.id);
    if(!fx){ TL.sel = null; return renderInspector(); }
    box.innerHTML = `<div class="ttl">${SFX_ICON[fx.kind]} Sound effect at ${fmt(fx.t)} — drag the dot to move it</div>
      <div class="f"><label>Sound</label><select id="ti_sfx">${opts(SFX, fx.kind)}</select></div>
      <div class="f"><label>Plays at (s)</label><input type="number" id="ti_sfxt" min="0" step="0.1" value="${fx.t.toFixed(1)}"></div>
      <div class="f" style="flex-direction:row;gap:6px;min-width:0;"><button class="btn small" id="ti_hear">▶ Hear it</button>
      <button class="btn small" id="ti_sfxdel" style="border-color:#5a3a2f;color:#e08a70;">🗑 Remove</button></div>`;
    $('ti_sfx').onchange = e => { fx.kind = e.target.value; unlockAudio(); playSfx(fx.kind); tlRender(); };
    $('ti_sfxt').onchange = e => { fx.t = Math.max(0, parseFloat(e.target.value) || 0); tlRender(); };
    $('ti_hear').onclick = () => { unlockAudio(); playSfx(fx.kind); };
    $('ti_sfxdel').onclick = () => { A().sfx = A().sfx.filter(x => x!==fx); TL.sel = null; tlRender(); };
    return;
  }
  if(s && s.kind==='music' && A().music){
    const mu = A().music, dur = mu.buf ? mu.buf.duration : 60;
    box.innerHTML = `<div class="ttl">♪ ${esc(mu.name)} — plays under the whole video and fades out at the end</div>
      <div class="f"><label>Volume</label><input type="range" id="ti_vol" min="0" max="1" step="0.05" value="${mu.vol!=null?mu.vol:.8}"></div>
      <div class="f"><label>Start the song at ${fmt(mu.offset||0)}</label><input type="range" id="ti_off" min="0" max="${Math.max(0, dur - 1).toFixed(1)}" step="0.5" value="${mu.offset||0}"></div>
      <div class="f" style="flex-direction:row;gap:6px;min-width:0;"><button class="btn small" id="ti_mrep">Replace</button>
      <button class="btn small" id="ti_mdel" style="border-color:#5a3a2f;color:#e08a70;">🗑 Remove music</button></div>`;
    $('ti_vol').oninput = e => { mu.vol = parseFloat(e.target.value); musicSync(TL.t, TL.playing ? 'play' : 'seek'); };
    $('ti_off').oninput = e => { mu.offset = parseFloat(e.target.value); box.querySelectorAll('.f label')[1].textContent = 'Start the song at ' + fmt(mu.offset); musicSync(TL.t, TL.playing ? 'play' : 'seek'); };
    $('ti_mrep').onclick = () => $('tlMusicInput').click();
    $('ti_mdel').onclick = () => { stopVoice('music'); A().music = null; TL.sel = null; tlRender(); };
    return;
  }
  box.innerHTML = `<div class="hint">Tap a clip to trim it, change its speed, add a filter or a transition · “+ Clips” adds more videos or photos in a row · drag the pink bars to change when text shows · press ▶ to watch it. MP4 saves everything with sound.</div>`;
}

// pointer: scrub, trim, move bars and sound dots
function bindTrackPointer(){
  const tracks = $('tlTracks');
  tracks.addEventListener('pointerdown', e => {
    const g = laneGeom(); if(!g.width) return;
    const tAt = x => clamp((x - g.left)/g.width*g.T, 0, g.T);
    const handle = e.target.closest('.tl-h');
    const clipEl = e.target.closest('.tl-clip'), barEl = e.target.closest('.tl-el'), sfxEl = e.target.closest('.tl-sfx'), musEl = e.target.closest('.tl-music');
    const startX = e.clientX; let moved = false;
    let d = null;
    if(clipEl){
      const h = findHolder(clipEl.dataset.hk), i = +clipEl.dataset.i, c = h && h.obj.clips && h.obj.clips[i];
      if(!c) return;
      TL.sel = { kind:'clip', hk:h.key, i };
      if(selectedId!==h.sel){ selectedId = h.sel; draw(); _props(); appendTimingProps(); }
      if(handle) d = { type: handle.classList.contains('l') ? 'trimL' : 'trimR', c, orig:{ in:c.in, out:c.out }, h, i };
      else d = { type:'pickClip', h, i };
    } else if(barEl){
      const el = elements.find(x => x.id===barEl.dataset.el); if(!el) return;
      TL.sel = { kind:'el', id:el.id };
      if(selectedId!==el.id){ selectedId = el.id; draw(); _props(); appendTimingProps(); }
      d = { type: handle ? (handle.classList.contains('l') ? 'elL' : 'elR') : 'elMove', el, orig:{ tIn:el.tIn, tOut: el.tOut!=null ? el.tOut : g.T } };
    } else if(sfxEl){
      const fx = A().sfx.find(x => x.id===sfxEl.dataset.sfx); if(!fx) return;
      TL.sel = { kind:'sfx', id:fx.id }; d = { type:'sfx', fx, orig:fx.t };
    } else if(musEl){
      TL.sel = { kind:'music' }; d = { type:'music' };
    } else {
      d = { type:'scrub' }; scrubTo(tAt(e.clientX));
    }
    TL.drag = d;
    tracks.setPointerCapture && tracks.setPointerCapture(e.pointerId);
    const move = ev => {
      const dt = (ev.clientX - startX)/g.width*g.T;
      if(Math.abs(ev.clientX - startX) > 3) moved = true;
      if(!moved && d.type!=='scrub') return;
      if(d.type==='scrub') scrubTo(tAt(ev.clientX));
      else if(d.type==='trimL'){ const c = d.c; c.in = clamp(d.orig.in + dt*c.speed, 0, c.out - .2); if(c.kind==='photo'){ c.out = d.orig.out; } quickRender(); }
      else if(d.type==='trimR'){ const c = d.c; c.out = clamp(d.orig.out + dt*c.speed, c.in + .2, srcDur(c)); quickRender(); }
      else if(d.type==='elMove'){ const len = d.orig.tOut - d.orig.tIn; d.el.tIn = +clamp(d.orig.tIn + dt, 0, 600).toFixed(2); d.el.tOut = +(d.el.tIn + len).toFixed(2); quickRender(); }
      else if(d.type==='elL'){ d.el.tIn = +clamp(d.orig.tIn + dt, 0, d.orig.tOut - .2).toFixed(2); quickRender(); }
      else if(d.type==='elR'){ d.el.tOut = +Math.max(d.el.tIn + .2, d.orig.tOut + dt).toFixed(2); quickRender(); }
      else if(d.type==='sfx'){ d.fx.t = +clamp(d.orig + dt, 0, 600).toFixed(2); quickRender(); }
    };
    const up = () => {
      tracks.removeEventListener('pointermove', move); tracks.removeEventListener('pointerup', up); tracks.removeEventListener('pointercancel', up);
      TL.drag = null;
      if(!moved && (d.type==='pickClip' || d.type==='elMove' || d.type==='sfx' || d.type==='music')){
        // a tap: jump the red line there
        if(d.type==='pickClip'){ const off = d.h.obj.clips.slice(0, d.i).reduce((a,x) => a + clipLen(x), 0); tlSeek(TL.t>=off && TL.t<off+clipLen(d.h.obj.clips[d.i]) ? TL.t : off); }
        else if(d.type==='elMove') tlSeek(d.el.tIn);
        else if(d.type==='sfx'){ unlockAudio(); playSfx(d.fx.kind); }
      }
      if(d.type==='trimL' || d.type==='trimR'){
        const off = d.h.obj.clips.slice(0, d.i).reduce((a,x) => a + clipLen(x), 0);
        tlSeek(d.type==='trimL' ? off : off + Math.max(0, clipLen(d.c) - .05));
      }
      draw(); tlRender();
      if(d.type==='elMove' || d.type==='elL' || d.type==='elR'){ _props(); appendTimingProps(); }
    };
    tracks.addEventListener('pointermove', move); tracks.addEventListener('pointerup', up); tracks.addEventListener('pointercancel', up);
  });
}
let quickQueued = false;
function quickRender(){
  if(quickQueued) return; quickQueued = true;
  requestAnimationFrame(() => { quickQueued = false; tlRender(); if(!TL.playing) draw(); });
}

// ---------------------------------------------------------------- actions
function targetHolder(){
  if(TL.sel && TL.sel.hk){ const h = findHolder(TL.sel.hk); if(h) return h; }
  const hs = holderOfSelection(); if(hs) return hs;
  const withClips = tlHolders()[0]; if(withClips) return withClips;
  return findHolder('c0');
}
function loadImage(url){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
function loadVideo(url){ return new Promise(res => loadVideoEl(url, v => { v.pause(); res(v); })); }
async function addClipFiles(files){
  const h = targetHolder(); if(!h){ setStatus('Pick a background or a photo/video slot first.'); return; }
  if(TL.playing) tlPause();
  setStatus('Adding ' + files.length + (files.length>1 ? ' clips…' : ' clip…'));
  let clips = ensureClips(h);
  const cur = getM(h);
  if(!clips){ clips = []; if(cur && !isVid(cur)) clips.push(newClip(cur, h.kind==='fill' ? h.obj.fillSrc : h.obj.src)); }
  let at = (TL.sel && TL.sel.kind==='clip' && TL.sel.hk===h.key) ? TL.sel.i + 1 : clips.length;
  for(const f of files){
    const url = URL.createObjectURL(f);
    try{
      const m = isVideoFile(f) ? await loadVideo(url) : await loadImage(url);
      if(isVid(m)) await scanDuration(m);
      clips.splice(at++, 0, newClip(m, url));
    }catch(err){ console.error(err); setStatus('One file couldn’t be opened — try an MP4 or a JPG/PNG.'); }
  }
  if(!clips.length) return;
  h.obj.clips = clips;
  if(h.kind==='fill') h.obj.fillType = 'image';
  if(!getM(h) || !clips.some(c => c.el===getM(h))) setM(h, clips[0].el);
  TL.sel = { kind:'clip', hk:h.key, i: at - 1 };
  if(!TL.open) openPanel(true);
  const off = clips.slice(0, at - files.length < 0 ? 0 : at - files.length).reduce((a,x) => a + clipLen(x), 0);
  refreshAllThumbnails(); renderLayerList();
  tlRender(); await tlSeek(off); tlPlay();
  setStatus(files.length>1 ? files.length + ' clips added in a row.' : 'Clip added.');
}
function deleteClip(h, i){
  const clips = h.obj.clips; if(!clips) return;
  const gone = clips.splice(i, 1)[0];
  if(gone && gone.el && !clips.some(c => c.el===gone.el)){ if(isVid(gone.el)) gone.el.pause(); delete gone.el._tl; }
  if(!clips.length){ delete h.obj.clips; setM(h, null); if(h.kind==='fill') h.obj.fillEl = null; TL.sel = null; }
  else { if(!clips.some(c => c.el===getM(h))) setM(h, clips[0].el); TL.sel = { kind:'clip', hk:h.key, i: Math.min(i, clips.length - 1) }; }
  TL.t = Math.min(TL.t, totalDur());
  draw(); tlRender(); tlSeek(TL.t); renderProps();
}
function splitAtHead(){
  const h = targetHolder(); const clips = h && ensureClips(h);
  if(!clips){ setStatus('Add a video first, then move the red line to where you want to cut.'); return; }
  const a = clipAt(clips, TL.t), c = a.c;
  if(a.into < .15 || clipLen(c) - a.into < .15){ setStatus('Move the red line into the middle of a clip to split it.'); return; }
  const cut = c.in + a.into*c.speed;
  const b = Object.assign({}, c, { id:uid('clip'), in:cut });
  if(c.kind==='photo'){ b.in = 0; b.out = (c.out - c.in) - a.into; c.out = c.in + a.into; }
  else c.out = cut;
  clips.splice(a.i + 1, 0, b);
  TL.sel = { kind:'clip', hk:h.key, i:a.i + 1 };
  draw(); tlRender();
  setStatus('Split into two clips — you can now trim, speed up, filter or delete each part.');
}
function addSfx(kind){
  unlockAudio();
  const fx = { id:uid('sfx'), kind, t: +TL.t.toFixed(2) };
  A().sfx.push(fx);
  TL.sel = { kind:'sfx', id:fx.id };
  playSfx(kind);
  if(!TL.open) openPanel(true);
  tlRender();
  setStatus(SFX.find(s => s[0]===kind)[1] + ' added at ' + fmt(fx.t) + '. Drag the dot to move it.');
}
async function addMusic(file){
  if(!audio()){ setStatus('This browser can’t play sound here.'); return; }
  unlockAudio();
  setStatus('Loading music…');
  const tpl = currentTplKey;
  let buf = null;
  try{
    const ab = await file.arrayBuffer();
    buf = await new Promise(res => { try{ AC.decodeAudioData(ab, res, () => res(null)); }catch(e){ res(null); } });
  }catch(e){ buf = null; }
  if(!buf){ setStatus('That sound file couldn’t be opened — try an MP3 or M4A.'); return; }
  if(tpl!==currentTplKey) return;
  stopVoice('music');
  const name = (file.name || 'music').replace(/\.[a-z0-9]+$/i, '');
  A().music = { buf, name, vol:.8, offset:0 };
  TL.sel = { kind:'music' };
  if(!TL.open) openPanel(true);
  tlRender(); await tlSeek(0); tlPlay();
  setStatus('Music added — it plays under the whole video and fades out at the end.');
}

// ---------------------------------------------------------------- export
function pickMime(withAudio){
  const list = withAudio
    ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  for(const m of list){ try{ if(MediaRecorder.isTypeSupported(m)) return m; }catch(e){} }
  return '';
}
function needsAudio(){
  const au = A();
  return !!(au.music || au.sfx.length || tlHolders().some(h => h.obj.clips.some(c => c.kind==='video' && c.sound)));
}

const _rec = recordCanvasVideo;
recordCanvasVideo = async function(){
  if(!tlActive()) return _rec();
  selectedId = null;
  unlockAudio();
  if(TL.playing) tlPause();
  const withAudio = needsAudio() && !!recDest;
  TL.exporting = true;
  let blob, mime, ext;
  try{
    if(withAudio){ setStatus('Getting the sound ready…'); await preloadSounds(); setStatus('Recording…'); }
    await tlSeek(0);
    if(AC && AC.state==='suspended') await AC.resume().catch(()=>{});
    const stream = canvas.captureStream(30);
    if(withAudio) recDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
    mime = pickMime(withAudio);
    ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const chunks = [];
    const recorder = new MediaRecorder(stream, mime ? { mimeType:mime, videoBitsPerSecond:8000000 } : { videoBitsPerSecond:8000000 });
    recorder.ondataavailable = e => { if(e.data.size > 0) chunks.push(e.data); };
    const done = new Promise(res => recorder.onstop = res);
    if(spk) spk.gain.value = 0;                      // record the sound without playing it out loud
    recorder.start(250);
    await new Promise(res => { TL.onEnd = res; tlPlay(true); });
    await new Promise(r => setTimeout(r, 120));      // let the last frame land
    recorder.stop();
    await done;
    blob = new Blob(chunks, { type:(mime || 'video/webm').split(';')[0] });
  } finally {
    TL.exporting = false; if(spk) spk.gain.value = 1; motionT = null;
  }
  draw();
  tlSeek(0).then(() => tlPlay());
  return { blob, mime:(mime || 'video/webm').split(';')[0], ext };
};

const gifBtn = $('expGif'), _gif = gifBtn.onclick;
gifBtn.onclick = function(ev){
  if(!tlActive()) return _gif.call(this, ev);
  runExportAd(async () => {
    selectedId = null; if(TL.playing) tlPause();
    setExportingUI(true); setStatus('Preparing GIF encoder…'); setProgress(1);
    TL.exporting = true;
    try{
      const workerBlob = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js').then(r => r.blob());
      const gif = new GIF({ workers:3, quality:8, workerScript:URL.createObjectURL(workerBlob), width:W, height:H, repeat:0 });
      const fps = 12, dur = Math.min(GIF_MAX_SECONDS, totalDur()), n = Math.max(1, Math.round(dur*fps));
      for(let i=0;i<n;i++){
        const t = i/fps;
        TL.t = t; motionT = t;
        await applyTime(t, 'seek');
        draw();
        gif.addFrame(ctx, { copy:true, delay:1000/fps });
        setProgress(5 + (i/n)*45);
      }
      motionT = null; TL.exporting = false;
      gif.on('progress', p => setProgress(50 + p*50));
      gif.on('finished', blob => {
        download(URL.createObjectURL(blob), 'inspocult.gif');
        setStatus(totalDur() > GIF_MAX_SECONDS ? 'GIF saved (first ' + GIF_MAX_SECONDS + 's — GIFs have no sound; use MP4 for the full video).' : 'GIF saved (GIFs have no sound — use MP4 for sound).');
        setProgress(0); setExportingUI(false);
        tlSeek(0).then(() => tlPlay());
      });
      gif.render();
    }catch(err){
      console.error(err); motionT = null; TL.exporting = false;
      setStatus('GIF export failed — see console.'); setProgress(0); setExportingUI(false);
    }
  });
};

// ---------------------------------------------------------------- start
injectUI();
tlRender();
window.inspoTimeline = { TL, totalDur, tlPlay, tlPause, tlSeek, addClipFiles, addSfx, playSfx, openPanel, tlHolders };
})();
