// =========================================================================
// 🎨 Studio Paint Pro v3.0
// NEW: Layers · Bézier · Pressure Sensitivity · Marquee Select · Filters ·
//      Text Tool · Blending Modes · Color Swatches · Touch Support · IndexedDB
// =========================================================================

// ── DOM refs ──────────────────────────────────────────────────────────────
const canvas           = document.getElementById("canvas");
const ctx              = canvas.getContext("2d");
const color1           = document.getElementById("col");
const color2           = document.getElementById("col2");
const currentToolDisp  = document.getElementById("current-tool-display");
const toleranceSlider  = document.getElementById("tolerance-slider");
const toleranceValEl   = document.getElementById("toleranceVal");
const brushSizeSlider  = document.getElementById("brushSize");
const brushSizeValEl   = document.getElementById("brushSizeVal");
const opacitySlider    = document.getElementById("opacity");
const opacityValEl     = document.getElementById("opacityVal");
const zoomDisplay      = document.getElementById("zoom-level");
const mousePosDisplay  = document.getElementById("mouse-pos");

// ── State ─────────────────────────────────────────────────────────────────
let tool         = 'free';
let freeMode     = 'pen';
let drawing      = false;
let fillShapes   = false;
let isProcessing = false;
let tolerance    = 40;
let blendMode    = 'source-over';
let usePressure  = false;

// Canvas dimensions (logical drawing space)
let canvasWidth  = 2000;
let canvasHeight = 2000;
let canvasPreset = 'Custom';

// Viewport
let scale   = 1, offsetX = 0, offsetY = 0;
let panning = false, panStart = {x:0,y:0};

// Render
let needsRedraw   = false;
let pendingPreview= null;

// Gradient
let useGradient  = false;
let gradientType = 'linear';
let gradientAngle= 180;

// Grid
let showGrid  = false, gridSize = 20;

// History
let undoStack = [], redoStack = [];
const MAX_UNDO = 30;

// Coords
let startX=0, startY=0, lastX=0, lastY=0;

// ── LAYER SYSTEM ──────────────────────────────────────────────────────────
let layers = [];       // [{canvas, ctx, name, visible, opacity, id}]
let activeLayerIdx = 0;
let layerCounter   = 0;

function createLayerCanvas() {
    const c = document.createElement('canvas');
    c.width  = canvasWidth; c.height = canvasHeight;
    return c;
}

function addLayer(name) {
    const c   = createLayerCanvas();
    const lctx= c.getContext('2d', {willReadFrequently:true});
    const id  = ++layerCounter;
    layers.push({canvas:c, ctx:lctx, name: name || `Layer ${id}`, visible:true, opacity:1, id});
    activeLayerIdx = layers.length - 1;
    renderLayerList();
    saveSnapshot();
    needsRedraw = true;
}

function deleteLayer() {
    if (layers.length <= 1) return;
    layers.splice(activeLayerIdx, 1);
    activeLayerIdx = Math.min(activeLayerIdx, layers.length - 1);
    renderLayerList();
    saveSnapshot();
    needsRedraw = true;
}

function duplicateLayer() {
    const src = layers[activeLayerIdx];
    const c   = createLayerCanvas();
    const lctx= c.getContext('2d', {willReadFrequently:true});
    lctx.drawImage(src.canvas, 0, 0);
    const id  = ++layerCounter;
    layers.splice(activeLayerIdx + 1, 0, {canvas:c, ctx:lctx, name: src.name+' copy', visible:true, opacity:src.opacity, id});
    activeLayerIdx++;
    renderLayerList();
    saveSnapshot();
    needsRedraw = true;
}

function mergeDown() {
    if (activeLayerIdx === 0) return;
    const above = layers[activeLayerIdx];
    const below = layers[activeLayerIdx - 1];
    below.ctx.save();
    below.ctx.globalAlpha = above.opacity;
    below.ctx.drawImage(above.canvas, 0, 0);
    below.ctx.restore();
    layers.splice(activeLayerIdx, 1);
    activeLayerIdx--;
    renderLayerList();
    saveSnapshot();
    needsRedraw = true;
}

function setActiveLayer(idx) {
    activeLayerIdx = idx;
    renderLayerList();
    needsRedraw = true;
    if (currentToolDisp) updateToolbar();
}

function toggleLayerVisibility(idx, e) {
    e.stopPropagation();
    layers[idx].visible = !layers[idx].visible;
    renderLayerList();
    needsRedraw = true;
}

function renderLayerList() {
    const list = document.getElementById('layer-list');
    if (!list) return;
    list.innerHTML = '';
    // Render reversed so top layer is at top of list
    for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        const el = document.createElement('div');
        el.className = 'layer-item' + (i === activeLayerIdx ? ' active' : '');
        el.onclick = () => setActiveLayer(i);

        // Thumbnail
        const thumb = document.createElement('canvas');
        thumb.className = 'layer-thumb';
        const tc = thumb.getContext('2d');
        thumb.width = 28; thumb.height = 20;
        tc.fillStyle = '#fff'; tc.fillRect(0,0,28,20);
        tc.drawImage(L.canvas, 0, 0, L.canvas.width, L.canvas.height, 0, 0, 28, 20);

        const info = document.createElement('div');
        info.className = 'layer-info';
        info.innerHTML = `<div class="layer-name">${L.name}</div>
            <div class="layer-opacity-mini">${Math.round(L.opacity*100)}%</div>`;

        const visBtn = document.createElement('button');
        visBtn.className = 'layer-vis-btn';
        visBtn.title = L.visible ? 'Hide layer' : 'Show layer';
        visBtn.textContent = L.visible ? '👁' : '🚫';
        visBtn.onclick = (e) => toggleLayerVisibility(i, e);

        el.appendChild(thumb);
        el.appendChild(info);
        el.appendChild(visBtn);
        list.appendChild(el);
    }
    // Update active layer display
    const al = document.getElementById('active-layer-display');
    if (al) al.textContent = layers[activeLayerIdx]?.name || '—';
    // Update thumbnails in IndexedDB save
    scheduleAutoSave();
}

// Convenience accessors for active layer
function getOffscreen() { return layers[activeLayerIdx].canvas; }
function getOffctx()    { return layers[activeLayerIdx].ctx; }

// ── STROKE CANVAS (temp buffer) ───────────────────────────────────────────
const strokeCanvas = createLayerCanvas();
const strokeCtx    = strokeCanvas.getContext('2d');

// ── HISTORY (snapshot all layers) ─────────────────────────────────────────
async function saveSnapshot() {
    const blobs = await Promise.all(layers.map(L =>
        new Promise(r => L.canvas.toBlob(r, 'image/png'))
    ));
    const snapshot = { blobs, activeLayerIdx, layerMeta: layers.map(L => ({name:L.name, visible:L.visible, opacity:L.opacity, id:L.id})) };
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push(snapshot);
    redoStack = [];
}

async function applySnapshot(snapshot) {
    // Restore layer canvases
    layers = await Promise.all(snapshot.blobs.map((blob, i) => new Promise(resolve => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const c   = createLayerCanvas();
            const lctx= c.getContext('2d', {willReadFrequently:true});
            lctx.clearRect(0, 0, canvasWidth, canvasHeight);
            lctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            const m = snapshot.layerMeta[i];
            resolve({canvas:c, ctx:lctx, name:m.name, visible:m.visible, opacity:m.opacity, id:m.id});
        };
        img.src = url;
    })));
    activeLayerIdx = snapshot.activeLayerIdx;
    layerCounter   = Math.max(...layers.map(l=>l.id), 0);
    renderLayerList();
    needsRedraw = true;
}

async function undo() {
    if (isProcessing || undoStack.length < 2) return;
    isProcessing = true;
    redoStack.push(undoStack.pop());
    await applySnapshot(undoStack[undoStack.length - 1]);
    isProcessing = false;
}

async function redo() {
    if (isProcessing || redoStack.length === 0) return;
    isProcessing = true;
    const next = redoStack.pop();
    undoStack.push(next);
    await applySnapshot(next);
    isProcessing = false;
}

// ── INDEXEDDB AUTO-SAVE ───────────────────────────────────────────────────
let autoSaveTimer = null;
let db = null;

function initDB() {
    const req = indexedDB.open('StudioPaintPro', 2);
    req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('autosave')) d.createObjectStore('autosave');
    };
    req.onsuccess = e => {
        db = e.target.result;
        loadAutoSave();
    };
    req.onerror = () => console.warn('IndexedDB unavailable — auto-save disabled.');
}

function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(doAutoSave, 3000);
}

async function doAutoSave() {
    if (!db) return;
    const ind = document.getElementById('autosave-indicator');
    if (ind) { ind.className='saving'; ind.textContent='💾 Saving…'; }
    try {
        const blobs = await Promise.all(layers.map(L =>
            new Promise(r => L.canvas.toBlob(r, 'image/webp', 0.8))
        ));
        const meta  = layers.map(L => ({name:L.name, visible:L.visible, opacity:L.opacity, id:L.id}));
        const tx    = db.transaction('autosave', 'readwrite');
        const store = tx.objectStore('autosave');
        store.put({blobs, meta, activeLayerIdx, layerCounter}, 'session');
        tx.oncomplete = () => {
            if (ind) { ind.className='autosave-ok'; ind.textContent='💾 Saved'; }
        };
    } catch(e) {
        if (ind) { ind.className='error'; ind.textContent='⚠️ Save failed'; }
    }
}

async function loadAutoSave() {
    if (!db) return;
    const tx    = db.transaction('autosave','readonly');
    const store = tx.objectStore('autosave');
    const req   = store.get('session');
    req.onsuccess = async e => {
        const data = e.target.result;
        if (!data) return;
        // Always start fresh — offer restore via toast
        showRestoreToast(data);
    };
}

