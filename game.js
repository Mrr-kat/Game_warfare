"use strict";

const socket = io({ transports: ["websocket"] }); // evita polling HTTP fallback

const MAP_WIDTH = 5000;
const MAP_HEIGHT = 5000;
const TILE_SIZE = 100;
const FOV_MARGIN = 80;

let myId = null;
let myTeam = null;
let myShape = null;

// Estado del juego: formato compacto que viene del servidor
let gameState = { p: {}, b: {} };

let keys = { w: false, a: false, s: false, d: false };
let mouseAngle = 0;
let mouseX = 0;
let mouseY = 0;

let camera = { x: 0, y: 0 };
let lastTime = performance.now();

let deathTimer = 0;
let isDead = false;

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d", { alpha: false });

const lobbySel   = document.getElementById("lobby-screen");
const gameSel    = document.getElementById("game-screen");
const deathOverlay = document.getElementById("death-overlay");
const killFeed   = document.getElementById("kill-feed");
const healthFill = document.getElementById("health-bar-fill");
const healthText = document.getElementById("health-bar-text");
const crosshair  = document.getElementById("crosshair");

// ─────────────────────────────────────────
// TERRENO  (generado 1 sola vez, igual que el servidor)
// ─────────────────────────────────────────
const TERRAIN_SEED = 42;
let terrainObjects = [];

// Cache de terreno: se dibuja 1 vez en un OffscreenCanvas y se reutiliza
let terrainCache = null;
let terrainCacheOffsetX = 0;
let terrainCacheOffsetY = 0;
const CACHE_PAD = 400; // píxeles extra alrededor de la pantalla para el cache

function seededRandom(seed) {
    let s = seed;
    return function () {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
    };
}

function generateTerrain() {
    const rng = seededRandom(TERRAIN_SEED);
    terrainObjects = [];

    for (let i = 0; i < 70; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const w = 40 + rng() * 70;
        const h = 28 + rng() * 50;
        rng();
        terrainObjects.push({ type: "rock",  x, y, r: (w + h) / 4 });
    }
    for (let i = 0; i < 100; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const r = 16 + rng() * 24;
        rng(); rng(); rng();
        terrainObjects.push({ type: "bush", x, y, r });
    }
    for (let i = 0; i < 50; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const size = 22 + rng() * 14;
        rng();
        terrainObjects.push({ type: "crate", x, y, size });
    }
}

