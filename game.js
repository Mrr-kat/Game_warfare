"use strict";

const socket = io({ transports: ["websocket"], reconnectionAttempts: 5 });

const MAP_WIDTH  = 4000;
const MAP_HEIGHT = 4000;
const TILE_SIZE  = 200;
const FOV_MARGIN = 60;
const SERVER_HZ  = 20; // Aumentado a 20Hz para mejor respuesta
const INTERP_MS  = 1000 / SERVER_HZ;

let myId    = null;
let myTeam  = null;
let myShape = null;

let snapshots = [];
let qualityReduced = false;
let frameCount = 0;
let lastFPSUpdate = 0;
let currentFPS = 60;

let keys = { w: false, a: false, s: false, d: false };
let mouseAngle = 0;
let mouseX = 0, mouseY = 0;

// MEJORA: Sistema de predicción con historial
let localX = 0, localY = 0;
let localReady = false;
let lastProcessedSeq = 0;
let inputQueue = []; // Guardar inputs no procesados
let lastServerPos = { x: 0, y: 0 };
let reconciliationStrength = 0.15; // Reducido para menos tirón

let camera   = { x: 0, y: 0 };
let lastTime = performance.now();
let deathTimer = 0;
let isDead   = false;
let lastSentTime = 0;
let inputSequence = 0;

const canvas = document.getElementById("game-canvas");
const ctx    = canvas.getContext("2d", { alpha: false });

const lobbySel     = document.getElementById("lobby-screen");
const gameSel      = document.getElementById("game-screen");
const deathOverlay = document.getElementById("death-overlay");
const killFeed     = document.getElementById("kill-feed");
const healthFill   = document.getElementById("health-bar-fill");
const healthText   = document.getElementById("health-bar-text");
const crosshair    = document.getElementById("crosshair");
const deathTimerEl = document.getElementById("death-timer-text");

// ═══════════════════════════════════════════
// TERRENO (Reducido)
// ═══════════════════════════════════════════
const TERRAIN_SEED = 42;
let terrainObjects = [];

function seededRandom(seed) {
    let s = seed;
    return () => { s=(s*1664525+1013904223)&0xffffffff; return (s>>>0)/0xffffffff; };
}

function generateTerrain() {
    const rng = seededRandom(TERRAIN_SEED);
    terrainObjects = [];
    for(let i=0;i<40;i++){
        const x=rng()*MAP_WIDTH, y=rng()*MAP_HEIGHT;
        const w=40+rng()*70, h=28+rng()*50;
        rng();
        terrainObjects.push({type:"rock",x,y,r:(w+h)/4});
    }
    for(let i=0;i<60;i++){
        const x=rng()*MAP_WIDTH, y=rng()*MAP_HEIGHT, r=16+rng()*24;
        rng();rng();rng();
        terrainObjects.push({type:"bush",x,y,r});
    }
    for(let i=0;i<30;i++){
        const x=rng()*MAP_WIDTH, y=rng()*MAP_HEIGHT, size=22+rng()*14;
        rng();
        terrainObjects.push({type:"crate",x,y,size});
    }
}
generateTerrain();

// ═══════════════════════════════════════════
// CACHE DE TERRENO
// ═══════════════════════════════════════════
const CACHE_PAD = 250;
let terrainCache = null, cacheCamX = -99999, cacheCamY = -99999;
let cacheWorldX  = 0, cacheWorldY = 0;

