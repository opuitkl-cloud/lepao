// ══ STATE ═══════════════════════════════════════════════
const state = {
  images: [],      // [{img,imgSrc,neLat,neLng,swLat,swLng,trackSegments,checkinPoints}]
  currentIdx: 0,
  isDrawing: false, isPaused: false,
  drawColor: '#fb7299', lineWidth: 2,
  lastPos: null, currentSegment: [],
};
let bgCtx, drawCtx, bgCanvas, drawCanvas;

// ══ STORAGE ══════════════════════════════════════════════
function saveToStorage() {
  const data = state.images.map(l => {
    const isPath = l.imgSrc && !l.imgSrc.startsWith('data:');
    return {
      imgPath: isPath ? l.imgSrc : null,
      neLat: l.neLat, neLng: l.neLng, swLat: l.swLat, swLng: l.swLng,
      checkinPoints: l.checkinPoints || [],
    };
  });
  const settings = {
    totalTime: document.getElementById('totalTime').value,
    sampleInterval: document.getElementById('sampleInterval').value,
  };
  const payload = JSON.stringify({ layers: data, settings, currentIdx: state.currentIdx });
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).catch(e => console.warn('Save failed', e));
}

function loadFromStorage() {
  return fetch('/api/settings')
    .then(r => r.json())
    .then(raw => {
      if (!raw || !raw.layers || !raw.layers.length) return false;
      if (raw.settings) {
        document.getElementById('totalTime').value = raw.settings.totalTime || 3600;
        document.getElementById('sampleInterval').value = raw.settings.sampleInterval || 20;
      }
      state.images = [];
      const promises = raw.layers.map((l, i) => new Promise(res => {
        const imgSrc = l.imgPath || null;
        state.images.push({
          img: null, imgSrc: imgSrc,
          neLat: l.neLat||'', neLng: l.neLng||'', swLat: l.swLat||'', swLng: l.swLng||'',
          trackSegments: [],
          checkinPoints: l.checkinPoints || [],
        });
        if (imgSrc) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { state.images[i].img = img; res(); };
          img.onerror = () => { res(); };
          img.src = imgSrc;
        } else res();
      }));
      return Promise.all(promises).then(() => {
        renderTabs();
        switchTab(Math.min(raw.currentIdx||0, state.images.length-1), true);
        return true;
      });
    })
    .catch(e => { console.warn('Load failed', e); return false; });
}

// ══ MOBILE PAGE SYSTEM ════════════════════════════════
function switchToDrawPage() {
  document.getElementById('page-main').classList.remove('active');
  document.getElementById('page-draw').classList.add('active');
  window.scrollTo(0, 0);
  // Mobile: recalculate canvas after layout change
  const cur = state.images[state.currentIdx];
  if (cur && cur.img) setTimeout(() => { showCanvas(cur.img); redrawAll(); }, 50);
}

function switchToMainPage() {
  document.getElementById('page-draw').classList.remove('active');
  document.getElementById('page-main').classList.add('active');
}

// Show enter button only on mobile
function initMobileUI() {
  if (window.innerWidth <= 768) {
    document.querySelectorAll('.enter-draw-btn').forEach(el => el.style.display = 'flex');
  }
}

// ══ INIT ══════════════════════════════════════════════════
window.onload = () => {
  initMobileUI();

  bgCanvas   = document.getElementById('bgCanvas');
  drawCanvas = document.getElementById('drawCanvas');
  bgCtx  = bgCanvas.getContext('2d');
  drawCtx = drawCanvas.getContext('2d');

  drawCanvas.addEventListener('mousedown',  onMouseDown);
  drawCanvas.addEventListener('mousemove',  onMouseMove);
  drawCanvas.addEventListener('mouseup',    onMouseUp);
  drawCanvas.addEventListener('mouseleave', () => { state.lastPos = null; });
  drawCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
  drawCanvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
  drawCanvas.addEventListener('touchend',   onTouchEnd,   { passive: false });

  document.getElementById('sampleInterval').addEventListener('input', () => { redrawAll(); updateStats(); updatePointInfo(); });
  document.getElementById('totalTime').addEventListener('input', updateStats);

  loadFromStorage().then(ok => { if (!ok) addImageTab(); bindCoordInputs(); });

  // Init collapse (open by default)
  const body = document.getElementById('layerBody');
  body.style.maxHeight = 'none';
};