function showRestoreToast(data) {
    const toast = document.getElementById('restore-toast');
    if (!toast) return;
    toast.classList.add('visible');

    let dismissTimer = setTimeout(() => dismiss(false), 8000);

    function dismiss(restore) {
        clearTimeout(dismissTimer);
        toast.classList.remove('visible');
        if (!restore && db) {
            const tx2 = db.transaction('autosave','readwrite');
            tx2.objectStore('autosave').delete('session');
        }
    }

    document.getElementById('restore-btn-yes').onclick = async () => {
        dismiss(true);
        layers = await Promise.all(data.blobs.map((blob, i) => new Promise(resolve => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const c   = createLayerCanvas();
                const lctx= c.getContext('2d', {willReadFrequently:true});
                lctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                const m   = data.meta[i];
                resolve({canvas:c, ctx:lctx, name:m.name, visible:m.visible, opacity:m.opacity, id:m.id});
            };
            img.src = url;
        })));
        activeLayerIdx = data.activeLayerIdx;
        layerCounter   = data.layerCounter || layers.length;
        renderLayerList();
        await saveSnapshot();
        needsRedraw = true;
    };

    document.getElementById('restore-btn-no').onclick = () => dismiss(false);
}

// ── VIEWPORT & RENDERING ──────────────────────────────────────────────────
function setupCanvasResolution() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    redraw();
}

function redraw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(scale*dpr, 0, 0, scale*dpr, offsetX*dpr, offsetY*dpr);

    // Paper background
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.shadowBlur  = 10/scale;
    ctx.shadowColor = "rgba(0,0,0,.3)";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.restore();

    // Draw all visible layers bottom-to-top
    for (const L of layers) {
        if (!L.visible) continue;
        ctx.save();
        ctx.globalAlpha = L.opacity;
        ctx.drawImage(L.canvas, 0, 0);
        ctx.restore();
    }

    // Live stroke / shape preview
    drawLiveContent(ctx);

    // Selection overlay
    if (hasSelection) drawSelectionOverlay(ctx);

    // Text preview
    if (tool === 'text') drawTextPreview(ctx);

    // Bézier preview
    if (tool === 'bezier') drawBezierPreview(ctx);

    // Grid
    if (showGrid) drawGridOverlay(ctx, scale);

    updateZoomDisplay();
    updateNavigator();
}

function drawLiveContent(tc) {
    if (drawing && tool === 'free') {
        tc.save();
        tc.globalAlpha = getOpacity();
        if (freeMode === 'eraser') tc.globalCompositeOperation = 'destination-out';
        tc.drawImage(strokeCanvas, 0, 0);
        tc.restore();
    }
    if (pendingPreview) {
        tc.save();
        const p = pendingPreview;
        tc.strokeStyle = p.strokeStyle;
        tc.fillStyle   = p.fillStyle;
        tc.globalAlpha = p.alpha;
        tc.lineWidth   = p.lineWidth;
        drawShape(tc, p.tool, p.x1, p.y1, p.x2, p.y2, p.w, p.h);
        tc.restore();
    }
}

function drawGridOverlay(tc, s) {
    tc.save();
    tc.strokeStyle = 'rgba(100,116,139,.35)';
    tc.lineWidth   = Math.max(.4, .8/s);
    tc.setLineDash([]);
    for (let x=0; x<=canvasWidth; x+=gridSize) {
        tc.beginPath(); tc.moveTo(x,0); tc.lineTo(x,canvasHeight); tc.stroke();
    }
    for (let y=0; y<=canvasHeight; y+=gridSize) {
        tc.beginPath(); tc.moveTo(0,y); tc.lineTo(canvasWidth,y); tc.stroke();
    }
    tc.restore();
}

// ── NAVIGATOR ─────────────────────────────────────────────────────────────
function updateNavigator() {
    const miniCanvas = document.getElementById('mini-preview-canvas');
    if (!miniCanvas) return;
    const mc  = miniCanvas.getContext('2d');
    const mw  = miniCanvas.offsetWidth  || 160;
    const mh  = miniCanvas.offsetHeight || 120;
    miniCanvas.width  = mw;
    miniCanvas.height = mh;

    const ratio = Math.min(mw/canvasWidth, mh/canvasHeight);
    const nw    = canvasWidth*ratio, nh = canvasHeight*ratio;
    const nx    = (mw-nw)/2,  ny = (mh-nh)/2;

    mc.clearRect(0,0,mw,mh);
    mc.fillStyle = '#fff'; mc.fillRect(nx,ny,nw,nh);
    for (const L of layers) {
        if (!L.visible) continue;
        mc.save(); mc.globalAlpha = L.opacity;
        mc.drawImage(L.canvas, 0,0,canvasWidth,canvasHeight, nx,ny,nw,nh);
        mc.restore();
    }

    // Viewport rect — positioned RELATIVE inside mini-preview-wrap
    const vp   = document.getElementById('nav-viewport');
    if (!vp) return;
    const dpr  = window.devicePixelRatio || 1;
    const cw   = canvas.width/dpr, ch = canvas.height/dpr;
    // How much of the logical canvas is visible in screen pixels
    const vx   = nx + (-offsetX/scale) * ratio;
    const vy   = ny + (-offsetY/scale) * ratio;
    const vw   = (cw/scale) * ratio;
    const vh   = (ch/scale) * ratio;
    // Clamp to minimap bounds
    const clampedX = Math.max(nx, Math.min(nx+nw, vx));
    const clampedY = Math.max(ny, Math.min(ny+nh, vy));
    const clampedW = Math.min(vw, nx+nw-clampedX);
    const clampedH = Math.min(vh, ny+nh-clampedY);
    vp.style.left   = clampedX + 'px';
    vp.style.top    = clampedY + 'px';
    vp.style.width  = Math.max(4, clampedW) + 'px';
    vp.style.height = Math.max(4, clampedH) + 'px';
}

// Navigator click-to-pan
document.addEventListener('DOMContentLoaded', () => {
    const mini = document.getElementById('mini-preview-canvas');
    if (!mini) return;
    mini.addEventListener('click', e => {
        const rect  = mini.getBoundingClientRect();
        const mw    = mini.offsetWidth, mh = mini.offsetHeight;
        const ratio = Math.min(mw/canvasWidth, mh/canvasHeight);
        const nw    = canvasWidth*ratio, nh = canvasHeight*ratio;
        const nx    = (mw-nw)/2,  ny = (mh-nh)/2;
        const wx    = (e.clientX - rect.left - nx) / ratio;
        const wy    = (e.clientY - rect.top  - ny) / ratio;
        const dpr   = window.devicePixelRatio || 1;
        const cw    = canvas.width/dpr, ch = canvas.height/dpr;
        offsetX = cw/2 - wx*scale;
        offsetY = ch/2 - wy*scale;
        clampOffset();
        needsRedraw = true;
    });
});

// ── ZOOM & PAN ────────────────────────────────────────────────────────────
function clampOffset() {
    const dpr  = window.devicePixelRatio||1;
    const vw   = canvas.width/dpr, vh = canvas.height/dpr;
    const minX = Math.min(vw - canvasWidth*scale, 0);
    const minY = Math.min(vh - canvasHeight*scale, 0);
    offsetX    = Math.min(Math.max(offsetX, minX), 0);
    offsetY    = Math.min(Math.max(offsetY, minY), 0);
}
function resetView() { scale=1; offsetX=0; offsetY=0; needsRedraw=true; }
function updateZoomDisplay() { if(zoomDisplay) zoomDisplay.textContent=Math.round(scale*100)+'%'; }
function getMousePos(e) {
    return { x:(e.offsetX-offsetX)/scale, y:(e.offsetY-offsetY)/scale };
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function getBrushSize() { return parseInt(brushSizeSlider.value); }
function getOpacity()   { return parseInt(opacitySlider.value)/100; }

// ── GRADIENT BUILD ────────────────────────────────────────────────────────
function buildFillStyle(context, x1, y1, x2, y2) {
    if (!useGradient) return color1.value;
    const c1=color1.value, c2=color2.value;
    const w=x2-x1, h=y2-y1, cx=x1+w/2, cy=y1+h/2;
    if (gradientType==='radial') {
        const r = Math.sqrt(w*w+h*h)/2;
        const g = context.createRadialGradient(cx,cy,0,cx,cy,r||1);
        g.addColorStop(0,c1); g.addColorStop(1,c2); return g;
    }
    const rad=gradientAngle*Math.PI/180;
    const hw=Math.abs(w)/2||1, hh=Math.abs(h)/2||1;
    const gx=Math.cos(rad)*hw, gy=Math.sin(rad)*hh;
    const g=context.createLinearGradient(cx-gx,cy-gy,cx+gx,cy+gy);
    g.addColorStop(0,c1); g.addColorStop(1,c2); return g;
}

// ── SHAPE ENGINE ──────────────────────────────────────────────────────────
function drawShape(context, shape, x1, y1, x2, y2, w, h) {
    context.lineCap='round'; context.lineJoin='round';
    context.beginPath();
    if (shape==='rect') {
        context.rect(x1,y1,w,h);
    } else if (shape==='roundrect') {
        const r=Math.min(Math.abs(w),Math.abs(h))*0.15;
        context.roundRect(x1,y1,w,h,r);
    } else if (shape==='circle') {
        const cx=x1+w/2, cy=y1+h/2, r=Math.min(Math.abs(w),Math.abs(h))/2;
        context.arc(cx,cy,r,0,Math.PI*2);
    } else if (shape==='ellipse') {
        context.ellipse(x1+w/2,y1+h/2,Math.abs(w/2),Math.abs(h/2),0,0,Math.PI*2);
    } else if (shape==='line') {
        context.moveTo(x1,y1); context.lineTo(x2,y2);
    } else if (shape==='triangle') {
        context.moveTo(x1+w/2,y1); context.lineTo(x2,y2); context.lineTo(x1,y2); context.closePath();
    } else if (shape==='diamond') {
        const cx=x1+w/2, cy=y1+h/2;
        context.moveTo(cx,y1); context.lineTo(x2,cy); context.lineTo(cx,y2); context.lineTo(x1,cy); context.closePath();
    } else if (shape==='star') {
        const cx=x1+w/2, cy=y1+h/2;
        const outerR=Math.min(Math.abs(w),Math.abs(h))/2, innerR=outerR*0.4;
        const pts=5;
        for(let i=0;i<pts*2;i++){
            const a=i*Math.PI/pts - Math.PI/2;
            const r=i%2===0?outerR:innerR;
            i===0?context.moveTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r):context.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);
        }
        context.closePath();
    } else if (shape==='pentagon') {
        const cx=x1+w/2, cy=y1+h/2, r=Math.min(Math.abs(w),Math.abs(h))/2;
        for(let i=0;i<5;i++){
            const a=i*2*Math.PI/5 - Math.PI/2;
            i===0?context.moveTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r):context.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);
        }
        context.closePath();
    } else if (shape==='hexagon') {
        const cx=x1+w/2, cy=y1+h/2, r=Math.min(Math.abs(w),Math.abs(h))/2;
        for(let i=0;i<6;i++){
            const a=i*2*Math.PI/6;
            i===0?context.moveTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r):context.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);
        }
        context.closePath();
    } else if (shape==='arrow') {
        const hw=Math.abs(w), hh=Math.abs(h);
        const sx=w>=0?x1:x2, sy=h>=0?y1:y2;
        const ex=w>=0?x2:x1, ey=h>=0?y2:y1;
        const headLen=Math.min(hw,hh)*0.4, shaftH=hh*0.35;
        const sy1=sy+hh/2-shaftH/2, sy2=sy+hh/2+shaftH/2;
        context.moveTo(sx, sy1);
        context.lineTo(ex-headLen, sy1);
        context.lineTo(ex-headLen, sy+hh/2-shaftH);
        context.lineTo(ex, sy+hh/2);
        context.lineTo(ex-headLen, sy+hh/2+shaftH);
        context.lineTo(ex-headLen, sy2);
        context.lineTo(sx, sy2);
        context.closePath();
    }
    if (fillShapes && shape!=='line') context.fill();
    context.stroke();
}