// Dibuja el terreno completo en un canvas fuera de pantalla.
// Solo se llama cuando la cámara se mueve demasiado (cada ~CACHE_PAD px).
function rebuildTerrainCache() {
    const cw = canvas.width  + CACHE_PAD * 2;
    const ch = canvas.height + CACHE_PAD * 2;

    terrainCacheOffsetX = camera.x - CACHE_PAD;
    terrainCacheOffsetY = camera.y - CACHE_PAD;

    if (!terrainCache || terrainCache.width !== cw || terrainCache.height !== ch) {
        terrainCache = document.createElement("canvas");
        terrainCache.width  = cw;
        terrainCache.height = ch;
    }

    const c = terrainCache.getContext("2d", { alpha: false });
    c.clearRect(0, 0, cw, ch);

    for (const obj of terrainObjects) {
        const sx = obj.x - terrainCacheOffsetX;
        const sy = obj.y - terrainCacheOffsetY;
        if (sx + 120 < 0 || sx - 120 > cw || sy + 120 < 0 || sy - 120 > ch) continue;

        if (obj.type === "rock") {
            c.fillStyle = "#4a4a52";
            c.beginPath();
            c.arc(sx, sy, obj.r, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = "rgba(160,80,255,0.85)";
            c.lineWidth = 2;
            c.stroke();
        } else if (obj.type === "bush") {
            c.fillStyle = "#2d6e2d";
            c.beginPath();
            c.arc(sx, sy, obj.r, 0, Math.PI * 2);
            c.fill();
        } else if (obj.type === "crate") {
            const s = obj.size;
            c.fillStyle = "#7a5230";
            c.fillRect(sx - s / 2, sy - s / 2, s, s);
            c.strokeStyle = "rgba(160,80,255,0.85)";
            c.lineWidth = 2;
            c.strokeRect(sx - s / 2, sy - s / 2, s, s);
        }
    }
}

// ─────────────────────────────────────────
// RESIZE
// ─────────────────────────────────────────
function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    terrainCache  = null; // forzar rebuild del cache
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
generateTerrain();

// ─────────────────────────────────────────
// LOBBY
// ─────────────────────────────────────────
let selectedTeam = "red";

const redHalf  = document.getElementById("select-red");
const blueHalf = document.getElementById("select-blue");
const joinBtn  = document.getElementById("join-btn");

function updateTeamSelectionUI(team) {
    redHalf  && redHalf .classList.toggle("selected", team === "red");
    blueHalf && blueHalf.classList.toggle("selected", team === "blue");
}

redHalf  && redHalf .addEventListener("click", () => { selectedTeam = "red";  updateTeamSelectionUI("red");  });
blueHalf && blueHalf.addEventListener("click", () => { selectedTeam = "blue"; updateTeamSelectionUI("blue"); });
updateTeamSelectionUI(selectedTeam);

function setLobbyCursor() { document.body.style.cursor = "default"; crosshair && (crosshair.style.display = "none"); }
function setGameCursor()  { document.body.style.cursor = "none";    crosshair && (crosshair.style.display = "block"); }
setLobbyCursor();

joinBtn && joinBtn.addEventListener("click", () => {
    myTeam = selectedTeam;
    socket.emit("join_game", { team: selectedTeam });
});

// ─────────────────────────────────────────
// EVENTOS DE RED
// ─────────────────────────────────────────
socket.on("joined", data => {
    myId    = data.id;
    myTeam  = data.team;
    myShape = data.shape;

    lobbySel.classList.remove("active");
    gameSel .classList.add("active");
    setGameCursor();

    const shapeNames = { circle: "CIRCULO", square: "CUADRADO", triangle: "TRIANGULO" };
    document.getElementById("player-shape-hud").textContent = shapeNames[myShape] || myShape.toUpperCase();

    const teamEl = document.getElementById("player-team-hud");
    teamEl.textContent = myTeam === "red" ? "BANDO ROJO" : "BANDO AZUL";
    teamEl.className   = myTeam === "red" ? "red-team-text" : "blue-team-text";

    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
});

// El servidor ahora envía estado compacto: arrays en lugar de objetos
// Formato p: { id: [x, y, hp, team, shape, dead, angle] }
// Formato b: { id: [x, y, dx, dy, owner_team] }
socket.on("game_state", data => {
    gameState = data;

    let redCount = 0, blueCount = 0;
    for (const pid in data.p) {
        if (data.p[pid][3] === "red") redCount++; else blueCount++;
    }
    document.getElementById("red-count") .textContent = redCount;
    document.getElementById("blue-count").textContent = blueCount;

    if (myId && data.p[myId]) {
        const hp = Math.max(0, data.p[myId][2]);
        healthFill.style.width = hp + "%";
        healthText.textContent = hp;
        healthFill.style.background =
            hp > 60 ? "linear-gradient(90deg,#2ecc71,#27ae60)" :
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
        document.getElementById("death-timer-text").textContent = "Reapareciendo en 3...";
    }
    addKillFeedEntry(data.killer_team, data.victim_team);
});

socket.on("player_respawned", data => {
    if (data.id === myId) {
        isDead = false;
        deathOverlay.classList.add("hidden");
    }
});

socket.on("player_left", () => {});

function addKillFeedEntry(killerTeam, victimTeam) {
    const entry = document.createElement("div");
    entry.className = "kill-entry";
    const kColor = killerTeam === "red" ? "#ff5555" : "#4488ff";
    const vColor = victimTeam === "red" ? "#ff5555" : "#4488ff";
    const kLabel = killerTeam === "red" ? "ROJO" : "AZUL";
    const vLabel = victimTeam === "red" ? "ROJO" : "AZUL";
    entry.innerHTML = `<span style="color:${kColor}">${kLabel}</span><span class="symbol"> ✦ </span><span style="color:${vColor}">${vLabel}</span>`;
    killFeed.appendChild(entry);
    setTimeout(() => { entry.style.opacity = "0"; setTimeout(() => entry.remove(), 500); }, 3000);
    while (killFeed.children.length > 5) killFeed.removeChild(killFeed.firstChild);
}

// ─────────────────────────────────────────
// INPUT — envío adaptativo
// Reduce frecuencia si la pestaña está en background.
// Solo envía si hay cambio relevante (keys o ángulo cambió).
// ─────────────────────────────────────────
let lastSentAngle = 0;
let lastSentKeys  = "";
const INPUT_INTERVAL = 50; // ms — 20 veces/s, igual que el tick rate del servidor

setInterval(() => {
    if (!myId || isDead) return;
    const keysStr = `${+keys.w}${+keys.a}${+keys.s}${+keys.d}`;
    const angleDiff = Math.abs(mouseAngle - lastSentAngle);
    if (keysStr === lastSentKeys && angleDiff < 0.02) return; // sin cambios, no enviar
    lastSentKeys  = keysStr;
    lastSentAngle = mouseAngle;
    socket.emit("player_input", { keys: { ...keys }, angle: mouseAngle, dt: INPUT_INTERVAL / 1000 });
}, INPUT_INTERVAL);

// ─────────────────────────────────────────
// INPUT — teclado y ratón
// ─────────────────────────────────────────
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
    if (myId) { crosshair.style.left = mouseX + "px"; crosshair.style.top = mouseY + "px"; }
    if (!myId || !gameState.p[myId]) return;
    const me = gameState.p[myId];
    const screenX = me[0] - camera.x;
    const screenY = me[1] - camera.y;
    mouseAngle = Math.atan2(mouseY - screenY, mouseX - screenX);
});