// ══ TABS ══════════════════════════════════════════════════
function addImageTab() {
  const idx = state.images.length;
  state.images.push({ img:null, imgSrc:null, neLat:'',neLng:'',swLat:'',swLng:'', trackSegments:[], checkinPoints:[] });
  renderTabs();
  switchTab(idx);
}

function renderTabs() {
  const c = document.getElementById('imgTabs');
  c.innerHTML = '';
  state.images.forEach((_, i) => {
    const t = document.createElement('div');
    t.className = 'img-tab' + (i===state.currentIdx?' active':'');
    t.textContent = `图层 ${i+1}`;
    t.onclick = () => switchTab(i);
    c.appendChild(t);
  });
}

function switchTab(idx, skipSave) {
  if (!skipSave) {
    saveCurrentCoords();
    saveToStorage();
  }
  state.currentIdx = idx;
  const cur = state.images[idx];
  document.getElementById('neLat').value = cur.neLat;
  document.getElementById('neLng').value = cur.neLng;
  document.getElementById('swLat').value = cur.swLat;
  document.getElementById('swLng').value = cur.swLng;
  // Show path if it's a path-based image
  const pathEl = document.getElementById('imgPath');
  if (pathEl) pathEl.value = (cur.imgSrc && !cur.imgSrc.startsWith('data:')) ? cur.imgSrc : '';
  renderTabs();
  renderCheckinList();
  if (cur.img) { showCanvas(cur.img); redrawAll(); }
  else { document.getElementById('canvasContainer').style.display='none'; document.getElementById('emptyState').style.display='flex'; }
  updateStats();
  updatePointInfo();
}

function saveCurrentCoords() {
  const cur = state.images[state.currentIdx];
  if (!cur) return;
  cur.neLat = document.getElementById('neLat').value;
  cur.neLng = document.getElementById('neLng').value;
  cur.swLat = document.getElementById('swLat').value;
  cur.swLng = document.getElementById('swLng').value;
}

function bindCoordInputs() {
  ['neLat','neLng','swLat','swLng','totalTime','sampleInterval','imgPath'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (id === 'imgPath') return; // imgPath handled by loadImageFromPath
      saveCurrentCoords();
      saveToStorage();
      showSavedHint(el);
    });
  });
}

function showSavedHint(el) {
  const hint = document.createElement('span');
  hint.textContent = '已保存';
  hint.style.cssText = 'font-size:9px;color:var(--accent);margin-left:6px;opacity:0;transition:opacity .3s;';
  el.parentElement.appendChild(hint);
  requestAnimationFrame(() => { hint.style.opacity = '1'; });
  setTimeout(() => { hint.style.opacity = '0'; setTimeout(() => hint.remove(), 300); }, 800);
}

// ══ IMAGE ══════════════════════════════════════════════════
function loadImage(evt) {
  const file = evt.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      state.images[state.currentIdx].img    = img;
      state.images[state.currentIdx].imgSrc = e.target.result;
      showCanvas(img); redrawAll(); saveToStorage();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function loadImageFromPath(path) {
  if (!path) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    state.images[state.currentIdx].img = img;
    state.images[state.currentIdx].imgSrc = path;
    document.getElementById('imgPath').value = path;
    saveCurrentCoords();
    showCanvas(img); redrawAll(); saveToStorage();
  };
  img.onerror = () => { alert('无法加载图片: ' + path + '\n请确认文件存在于服务器上'); };
  img.src = path;
}