// ── BÉZIER TOOL ───────────────────────────────────────────────────────────
// Workflow:
//   1. Click to place START point
//   2. Click to place END point  (preview line tracks mouse in between)
//   3. Drag anywhere to move CP1 (first control handle, shown in real-time)
//   4. Release → drag again to move CP2 (second handle) — or Enter to commit
//   5. Enter / double-click to commit  |  Esc to cancel
//   Handles are also individually draggable at any stage after step 2.

let bezierState = 0;
// 0 = idle
// 1 = start placed, waiting for end click
// 2 = end placed, dragging CP1
// 3 = CP1 set, dragging CP2
// 4 = both CPs set — fine-tune mode (drag any handle)

let bzStart = null, bzEnd = null, bzCtrl = null, bzCtrl2 = null;
let bzMousePos  = null;   // tracks live mouse for state-1 preview
let bzDragTarget = null;  // 'start'|'end'|'cp1'|'cp2' when dragging a handle in state 4

const BZ_HIT_RADIUS = 10; // px screen-space hit radius for handle dragging

function bzHitTest(pos) {
    // Returns which handle the mouse is over (state 4 fine-tune mode)
    const pts = { start: bzStart, end: bzEnd, cp1: bzCtrl, cp2: bzCtrl2 };
    for (const [key, p] of Object.entries(pts)) {
        if (!p) continue;
        const dx = (p.x - pos.x) * scale;
        const dy = (p.y - pos.y) * scale;
        if (Math.sqrt(dx*dx + dy*dy) < BZ_HIT_RADIUS) return key;
    }
    return null;
}

function drawBezierPreview(tc) {
    if (bezierState === 0 || !bzStart) return;
    tc.save();

    const cp1 = bzCtrl  || bzEnd || bzMousePos;
    const cp2 = bzCtrl2 || cp1;

    // ── Curve preview ──
    if (bezierState === 1 && bzMousePos) {
        // Just a straight preview line to mouse
        tc.strokeStyle = color1.value;
        tc.lineWidth   = getBrushSize();
        tc.globalAlpha = getOpacity() * 0.6;
        tc.setLineDash([6 / scale, 4 / scale]);
        tc.beginPath();
        tc.moveTo(bzStart.x, bzStart.y);
        tc.lineTo(bzMousePos.x, bzMousePos.y);
        tc.stroke();
        tc.setLineDash([]);
    } else if (bezierState >= 2 && bzEnd) {
        // Full curve
        tc.strokeStyle = color1.value;
        tc.lineWidth   = getBrushSize();
        tc.globalAlpha = getOpacity();
        tc.globalCompositeOperation = blendMode;
        tc.lineCap = 'round'; tc.lineJoin = 'round';
        tc.beginPath();
        tc.moveTo(bzStart.x, bzStart.y);
        tc.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, bzEnd.x, bzEnd.y);
        tc.stroke();
    }

    // ── Handle lines (arms) ──
    tc.globalCompositeOperation = 'source-over';
    tc.strokeStyle = 'rgba(99,179,237,0.6)';
    tc.lineWidth   = 1 / scale;
    tc.setLineDash([3 / scale, 3 / scale]);
    tc.globalAlpha = 0.8;
    if (bzCtrl && bzStart) {
        tc.beginPath(); tc.moveTo(bzStart.x, bzStart.y); tc.lineTo(bzCtrl.x, bzCtrl.y); tc.stroke();
    }
    if (bzCtrl2 && bzEnd) {
        tc.beginPath(); tc.moveTo(bzEnd.x, bzEnd.y); tc.lineTo(bzCtrl2.x, bzCtrl2.y); tc.stroke();
    }
    tc.setLineDash([]);

    // ── Handle dots ──
    const handles = [
        { p: bzStart,  color: '#60a5fa', label: 'S', filled: true  },
        { p: bzEnd,    color: '#60a5fa', label: 'E', filled: true  },
        { p: bzCtrl,   color: '#a78bfa', label: '1', filled: false },
        { p: bzCtrl2,  color: '#f472b6', label: '2', filled: false },
    ];
    const r = 6 / scale;
    handles.forEach(({ p, color, filled }) => {
        if (!p) return;
        tc.globalAlpha = 1;
        tc.strokeStyle = color;
        tc.fillStyle   = filled ? color : 'rgba(15,23,42,0.7)';
        tc.lineWidth   = 1.5 / scale;
        tc.beginPath();
        tc.arc(p.x, p.y, r, 0, Math.PI * 2);
        tc.fill();
        tc.stroke();
    });

    tc.restore();
}

function commitBezier() {
    if (!bzStart || !bzEnd) return;
    const cp1 = bzCtrl  || bzEnd;
    const cp2 = bzCtrl2 || cp1;
    const offctx = getOffctx();
    offctx.save();
    offctx.strokeStyle = color1.value;
    offctx.fillStyle   = buildFillStyle(offctx, bzStart.x, bzStart.y, bzEnd.x, bzEnd.y);
    offctx.lineWidth   = getBrushSize();
    offctx.globalAlpha = getOpacity();
    offctx.globalCompositeOperation = blendMode;
    offctx.lineCap = 'round'; offctx.lineJoin = 'round';
    offctx.beginPath();
    offctx.moveTo(bzStart.x, bzStart.y);
    offctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, bzEnd.x, bzEnd.y);
    offctx.stroke();
    offctx.restore();
    bzStart = bzEnd = bzCtrl = bzCtrl2 = bzMousePos = null;
    bezierState = 0; bzDragTarget = null;
    saveSnapshot(); needsRedraw = true;
}

function cancelBezier() {
    bzStart = bzEnd = bzCtrl = bzCtrl2 = bzMousePos = null;
    bezierState = 0; bzDragTarget = null;
    needsRedraw = true;
}

// ── TEXT TOOL ─────────────────────────────────────────────────────────────
let textState = null;  // {x, y, text}
let fontBold  = false, fontItalic = false;

function toggleFontStyle(s) {
    if (s==='bold')   { fontBold   = !fontBold;   document.getElementById('btn-bold')?.classList.toggle('active', fontBold); }
    if (s==='italic') { fontItalic = !fontItalic; document.getElementById('btn-italic')?.classList.toggle('active', fontItalic); }
    needsRedraw = true;
}

function getFontString() {
    const family = document.getElementById('font-family')?.value || 'Arial';
    const size   = parseInt(document.getElementById('font-size')?.value) || 32;
    return `${fontItalic ? 'italic ' : ''}${fontBold ? 'bold ' : ''}${size}px "${family}"`;
}

function startTextInput(x, y) {
    textState = { x, y, text: '' };
    positionTextCursor();
    needsRedraw = true;
}

// Position the blinking DOM cursor overlay after the last typed character
function positionTextCursor() {
    const cur = document.getElementById('text-cursor');
    if (!cur || !textState) return;

    const fontSize = parseInt(document.getElementById('font-size')?.value) || 32;

    // Measure typed text width so cursor sits right after last char
    const tmpCtx = document.createElement('canvas').getContext('2d');
    tmpCtx.font  = getFontString();
    const textW  = tmpCtx.measureText(textState.text).width;

    // Canvas-space → screen-space, then relative to canvas-container
    const canvasRect = canvas.getBoundingClientRect();
    const contRect   = document.getElementById('canvas-container').getBoundingClientRect();

    const relX = canvasRect.left - contRect.left + (textState.x + textW) * scale + offsetX;
    const relY = canvasRect.top  - contRect.top  + (textState.y - fontSize * 0.85) * scale + offsetY;

    cur.style.left   = relX + 'px';
    cur.style.top    = relY + 'px';
    cur.style.height = (fontSize * scale) + 'px';
    cur.style.display = 'block';
}

// Render live text preview on the canvas every frame
function drawTextPreview(tc) {
    if (!textState) return;
    const fontSize = parseInt(document.getElementById('font-size')?.value) || 32;
    tc.save();
    tc.font      = getFontString();
    tc.fillStyle = color1.value;
    tc.globalAlpha = getOpacity();
    tc.globalCompositeOperation = blendMode;

    // Draw the typed text
    tc.fillText(textState.text, textState.x, textState.y);

    // Blinking cursor bar drawn on canvas as well (complements DOM cursor)
    const textW = tc.measureText(textState.text).width;
    const cursorX = textState.x + textW + 1 / scale;
    tc.strokeStyle = color1.value;
    tc.lineWidth   = Math.max(0.5, 1.5 / scale);
    tc.lineCap = 'round';
    tc.beginPath();
    tc.moveTo(cursorX, textState.y - fontSize * 0.85);
    tc.lineTo(cursorX, textState.y + fontSize * 0.15);
    tc.stroke();

    // Dashed baseline underline to show anchor
    const lineY = textState.y + fontSize * 0.12;
    tc.globalAlpha = 0.3;
    tc.setLineDash([4 / scale, 4 / scale]);
    tc.beginPath();
    tc.moveTo(textState.x, lineY);
    tc.lineTo(textState.x + Math.max(textW + 60 / scale, 80 / scale), lineY);
    tc.stroke();
    tc.setLineDash([]);
    tc.restore();
}

