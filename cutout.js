// =========================================================================
// inspocult — Cutout maker
// Removes the background from a photo (U²-Net "u2netp" model, Apache-2.0, run on the
// person's own computer with onnxruntime-web; nothing is uploaded), lets them fix the
// edges with an erase / restore brush, and hands back a transparent PNG to save as a sticker.
//
//   window.openCutout({ file?, image?, onSave(blob, w, h) })
// =========================================================================
(function(){
  const ORT_VER = '1.20.1';
  const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
  const MODEL_URL = 'u2netp.onnx';
  const SIZE = 320;            // model input size
  const WORK_MAX = 1200;       // longest side we edit at
  const OUT_MAX = 900;         // longest side of the saved sticker

  // ---------- styles + markup ----------
  const css = `
  .co-scrim{ position:fixed; inset:0; background:rgba(10,9,6,.78); display:none; align-items:center; justify-content:center; z-index:1200; font-family:Inter, system-ui, sans-serif; }
  .co-scrim.open{ display:flex; }
  .co-scrim [hidden]{ display:none !important; }
  .co-modal{ width:min(860px, calc(100vw - 32px)); max-height:calc(100vh - 32px); overflow:auto; background:#1d1a14; color:#f6f1e3; border:1px solid #3a3424; border-radius:16px; padding:20px 22px; display:flex; flex-direction:column; gap:14px; box-shadow:0 30px 80px rgba(0,0,0,.5); }
  .co-head{ display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
  .co-head h3{ margin:0; font-family:Fraunces, Georgia, serif; font-weight:500; font-size:22px; }
  .co-head small{ font-family:'IBM Plex Mono', monospace; font-size:10.5px; letter-spacing:.08em; color:#8b856f; text-transform:uppercase; }
  .co-stage{ position:relative; display:flex; align-items:center; justify-content:center; min-height:300px; border-radius:12px; border:1px solid #3a3424; overflow:hidden;
    background-color:#e9e4d6; background-image:linear-gradient(45deg,#cfc8b4 25%,transparent 25%),linear-gradient(-45deg,#cfc8b4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#cfc8b4 75%),linear-gradient(-45deg,transparent 75%,#cfc8b4 75%);
    background-size:22px 22px; background-position:0 0,0 11px,11px -11px,-11px 0; }
  .co-stage canvas{ display:block; max-width:100%; touch-action:none; cursor:none; }
  .co-drop{ display:flex; flex-direction:column; align-items:center; gap:10px; padding:60px 20px; text-align:center; color:#5b5543; }
  .co-drop b{ font-family:Fraunces, Georgia, serif; font-weight:500; font-size:20px; color:#292217; }
  .co-busy{ position:absolute; inset:0; display:none; align-items:center; justify-content:center; background:rgba(29,26,20,.62); color:#FCF3D3; font-family:'IBM Plex Mono', monospace; font-size:13px; letter-spacing:.06em; text-align:center; padding:20px; }
  .co-busy.on{ display:flex; }
  .co-tools{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .co-seg{ display:inline-flex; border:1px solid #3a3424; border-radius:9px; overflow:hidden; }
  .co-seg button{ border:0; border-radius:0; }
  .co-btn{ font-family:'IBM Plex Mono', monospace; font-size:11.5px; letter-spacing:.04em; text-transform:uppercase; background:#24201a; color:#f6f1e3; border:1px solid #3a3424; border-radius:9px; padding:9px 13px; cursor:pointer; }
  .co-btn:hover{ border-color:#F5E3A3; }
  .co-btn.on{ background:#F5E3A3; color:#292217; border-color:#F5E3A3; }
  .co-btn.primary{ background:#FFD1DC; color:#5c2035; border-color:#FFD1DC; font-weight:600; }
  .co-btn:disabled{ opacity:.45; cursor:default; }
  .co-size{ display:flex; align-items:center; gap:8px; font-family:'IBM Plex Mono', monospace; font-size:11px; color:#a9a28a; }
  .co-size input{ width:120px; accent-color:#F5E3A3; }
  .co-check{ display:flex; align-items:center; gap:6px; font-size:12px; color:#cfc8b4; cursor:pointer; }
  .co-hint{ margin:0; font-size:12px; color:#a9a28a; line-height:1.5; }
  .co-foot{ display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  .co-foot .r{ display:flex; gap:8px; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const wrap = document.createElement('div');
  wrap.className = 'co-scrim'; wrap.id = 'coScrim';
  wrap.innerHTML = `<div class="co-modal" role="dialog" aria-modal="true" aria-label="Make a sticker">
    <div class="co-head"><h3>✂ Make a sticker</h3><small>runs on your computer · nothing is uploaded until you save</small></div>
    <div class="co-stage" id="coStage">
      <div class="co-drop" id="coDrop"><b>Choose a photo</b><span>The background is removed automatically. Then fix any edges with the brush.</span>
        <button class="co-btn primary" id="coPick">⬆ Choose photo</button></div>
      <canvas id="coCanvas" hidden></canvas>
      <div class="co-busy" id="coBusy">Removing the background…</div>
    </div>
    <div class="co-tools" id="coTools" hidden>
      <div class="co-seg"><button class="co-btn on" id="coErase" title="Paint over what you want gone">⌫ Erase</button><button class="co-btn" id="coRestore" title="Paint back what should stay">✎ Restore</button></div>
      <label class="co-size">brush <input type="range" id="coBrush" min="4" max="160" value="40"></label>
      <label class="co-check"><input type="checkbox" id="coGhost" checked> show removed parts faintly</label>
      <button class="co-btn" id="coUndo" title="Undo (⌘Z)">↶ Undo</button>
      <button class="co-btn" id="coAuto" title="Run the automatic cutout again">✦ Auto again</button>
      <button class="co-btn" id="coWhole" title="Keep the whole photo and erase by hand">▢ Start from whole photo</button>
    </div>
    <p class="co-hint" id="coHint" hidden>Tip: <b>Erase</b> paints things away, <b>Restore</b> paints them back. Zoom your browser in for small details.</p>
    <div class="co-foot">
      <button class="co-btn" id="coOther" hidden>⬆ Different photo</button>
      <span></span>
      <div class="r"><button class="co-btn" id="coCancel">Cancel</button><button class="co-btn primary" id="coSave" disabled>Save sticker</button></div>
    </div>
    <input type="file" id="coFile" accept="image/*" hidden>
  </div>`;
  document.body.appendChild(wrap);
  const $ = id => document.getElementById(id);

  // ---------- state ----------
  let opts = null, photo = null, W = 0, H = 0;
  let mask = null, mctx = null;               // alpha mask at work size (white = keep)
  let view = $('coCanvas'), vctx = view.getContext('2d');
  let comp = document.createElement('canvas'), cctx = comp.getContext('2d');
  let mode = 'erase', painting = false, last = null, pointer = null, undo = [];
  let session = null, ortLoading = null;

  function busy(msg){ $('coBusy').textContent = msg || ''; $('coBusy').classList.toggle('on', !!msg); }
  function setMode(m){ mode = m; $('coErase').classList.toggle('on', m==='erase'); $('coRestore').classList.toggle('on', m==='restore'); }

  // ---------- model ----------
  function loadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
  async function getSession(){
    if(session) return session;
    if(!ortLoading) ortLoading = (async () => {
      if(!window.ort) await loadScript(ORT_BASE + 'ort.min.js');
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1;            // GitHub Pages isn't cross-origin isolated
      session = await ort.InferenceSession.create(MODEL_URL, { executionProviders:['wasm'] });
      return session;
    })();
    try{ return await ortLoading; } catch(e){ ortLoading = null; throw e; }
  }
  async function autoMask(){
    const sess = await getSession();
    const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
    const x = c.getContext('2d', { willReadFrequently:true });
    x.drawImage(photo, 0, 0, SIZE, SIZE);
    const px = x.getImageData(0, 0, SIZE, SIZE).data;
    let max = 1; for(let i = 0; i < px.length; i += 4){ max = Math.max(max, px[i], px[i+1], px[i+2]); }
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225], N = SIZE*SIZE;
    const input = new Float32Array(3*N);
    for(let i = 0; i < N; i++) for(let ch = 0; ch < 3; ch++) input[ch*N + i] = (px[i*4+ch] / max - mean[ch]) / std[ch];
    const feeds = {}; feeds[sess.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
    const out = (await sess.run(feeds))[sess.outputNames[0]].data;
    let mi = Infinity, ma = -Infinity; for(let i = 0; i < N; i++){ if(out[i] < mi) mi = out[i]; if(out[i] > ma) ma = out[i]; }
    const m = x.createImageData(SIZE, SIZE);
    for(let i = 0; i < N; i++){
      let v = (out[i] - mi) / ((ma - mi) || 1);
      v = Math.min(1, Math.max(0, (v - 0.12) / 0.76));      // firmer edges, less halo
      m.data[i*4] = m.data[i*4+1] = m.data[i*4+2] = 255; m.data[i*4+3] = Math.round(v*255);
    }
    x.putImageData(m, 0, 0);
    mctx.globalCompositeOperation = 'copy'; mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(c, 0, 0, W, H); mctx.globalCompositeOperation = 'source-over';
  }
  function wholeMask(){ mctx.globalCompositeOperation = 'copy'; mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, W, H); mctx.globalCompositeOperation = 'source-over'; }

  // ---------- drawing ----------
  function fitView(){
    const maxW = Math.min(800, window.innerWidth - 90), maxH = Math.max(260, window.innerHeight - 330);
    const k = Math.min(maxW / W, maxH / H, 1);
    view.style.width = Math.round(W*k) + 'px'; view.style.height = Math.round(H*k) + 'px';
  }
  function composite(){
    cctx.globalCompositeOperation = 'copy'; cctx.drawImage(photo, 0, 0, W, H);
    cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(mask, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
  }
  function render(){
    composite();
    vctx.clearRect(0, 0, W, H);
    if($('coGhost').checked){ vctx.globalAlpha = 0.22; vctx.drawImage(photo, 0, 0, W, H); vctx.globalAlpha = 1; }
    vctx.drawImage(comp, 0, 0);
    if(pointer){
      const r = brushR();
      vctx.beginPath(); vctx.arc(pointer.x, pointer.y, r, 0, Math.PI*2);
      vctx.lineWidth = Math.max(1.5, W/500); vctx.strokeStyle = mode==='erase' ? '#d2453b' : '#2e8b57'; vctx.stroke();
    }
  }
  const brushR = () => (+$('coBrush').value) * (W / parseFloat(view.style.width || W)) / 2;
  function toWork(e){ const r = view.getBoundingClientRect(); return { x:(e.clientX - r.left) * W / r.width, y:(e.clientY - r.top) * H / r.height }; }
  function stroke(a, b){
    mctx.save();
    mctx.globalCompositeOperation = mode==='erase' ? 'destination-out' : 'source-over';
    mctx.strokeStyle = '#fff'; mctx.fillStyle = '#fff'; mctx.lineCap = 'round'; mctx.lineJoin = 'round'; mctx.lineWidth = brushR()*2;
    mctx.beginPath(); mctx.moveTo(a.x, a.y); mctx.lineTo(b.x, b.y); mctx.stroke();
    mctx.beginPath(); mctx.arc(b.x, b.y, brushR(), 0, Math.PI*2); mctx.fill();
    mctx.restore();
  }
  function pushUndo(){ undo.push(mctx.getImageData(0, 0, W, H)); if(undo.length > 20) undo.shift(); $('coUndo').disabled = false; }
  function doUndo(){ const d = undo.pop(); if(d){ mctx.putImageData(d, 0, 0); render(); } $('coUndo').disabled = !undo.length; }

  view.addEventListener('pointerdown', e => { if(!photo) return; view.setPointerCapture(e.pointerId); pushUndo(); painting = true; last = toWork(e); stroke(last, last); render(); });
  view.addEventListener('pointermove', e => { if(!photo) return; pointer = toWork(e); if(painting){ stroke(last, pointer); last = pointer; } render(); });
  view.addEventListener('pointerup', () => { painting = false; });
  view.addEventListener('pointerleave', () => { pointer = null; painting = false; if(photo) render(); });

  // ---------- load a photo ----------
  async function loadFile(file){
    const url = URL.createObjectURL(file);
    try{
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('bad image')); i.src = url; });
      await start(img);
    } catch(e){ alertMsg('That file couldn’t be opened. Try a JPG or PNG.'); }
  }
  async function start(img){
    const k = Math.min(1, WORK_MAX / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    W = Math.max(1, Math.round((img.naturalWidth || img.width) * k)); H = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
    const pc = document.createElement('canvas'); pc.width = W; pc.height = H; pc.getContext('2d').drawImage(img, 0, 0, W, H);
    photo = pc;
    mask = document.createElement('canvas'); mask.width = W; mask.height = H; mctx = mask.getContext('2d', { willReadFrequently:true });
    comp.width = W; comp.height = H; view.width = W; view.height = H;
    undo = []; $('coUndo').disabled = true;
    $('coDrop').hidden = true; view.hidden = false; $('coTools').hidden = false; $('coHint').hidden = false; $('coOther').hidden = false;
    fitView(); wholeMask(); render();
    await runAuto();
  }
  async function runAuto(){
    busy(session ? 'Removing the background…' : 'Getting the cutout tool ready (first time only, about 5 MB)…');
    $('coSave').disabled = true;
    try{
      pushUndo();
      await autoMask(); render();
    } catch(e){
      console.error(e);
      alertMsg('The automatic cutout didn’t work on this browser. You can still erase the background by hand.');
    } finally { busy(''); $('coSave').disabled = false; }
  }
  function alertMsg(m){ if(window.plStickers) window.plStickers.toast(m, true); else alert(m); }

  // ---------- save ----------
  function exportPNG(){
    composite();
    const d = cctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){ if(d[(y*W + x)*4 + 3] > 10){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; } }
    if(x1 < 0) return null;
    const pad = 2; x0 = Math.max(0, x0-pad); y0 = Math.max(0, y0-pad); x1 = Math.min(W-1, x1+pad); y1 = Math.min(H-1, y1+pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, k = Math.min(1, OUT_MAX / Math.max(cw, ch));
    const o = document.createElement('canvas'); o.width = Math.round(cw*k); o.height = Math.round(ch*k);
    const ox = o.getContext('2d'); ox.imageSmoothingQuality = 'high'; ox.drawImage(comp, x0, y0, cw, ch, 0, 0, o.width, o.height);
    return new Promise(res => o.toBlob(b => res(b ? { blob:b, w:o.width, h:o.height } : null), 'image/png'));
  }
  $('coSave').onclick = async () => {
    const out = await exportPNG();
    if(!out){ alertMsg('Nothing left to save. Use Restore to paint part of the photo back.'); return; }
    const cb = opts && opts.onSave; close();
    if(cb) cb(out.blob, out.w, out.h);
  };

  // ---------- buttons ----------
  $('coPick').onclick = () => $('coFile').click();
  $('coOther').onclick = () => $('coFile').click();
  $('coFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if(f) loadFile(f); };
  $('coErase').onclick = () => setMode('erase');
  $('coRestore').onclick = () => setMode('restore');
  $('coGhost').onchange = () => render();
  $('coUndo').onclick = doUndo;
  $('coAuto').onclick = () => runAuto();
  $('coWhole').onclick = () => { pushUndo(); wholeMask(); render(); };
  $('coCancel').onclick = () => close();
  wrap.addEventListener('click', e => { if(e.target === wrap) close(); });
  document.addEventListener('keydown', e => {
    if(!wrap.classList.contains('open')) return;
    if(e.key === 'Escape'){ e.preventDefault(); close(); }
    else if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); e.stopPropagation(); doUndo(); }
    else if(e.key === 'e') setMode('erase');
    else if(e.key === 'r') setMode('restore');
  }, true);
  window.addEventListener('resize', () => { if(photo) fitView(); });

  function close(){ wrap.classList.remove('open'); opts = null; photo = null; pointer = null; }
  window.openCutout = function(o){
    opts = o || {}; photo = null; setMode('erase');
    $('coDrop').hidden = false; view.hidden = true; $('coTools').hidden = true; $('coHint').hidden = true; $('coOther').hidden = true; $('coSave').disabled = true; busy('');
    wrap.classList.add('open');
    if(opts.file) loadFile(opts.file);
    else if(opts.image) start(opts.image);
    getSession().catch(() => {});      // warm up the model in the background
  };
})();