function rebuildTerrainCache() {
    const cw = canvas.width + CACHE_PAD*2, ch = canvas.height + CACHE_PAD*2;
    if (!terrainCache) terrainCache = document.createElement("canvas");
    terrainCache.width = cw;
    terrainCache.height = ch;
    cacheWorldX = camera.x - CACHE_PAD;
    cacheWorldY = camera.y - CACHE_PAD;
    const c = terrainCache.getContext("2d");
    c.clearRect(0, 0, cw, ch);
    for (const obj of terrainObjects) {
        const sx = obj.x - cacheWorldX, sy = obj.y - cacheWorldY;
        const pad = (obj.r || obj.size || 40) + 10;
        if (sx+pad < 0 || sx-pad > cw || sy+pad < 0 || sy-pad > ch) continue;
        if (obj.type === "rock") {
            c.fillStyle = "#4a4a52";
            c.beginPath();
            c.arc(sx, sy, obj.r, 0, Math.PI*2);
            c.fill();
            c.strokeStyle = "rgba(160,80,255,0.85)";
            c.lineWidth = 2;
            c.stroke();
        } else if (obj.type === "bush") {
            c.fillStyle = "#2d6e2d";
            c.beginPath();
            c.arc(sx, sy, obj.r, 0, Math.PI*2);
            c.fill();
        } else {
            const s = obj.size;
            c.fillStyle = "#7a5230";
            c.fillRect(sx - s/2, sy - s/2, s, s);
            c.strokeStyle = "rgba(160,80,255,0.85)";
            c.lineWidth = 2;
            c.strokeRect(sx - s/2, sy - s/2, s, s);
        }
    }
    cacheCamX = camera.x;
    cacheCamY = camera.y;
}

