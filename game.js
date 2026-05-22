"use strict";

const socket = io({ transports: ["websocket"], reconnectionAttempts: 5 });

const MAP_WIDTH  = 4000;
const MAP_HEIGHT = 4000;
const TILE_SIZE  = 200;
const FOV_MARGIN = 60; // Reducido de 80 para mejor rendimiento
const SERVER_HZ  = 15; // Coincide con servidor
const INTERP_MS  = 1000 / SERVER_HZ;

let myId    = null;
let myTeam  = null;
let myShape = null;

let snapshots = [];
let qualityReduced = false;
let frameCount = 0;
let lastFPSUpdate = 0;
let currentFPS = 60;
let inputInterval = null;

let keys = { w: false, a: false, s: false, d: false };
let mouseAngle = 0;
let mouseX = 0, mouseY = 0;

let localX = 0, localY = 0;
let localReady = false;

let camera   = { x: 0, y: 0 };
let lastTime = performance.now();
let deathTimer = 0;
let isDead   = false;

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
// TERRENO (Reducido para mejor rendimiento)
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
    // Reducido de 70 a 40 rocas
    for(let i=0;i<40;i++){
        const x=rng()*MAP_WIDTH, y=rng()*MAP_HEIGHT;
        const w=40+rng()*70, h=28+rng()*50;
        rng();
        terrainObjects.push({type:"rock",x,y,r:(w+h)/4});
    }
    // Reducido de 100 a 60 bushes
    for(let i=0;i<60;i++){
        const x=rng()*MAP_WIDTH, y=rng()*MAP_HEIGHT, r=16+rng()*24;
        rng();rng();rng();
        terrainObjects.push({type:"bush",x,y,r});
    }
    // Reducido de 50 a 30 crates
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
const CACHE_PAD = 250; // Reducido de 300
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

// ═══════════════════════════════════════════
// TILE PATTERN
// ═══════════════════════════════════════════
let tilePattern = null;
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
    tilePattern = ctx.createPattern(tc, "repeat");
}

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
    
    // Configurar intervalo de input optimizado
    if (inputInterval) clearInterval(inputInterval);
    inputInterval = setInterval(() => {
        if (!myId || isDead) return;
        const ks = `${+keys.w}${+keys.a}${+keys.s}${+keys.d}`;
        if (ks === lastSentKeys && Math.abs(mouseAngle - lastSentAngle) < 0.02) return;
        lastSentKeys = ks;
        lastSentAngle = mouseAngle;
        socket.emit("player_input", { keys: { ...keys }, angle: mouseAngle, dt: 0.05 });
    }, 66); // ~15 veces por segundo (reducido de 50ms)
    
    requestAnimationFrame(gameLoop);
});

let lastSentKeys = "";
let lastSentAngle = 0;

socket.on("game_state", data => {
    const ts = performance.now();
    snapshots.push({ ts, p: data.p, b: data.b });
    if (snapshots.length > 3) snapshots.shift();
    
    let rc = 0, bc = 0;
    for (const id in data.p) {
        if (data.p[id][3] === "red") rc++;
        else bc++;
    }
    document.getElementById("red-count").textContent = rc;
    document.getElementById("blue-count").textContent = bc;
    
    if (myId && data.p[myId]) {
        const hp = Math.max(0, data.p[myId][2]);
        healthFill.style.width = hp + "%";
        healthText.textContent = hp;
        healthFill.style.background = hp > 60 ? "linear-gradient(90deg,#2ecc71,#27ae60)" :
                                      hp > 30 ? "linear-gradient(90deg,#f39c12,#e67e22)" :
                                                "linear-gradient(90deg,#e74c3c,#c0392b)";
        if (localReady && !isDead) {
            const srvX = data.p[myId][0], srvY = data.p[myId][1];
            localX += (srvX - localX) * 0.3; // Aumentado de 0.2 para mejor reconciliación
            localY += (srvY - localY) * 0.3;
        }
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
    }
    addKillFeed(data.killer_team, data.victim_team);
});

socket.on("player_respawned", data => {
    if (data.id === myId) {
        isDead = false;
        localReady = false;
        deathOverlay.classList.add("hidden");
    }
});
socket.on("player_left", () => {});

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
// INPUT
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
    if (!myId) return;
    const camRelX = (localReady ? localX : 0) - camera.x;
    const camRelY = (localReady ? localY : 0) - camera.y;
    mouseAngle = Math.atan2(mouseY - camRelY, mouseX - camRelX);
});
window.addEventListener("mousedown", e => {
    if (e.button === 0 && myId && !isDead) socket.emit("shoot", { angle: mouseAngle });
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

// ═══════════════════════════════════════════
// FOV
// ═══════════════════════════════════════════
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
    if (!tilePattern) buildTilePattern();
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
    const c = team === "red" ? "224