function showCanvas(img) {
  const isMobile = window.innerWidth <= 768;
  let maxW, maxH;
  if (isMobile) {
    // Mobile: use full viewport minus header/back button
    maxW = window.innerWidth - 20;
    maxH = window.innerHeight * 0.75;
  } else {
    // Desktop: use canvas-area dimensions, fill more space
    const area = document.querySelector('.canvas-area');
    maxW = area.clientWidth - 10;
    maxH = area.clientHeight - 10;
  }
  const scale = Math.min(maxW/img.width, maxH/img.height);
  const w = Math.round(img.width*scale), h = Math.round(img.height*scale);
  bgCanvas.width=w; bgCanvas.height=h;
  drawCanvas.width=w; drawCanvas.height=h;
  bgCanvas.style.width=w+'px'; bgCanvas.style.height=h+'px';
  drawCanvas.style.width=w+'px'; drawCanvas.style.height=h+'px';
  document.getElementById('canvasContainer').style.width=w+'px';
  document.getElementById('canvasContainer').style.height=h+'px';
  bgCtx.clearRect(0,0,w,h); bgCtx.drawImage(img,0,0,w,h);
  document.getElementById('emptyState').style.display='none';
  document.getElementById('canvasContainer').style.display='inline-block';
}

// ══ DRAWING CONTROLS ════════════════════════════════════
function setDrawBtnState(text, cls) {
  ['drawBtn','drawBtnMobile'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.textContent = text; b.className = cls; }
  });
}

function toggleDrawing() {
  if (!state.isDrawing) {
    if (!state.images[state.currentIdx].img) { alert('请先上传地图图片'); return; }
    state.isDrawing=true; state.isPaused=false; state.lastPos=null; state.currentSegment=[];
    setDrawBtnState('⏸ 结束绘制','btn btn-danger');
    setStatus('drawing','绘制中');
  } else if (!state.isPaused) {
    if (state.currentSegment.length>0) {
      state.images[state.currentIdx].trackSegments.push([...state.currentSegment]);
      state.currentSegment=[];
    }
    state.isPaused=true; state.lastPos=null;
    setDrawBtnState('▶ 继续绘制','btn btn-primary');
    setStatus('paused','已暂停');
    saveToStorage();
  } else {
    state.isPaused=false; state.currentSegment=[]; state.lastPos=null;
    setDrawBtnState('⏸ 结束绘制','btn btn-danger');
    setStatus('drawing','绘制中');
  }
}


function stopIfDrawing() {
  if (!state.isDrawing||state.isPaused) return;
  if (state.currentSegment.length>0) {
    state.images[state.currentIdx].trackSegments.push([...state.currentSegment]);
    state.currentSegment=[];
  }
  state.lastPos=null; updateStats(); updatePointInfo(); saveToStorage();
}

function clearTrack() {
  const cur = state.images[state.currentIdx];
  cur.trackSegments=[]; state.currentSegment=[]; state.lastPos=null;
  state.isDrawing=false; state.isPaused=false;
  setDrawBtnState('▶ 开始绘制','btn btn-primary');
  setStatus('idle','待机');
  redrawAll(); updateStats(); updatePointInfo();
  document.getElementById('jsonOutput').textContent='// 点击"生成 GPS JSON"';
  saveToStorage();
}

function undoLast() {
  const cur = state.images[state.currentIdx];
  if (!cur.trackSegments.length) return;
  cur.trackSegments.pop(); state.currentSegment=[]; state.lastPos=null;
  redrawAll(); updateStats(); updatePointInfo(); saveToStorage();
}

// ══ MOUSE / TOUCH ═════════════════════════════════════════
function getPos(e) {
  const r = drawCanvas.getBoundingClientRect();
  return { x: e.clientX-r.left, y: e.clientY-r.top };
}