function buildTilePattern() {
    const tc = document.createElement("canvas");
    tc.width = TILE_SIZE*2;
    tc.height = TILE_SIZE*2;
    const c = tc.getContext("2d");
    c.fillStyle = "#14141d";
    c.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    c.fillRect(TILE_SIZE, TILE_SIZE, TILE_SIZE, TILE_SIZE);
    c.fillStyle = "#111119";
    c.fillRect(TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
    c.fillRect(0, TILE_SIZE, TILE_SIZE, TILE_SIZE);
    return ctx.createPattern(tc, "repeat");
}

let tilePattern = null;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    tilePattern = null;
    terrainCache = null;
    cacheCamX = -99999;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ═══════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════
let selectedTeam = "red";
const redHalf  = document.getElementById("select-red");
const blueHalf = document.getElementById("select-blue");
const joinBtn  = document.getElementById("join-btn");

function updateTeamUI(t) {
    if (redHalf) redHalf.classList.toggle("selected", t === "red");
    if (blueHalf) blueHalf.classList.toggle("selected", t === "blue");
}
if (redHalf) redHalf.addEventListener("click", () => { selectedTeam = "red"; updateTeamUI("red"); });
if (blueHalf) blueHalf.addEventListener("click", () => { selectedTeam = "blue"; updateTeamUI("blue"); });
updateTeamUI(selectedTeam);

const setLobbyCursor = () => { document.body.style.cursor = "default"; if(crosshair) crosshair.style.display = "none"; };
const setGameCursor  = () => { document.body.style.cursor = "none"; if(crosshair) crosshair.style.display = "block"; };
setLobbyCursor();

if (joinBtn) joinBtn.addEventListener("click", () => { myTeam = selectedTeam; socket.emit("join_game", { team: selectedTeam }); });

// ═══════════════════════════════════════════
// EVENTOS DE RED
// ═══════════════════════════════════════════
socket.on("joined", data => {
    myId = data.id;
    myTeam = data.team;
    myShape = data.shape;
    lobbySel.classList.remove("active");
    gameSel.classList.add("active");
    setGameCursor();
    const names = { circle: "CIRCULO", square: "CUADRADO", triangle: "TRIANGULO" };
    document.getElementById("player-shape-hud").textContent = names[myShape] || myShape.toUpperCase();
    const el = document.getElementById("player-team-hud");
    el.textContent = myTeam === "red" ? "BANDO ROJO" : "BANDO AZUL";
    el.className = myTeam === "red" ? "red-team-text" : "blue-team-text";
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
});

// INPUT: Enviar a 30Hz para mejor respuesta (cada 33ms)
setInterval(() => {
    if (!myId || isDead || !localReady) return;
    
    const now = Date.now();
    if (now - lastSentTime < 33) return; // 30Hz máximo
    lastSentTime = now;
    
    inputSequence++;
    const input = {
        seq: inputSequence,
        keys: { w: keys.w, a: keys.a, s: keys.s, d: keys.d },
        angle: mouseAngle,
        dt: 0.033
    };
    
    // Guardar para posible reenvío
    inputQueue.push(input);
    if (inputQueue.length > 10) inputQueue.shift();
    
    socket.emit("player_input", input);
}, 33);

socket.on("game_state", data => {
    const ts = performance.now();
    snapshots.push({ ts, p: data.p, b: data.b, seq: data.seq || 0 });
    if (snapshots.length > 3) snapshots.shift();
    
    let rc = 0, bc = 0;
    for (const id in data.p) {
        if (data.p[id][3] === "red") rc++;
        else bc++;
    }
    document.getElementById("red-count").textContent = rc;
    document.getElementById("blue-count").textContent = bc;
    
    // RECONCILIACIÓN MEJORADA
    if (myId && data.p[myId] && localReady && !isDead) {
        const srvX = data.p[myId][0];
        const srvY = data.p[myId][1];
        const srvSeq = data.p[myId][7] || 0; // Secuencia del servidor
        
        // Calcular error de posición
        const errorX = srvX - localX;
        const errorY = srvY - localY;
        const errorDist = Math.sqrt(errorX*errorX + errorY*errorY);
        
        // Solo corregir si el error es significativo (>10px)
        if (errorDist > 10) {
            // Corrección suave pero efectiva
            localX += errorX * reconciliationStrength;
            localY += errorY * reconciliationStrength;
            
            // Si el error es muy grande, corregir inmediatamente
            if (errorDist > 50) {
                localX = srvX;
                localY = srvY;
            }
        }
        
        // Actualizar última posición del servidor
        lastServerPos = { x: srvX, y: srvY };
        
        // Re-aplicar inputs no procesados (re-predicción)
        if (srvSeq > lastProcessedSeq) {
            lastProcessedSeq = srvSeq;
            // Limpiar inputs ya procesados
            inputQueue = inputQueue.filter(inp => inp.seq > srvSeq);
            // Re-aplicar los inputs pendientes
            for (const inp of inputQueue) {
                const dt = Math.min(inp.dt, 0.033);
                let dx = 0, dy = 0;
                if (inp.keys.w) dy -= 1;
                if (inp.keys.s) dy += 1;
                if (inp.keys.a) dx -= 1;
                if (inp.keys.d) dx += 1;
                if (dx && dy) {
                    dx *= 0.7071;
                    dy *= 0.7071;
                }
                localX += dx * 250 * dt;
                localY += dy * 250 * dt;
                // Clamp
                localX = Math.max(20, Math.min(MAP_WIDTH - 20, localX));
                localY = Math.max(20, Math.min(MAP_HEIGHT - 20, localY));
            }
        }
    }
    
    // Actualizar HP
    if (myId && data.p[myId]) {
        const hp = Math.max(0, data.p[myId][2]);
        healthFill.style.width = hp + "%";
        healthText.textContent = hp;
        healthFill.style.background = hp > 60 ? "linear-gradient(90deg,#2ecc71,#27ae60)" :
                                      hp > 30 ? "linear-gradient(90deg,#f39c12,#e67e22)" :
                                                "linear-gradient(90deg,#e74c3c,#c0392b)";
    }
});

socket.on("player_died", data => {
    if (data.id === myId) {
        isDead = true;
        deathTimer = 3;
        deathOverlay.classList.remove("hidden");
        document.getElementById("death-by-text").textContent =
            data.killer_id && data.killer_id !== data.id ? "Eliminado por un enemigo" : "";
        deathTimerEl.textContent = "Reapareciendo en 3...";
        localReady = false;
    }
    addKillFeed(data.killer_team, data.victim_team);
});

socket.on("player_respawned", data => {
    if (data.id === myId) {
        isDead = false;
        localReady = false;
        deathOverlay.classList.add("hidden");
        inputQueue = [];
        lastProcessedSeq = 0;
    }
});

function addKillFeed(kt, vt) {
    const e = document.createElement("div");
    e.className = "kill-entry";
    const kc = kt === "red" ? "#ff5555" : "#4488ff";
    const vc = vt === "red" ? "#ff5555" : "#4488ff";
    e.innerHTML = `<span style="color:${kc}">${kt === "red" ? "ROJO" : "AZUL"}</span><span class="symbol"> ✦ </span><span style="color:${vc}">${vt === "red" ? "ROJO" : "AZUL"}</span>`;
    killFeed.appendChild(e);
    setTimeout(() => { e.style.opacity = "0"; setTimeout(() => e.remove(), 500); }, 3000);
    while (killFeed.children.length > 5) killFeed.removeChild(killFeed.firstChild);
}

// ═══════════════════════════════════════════
// INPUT EVENTOS
// ═══════════════════════════════════════════
window.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (k === "w") keys.w = true;
    else if (k === "a") keys.a = true;
    else if (k === "s") keys.s = true;
    else if (k === "d") keys.d = true;
    if ("wasd ".includes(k)) e.preventDefault();
});
window.addEventListener("keyup", e => {
    const k = e.key.toLowerCase();
    if (k === "w") keys.w = false;
    else if (k === "a") keys.a = false;
    else if (k === "s") keys.s = false;
    else if (k === "d") keys.d = false;
});
window.addEventListener("mousemove", e => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (myId && crosshair) {
        crosshair.style.left = mouseX + "px";
        crosshair.style.top = mouseY + "px";
    }
    if (!myId || !localReady) return;
    const camRelX = localX - camera.x;
    const camRelY = localY - camera.y;
    mouseAngle = Math.atan2(mouseY - camRelY, mouseX - camRelX);
});
window.addEventListener("mousedown", e => {
    if (e.button === 0 && myId && !isDead && localReady) {
        socket.emit("shoot", { angle: mouseAngle });
    }
});