function commitText() {
    if (!textState) return;
    if (!textState.text.trim()) { cancelText(); return; }
    const offctx = getOffctx();
    offctx.save();
    offctx.font      = getFontString();
    offctx.fillStyle = color1.value;
    offctx.globalAlpha = getOpacity();
    offctx.globalCompositeOperation = blendMode;
    offctx.fillText(textState.text, textState.x, textState.y);
    offctx.restore();
    cancelText();
    saveSnapshot();
    needsRedraw = true;
}

function cancelText() {
    textState = null;
    const cur = document.getElementById('text-cursor');
    if (cur) cur.style.display = 'none';
    needsRedraw = true;
}

// ── SELECTION (Marquee) ───────────────────────────────────────────────────
let selRect      = null;   // {x,y,w,h}
let hasSelection = false;
let selDrawing   = false;
let selStart     = null;
let marchOffset  = 0;

function drawSelectionOverlay(tc) {
    if (!selRect) return;
    marchOffset = (marchOffset + 1) % 40;
    tc.save();
    tc.strokeStyle = '#fff';
    tc.lineWidth   = 1.5/scale;
    tc.setLineDash([5/scale, 5/scale]);
    tc.lineDashOffset = -marchOffset/scale;
    tc.strokeRect(selRect.x, selRect.y, selRect.w, selRect.h);
    tc.strokeStyle = '#000';
    tc.lineDashOffset = -(marchOffset+5)/scale;
    tc.strokeRect(selRect.x, selRect.y, selRect.w, selRect.h);
    tc.setLineDash([]);
    tc.fillStyle = 'rgba(59,130,246,.05)';
    tc.fillRect(selRect.x, selRect.y, selRect.w, selRect.h);
    tc.restore();
    // Keep animating while selection exists
    needsRedraw = true;
}

function deselect() {
    selRect = null; hasSelection = false; needsRedraw = true;
    document.getElementById('selectSubToolbar').style.display = 'none';
}

function getNormSelRect() {
    if (!selRect) return null;
    const x = selRect.w < 0 ? selRect.x+selRect.w : selRect.x;
    const y = selRect.h < 0 ? selRect.y+selRect.h : selRect.y;
    const w = Math.abs(selRect.w), h = Math.abs(selRect.h);
    return {x:Math.floor(x), y:Math.floor(y), w:Math.ceil(w), h:Math.ceil(h)};
}