function onMouseDown(e) {
  const pos = getPos(e);
  if (!state.isDrawing||state.isPaused) { handleCheckinClick(pos); return; }
  state.lastPos=pos; state.currentSegment.push(pos); drawDot(pos);
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveToStorage(); saveTimer = null; }, 2000);
}

function onMouseMove(e) {
  const pos = getPos(e);
  updateCoordDisplay(pos);
  if (!state.isDrawing||state.isPaused||!state.lastPos||e.buttons!==1) return;
  drawLine(state.lastPos, pos);
  state.currentSegment.push(pos); state.lastPos=pos;
  updateStats(); updatePointInfo(); scheduleSave();
}
function onMouseUp()  { stopIfDrawing(); }

function onTouchStart(e) {
  e.preventDefault();
  const pos = getPos(e.touches[0]);
  if (!state.isDrawing||state.isPaused) { handleCheckinClick(pos); return; }
  state.lastPos=pos; state.currentSegment.push(pos); drawDot(pos);
}
function onTouchMove(e) {
  e.preventDefault();
  if (!state.isDrawing||state.isPaused||!state.lastPos) return;
  const pos = getPos(e.touches[0]);
  drawLine(state.lastPos, pos);
  state.currentSegment.push(pos); state.lastPos=pos;
  updateStats(); updatePointInfo();
}
function onTouchEnd(e) { e.preventDefault(); stopIfDrawing(); }

// ══ DRAW PRIMITIVES ══════════════════════════════════════
function drawDot(p) {
  drawCtx.beginPath(); drawCtx.arc(p.x, p.y, state.lineWidth/2, 0, Math.PI*2);
  drawCtx.fillStyle=state.drawColor; drawCtx.fill();
}
function drawLine(a, b) {
  drawCtx.beginPath(); drawCtx.moveTo(a.x,a.y); drawCtx.lineTo(b.x,b.y);
  drawCtx.strokeStyle=state.drawColor; drawCtx.lineWidth=state.lineWidth;
  drawCtx.lineCap='round'; drawCtx.lineJoin='round';
  drawCtx.stroke();
}

function redrawAll() {
  const cur = state.images[state.currentIdx];
  if (!cur.img) return;
  bgCtx.clearRect(0,0,bgCanvas.width,bgCanvas.height);
  bgCtx.drawImage(cur.img,0,0,bgCanvas.width,bgCanvas.height);
  drawCtx.clearRect(0,0,drawCanvas.width,drawCanvas.height);
  cur.trackSegments.forEach(seg => {
    if (!seg.length) return;
    drawCtx.beginPath(); drawCtx.moveTo(seg[0].x,seg[0].y);
    for (let i=1;i<seg.length;i++) drawCtx.lineTo(seg[i].x,seg[i].y);
    drawCtx.strokeStyle=state.drawColor; drawCtx.lineWidth=state.lineWidth;
    drawCtx.lineCap='round'; drawCtx.lineJoin='round';
    drawCtx.stroke();
    drawCtx.beginPath(); drawCtx.arc(seg[0].x,seg[0].y,5,0,Math.PI*2);
    drawCtx.fillStyle='#fff'; drawCtx.fill();
  });
  const interval = parseInt(document.getElementById('sampleInterval').value)||20;
  getAllRawPoints().forEach((p,i) => {
    if (i%interval===0) {
      drawCtx.beginPath(); drawCtx.arc(p.x,p.y,3,0,Math.PI*2);
      drawCtx.fillStyle='rgba(255,255,255,.7)'; drawCtx.strokeStyle=state.drawColor; drawCtx.lineWidth=1;
      drawCtx.fill(); drawCtx.stroke();
    }
  });
  drawCheckinPoints();
}