window.addEventListener("mousedown", e => {
    if (e.button === 0 && myId && !isDead) socket.emit("shoot", { angle: mouseAngle });
});

// ─────────────────────────────────────────
// FOV helpers
// ─────────────────────────────────────────
function inFOV(wx, wy, margin) {
    const sx = wx - camera.x;
    const sy = wy - camera.y;
    return sx > -margin && sx < canvas.width  + margin &&
           sy > -margin && sy < canvas.height + margin;
}

// ─────────────────────────────────────────
// RENDER — MAPA BASE (tiles cacheados con createPattern)
// ─────────────────────────────────────────
let tilePattern = null;

function buildTilePattern() {
    // Crea un micro-canvas 2×2 tiles y lo convierte en patrón repetible
    const tc = document.createElement("canvas");
    tc.width  = TILE_SIZE * 2;
    tc.height = TILE_SIZE * 2;
    const tc2 = tc.getContext("2d");
    tc2.fillStyle = "#14141d";
    tc2.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    tc2.fillRect(TILE_SIZE, TILE_SIZE, TILE_SIZE, TILE_SIZE);
    tc2.fillStyle = "#111119";
    tc2.fillRect(TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
    tc2.fillRect(0, TILE_SIZE, TILE_SIZE, TILE_SIZE);
    tilePattern = ctx.createPattern(tc, "repeat");
}

function drawMap() {
    const vw = canvas.width;
    const vh = canvas.height;

    // Fondo base
    ctx.fillStyle = "#13131b";
    ctx.fillRect(0, 0, vw, vh);

    // Tiles via patrón (1 sola llamada fillRect en vez de N×M)
    if (!tilePattern) buildTilePattern();
    ctx.save();
    ctx.translate(-camera.x % (TILE_SIZE * 2), -camera.y % (TILE_SIZE * 2));
    ctx.fillStyle = tilePattern;
    ctx.fillRect(
        -((-camera.x % (TILE_SIZE * 2)) + TILE_SIZE * 2),
        -((-camera.y % (TILE_SIZE * 2)) + TILE_SIZE * 2),
        vw + TILE_SIZE * 4,
        vh + TILE_SIZE * 4
    );
    ctx.restore();

    // Borde del mapa
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 3;
    ctx.strokeRect(-camera.x, -camera.y, MAP_WIDTH, MAP_HEIGHT);

    drawSpawnZone(250, 250, "red");
    drawSpawnZone(MAP_WIDTH - 250, MAP_HEIGHT - 250, "blue");
}

function drawSpawnZone(cx, cy, team) {
    if (!inFOV(cx, cy, 220)) return;
    const sx = cx - camera.x;
    const sy = cy - camera.y;
    const color = team === "red" ? "224,48,48" : "32,96,224";

    ctx.beginPath();
    ctx.arc(sx, sy, 200, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},0.04)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${color},0.12)`;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${color},0.5)`;
    ctx.font = "bold 11px 'Share Tech Mono',monospace";
    ctx.textAlign = "center";
    ctx.fillText(team === "red" ? "SPAWN ROJO" : "SPAWN AZUL", sx, sy);
}

// ─────────────────────────────────────────
// RENDER — TERRENO (desde cache)
// ─────────────────────────────────────────
let lastCacheCamX = -9999;
let lastCacheCamY = -9999;