// ═══════════════════════════════════════════
// INTERPOLACIÓN
// ═══════════════════════════════════════════
function getInterpolated(now) {
    if (snapshots.length < 2) {
        return snapshots.length ? snapshots[snapshots.length-1] : null;
    }
    const renderTime = now - INTERP_MS;
    let s0 = snapshots[0], s1 = snapshots[1];
    for (let i = 1; i < snapshots.length; i++) {
        if (snapshots[i].ts >= renderTime) {
            s0 = snapshots[i-1];
            s1 = snapshots[i];
            break;
        }
        s1 = snapshots[i];
        if (i === snapshots.length-1) s0 = snapshots[i-1];
    }
    const span = s1.ts - s0.ts;
    const t = span > 0 ? Math.min((renderTime - s0.ts) / span, 1) : 1;
    
    const p = {};
    for (const id in s1.p) {
        const a = s0.p[id], b = s1.p[id];
        if (!a) {
            p[id] = b;
            continue;
        }
        p[id] = [
            a[0] + (b[0]-a[0]) * t,
            a[1] + (b[1]-a[1]) * t,
            b[2], b[3], b[4], b[5],
            lerpAngle(a[6], b[6], t)
        ];
    }
    
    const bul = {};
    for (const id in s1.b) {
        const a = s0.b[id], b = s1.b[id];
        if (!a) {
            bul[id] = b;
            continue;
        }
        bul[id] = [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, b[2], b[3], b[4]];
    }
    
    return { p, b: bul };
}

function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
}

function inFOV(wx, wy, margin) {
    const sx = wx - camera.x, sy = wy - camera.y;
    return sx > -margin && sx < canvas.width + margin && sy > -margin && sy < canvas.height + margin;
}