// ══ GPS MAPPING ═══════════════════════════════════════════
function pixelToGPS(px,py) {
  const cur=state.images[state.currentIdx];
  const neLat=+cur.neLat,neLng=+cur.neLng,swLat=+cur.swLat,swLng=+cur.swLng;
  if ([neLat,neLng,swLat,swLng].some(isNaN)) return null;
  const w=drawCanvas.width, h=drawCanvas.height;
  return { lat: neLat-(py/h)*(neLat-swLat), lng: swLng+(px/w)*(neLng-swLng) };
}
function gpsToPixel(lat,lng) {
  const cur=state.images[state.currentIdx];
  const neLat=+cur.neLat,neLng=+cur.neLng,swLat=+cur.swLat,swLng=+cur.swLng;
  if ([neLat,neLng,swLat,swLng].some(isNaN)) return null;
  return { x:((lng-swLng)/(neLng-swLng))*drawCanvas.width, y:((neLat-lat)/(neLat-swLat))*drawCanvas.height };
}
function updateCoordDisplay(pos) {
  const g=pixelToGPS(pos.x,pos.y);
  document.getElementById('coordDisplay').textContent = g
    ? `lat:${g.lat.toFixed(6)} lng:${g.lng.toFixed(6)}`
    : `x:${Math.round(pos.x)} y:${Math.round(pos.y)} | 请填写坐标`;
}

// ══ STATS ══════════════════════════════════════════════════
function getAllRawPoints() { return state.images[state.currentIdx].trackSegments.flat(); }