function drawTerrain() {
    // Reconstruir cache si la cámara se alejó más de CACHE_PAD/2
    if (!terrainCache ||
        Math.abs(camera.x - lastCacheCamX) > CACHE_PAD / 2 ||
        Math.abs(camera.y - lastCacheCamY) > CACHE_PAD / 2) {
        rebuildTerrainCache();
        lastCacheCamX = camera.x;
        lastCacheCamY = camera.y;
    }
    // Dibujar el cache de terreno con 1 sola llamada drawImage
    ctx.drawImage(terrainCache,
        camera.x - terrainCacheOffsetX,
        camera.y - terrainCacheOffsetY,
        canvas.width,
        canvas.height,
        0, 0,
        canvas.width,
        canvas.height
    );
}

// ─────────────────────────────────────────
// RENDER — JUGADORES  (datos en array compacto)
// [x, y, hp, team, shape, dead, angle]
// ─────────────────────────────────────────
function drawPlayer(pid, pd) {
    const [px, py, hp, team, shape, dead, angle] = pd;
    if (!inFOV(px, py, 40)) return;

    const sx = px - camera.x;
    const sy = py - camera.y;
    const r  = 20;
    const isMe = pid === myId;

    const teamColor  = team === "red" ? "#cc2828" : "#1850cc";
    const teamBorder = team === "red" ? "#e84444" : "#3d78f5";

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    if (dead) ctx.globalAlpha = 0.35;

    ctx.fillStyle   = teamColor;
    ctx.strokeStyle = isMe ? "rgba(255,255,255,0.9)" : teamBorder;
    ctx.lineWidth   = isMe ? 2.5 : 1.5;

    if (shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
    } else if (shape === "square") {
        const s = r * 1.5;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.strokeRect(-s / 2, -s / 2, s, s);
    } else {
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.7, -r * 0.75);
        ctx.lineTo(-r * 0.7,  r * 0.75);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (!dead) {
        const barW = 40;
        const barH = 4;
        const bx   = sx - barW / 2;
        const by   = sy - r - 10;
        const hpR  = hp / 100;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = hpR > 0.6 ? "#2ecc71" : hpR > 0.3 ? "#f39c12" : "#e74c3c";
        ctx.fillRect(bx, by, barW * hpR, barH);
        if (isMe) {
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = "bold 9px 'Share Tech Mono',monospace";
            ctx.textAlign = "center";
            ctx.fillText("TU", sx, by - 3);
        }
    }
}

// ─────────────────────────────────────────
// RENDER — PROYECTILES  [x, y, dx, dy, owner_team]
// ─────────────────────────────────────────
function drawProjectile(bd) {
    const [bx, by, dx, dy, owner_team] = bd;
    if (!inFOV(bx, by, 20)) return;

    const sx    = bx - camera.x;
    const sy    = by - camera.y;
    const angle = Math.atan2(dy, dx);
    const color = owner_team === "red" ? "#ff6030" : "#30a8ff";

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.fillRect(-6, -2, 12, 4);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(3, -1, 3, 2);
    ctx.restore();
}

// ─────────────────────────────────────────
// CÁMARA
// ─────────────────────────────────────────
function updateCamera() {
    if (!myId || !gameState.p[myId]) return;
    const [px, py] = gameState.p[myId];
    const tx = px - canvas.width  / 2;
    const ty = py - canvas.height / 2;
    camera.x = Math.max(0, Math.min(MAP_WIDTH  - canvas.width,  tx));
    camera.y = Math.max(0, Math.min(MAP_HEIGHT - canvas.height, ty));
}

// ─────────────────────────────────────────
// TIMER DE MUERTE
// ─────────────────────────────────────────
const deathTimerEl = document.getElementById("death-timer-text");
function updateDeathTimer(dt) {
    if (!isDead) return;
    deathTimer = Math.max(0, deathTimer - dt);
    const sec = Math.ceil(deathTimer);
    deathTimerEl.textContent = sec > 0 ? "Reapareciendo en " + sec + "..." : "Reapareciendo...";
}

// ─────────────────────────────────────────
// GAME LOOP  (solo render — la física está en el servidor)
// ─────────────────────────────────────────
function gameLoop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    updateCamera();
    updateDeathTimer(dt);

    drawMap();
    drawTerrain();

    // Proyectiles
    for (const bid in gameState.b) {
        drawProjectile(gameState.b[bid]);
    }

    // Jugadores: primero los demás, luego yo (para quedar encima)
    for (const pid in gameState.p) {
        if (pid !== myId) drawPlayer(pid, gameState.p[pid]);
    }
    if (myId && gameState.p[myId]) {
        drawPlayer(myId, gameState.p[myId]);
    }

    requestAnimationFrame(gameLoop);
}
