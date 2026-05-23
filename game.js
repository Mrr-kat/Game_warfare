"use strict";

const socket = io({
    transports: ['websocket'], // Solo websocket para mejor performance
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

// MAPA REDUCIDO (debe coincidir con server)
const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const TILE_SIZE = 80; // Grid más grande = menos celdas a renderizar

const FOV_MARGIN = 100;
const MAX_PLAYERS_RENDER = 20; // Límite de renderizado

let myId = null;
let myTeam = null;
let myShape = null;

let gameState = { players: {}, projectiles: {} };
let keys = { w: false, a: false, s: false, d: false };
let mouseAngle = 0;
let mouseX = 0;
let mouseY = 0;

let camera = { x: 0, y: 0 };
let lastTime = performance.now();
let lastRenderTime = 0;
let frameCount = 0;
let fps = 60;

let deathTimer = 0;
let isDead = false;

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d", { alpha: false });

const lobbySel = document.getElementById("lobby-screen");
const gameSel = document.getElementById("game-screen");
const deathOverlay = document.getElementById("death-overlay");
const killFeed = document.getElementById("kill-feed");
const healthFill = document.getElementById("health-bar-fill");
const healthText = document.getElementById("health-bar-text");
const crosshair = document.getElementById("crosshair");

// TERRENO DECORATIVO REDUCIDO
const TERRAIN_SEED = 42;
let terrainObjects = [];

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

    // REDUCIDO: 40 rocas (antes 70)
    for (let i = 0; i < 40; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const w = 35 + rng() * 60;
        const h = 25 + rng() * 40;
        terrainObjects.push({
            type: "rock",
            x, y,
            r: (w + h) / 4,
            color: "#4a4a52"
        });
    }

    // REDUCIDO: 60 arbustos (antes 100)
    for (let i = 0; i < 60; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const r = 14 + rng() * 20;
        terrainObjects.push({
            type: "bush",
            x, y,
            r,
            color: "#2d6e2d"
        });
    }

    // REDUCIDO: 30 cajas (antes 50)
    for (let i = 0; i < 30; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const size = 20 + rng() * 12;
        terrainObjects.push({
            type: "crate",
            x, y,
            size,
            color: "#7a5230"
        });
    }
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
generateTerrain();

// LOBBY
let selectedTeam = "red";

const redHalf = document.getElementById("select-red");
const blueHalf = document.getElementById("select-blue");
const joinBtn = document.getElementById("join-btn");

function updateTeamSelectionUI(team) {
    if (team === "red") {
        if (redHalf) redHalf.classList.add("selected");
        if (blueHalf) blueHalf.classList.remove("selected");
    } else {
        if (blueHalf) blueHalf.classList.add("selected");
        if (redHalf) redHalf.classList.remove("selected");
    }
}

if (redHalf) {
    redHalf.addEventListener("click", () => {
        selectedTeam = "red";
        updateTeamSelectionUI("red");
    });
}

if (blueHalf) {
    blueHalf.addEventListener("click", () => {
        selectedTeam = "blue";
        updateTeamSelectionUI("blue");
    });
}

updateTeamSelectionUI(selectedTeam);

function setLobbyCursor() {
    document.body.style.cursor = "default";
    if (crosshair) crosshair.style.display = "none";
}

function setGameCursor() {
    document.body.style.cursor = "none";
    if (crosshair) crosshair.style.display = "block";
}

setLobbyCursor();

if (joinBtn) {
    joinBtn.addEventListener("click", () => {
        myTeam = selectedTeam;
        socket.emit("join_game", { team: selectedTeam });
    });
}

// EVENTOS DE RED
socket.on("joined", data => {
    myId = data.id;
    myTeam = data.team;
    myShape = data.shape;

    lobbySel.classList.remove("active");
    gameSel.classList.add("active");

    setGameCursor();

    const shapeNames = { circle: "CIRCULO", square: "CUADRADO", triangle: "TRIANGULO" };
    document.getElementById("player-shape-hud").textContent = shapeNames[myShape] || myShape.toUpperCase();

    const teamEl = document.getElementById("player-team-hud");
    teamEl.textContent = myTeam === "red" ? "BANDO ROJO" : "BANDO AZUL";
    teamEl.className = myTeam === "red" ? "red-team-text" : "blue-team-text";

    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
});

// Rate limiting para updates de UI
let lastScoreUpdate = 0;
let pendingRedCount = 0;
let pendingBlueCount = 0;

socket.on("game_state", data => {
    gameState = data;
    
    // Actualizar scores solo cada 200ms para reducir reflows
    const now = Date.now();
    if (now - lastScoreUpdate > 200) {
        let redCount = 0;
        let blueCount = 0;
        for (const pid in data.players) {
            if (data.players[pid].team === "red") redCount++;
            else blueCount++;
        }
        document.getElementById("red-count").textContent = redCount;
        document.getElementById("blue-count").textContent = blueCount;
        lastScoreUpdate = now;
    }

    if (myId && data.players[myId]) {
        const me = data.players[myId];
        const hp = Math.max(0, me.hp);
        requestAnimationFrame(() => {
            healthFill.style.width = hp + "%";
            healthText.textContent = hp;
        });
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

function addKillFeedEntry(killerTeam, victimTeam) {
    const entry = document.createElement("div");
    entry.className = "kill-entry";
    const kColor = killerTeam === "red" ? "#ff5555" : "#4488ff";
    const vColor = victimTeam === "red" ? "#ff5555" : "#4488ff";
    const kLabel = killerTeam === "red" ? "ROJO" : "AZUL";
    const vLabel = victimTeam === "red" ? "ROJO" : "AZUL";
    entry.innerHTML = `<span style="color:${kColor}">${kLabel}</span><span class="symbol"> + </span><span style="color:${vColor}">${vLabel}</span>`;
    killFeed.appendChild(entry);
    setTimeout(() => {
        entry.style.opacity = "0";
        setTimeout(() => entry.remove(), 500);
    }, 3000);
    while (killFeed.children.length > 5) killFeed.removeChild(killFeed.firstChild);
}

// INPUT con throttling
let lastInputTime = 0;
const INPUT_INTERVAL = 1000 / 40; // 40 inputs por segundo (antes 60)

window.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (k === "w") keys.w = true;
    else if (k === "a") keys.a = true;
    else if (k === "s") keys.s = true;
    else if (k === "d") keys.d = true;
    if (["w","a","s","d"," "].includes(k)) e.preventDefault();
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

    if (!myId || !gameState.players[myId]) return;
    const me = gameState.players[myId];
    const screenX = me.x - camera.x;
    const screenY = me.y - camera.y;
    mouseAngle = Math.atan2(mouseY - screenY, mouseX - screenX);
});

window.addEventListener("mousedown", e => {
    if (e.button === 0 && myId && !isDead) {
        socket.emit("shoot", { angle: mouseAngle });
    }
    e.preventDefault();
});

// Input con throttling
setInterval(() => {
    if (!myId || isDead) return;
    const now = Date.now();
    if (now - lastInputTime >= INPUT_INTERVAL) {
        socket.emit("player_input", {
            keys: { ...keys },
            angle: mouseAngle,
            dt: 0.025
        });
        lastInputTime = now;
    }
}, INPUT_INTERVAL);

// CAMPOS DE VISIÓN OPTIMIZADOS
function inFOV(wx, wy, margin) {
    const m = margin || FOV_MARGIN;
    const sx = wx - camera.x;
    const sy = wy - camera.y;
    return sx > -m && sx < canvas.width + m && sy > -m && sy < canvas.height + m;
}

// RENDER OPTIMIZADO
function drawMap() {
    const vx = camera.x;
    const vy = camera.y;
    const vw = canvas.width;
    const vh = canvas.height;

    ctx.fillStyle = "#13131b";
    ctx.fillRect(0, 0, vw, vh);

    // Grid más grande (TILE_SIZE 80 en lugar de 100)
    const startTX = Math.max(0, Math.floor(vx / TILE_SIZE));
    const startTY = Math.max(0, Math.floor(vy / TILE_SIZE));
    const endTX = Math.min(Math.floor(MAP_WIDTH / TILE_SIZE), Math.ceil((vx + vw) / TILE_SIZE));
    const endTY = Math.min(Math.floor(MAP_HEIGHT / TILE_SIZE), Math.ceil((vy + vh) / TILE_SIZE));

    for (let tx = startTX; tx <= endTX; tx++) {
        for (let ty = startTY; ty <= endTY; ty++) {
            const px = tx * TILE_SIZE - vx;
            const py = ty * TILE_SIZE - vy;
            ctx.fillStyle = (tx + ty) % 2 === 0 ? "#14141d" : "#111119";
            ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 3;
    ctx.strokeRect(-vx, -vy, MAP_WIDTH, MAP_HEIGHT);

    drawSpawnZone(150, 150, "red");
    drawSpawnZone(MAP_WIDTH - 150, MAP_HEIGHT - 150, "blue");
}

function drawSpawnZone(cx, cy, team) {
    if (!inFOV(cx, cy, 220)) return;
    const sx = cx - camera.x;
    const sy = cy - camera.y;
    const color = team === "red" ? "224,48,48" : "32,96,224";

    ctx.beginPath();
    ctx.arc(sx, sy, 180, 0, Math.PI * 2);
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

function drawTerrain() {
    for (const obj of terrainObjects) {
        if (!inFOV(obj.x, obj.y, 100)) continue;

        const sx = obj.x - camera.x;
        const sy = obj.y - camera.y;

        ctx.fillStyle = obj.color;

        if (obj.type === "rock") {
            ctx.beginPath();
            ctx.arc(sx, sy, obj.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(160,80,255,0.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();

        } else if (obj.type === "bush") {
            ctx.beginPath();
            ctx.arc(sx, sy, obj.r, 0, Math.PI * 2);
            ctx.fill();

        } else if (obj.type === "crate") {
            const s = obj.size;
            ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
            ctx.strokeStyle = "rgba(160,80,255,0.85)";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(sx - s / 2, sy - s / 2, s, s);
        }
    }
}

function drawPlayer(plr) {
    if (!inFOV(plr.x, plr.y, 50)) return;

    const sx = plr.x - camera.x;
    const sy = plr.y - camera.y;
    const r = 18;
    const isMe = plr.id === myId;

    const teamColor = plr.team === "red" ? "#cc2828" : "#1850cc";
    const teamBorder = plr.team === "red" ? "#e84444" : "#3d78f5";

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(plr.angle);

    if (plr.dead) {
        ctx.globalAlpha = 0.35;
    }

    ctx.fillStyle = teamColor;
    ctx.strokeStyle = isMe ? "rgba(255,255,255,0.9)" : teamBorder;
    ctx.lineWidth = isMe ? 2.5 : 1.5;

    if (plr.shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    } else if (plr.shape === "square") {
        const s = r * 1.4;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.strokeRect(-s / 2, -s / 2, s, s);
    } else if (plr.shape === "triangle") {
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.7, -r * 0.75);
        ctx.lineTo(-r * 0.7, r * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();

    if (!plr.dead) {
        const barW = 38;
        const barH = 4;
        const bx = sx - barW / 2;
        const by = sy - r - 8;
        const hpRatio = plr.hp / 100;

        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);

        ctx.fillStyle = hpRatio > 0.6 ? "#2ecc71" : hpRatio > 0.3 ? "#f39c12" : "#e74c3c";
        ctx.fillRect(bx, by, barW * hpRatio, barH);

        if (isMe) {
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = "bold 9px 'Share Tech Mono',monospace";
            ctx.textAlign = "center";
            ctx.fillText("TU", sx, by - 3);
        }
    }
}

function drawProjectile(proj) {
    if (!inFOV(proj.x, proj.y, 30)) return;

    const sx = proj.x - camera.x;
    const sy = proj.y - camera.y;
    const angle = Math.atan2(proj.dy, proj.dx);
    const color = proj.owner_team === "red" ? "#ff6030" : "#30a8ff";

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.fillRect(-5, -2, 10, 4);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(3, -1, 3, 2);
    ctx.restore();
}

function updateCamera() {
    if (!myId || !gameState.players[myId]) return;
    const me = gameState.players[myId];
    const tx = me.x - canvas.width / 2;
    const ty = me.y - canvas.height / 2;
    camera.x = Math.max(0, Math.min(MAP_WIDTH - canvas.width, tx));
    camera.y = Math.max(0, Math.min(MAP_HEIGHT - canvas.height, ty));
}

function updateDeathTimer(dt) {
    if (!isDead) return;
    deathTimer = Math.max(0, deathTimer - dt);
    const sec = Math.ceil(deathTimer);
    const timerEl = document.getElementById("death-timer-text");
    if (timerEl) {
        timerEl.textContent = sec > 0 ? "Reapareciendo en " + sec + "..." : "Reapareciendo...";
    }
}

// GAME LOOP OPTIMIZADO con frame rate limit
let lastFrameTime = 0;
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

function gameLoop(now) {
    requestAnimationFrame(gameLoop);
    
    const delta = now - lastFrameTime;
    if (delta < FRAME_INTERVAL) return;
    
    lastFrameTime = now - (delta % FRAME_INTERVAL);
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    updateCamera();
    updateDeathTimer(dt);

    drawMap();
    drawTerrain();

    // Renderizar proyectiles
    for (const pid in gameState.projectiles) {
        drawProjectile(gameState.projectiles[pid]);
    }

    // Renderizar jugadores
    const players = Object.values(gameState.players);
    for (const plr of players) {
        if (plr.id !== myId) drawPlayer(plr);
    }
    if (myId && gameState.players[myId]) {
        drawPlayer(gameState.players[myId]);
    }
}

// Iniciar después de cargar
window.addEventListener('load', () => {
    lastTime = performance.now();
    lastFrameTime = performance.now();
});