function cropToSelection() {
    const r = getNormSelRect();
    if (!r || r.w < 2 || r.h < 2) return;
    layers.forEach(L => {
        const tmp = createLayerCanvas();
        const tc  = tmp.getContext('2d', {willReadFrequently:true});
        tc.drawImage(L.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        L.ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        L.ctx.drawImage(tmp, 0, 0);
    });
    deselect(); saveSnapshot(); needsRedraw = true;
}

function copySelection() {
    const r = getNormSelRect();
    if (!r || r.w < 2 || r.h < 2) return;
    const tmp = document.createElement('canvas');
    tmp.width=r.w; tmp.height=r.h;
    const tc  = tmp.getContext('2d');
    tc.fillStyle='#fff'; tc.fillRect(0,0,r.w,r.h);
    layers.forEach(L => { if(L.visible){ tc.globalAlpha=L.opacity; tc.drawImage(L.canvas,r.x,r.y,r.w,r.h,0,0,r.w,r.h); }});
    tmp.toBlob(blob => {
        try {
            navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        } catch(e) { alert('Clipboard write failed — copy not supported in this browser.'); }
    });
}

function clearSelection() {
    const r = getNormSelRect();
    if (!r) return;
    getOffctx().clearRect(r.x, r.y, r.w, r.h);
    saveSnapshot(); needsRedraw = true;
}

// ── EYEDROPPER ────────────────────────────────────────────────────────────
function pickColor(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x<0||x>=canvasWidth||y<0||y>=canvasHeight) return;
    // Read from composite (all visible layers)
    const tmp = document.createElement('canvas');
    tmp.width=1; tmp.height=1;
    const tc  = tmp.getContext('2d');
    tc.fillStyle='#fff'; tc.fillRect(0,0,1,1);
    layers.forEach(L => { if(L.visible){ tc.globalAlpha=L.opacity; tc.drawImage(L.canvas,x,y,1,1,0,0,1,1); }});
    const px = tc.getImageData(0,0,1,1).data;
    if (px[3]===0) { color1.value='#ffffff'; setTool('free'); return; }
    color1.value = '#'+[px[0],px[1],px[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
    if (opacitySlider) { opacitySlider.value=Math.round(px[3]/255*100); opacitySlider.dispatchEvent(new Event('input')); }
    setTool('free');
}

// ── FLOOD FILL ────────────────────────────────────────────────────────────
function hexToRGB(hex) {
    return [parseInt(hex.slice(1,3),16)||0, parseInt(hex.slice(3,5),16)||0, parseInt(hex.slice(5,7),16)||0];
}
function matchColor(data, i, target) {
    return Math.abs(data[i]-target[0])<=tolerance&&Math.abs(data[i+1]-target[1])<=tolerance&&Math.abs(data[i+2]-target[2])<=tolerance;
}

function floodFill(sx, sy) {
    sx=Math.floor(sx); sy=Math.floor(sy);
    if (sx<0||sx>=canvasWidth||sy<0||sy>=canvasHeight) return;
    const offctx = getOffctx();
    const W=canvasWidth, H=canvasHeight;
    // Composite read canvas
    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const tc=tmp.getContext('2d');
    tc.fillStyle='#fff'; tc.fillRect(0,0,W,H); tc.drawImage(getOffscreen(),0,0);
    const readData  = tc.getImageData(0,0,W,H).data;
    const imageData = offctx.getImageData(0,0,W,H);
    const writeData = imageData.data;
    const c1=hexToRGB(color1.value), c2=hexToRGB(color2.value), op=getOpacity();
    const si=(sy*W+sx)*4;
    const target=[readData[si],readData[si+1],readData[si+2],readData[si+3]];
    const fillRGB=hexToRGB(color1.value);
    if(target[0]===fillRGB[0]&&target[1]===fillRGB[1]&&target[2]===fillRGB[2]) return;
    const stack=[[sx,sy]], visited=new Uint8Array(W*H), pixels=[];
    while(stack.length){
        let [x,y]=stack.pop();
        while(y>=0&&matchColor(readData,(y*W+x)*4,target)&&!visited[y*W+x]) y--;
        y++;
        let rL=false,rR=false;
        while(y<H&&matchColor(readData,(y*W+x)*4,target)&&!visited[y*W+x]){
            const idx=y*W+x; visited[idx]=1;
            if(!useGradient){
                const p=idx*4,a=op;
                writeData[p]   =Math.round(c1[0]*a+writeData[p]  *(1-a));
                writeData[p+1] =Math.round(c1[1]*a+writeData[p+1]*(1-a));
                writeData[p+2] =Math.round(c1[2]*a+writeData[p+2]*(1-a));
                writeData[p+3] =Math.round(255*a+writeData[p+3]*(1-a));
            } else pixels.push({x,y});
            if(x>0){const li=idx-1;if(!rL&&matchColor(readData,li*4,target)&&!visited[li]){stack.push([x-1,y]);rL=true;}else if(rL&&(!matchColor(readData,li*4,target)||visited[li]))rL=false;}
            if(x<W-1){const ri=idx+1;if(!rR&&matchColor(readData,ri*4,target)&&!visited[ri]){stack.push([x+1,y]);rR=true;}else if(rR&&(!matchColor(readData,ri*4,target)||visited[ri]))rR=false;}
            y++;
        }
    }
    if(useGradient&&pixels.length) applyGradientToPixels(writeData,pixels,W,c1,c2,op);
    offctx.putImageData(imageData,0,0);
    saveSnapshot(); needsRedraw=true;
}

function applyGradientToPixels(data, pixels, width, c1, c2, op) {
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for(const p of pixels){if(p.x<minX)minX=p.x;if(p.x>maxX)maxX=p.x;if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y;}
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
    const rx=(maxX-minX)/2||1,ry=(maxY-minY)/2||1;
    const rad=gradientAngle*Math.PI/180,dx=Math.cos(rad),dy=Math.sin(rad);
    const mxP=Math.abs(rx*dx)+Math.abs(ry*dy)||1,inv=1/(2*mxP);
    const mxR=1/(Math.sqrt(rx*rx+ry*ry)||1),inv2pi=1/(Math.PI*2);
    const dr=c2[0]-c1[0],dg=c2[1]-c1[1],db=c2[2]-c1[2],invOp=1-op;
    for(const p of pixels){
        const i=(p.y*width+p.x)*4;
        const pdx=p.x-cx,pdy=p.y-cy;
        let t=0;
        if(gradientType==='linear')   t=(pdx*dx+pdy*dy+mxP)*inv;
        else if(gradientType==='radial') t=Math.sqrt(pdx*pdx+pdy*pdy)*mxR;
        else t=(Math.atan2(pdy,pdx)-rad+Math.PI*4)%(Math.PI*2)*inv2pi;
        if(t<0)t=0;else if(t>1)t=1;
        data[i]  =(((c1[0]+dr*t)*op+data[i]  *invOp)|0);
        data[i+1]=(((c1[1]+dg*t)*op+data[i+1]*invOp)|0);
        data[i+2]=(((c1[2]+db*t)*op+data[i+2]*invOp)|0);
        data[i+3]=255;
    }
}

// ── FILTERS ───────────────────────────────────────────────────────────────
function applyFilter(type) {
    const offctx = getOffctx();
    const w=canvasWidth, h=canvasHeight;

    const simpleConvolution = (kernel, divisor) => {
        const src = offctx.getImageData(0,0,w,h);
        const dst = offctx.createImageData(w,h);
        const s=src.data, d=dst.data;
        const kSize=Math.sqrt(kernel.length), half=Math.floor(kSize/2);
        for(let y=0;y<h;y++) for(let x=0;x<w;x++){
            let r=0,g=0,b=0;
            for(let ky=0;ky<kSize;ky++) for(let kx=0;kx<kSize;kx++){
                const ny=Math.max(0,Math.min(h-1,y+ky-half));
                const nx=Math.max(0,Math.min(w-1,x+kx-half));
                const idx=(ny*w+nx)*4;
                const k=kernel[ky*kSize+kx];
                r+=s[idx]*k; g+=s[idx+1]*k; b+=s[idx+2]*k;
            }
            const i=(y*w+x)*4;
            d[i]  =Math.max(0,Math.min(255,r/divisor));
            d[i+1]=Math.max(0,Math.min(255,g/divisor));
            d[i+2]=Math.max(0,Math.min(255,b/divisor));
            d[i+3]=s[i+3];
        }
        offctx.putImageData(dst,0,0);
    };

    if (type==='grayscale') {
        const id=offctx.getImageData(0,0,w,h);
        for(let i=0;i<id.data.length;i+=4){const v=id.data[i]*.299+id.data[i+1]*.587+id.data[i+2]*.114;id.data[i]=id.data[i+1]=id.data[i+2]=v;}
        offctx.putImageData(id,0,0);
    } else if (type==='invert') {
        const id=offctx.getImageData(0,0,w,h);
        for(let i=0;i<id.data.length;i+=4){if(id.data[i+3]===0)continue;id.data[i]=255-id.data[i];id.data[i+1]=255-id.data[i+1];id.data[i+2]=255-id.data[i+2];}
        offctx.putImageData(id,0,0);
    } else if (type==='sepia') {
        const id=offctx.getImageData(0,0,w,h);
        for(let i=0;i<id.data.length;i+=4){const r=id.data[i],g=id.data[i+1],b=id.data[i+2];id.data[i]=Math.min(255,r*.393+g*.769+b*.189);id.data[i+1]=Math.min(255,r*.349+g*.686+b*.168);id.data[i+2]=Math.min(255,r*.272+g*.534+b*.131);}
        offctx.putImageData(id,0,0);
    } else if (type==='blur') {
        simpleConvolution([1,2,1,2,4,2,1,2,1],16);
    } else if (type==='sharpen') {
        simpleConvolution([0,-1,0,-1,5,-1,0,-1,0],1);
    } else if (type==='emboss') {
        simpleConvolution([-2,-1,0,-1,1,1,0,1,2],1);
    } else if (type==='edgeDetect') {
        simpleConvolution([-1,-1,-1,-1,8,-1,-1,-1,-1],1);
    } else if (type==='brighten') {
        const id=offctx.getImageData(0,0,w,h);
        for(let i=0;i<id.data.length;i+=4){if(id.data[i+3]===0)continue;id.data[i]=Math.min(255,id.data[i]+30);id.data[i+1]=Math.min(255,id.data[i+1]+30);id.data[i+2]=Math.min(255,id.data[i+2]+30);}
        offctx.putImageData(id,0,0);
    } else if (type==='darken') {
        const id=offctx.getImageData(0,0,w,h);
        for(let i=0;i<id.data.length;i+=4){if(id.data[i+3]===0)continue;id.data[i]=Math.max(0,id.data[i]-30);id.data[i+1]=Math.max(0,id.data[i+1]-30);id.data[i+2]=Math.max(0,id.data[i+2]-30);}
        offctx.putImageData(id,0,0);
    } else if (type==='saturate'||type==='desaturate') {
        const id=offctx.getImageData(0,0,w,h); const amt=type==='saturate'?1.4:.4;
        for(let i=0;i<id.data.length;i+=4){const v=id.data[i]*.299+id.data[i+1]*.587+id.data[i+2]*.114;id.data[i]=Math.max(0,Math.min(255,v+(id.data[i]-v)*amt));id.data[i+1]=Math.max(0,Math.min(255,v+(id.data[i+1]-v)*amt));id.data[i+2]=Math.max(0,Math.min(255,v+(id.data[i+2]-v)*amt));}
        offctx.putImageData(id,0,0);
    } else if (type==='flipH') {
        const tmp=createLayerCanvas(); const tc=tmp.getContext('2d');
        tc.translate(w,0); tc.scale(-1,1); tc.drawImage(getOffscreen(),0,0);
        offctx.clearRect(0,0,w,h); offctx.drawImage(tmp,0,0);
    } else if (type==='flipV') {
        const tmp=createLayerCanvas(); const tc=tmp.getContext('2d');
        tc.translate(0,h); tc.scale(1,-1); tc.drawImage(getOffscreen(),0,0);
        offctx.clearRect(0,0,w,h); offctx.drawImage(tmp,0,0);
    } else if (type==='rotate90') {
        const tmp=createLayerCanvas(); const tc=tmp.getContext('2d');
        tc.translate(w,0); tc.rotate(Math.PI/2); tc.drawImage(getOffscreen(),0,0);
        offctx.clearRect(0,0,w,h); offctx.drawImage(tmp,0,0);
    }
    saveSnapshot(); needsRedraw=true; closeFilterModal();
}

// ── COLOR SWATCHES ────────────────────────────────────────────────────────
const DEFAULT_PALETTES = {
    material: ['#f44336','#e91e63','#9c27b0','#673ab7','#3f51b5','#2196f3','#03a9f4','#00bcd4','#009688','#4caf50','#8bc34a','#cddc39','#ffeb3b','#ffc107','#ff9800','#ff5722','#795548','#607d8b'],
    pastel:   ['#ffb3ba','#ffdfba','#ffffba','#baffc9','#bae1ff','#d5b3ff','#ffb3f0','#ffddb3','#b3f0ff','#b3ffcc','#f0ffb3','#ffb3b3','#c9b3ff','#b3fff0','#ffc9b3','#e8b3ff','#b3d4ff','#b3ffde'],
    neon:     ['#ff0090','#ff00ff','#00ff41','#00ffff','#ff6600','#ffff00','#0080ff','#8000ff','#ff0040','#00ff80','#ff8000','#40ff00','#0040ff','#ff4000','#00ff00','#ff00c0','#c0ff00','#0000ff'],
    earth:    ['#3b1e08','#5c3317','#8b5e3c','#a0785a','#c4956a','#d4b483','#e8d5b0','#c4a882','#7d6144','#504030','#2c1810','#6b4226','#9c6b3c','#b8860b','#8b6914','#6b5430','#4a3728','#9b7653'],
};

let userSwatches = JSON.parse(localStorage.getItem('spp_swatches') || '[]');

function renderSwatches() {
    const grid = document.getElementById('swatch-grid');
    if (!grid) return;
    grid.innerHTML = '';
    userSwatches.forEach((hex, i) => {
        const el = document.createElement('div');
        el.className    = 'swatch-cell';
        el.style.background = hex;
        el.title        = hex;
        el.onclick      = () => { color1.value = hex; };
        el.oncontextmenu= e => { e.preventDefault(); userSwatches.splice(i,1); saveSwatches(); renderSwatches(); };
        grid.appendChild(el);
    });
}

function addSwatch() {
    if (!userSwatches.includes(color1.value)) { userSwatches.push(color1.value); saveSwatches(); renderSwatches(); }
}

function saveSwatches() { localStorage.setItem('spp_swatches', JSON.stringify(userSwatches)); }

function loadPalette(name) {
    const colors = DEFAULT_PALETTES[name] || [];
    userSwatches = [...new Set([...userSwatches, ...colors])].slice(0, 60);
    saveSwatches(); renderSwatches();
}

// ── PRESSURE SENSITIVITY ──────────────────────────────────────────────────
function togglePressure() {
    usePressure = !usePressure;
    document.getElementById('btn-pressure')?.classList.toggle('active', usePressure);
}

function getEffectiveBrushSize(pressure) {
    if (!usePressure || pressure == null) return getBrushSize();
    return Math.max(1, getBrushSize() * (pressure > 0 ? pressure : 1));
}

function getEffectiveOpacity(pressure) {
    if (!usePressure || pressure == null) return getOpacity();
    return Math.max(.05, getOpacity() * (pressure > 0 ? pressure : 1));
}

// ── TOUCH SUPPORT ─────────────────────────────────────────────────────────
// NOTE: MouseEvent offsetX/offsetY are read-only — we cannot fake them via
// Object.assign. Instead we convert touch clientX/Y to canvas-space directly
// and call the same drawing logic the mouse handlers use.

let touchStartDist = 0, touchStartScale = 1;
let touchPanStart  = {x:0, y:0};

/** Convert a Touch object's clientX/Y into canvas-element offsetX/offsetY */
function touchOffset(t) {
    const rect = canvas.getBoundingClientRect();
    return { offsetX: t.clientX - rect.left, offsetY: t.clientY - rect.top };
}

/** Convert canvas offsetX/offsetY into logical drawing coordinates */
function offsetToPos(ox, oy) {
    return { x: (ox - offsetX) / scale, y: (oy - offsetY) / scale };
}

canvas.addEventListener('touchstart', e => {
    e.preventDefault();

    // ── Pinch-to-zoom (2 fingers) ──
    if (e.touches.length === 2) {
        touchStartDist  = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        touchStartScale = scale;
        panning = false; drawing = false;
        return;
    }

    if (e.touches.length !== 1) return;
    const t  = e.touches[0];
    const off = touchOffset(t);
    const pos = offsetToPos(off.offsetX, off.offsetY);
    const pressure = t.force > 0 ? t.force : 1;

    startX = pos.x; startY = pos.y; lastX = startX; lastY = startY;

    // Bézier state machine
    if (tool === 'bezier') {
        if (bezierState === 0) {
            bzStart = {...pos}; bezierState = 1;
        } else if (bezierState === 1) {
            bzEnd = {...pos};
            const mx = (bzStart.x + bzEnd.x) / 2, my = (bzStart.y + bzEnd.y) / 2;
            bzCtrl = {x:mx, y:my}; bzCtrl2 = {x:mx, y:my};
            bezierState = 2;
        } else if (bezierState === 4) {
            bzDragTarget = bzHitTest(pos) || null;
        }
        needsRedraw = true; return;
    }

    if (tool === 'text') {
        if (textState) commitText();
        startTextInput(pos.x, pos.y); return;
    }

    if (tool === 'eyedropper') { pickColor(pos.x, pos.y); return; }

    if (tool === 'select') {
        selStart = {...pos}; selRect = {x:pos.x, y:pos.y, w:0, h:0};
        hasSelection = false; selDrawing = true; return;
    }

    drawing = true;

    if (tool === 'paint') {
        floodFill(Math.floor(startX), Math.floor(startY)); drawing = false; return;
    }

    if (tool === 'free') {
        strokeCtx.clearRect(0, 0, canvasWidth, canvasHeight);
        strokeCtx.globalAlpha = 1; strokeCtx.globalCompositeOperation = 'source-over';
        strokeCtx.strokeStyle = color1.value; strokeCtx.fillStyle = color1.value;
        strokeCtx.lineWidth = (freeMode === 'eraser')
            ? getEffectiveBrushSize(pressure) * 3
            : getEffectiveBrushSize(pressure);
        strokeCtx.lineCap = 'round'; strokeCtx.lineJoin = 'round';
        strokeCtx.beginPath(); strokeCtx.moveTo(startX, startY);
    } else {
        const offctx = getOffctx();
        offctx.globalAlpha = getOpacity(); offctx.globalCompositeOperation = blendMode;
        offctx.strokeStyle = color1.value;
        offctx.fillStyle   = buildFillStyle(offctx, startX, startY, startX+1, startY+1);
        offctx.lineWidth   = getBrushSize();
    }
    needsRedraw = true;
}, {passive:false});

canvas.addEventListener('touchmove', e => {
    e.preventDefault();

    // ── Pinch-to-zoom (2 fingers) ──
    if (e.touches.length === 2) {
        const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const newScale = Math.max(0.05, Math.min(20, touchStartScale * dist / touchStartDist));
        const rect = canvas.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const wx = (mx - offsetX) / scale, wy = (my - offsetY) / scale;
        scale   = newScale;
        offsetX = mx - wx * scale;
        offsetY = my - wy * scale;
        clampOffset(); needsRedraw = true; return;
    }

    if (e.touches.length !== 1) return;
    const t   = e.touches[0];
    const off = touchOffset(t);
    const pos = offsetToPos(off.offsetX, off.offsetY);
    const pressure = t.force > 0 ? t.force : 1;

    if (mousePosDisplay) mousePosDisplay.textContent = `${Math.floor(pos.x)}, ${Math.floor(pos.y)}`;

    // Bézier live tracking
    if (tool === 'bezier') {
        bzMousePos = {...pos};
        if (bezierState === 1)                   { needsRedraw = true; return; }
        if (bezierState === 2)                   { bzCtrl  = {...pos}; needsRedraw = true; return; }
        if (bezierState === 3)                   { bzCtrl2 = {...pos}; needsRedraw = true; return; }
        if (bezierState === 4 && bzDragTarget)   {
            if (bzDragTarget==='start') bzStart = {...pos};
            else if (bzDragTarget==='end')  bzEnd   = {...pos};
            else if (bzDragTarget==='cp1')  bzCtrl  = {...pos};
            else if (bzDragTarget==='cp2')  bzCtrl2 = {...pos};
            needsRedraw = true; return;
        }
        needsRedraw = true; return;
    }

    // Selection
    if (tool === 'select' && selDrawing) {
        selRect = {x:selStart.x, y:selStart.y, w:pos.x-selStart.x, h:pos.y-selStart.y};
        needsRedraw = true; return;
    }

    if (!drawing || tool === 'paint' || tool === 'eyedropper') return;
    const cx = pos.x, cy = pos.y;

    if (tool === 'free') {
        const bSize = getEffectiveBrushSize(pressure);
        if (freeMode === 'spray') {
            const radius = bSize * 3, density = 10 + bSize * 2;
            strokeCtx.fillStyle = color1.value;
            for (let i = 0; i < density; i++) {
                const a = Math.random() * 2 * Math.PI, r = Math.sqrt(Math.random()) * radius;
                strokeCtx.fillRect(cx + Math.cos(a)*r, cy + Math.sin(a)*r, Math.random()+.5, Math.random()+.5);
            }
        } else if (freeMode === 'brush') {
            strokeCtx.strokeStyle = color1.value;
            strokeCtx.lineWidth   = bSize;
            strokeCtx.shadowBlur  = bSize * 0.8;
            strokeCtx.shadowColor = color1.value;
            strokeCtx.lineTo(cx, cy); strokeCtx.stroke();
            strokeCtx.shadowBlur = 0;
            strokeCtx.beginPath(); strokeCtx.moveTo(cx, cy);
        } else {
            strokeCtx.lineWidth = bSize;
            strokeCtx.lineTo(cx, cy); strokeCtx.stroke();
            strokeCtx.beginPath(); strokeCtx.moveTo(cx, cy);
        }
    } else {
        pendingPreview = {tool, x1:startX, y1:startY, x2:cx, y2:cy, w:cx-startX, h:cy-startY,
            strokeStyle: color1.value,
            fillStyle:   buildFillStyle(getOffctx(), startX, startY, cx, cy),
            alpha:       getOpacity(), lineWidth: getBrushSize()};
    }
    lastX = cx; lastY = cy; needsRedraw = true;
}, {passive:false});

canvas.addEventListener('touchend', e => {
    e.preventDefault();

    // Bézier: advance state
    if (tool === 'bezier') {
        if (bezierState === 2) { bezierState = 3; bzCtrl2 = {...bzCtrl}; }
        else if (bezierState === 3) { bezierState = 4; }
        bzDragTarget = null; needsRedraw = true; return;
    }

    // Selection commit
    if (tool === 'select' && selDrawing) {
        selDrawing = false;
        if (Math.abs(selRect.w) > 4 && Math.abs(selRect.h) > 4) {
            hasSelection = true;
            document.getElementById('selectSubToolbar').style.display = 'flex';
        } else { selRect = null; }
        needsRedraw = true; return;
    }

    // Commit stroke / shape
    if (drawing) {
        const offctx = getOffctx();
        if (tool === 'free') {
            offctx.globalAlpha = getOpacity();
            offctx.globalCompositeOperation = freeMode === 'eraser' ? 'destination-out' : blendMode;
            offctx.drawImage(strokeCanvas, 0, 0);
            offctx.globalAlpha = 1; offctx.globalCompositeOperation = 'source-over';
            strokeCtx.clearRect(0, 0, canvasWidth, canvasHeight);
        } else if (pendingPreview) {
            const p = pendingPreview;
            offctx.globalCompositeOperation = blendMode;
            offctx.strokeStyle = p.strokeStyle;
            offctx.fillStyle   = buildFillStyle(offctx, p.x1, p.y1, p.x2, p.y2);
            offctx.globalAlpha = p.alpha; offctx.lineWidth = p.lineWidth;
            drawShape(offctx, p.tool, p.x1, p.y1, p.x2, p.y2, p.w, p.h);
            offctx.globalAlpha = 1; offctx.globalCompositeOperation = 'source-over';
        }
        saveSnapshot();
    }
    drawing = false; panning = false; pendingPreview = null;
    needsRedraw = true;
    renderLayerList();
}, {passive:false});

// ── UI TOOLBAR ────────────────────────────────────────────────────────────
function updateToolbar() {
    document.querySelectorAll('#toolbar button, #freeSubToolbar button').forEach(b => b.classList.remove('active'));
    const tid = (tool==='free'&&freeMode==='eraser')?'tool-eraser':'tool-'+tool;
    document.getElementById(tid)?.classList.add('active');

    const fst = document.getElementById('freeSubToolbar');
    const tst = document.getElementById('textSubToolbar');
    const sst = document.getElementById('selectSubToolbar');
    if (fst) fst.style.display = (tool==='free'&&freeMode!=='eraser') ? 'flex' : 'none';
    if (tst) tst.style.display = tool==='text' ? 'flex' : 'none';
    if (sst) sst.style.display = (tool==='select'&&hasSelection) ? 'flex' : 'none';
    if (tool==='free'&&freeMode!=='eraser') document.getElementById('sub-'+freeMode)?.classList.add('active');

    document.getElementById('btn-gradient')?.classList.toggle('active', useGradient);
    document.getElementById('btn-fill')?.classList.toggle('active', fillShapes);
    document.getElementById('btn-pressure')?.classList.toggle('active', usePressure);

    const col2w = document.getElementById('col2-wrapper');
    const gs    = document.getElementById('gradient-settings');
    const ac    = document.getElementById('angle-control');
    const gt    = document.getElementById('gradient-type');
    if (col2w) { col2w.style.opacity=useGradient?'1':'.3'; col2w.style.pointerEvents=useGradient?'auto':'none'; }
    if (gs)    gs.style.display = useGradient ? 'flex' : 'none';
    if (ac&&gt) ac.style.display = (useGradient&&(gt.value==='linear'||gt.value==='conical')) ? 'flex' : 'none';

    if (currentToolDisp) {
        let label = tool.charAt(0).toUpperCase()+tool.slice(1);
        if (tool==='free') label+=` (${freeMode})`;
        if (tool==='bezier') {
            const hints=[
                'Click to place start point',
                'Click to place end point',
                'Drag to set control point 1',
                'Drag to set control point 2',
                'Drag handles to adjust — Enter to commit'
            ];
            label = `Bézier — ${hints[bezierState] || 'ready'}`;
        }
        currentToolDisp.textContent = label;
    }
}

function setTool(t) {
    if (tool==='bezier'&&t!=='bezier') cancelBezier();
    if (tool==='text'&&t!=='text') cancelText();
    tool = t;
    if (tool==='free'&&freeMode==='eraser') freeMode='pen';
    updateToolbar();
}
function exitMode() {
    cancelBezier(); cancelText(); deselect();
    setTool('free'); changeFreeMode('pen');
}
function zoomCanvas(factor) {
    const dpr = window.devicePixelRatio||1;
    const cw  = canvas.width/dpr, ch = canvas.height/dpr;
    const cx  = cw/2, cy = ch/2;
    const wx  = (cx-offsetX)/scale, wy = (cy-offsetY)/scale;
    const ns  = Math.max(0.05, Math.min(20, scale*factor));
    scale=ns; offsetX=cx-wx*scale; offsetY=cy-wy*scale;
    clampOffset(); needsRedraw=true;
}
function changeFreeMode(m) { tool='free'; freeMode=m; updateToolbar(); }
function toggleGradient() {
    useGradient=!useGradient; updateToolbar(); needsRedraw=true;
}
function toggleFill() { fillShapes=!fillShapes; updateToolbar(); }
function toggleGrid() {
    showGrid=!showGrid; document.getElementById('btn-grid')?.classList.toggle('active',showGrid); needsRedraw=true;
}
function clr() {
    if (!confirm('Clear active layer? (Ctrl+Z to undo)')) return;
    getOffctx().clearRect(0,0,canvasWidth,canvasHeight); saveSnapshot(); needsRedraw=true;
}
function openSaveModal() { document.getElementById('save-modal-overlay').style.display='flex'; updateSaveModalUI(); }
function closeSaveModal(){ document.getElementById('save-modal-overlay').style.display='none'; }
function openFilterModal(){ document.getElementById('filter-modal-overlay').style.display='flex'; }
function closeFilterModal(){ document.getElementById('filter-modal-overlay').style.display='none'; }

function updateSaveModalUI() {
    const fmt=document.querySelector('input[name="save-format"]:checked')?.value||'png';
    const bg =document.querySelector('input[name="save-bg"]:checked')?.value||'white';
    document.getElementById('quality-section').style.display=(fmt==='jpeg'||fmt==='webp')?'block':'none';
    const jpgNT=fmt==='jpeg';
    const to=document.getElementById('transparent-option');
    if(to){to.style.opacity=jpgNT?'.4':'1';to.style.pointerEvents=jpgNT?'none':'auto';}
    document.getElementById('transparency-note').style.display=(jpgNT&&bg==='transparent')?'block':'none';
    if(jpgNT&&bg==='transparent') document.querySelector('input[name="save-bg"][value="white"]').checked=true;
}

function doSave() {
    const fmt=document.querySelector('input[name="save-format"]:checked')?.value||'png';
    const bg =document.querySelector('input[name="save-bg"]:checked')?.value||'white';
    const q  =parseInt(document.getElementById('save-quality').value)/100;
    const fn =document.getElementById('save-filename').value.trim()||'drawing';
    const sc =document.createElement('canvas');
    sc.width=canvasWidth; sc.height=canvasHeight;
    const sctx=sc.getContext('2d');
    // Only fill background if not transparent (or if format doesn't support transparency)
    const isTransparent = bg==='transparent' && fmt!=='jpeg';
    if (!isTransparent) {
        sctx.fillStyle = bg==='black' ? '#000' : '#fff';
        sctx.fillRect(0,0,canvasWidth,canvasHeight);
    }
    layers.forEach(L=>{if(L.visible){sctx.globalAlpha=L.opacity;sctx.drawImage(L.canvas,0,0);}});
    sctx.globalAlpha=1;
    const mimes={png:'image/png',jpeg:'image/jpeg',webp:'image/webp'};
    const ext=fmt==='jpeg'?'jpg':fmt;
    const link=document.createElement('a'); link.href=sc.toDataURL(mimes[fmt]||'image/png',q); link.download=`${fn}.${ext}`; link.click();
    closeSaveModal();
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────
canvas.addEventListener('contextmenu', e=>e.preventDefault());

// BUG FIX: Stop drawing when mouse leaves canvas or button released anywhere
window.addEventListener('mouseup', e => {
    if (!drawing && !panning) return;
    // Simulate a mouseup on canvas to properly commit the stroke
    if (drawing) {
        const offctx=getOffctx();
        if (tool==='free') {
            offctx.globalAlpha=getOpacity();
            offctx.globalCompositeOperation=freeMode==='eraser'?'destination-out':blendMode;
            offctx.drawImage(strokeCanvas,0,0);
            offctx.globalAlpha=1; offctx.globalCompositeOperation='source-over';
            strokeCtx.clearRect(0,0,canvasWidth,canvasHeight);
        } else if (pendingPreview) {
            const p=pendingPreview;
            offctx.globalCompositeOperation=blendMode;
            offctx.strokeStyle=p.strokeStyle;
            offctx.fillStyle=buildFillStyle(offctx,p.x1,p.y1,p.x2,p.y2);
            offctx.globalAlpha=p.alpha; offctx.lineWidth=p.lineWidth;
            drawShape(offctx,p.tool,p.x1,p.y1,p.x2,p.y2,p.w,p.h);
            offctx.globalAlpha=1; offctx.globalCompositeOperation='source-over';
        }
        saveSnapshot();
    }
    drawing=false; panning=false; pendingPreview=null;
    canvas.style.cursor=tool==='eyedropper'?'cell':'crosshair';
    needsRedraw=true;
    renderLayerList();
});

canvas.addEventListener('mousedown', e => {
    if (e.button===2||e.shiftKey) { panning=true; panStart={x:e.offsetX,y:e.offsetY}; canvas.style.cursor='grabbing'; return; }
    const pos=getMousePos(e);
    startX=pos.x; startY=pos.y; lastX=startX; lastY=startY;

    // Bézier tool state machine
    if (tool==='bezier') {
        if (bezierState===0) {
            // Place start point
            bzStart={...pos}; bezierState=1;
        } else if (bezierState===1) {
            // Place end point; default CPs to midpoint
            bzEnd={...pos};
            const mx=(bzStart.x+bzEnd.x)/2, my=(bzStart.y+bzEnd.y)/2;
            bzCtrl={x:mx,y:my}; bzCtrl2={x:mx,y:my};
            bezierState=2; // Now drag CP1
        } else if (bezierState===4) {
            // Fine-tune: check if clicking on a handle to drag it
            const hit=bzHitTest(pos);
            bzDragTarget=hit||null;
        }
        needsRedraw=true; return;
    }

    if (tool==='text') {
        if (textState) commitText();
        startTextInput(pos.x, pos.y); return;
    }

    if (tool==='eyedropper') { pickColor(pos.x,pos.y); return; }

    if (tool==='select') {
        selStart={...pos}; selRect={x:pos.x,y:pos.y,w:0,h:0}; hasSelection=false; selDrawing=true;
        return;
    }

    drawing=true;

    if (tool==='paint') {
        floodFill(Math.floor(startX),Math.floor(startY)); drawing=false; return;
    }

    if (tool==='free') {
        const pressure = e.pressure != null ? e.pressure : 1;
        strokeCtx.clearRect(0,0,canvasWidth,canvasHeight);
        strokeCtx.globalAlpha=1; strokeCtx.globalCompositeOperation='source-over';
        strokeCtx.strokeStyle=color1.value; strokeCtx.fillStyle=color1.value;
        strokeCtx.lineWidth=(freeMode==='eraser')?getEffectiveBrushSize(pressure)*3:getEffectiveBrushSize(pressure);
        strokeCtx.lineCap='round'; strokeCtx.lineJoin='round';
        strokeCtx.beginPath(); strokeCtx.moveTo(startX,startY);
    } else {
        const offctx=getOffctx();
        offctx.globalAlpha=getOpacity(); offctx.globalCompositeOperation=blendMode;
        offctx.strokeStyle=color1.value; offctx.fillStyle=buildFillStyle(offctx,startX,startY,startX+1,startY+1);
        offctx.lineWidth=getBrushSize();
    }
    canvas.style.cursor='crosshair';
});

canvas.addEventListener('mousemove', e => {
    const pos=getMousePos(e);
    if (mousePosDisplay) mousePosDisplay.textContent=`${Math.floor(pos.x)}, ${Math.floor(pos.y)}`;

    if (panning) {
        offsetX+=e.offsetX-panStart.x; offsetY+=e.offsetY-panStart.y;
        panStart={x:e.offsetX,y:e.offsetY}; clampOffset(); needsRedraw=true; return;
    }

    // Bézier live tracking
    if (tool==='bezier') {
        bzMousePos={...pos};
        if (bezierState===1) {
            needsRedraw=true; return;
        }
        if (bezierState===2&&e.buttons===1) {
            bzCtrl={...pos}; needsRedraw=true; return;
        }
        if (bezierState===3&&e.buttons===1) {
            bzCtrl2={...pos}; needsRedraw=true; return;
        }
        if (bezierState===4&&e.buttons===1&&bzDragTarget) {
            if (bzDragTarget==='start') bzStart={...pos};
            else if (bzDragTarget==='end') bzEnd={...pos};
            else if (bzDragTarget==='cp1') bzCtrl={...pos};
            else if (bzDragTarget==='cp2') bzCtrl2={...pos};
            needsRedraw=true; return;
        }
        needsRedraw=true; return;
    }

    // Selection drawing
    if (tool==='select'&&selDrawing) {
        selRect={x:selStart.x,y:selStart.y,w:pos.x-selStart.x,h:pos.y-selStart.y};
        needsRedraw=true; return;
    }

    if (!drawing||tool==='paint'||tool==='eyedropper') return;
    const cx=pos.x,cy=pos.y;
    const pressure=e.pressure!=null?e.pressure:1;

    if (tool==='free') {
        const bSize=getEffectiveBrushSize(pressure);
        if (freeMode==='spray') {
            const radius=bSize*3,density=10+bSize*2;
            strokeCtx.fillStyle=color1.value;
            for(let i=0;i<density;i++){
                const a=Math.random()*2*Math.PI,r=Math.sqrt(Math.random())*radius;
                strokeCtx.fillRect(cx+Math.cos(a)*r,cy+Math.sin(a)*r,Math.random()+.5,Math.random()+.5);
            }
        } else if (freeMode==='brush') {
            // Soft airbrush with dynamic size
            strokeCtx.strokeStyle=color1.value;
            strokeCtx.lineWidth=bSize;
            strokeCtx.shadowBlur=bSize*0.8;
            strokeCtx.shadowColor=color1.value;
            strokeCtx.lineTo(cx,cy); strokeCtx.stroke();
            strokeCtx.shadowBlur=0;
            strokeCtx.beginPath(); strokeCtx.moveTo(cx,cy);
        } else {
            strokeCtx.lineWidth=bSize;
            strokeCtx.lineTo(cx,cy); strokeCtx.stroke();
            strokeCtx.beginPath(); strokeCtx.moveTo(cx,cy);
        }
    } else {
        pendingPreview={tool,x1:startX,y1:startY,x2:cx,y2:cy,w:cx-startX,h:cy-startY,
            strokeStyle:color1.value,fillStyle:buildFillStyle(getOffctx(),startX,startY,cx,cy),
            alpha:getOpacity(),lineWidth:getBrushSize()};
    }
    lastX=cx; lastY=cy; needsRedraw=true;
});

canvas.addEventListener('mouseup', e => {
    // Bézier: advance state on mouse-release after dragging
    if (tool==='bezier') {
        if (bezierState===2) {
            bezierState=3;
            bzCtrl2={...bzCtrl};
        } else if (bezierState===3) {
            bezierState=4;
        }
        bzDragTarget=null;
        needsRedraw=true; return;
    }

    if (tool==='select'&&selDrawing) {
        selDrawing=false;
        if (Math.abs(selRect.w)>4&&Math.abs(selRect.h)>4) {
            hasSelection=true;
            document.getElementById('selectSubToolbar').style.display='flex';
        } else { selRect=null; }
        needsRedraw=true; return;
    }
    // Other mouseup handling is done by window mouseup listener
});

canvas.addEventListener('dblclick', e => {
    if (tool==='bezier'&&bezierState>=2) { commitBezier(); return; }
    if (tool==='bezier'&&bezierState===1) { cancelBezier(); return; }
    if (tool==='text'&&textState) { commitText(); return; }
    resetView();
});

canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const f=e.deltaY<0?1.1:.9;
    const mx=e.offsetX,my=e.offsetY;
    const wx=(mx-offsetX)/scale,wy=(my-offsetY)/scale;
    const ns=scale*f;
    if(ns>.05&&ns<20){scale=ns;offsetX=mx-wx*scale;offsetY=my-wy*scale;clampOffset();needsRedraw=true;}
}, {passive:false});

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
    if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT') return;

    if ((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if ((e.ctrlKey||e.metaKey)&&e.key==='y'){e.preventDefault();redo();return;}
    if ((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();openSaveModal();return;}

    if (tool==='text'&&textState) {
        if (e.key==='Enter'&&!e.shiftKey){commitText();return;}
        if (e.key==='Escape'){cancelText();return;}
        if (e.key==='Backspace'){e.preventDefault();textState.text=textState.text.slice(0,-1);positionTextCursor();needsRedraw=true;return;}
        if (e.key.length===1){textState.text+=e.key;positionTextCursor();needsRedraw=true;return;}
    }

    if (tool==='bezier'){
        if(e.key==='Enter'){commitBezier();return;}
        if(e.key==='Escape'){cancelBezier();return;}
        if(e.key==='z'&&bezierState>=2){
            // Step back: undo last bezier placement
            if(bezierState===4||bezierState===3){bezierState=2;bzCtrl2=null;needsRedraw=true;return;}
            if(bezierState===2){bezierState=1;bzCtrl=null;bzCtrl2=null;bzEnd=null;needsRedraw=true;return;}
        }
    }

    if (e.key==='Escape'){deselect();}

    if (!e.ctrlKey&&!e.metaKey) {
        const map={f:'free',r:'rect',c:'circle',e:'ellipse',t:'triangle',l:'line',
            b:'bezier',p:'paint',i:'eyedropper',s:'select',w:'text',x:'eraser',
            d:'diamond',h:'hexagon',n:'pentagon',a:'arrow',u:'star',q:'roundrect'};
        if(map[e.key.toLowerCase()]){
            const v=map[e.key.toLowerCase()];
            v==='eraser'?changeFreeMode('eraser'):setTool(v);
        }
        if(e.key.toLowerCase()==='g') toggleGrid();
    }
});

// Slider sync
toleranceSlider.addEventListener('input',()=>{tolerance=parseInt(toleranceSlider.value);toleranceValEl.textContent=tolerance;});
brushSizeSlider.addEventListener('input',()=>{if(brushSizeValEl)brushSizeValEl.textContent=brushSizeSlider.value;});
opacitySlider.addEventListener('input',()=>{if(opacityValEl)opacityValEl.textContent=opacitySlider.value+'%';});
document.getElementById('gradient-type').addEventListener('change',()=>{gradientType=document.getElementById('gradient-type').value;updateToolbar();});
document.getElementById('gradient-angle').addEventListener('input',e=>{gradientAngle=parseInt(e.target.value);document.getElementById('angleVal').textContent=gradientAngle+'°';});

// Modal close on overlay click / escape
document.getElementById('save-modal-overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeSaveModal();});
document.getElementById('filter-modal-overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeFilterModal();});
window.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
        if(document.getElementById('save-modal-overlay').style.display!=='none')closeSaveModal();
        if(document.getElementById('filter-modal-overlay').style.display!=='none')closeFilterModal();
    }
});

// Save modal reactive
document.querySelectorAll('input[name="save-format"]').forEach(r=>r.addEventListener('change',updateSaveModalUI));
document.querySelectorAll('input[name="save-bg"]').forEach(r=>r.addEventListener('change',updateSaveModalUI));

// ── RAF LOOP ──────────────────────────────────────────────────────────────
function loop() {
    if (tool==='text'&&textState) needsRedraw=true; // keep cursor blinking
    if (needsRedraw){redraw();needsRedraw=false;}
    requestAnimationFrame(loop);
}
loop();

// ── INIT ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', setupCanvasResolution);

document.addEventListener('DOMContentLoaded', () => {
    // Init first layer
    addLayer('Background');
    // Wait for layer, then save initial snapshot
    setTimeout(async () => {
        await saveSnapshot();
        setupCanvasResolution();
        updateToolbar();
        renderSwatches();
        initDB();
        updateCanvasSizeDisplay();
        needsRedraw=true;
        console.log('🎨 Studio Paint Pro v4.0 — Ready');
    }, 50);
});
// ── CANVAS SIZE ───────────────────────────────────────────────────────────
const CANVAS_PRESETS = {
    'a4-portrait':  { w: 794,  h: 1123, label: 'A4 Portrait'  },
    'a4-landscape': { w: 1123, h: 794,  label: 'A4 Landscape' },
    'a5-portrait':  { w: 559,  h: 794,  label: 'A5 Portrait'  },
    'a5-landscape': { w: 794,  h: 559,  label: 'A5 Landscape' },
    'hd':           { w: 1280, h: 720,  label: 'HD 720p'      },
    'fhd':          { w: 1920, h: 1080, label: 'Full HD 1080p' },
    'square-sm':    { w: 1000, h: 1000, label: 'Square 1000'  },
    'square-lg':    { w: 2000, h: 2000, label: 'Square 2000'  },
};

function openCanvasModal() {
    document.getElementById('canvas-w-input').value = canvasWidth;
    document.getElementById('canvas-h-input').value = canvasHeight;
    // Highlight matching preset
    document.querySelectorAll('.canvas-preset-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('canvas-modal-overlay').style.display = 'flex';
}
function closeCanvasModal() {
    document.getElementById('canvas-modal-overlay').style.display = 'none';
}

function applyCanvasPreset(key) {
    const p = CANVAS_PRESETS[key];
    if (!p) return;
    document.getElementById('canvas-w-input').value = p.w;
    document.getElementById('canvas-h-input').value = p.h;
    document.querySelectorAll('.canvas-preset-btn').forEach(b => b.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
}

function applyCanvasCustom() {
    const w = parseInt(document.getElementById('canvas-w-input').value);
    const h = parseInt(document.getElementById('canvas-h-input').value);
    if (!w || !h || w < 100 || h < 100 || w > 8000 || h > 8000) {
        alert('Please enter valid dimensions between 100 and 8000 pixels.');
        return;
    }
    if (!confirm(`Resize canvas to ${w} × ${h}px? This will clear all layers.`)) return;
    resizeCanvas(w, h);
    closeCanvasModal();
}

function resizeCanvas(w, h) {
    canvasWidth  = w;
    canvasHeight = h;

    // Find preset label
    canvasPreset = 'Custom';
    for (const [key, p] of Object.entries(CANVAS_PRESETS)) {
        if (p.w === w && p.h === h) { canvasPreset = p.label; break; }
    }

    // Recreate stroke canvas at new size
    strokeCanvas.width  = w;
    strokeCanvas.height = h;
    strokeCtx.clearRect(0, 0, w, h);

    // Reset layers — create fresh background layer
    layers = [];
    layerCounter = 0;
    undoStack = [];
    redoStack = [];
    addLayer('Background');

    // Reset view
    scale = 1; offsetX = 0; offsetY = 0;
    setupCanvasResolution();
    updateCanvasSizeDisplay();
    needsRedraw = true;
}

function updateCanvasSizeDisplay() {
    const sizeEl   = document.getElementById('canvas-size-display');
    const presetEl = document.getElementById('canvas-preset-display');
    const statusEl = document.getElementById('status-canvas-size');
    if (sizeEl)   sizeEl.textContent   = `${canvasWidth} × ${canvasHeight}`;
    if (presetEl) presetEl.textContent = canvasPreset;
    if (statusEl) statusEl.textContent = `${canvasWidth} × ${canvasHeight}`;
}

// Canvas modal close on overlay click / escape
document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('canvas-modal-overlay');
    if (overlay) {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closeCanvasModal();
        });
    }
});
window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        const cm = document.getElementById('canvas-modal-overlay');
        if (cm && cm.style.display !== 'none') closeCanvasModal();
    }
});
// ── MOBILE PANEL TOGGLE ────────────────────────────────────────────────────
function togglePanel() {
    const panel   = document.getElementById('left-panel');
    const overlay = document.getElementById('panel-overlay');
    const btn     = document.getElementById('panel-toggle-btn');
    const isOpen  = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    overlay.classList.toggle('visible', !isOpen);
    if (btn) btn.classList.toggle('active', !isOpen);
}

// Close panel on resize to desktop
window.addEventListener('resize', () => {
    if (window.innerWidth > 640) {
        const panel   = document.getElementById('left-panel');
        const overlay = document.getElementById('panel-overlay');
        const btn     = document.getElementById('panel-toggle-btn');
        panel.classList.remove('open');
        overlay.classList.remove('visible');
        if (btn) btn.classList.remove('active');
    }
});