function calcPixelDist(pts) {
  let d=0;
  for (let i=1;i<pts.length;i++) { const dx=pts[i].x-pts[i-1].x,dy=pts[i].y-pts[i-1].y; d+=Math.sqrt(dx*dx+dy*dy); }
  return d;
}
function pixelToMeters(px) {
  const cur=state.images[state.currentIdx];
  const neLat=+cur.neLat,neLng=+cur.neLng,swLat=+cur.swLat,swLng=+cur.swLng;
  if ([neLat,neLng,swLat,swLng].some(isNaN)) return px;
  const w=drawCanvas.width||1, h=drawCanvas.height||1;
  const cLat=(neLat+swLat)/2;
  const mW=Math.abs(neLng-swLng)*111320*Math.cos(cLat*Math.PI/180);
  const mH=Math.abs(neLat-swLat)*111320;
  return px*(mW/w+mH/h)/2;
}
function haversine(lat1,lng1,lat2,lng2) {
  const R=6371000, dL=(lat2-lat1)*Math.PI/180, dG=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function updateStats() {
  const pts=getAllRawPoints(), d=pixelToMeters(calcPixelDist(pts));
  const t=+(document.getElementById('totalTime').value)||3600;
  const iv=+(document.getElementById('sampleInterval').value)||20;
  const sampled = Math.floor(pts.length/iv) + (pts.length>0 && (pts.length-1)%iv!==0 ? 1 : 0);
  document.getElementById('totalDistStat').textContent = d>=1000?(d/1000).toFixed(3)+' km':d.toFixed(1)+' m';
  document.getElementById('recordedPtsStat').textContent = pts.length<2 ? 0 : sampled;
  const paceMin = d>0 ? t/60/(d/1000) : 0;
  const paceM = Math.floor(paceMin);
  const paceS = Math.round((paceMin-paceM)*60);
  document.getElementById('avgSpeedStat').textContent = d>0 ? paceM+':'+String(paceS).padStart(2,'0') : '0:00';
}
function updatePointInfo() {
  const pts=getAllRawPoints(), iv=+(document.getElementById('sampleInterval').value)||20;
  const sampled = Math.floor(pts.length/iv) + (pts.length>0 && (pts.length-1)%iv!==0 ? 1 : 0);
  document.getElementById('rawPtCount').textContent = pts.length;
  document.getElementById('recPtCount').textContent = pts.length<2 ? 0 : sampled;
}

// ══ SPEED COMPUTATION ════════════════════════════════════
function computeSpeedsAndTimes(segM, totalTime, sMin, sMax) {
  const n=segM.length; if (!n) return {speeds:[],times:[]};
  const rawSpeeds = Array.from({length:n},(_,i) => {
    const x = n>1?(i/(n-1))*6-3:0;
    const g = Math.exp(-x*x/2);
    return sMin + g*(sMax-sMin);
  });
  const rawTimes = segM.map((d,i) => rawSpeeds[i]>0?d/rawSpeeds[i]:0);
  const sum = rawTimes.reduce((a,b)=>a+b,0);
  const scale = sum>0?totalTime/sum:1;
  const times = rawTimes.map(t=>t*scale);
  const speeds = segM.map((d,i)=>times[i]>0?d/times[i]:0);
  return {speeds,times};
}

// ══ JSON GENERATION ══════════════════════════════════════
function generateJSON() {
  saveCurrentCoords();
  const cur = state.images[state.currentIdx];
  const allPts = getAllRawPoints();
  const interval = +(document.getElementById('sampleInterval').value)||20;
  const totalTime = +(document.getElementById('totalTime').value)||3600;
  // Sample
  const sampled=[];
  for (let i=0;i<allPts.length;i+=interval) sampled.push(allPts[i]);
  if (allPts.length>0 && (allPts.length-1)%interval!==0) sampled.push(allPts[allPts.length-1]);
  if (sampled.length<2) { document.getElementById('jsonOutput').textContent='// 轨迹点不足'; return; }

  // Segment meters
  const segM=[];
  for (let i=0;i<sampled.length-1;i++) {
    const dx=sampled[i+1].x-sampled[i].x, dy=sampled[i+1].y-sampled[i].y;
    segM.push(pixelToMeters(Math.sqrt(dx*dx+dy*dy)));
  }

  const totalM = pixelToMeters(calcPixelDist(allPts));
  // Uniform time distribution: time = distance proportion × total time
  const totalSegM = segM.reduce((a,b)=>a+b, 0)||1;
  const times = segM.map(d => (d/totalSegM)*totalTime);
  const speeds = segM.map((d,i) => times[i]>0 ? d/times[i] : 0);

  // Cumulative dist for d field
  const cumDist=[0];
  for (let i=0;i<segM.length;i++) cumDist.push(cumDist[i]+segM[i]);

  // Find SECOND point crossing each km milestone
  const milestoneIdx={};
  if (totalM>=1000) {
    const maxKm=Math.floor(totalM/1000);
    for (let km=1;km<=maxKm;km++) {
      const thr=km*1000; let count=0;
      for (let i=0;i<cumDist.length;i++) {
        if (cumDist[i]>=thr) { count++; if (count===2) { milestoneIdx[i]=km; break; } }
      }
    }
  }

  // Build points (b carries forward from milestone)
  let currentB = undefined;
  const pts=sampled.map((p,i) => {
    const g=pixelToGPS(p.x,p.y);
    if (milestoneIdx[i]!==undefined) currentB=milestoneIdx[i];
    const pt={
      a: g?parseFloat(g.lat.toFixed(6)):null,
      o: g?parseFloat(g.lng.toFixed(6)):null,
    };
    if (i > 0) pt.s = parseFloat((i<speeds.length?speeds[i]:0).toFixed(2));
    if (currentB!==undefined) pt.b=currentB;
    return pt;
  });

  const json = JSON.stringify(pts, null, 2);
  document.getElementById('jsonOutput').textContent = json;
  state._lastJSON = json;
  state._lastTimes = times;

  // Checkin result
  document.getElementById('checkinResult').innerHTML = computeCheckins(pts, times);

  redrawAll(); updateStats(); updatePointInfo();
}

// ══ CHECKIN POINTS ════════════════════════════════════════
let checkinIdCounter = 1;
function addCheckinPoint() {
  state.images[state.currentIdx].checkinPoints.push({id:checkinIdCounter++,name:'打卡点',lat:'',lng:'',size:20,active:false});
  renderCheckinList(); saveToStorage();
}

function importCheckins() {
  const text = prompt('粘贴打卡点数据（每行：ID 名称 纬度 经度 直径）');
  if (!text) return;
  const lines = text.trim().split('\n');
  lines.forEach(line => {
    // Remove common table separators and clean up
    line = line.replace(/[│├─┤┼┐┘└┌]/g, '').replace(/,/g, ' ').trim();
    const parts = line.split(/\s+/).filter(p => p);
    if (parts.length >= 4) {
      const id = parseInt(parts[0]) || checkinIdCounter++;
      const name = parts[1];
      const lat = parts[2];
      const lng = parts[3];
      const size = parts[4] ? parseInt(parts[4]) : 30;
      state.images[state.currentIdx].checkinPoints.push({id, name, lat, lng, size, active:false});
      if (id >= checkinIdCounter) checkinIdCounter = id + 1;
    }
  });
  renderCheckinList(); saveToStorage();
}
function deleteCheckinPoint(i) {
  state.images[state.currentIdx].checkinPoints.splice(i,1);
  renderCheckinList(); redrawAll(); saveToStorage();
}
function toggleCheckin(i) {
  const cp=state.images[state.currentIdx].checkinPoints[i];
  cp.active=!cp.active;
  renderCheckinList(); redrawAll(); saveToStorage();
}
function updateCheckin(i, field, val) {
  const cp=state.images[state.currentIdx].checkinPoints[i];
  if (field==='size') val=parseFloat(val)||0;
  cp[field]=val;
  if (['size','lat','lng'].includes(field)) redrawAll();
  saveToStorage();
}

function renderCheckinList() {
  const cur=state.images[state.currentIdx];
  const list=document.getElementById('checkinList');
  list.innerHTML='';
  (cur.checkinPoints||[]).forEach((pt,i) => {
    const el=document.createElement('div');
    el.className='checkin-item'+(pt.active?' active':'');
    el.innerHTML=`
      <div class="ci-header">
        <span style="font-family:'Quicksand',monospace;font-size:10px;color:var(--text-dim);min-width:24px;">CP${pt.id||''}</span>
        <div class="ci-icon" onclick="toggleCheckin(${i})" title="点击激活/取消"></div>
        <input class="ci-name-input" value="${pt.name}" onchange="updateCheckin(${i},'name',this.value)" placeholder="打卡点名称">
        <button class="ci-del" onclick="deleteCheckinPoint(${i})">✕</button>
      </div>
      <div class="ci-fields">
        <input type="number" step="0.000001" placeholder="纬度" value="${pt.lat}" onchange="updateCheckin(${i},'lat',this.value)">
        <input type="number" step="0.000001" placeholder="经度" value="${pt.lng}" onchange="updateCheckin(${i},'lng',this.value)">
        <input type="number" placeholder="直径px" value="${pt.size}" min="4" onchange="updateCheckin(${i},'size',this.value)">
      </div>
`;
    list.appendChild(el);
  });
}

function drawCheckinPoints() {
  const cur=state.images[state.currentIdx];
  (cur.checkinPoints||[]).forEach(pt => {
    const lat=parseFloat(pt.lat), lng=parseFloat(pt.lng);
    if (isNaN(lat)||isNaN(lng)) return;
    const pos=gpsToPixel(lat,lng); if (!pos) return;
    const r=(pt.size||20)/2;
    const color = pt.active?'#fb7299':'#4fffec';
    // Draw circle
    drawCtx.beginPath();
    drawCtx.arc(pos.x, pos.y, r, 0, Math.PI*2);
    drawCtx.strokeStyle = color;
    drawCtx.lineWidth=2;
    if (pt.active) { drawCtx.shadowBlur=14; drawCtx.shadowColor='#fb7299'; }
    drawCtx.stroke(); drawCtx.shadowBlur=0;
    // Minus
    drawCtx.beginPath();
    drawCtx.moveTo(pos.x-r*.4, pos.y);
    drawCtx.lineTo(pos.x+r*.4, pos.y);
    drawCtx.strokeStyle=color; drawCtx.lineWidth=2; drawCtx.stroke();
  });
}

function handleCheckinClick(pos) {
  const cur=state.images[state.currentIdx];
  (cur.checkinPoints||[]).forEach((pt,i) => {
    const lat=parseFloat(pt.lat), lng=parseFloat(pt.lng);
    if (isNaN(lat)||isNaN(lng)) return;
    const p=gpsToPixel(lat,lng); if (!p) return;
    const r=Math.max((pt.size||20)/2+10, 20);
    const dx=pos.x-p.x, dy=pos.y-p.y;
    if (Math.sqrt(dx*dx+dy*dy)<=r) toggleCheckin(i);
  });
}

// ══ CHECKIN CALCULATION ══════════════════════════════════
function computeCheckins(pts, times) {
  const cur=state.images[state.currentIdx];
  const active=(cur.checkinPoints||[]).filter(p=>p.active&&p.lat&&p.lng);
  if (!active.length) return '<span class="miss">没有激活的打卡点</span>';
  let html='';
  active.forEach(cp => {
    const cpLat=parseFloat(cp.lat), cpLng=parseFloat(cp.lng);
    let found=false, elapsed=0;
    for (let i=0;i<pts.length;i++) {
      if (i>0) elapsed+=times[i-1]||0;
      const p=pts[i];
      if (p.a==null||p.o==null) continue;
      if (haversine(p.a,p.o,cpLat,cpLng)<=200) {
        html+=`<div><span class="hit">✓ CP${cp.id} ${cp.name}</span>　第${i+1}点　t=${Math.round(elapsed)}s</div>`;
        found=true; break;
      }
    }
    if (!found) html+=`<div><span class="miss">✗ CP${cp.id} ${cp.name}</span>　未打卡</div>`;
  });
  return html;
}

// ══ COLLAPSIBLE ═══════════════════════════════════════════
function toggleSection(titleId, bodyId) {
  const title=document.getElementById(titleId);
  const body=document.getElementById(bodyId);
  const isCollapsed=body.classList.toggle('collapsed');
  title.classList.toggle('collapsed', isCollapsed);
  if (!isCollapsed) {
    body.style.maxHeight=body.scrollHeight+'px';
    setTimeout(()=>{ body.style.maxHeight='none'; }, 260);
  } else {
    body.style.maxHeight=body.scrollHeight+'px';
    requestAnimationFrame(()=>{ body.style.maxHeight='0'; });
  }
}

// ══ UI HELPERS ════════════════════════════════════════════
function setStatus(type, text) {
  const badge = document.getElementById('statusBadge');
  const textEl = document.getElementById('statusText');
  if (badge) badge.className='status-badge status-'+type;
  if (textEl) textEl.textContent=text;
  const badgeM = document.getElementById('statusBadgeMobile');
  const textM = document.getElementById('statusTextMobile');
  if (badgeM) badgeM.className='status-badge status-'+type;
  if (textM) textM.textContent=text;
}
function copyJSON() {
  if (!state._lastJSON) { alert('请先生成 JSON'); return; }
  navigator.clipboard.writeText(state._lastJSON).then(()=>{
    const n=document.getElementById('copyNote');
    n.classList.add('show'); setTimeout(()=>n.classList.remove('show'),2000);
  });
}
function downloadJSON() {
  if (!state._lastJSON) { alert('请先生成 JSON'); return; }
  const b=new Blob([state._lastJSON],{type:'application/json'});
  const u=URL.createObjectURL(b), a=document.createElement('a');
  a.href=u; a.download=`gps_track_layer${state.currentIdx+1}_${Date.now()}.json`;
  a.click(); URL.revokeObjectURL(u);
}