// ═══════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════
function drawMap() {
    const vw = canvas.width, vh = canvas.height;
    ctx.fillStyle = "#13131b";
    ctx.fillRect(0, 0, vw, vh);
    if (!tilePattern) tilePattern = buildTilePattern();
    const offX = ((-camera.x) % (TILE_SIZE*2) + TILE_SIZE*2) % (TILE_SIZE*2);
    const offY = ((-camera.y) % (TILE_SIZE*2) + TILE_SIZE*2) % (TILE_SIZE*2);
    ctx.save();
    ctx.translate(offX - TILE_SIZE*2, offY - TILE_SIZE*2);
    ctx.fillStyle = tilePattern;
    ctx.fillRect(0, 0, vw + TILE_SIZE*4, vh + TILE_SIZE*4);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 3;
    ctx.strokeRect(-camera.x, -camera.y, MAP_WIDTH, MAP_HEIGHT);
    drawSpawnZone(250, 250, "red");
    drawSpawnZone(MAP_WIDTH-250, MAP_HEIGHT-250, "blue");
}

function drawSpawnZone(cx, cy, team) {
    if (!inFOV(cx, cy, 220)) return;
    const sx = cx - camera.x, sy = cy - camera.y;
    const c = team === "red" ? "224,48,48" : "32,96,224";
    ctx.beginPath();
    ctx.arc(sx, sy, 200, 0, Math.PI*2);
    ctx.fillStyle = `rgba(${c},0.04)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${c},0.12)`;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${c},0.5)`;
    ctx.font = "bold 11px 'Share Tech Mono',monospace";
    ctx.textAlign = "center";
    ctx.fillText(team === "red" ? "SPAWN ROJO" : "SPAWN AZUL", sx, sy);
}

function drawTerrain() {
    if (!terrainCache ||
        Math.abs(camera.x - cacheCamX) > CACHE_PAD/2 ||
        Math.abs(camera.y - cacheCamY) > CACHE_PAD/2) rebuildTerrainCache();
    ctx.drawImage(terrainCache, cacheWorldX - camera.x, cacheWorldY - camera.y);
}

function drawPlayer(pid, pd, isLocal) {
    const [px, py, hp, team, shape, dead, angle] = pd;
    if (!inFOV(px, py, 40)) return;
    const sx = px - camera.x, sy = py - camera.y, r = 20;
    const isMe = (pid === myId);
    const tc = team === "red" ? "#cc2828" : "#1850cc";
    const tb = team === "red" ? "#e84444" : "#3d78f5";
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    if (dead) ctx.globalAlpha = 0.35;
    ctx.fillStyle = tc;
    ctx.strokeStyle = isMe ? "rgba(255,255,255,0.9)" : tb;
    ctx.lineWidth = isMe ? 2.5 : 1.5;
    if (shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
    } else if (shape === "square") {
        const s = r * 1.5;
        ctx.fillRect(-s/2, -s/2, s, s);
        ctx.strokeRect(-s/2, -s/2, s, s);
    } else {
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r*.7, -r*.75);
        ctx.lineTo(-r*.7, r*.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    if (!dead) {
        const bw = 40, bh = 4, bx = sx - bw/2, by = sy - r - 10, hr = hp/100;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(bx-1, by-1, bw+2, bh+2);
        ctx.fillStyle = hr > .6 ? "#2ecc71" : hr > .3 ? "#f39c12" : "#e74c3c";
        ctx.fillRect(bx, by, bw * hr, bh);
        if (isMe) {
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = "bold 9px 'Share Tech Mono',monospace";
            ctx.textAlign = "center";
            ctx.fillText("TU", sx, by-3);
        }
    }
}

function drawProjectile(bd) {
    const [bx, by, dx, dy, ot] = bd;
    if (!inFOV(bx, by, 20)) return;
    const sx = bx - camera.x, sy = by - camera.y;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = ot === "red" ? "#ff6030" : "#30a8ff";
    ctx.fillRect(-6, -2, 12, 4);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(3, -1, 3, 2);
    ctx.restore();
}

// ═══════════════════════════════════════════
// CÁMARA - sigue posición local suavemente
// ═══════════════════════════════════════════
function updateCamera() {
    if (!localReady) {
        if (myId && snapshots.length) {
            const last = snapshots[snapshots.length-1];
            if (last.p[myId]) {
                camera.x = Math.max(0, Math.min(MAP_WIDTH - canvas.width, last.p[myId][0] - canvas.width/2));
                camera.y = Math.max(0, Math.min(MAP_HEIGHT - canvas.height, last.p[myId][1] - canvas.height/2));
            }
        }
        return;
    }
    
    // Cámara sigue la posición local con suavizado
    const targetX = Math.max(0, Math.min(MAP_WIDTH - canvas.width, localX - canvas.width/2));
    const targetY = Math.max(0, Math.min(MAP_HEIGHT - canvas.height, localY - canvas.height/2));
    
    // Movimiento de cámara suave (para no marear)
    camera.x += (targetX - camera.x) * 0.1;
    camera.y += (targetY - camera.y) * 0.1;
}

// ═══════════════════════════════════════════
// CLIENT-SIDE PREDICTION mejorada
// ═══════════════════════════════════════════
const PLAYER_SPEED_CLIENT = 250;
let lastMoveTime = 0;

function updateLocalPlayer(dt) {
    if (!myId || isDead) return;
    
    // Inicializar desde servidor
    if (!localReady && snapshots.length) {
        const last = snapshots[snapshots.length-1];
        if (last.p[myId]) {
            localX = last.p[myId][0];
            localY = last.p[myId][1];
            lastServerPos = { x: localX, y: localY };
            localReady = true;
            lastMoveTime = performance.now();
        }
        return;
    }
    if (!localReady) return;
    
    // Predicción de movimiento local
    let dx = 0, dy = 0;
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;
    if (dx && dy) {
        dx *= 0.7071;
        dy *= 0.7071;
    }
    
    // Aplicar movimiento
    const moveX = dx * PLAYER_SPEED_CLIENT * dt;
    const moveY = dy * PLAYER_SPEED_CLIENT * dt;
    
    localX = Math.max(20, Math.min(MAP_WIDTH - 20, localX + moveX));
    localY = Math.max(20, Math.min(MAP_HEIGHT - 20, localY + moveY));
}

function updateDeathTimer(dt) {
    if (!isDead) return;
    deathTimer = Math.max(0, deathTimer - dt);
    const s = Math.ceil(deathTimer);
    deathTimerEl.textContent = s > 0 ? "Reapareciendo en " + s + "..." : "Reapareciendo...";
}

function reduceQuality() {
    if (qualityReduced) return;
    qualityReduced = true;
    window.FOV_MARGIN = 50;
    terrainCache = null;
    cacheCamX = -99999;
}

// ═══════════════════════════════════════════
// GAME LOOP
// ═══════════════════════════════════════════
function gameLoop(now) {
    let dt = Math.min((now - lastTime) / 1000, 0.033); // Limitar a 33ms max
    if (dt < 0.001) dt = 0.016; // Default 60fps
    lastTime = now;
    
    // FPS monitor
    frameCount++;
    if (now - lastFPSUpdate >= 1000) {
        currentFPS = frameCount;
        frameCount = 0;
        lastFPSUpdate = now;
        if (currentFPS < 25 && !qualityReduced) reduceQuality();
    }
    
    updateLocalPlayer(dt);
    updateCamera();
    updateDeathTimer(dt);
    
    const state = getInterpolated(now);
    
    drawMap();
    drawTerrain();
    
    if (state) {
        for (const bid in state.b) drawProjectile(state.b[bid]);
        for (const pid in state.p) {
            if (pid !== myId) drawPlayer(pid, state.p[pid]);
        }
        if (myId && state.p[myId] && localReady) {
            const sp = state.p[myId];
            const renderPd = [
                localX, localY,  // Usar posición predicha local
                sp[2], sp[3], sp[4], sp[5], mouseAngle
            ];
            drawPlayer(myId, renderPd);
        }
    }
    
    requestAnimationFrame(gameLoop);
}
