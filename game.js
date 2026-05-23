"use strict";

const socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

// MAPA
const MAP_WIDTH = 2500;
const MAP_HEIGHT = 2500;
const TILE_SIZE = 70;
const FOV_MARGIN = 100;

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

let deathTimer = 0;
let isDead = false;

// Variables para interpolación
let lastServerState = null;
let nextServerState = null;
let lastStateTime = 0;
let nextStateTime = 0;
let interpolationFactor = 0;

// Variables para predicción de movimiento local
let localPlayer = null;
let lastSentInput = { keys: {}, angle: 0, time: 0 };
let pendingInputs = [];

// FPS y Ping
let fps = 60;
let ping = 0;
let lastPingTime = 0;
let frameTimes = [];
let lastFrameTime = performance.now();
let lastPingRequest = 0;

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d", { alpha: false });

const lobbySel = document.getElementById("lobby-screen");
const gameSel = document.getElementById("game-screen");
const deathOverlay = document.getElementById("death-overlay");
const killFeed = document.getElementById("kill-feed");
const healthFill = document.getElementById("health-bar-fill");
const healthText = document.getElementById("health-bar-text");
const crosshair = document.getElementById("crosshair");

// Monitor de rendimiento
const performanceDiv = document.createElement("div");
performanceDiv.id = "performance-monitor";
performanceDiv.style.cssText = `
    position: fixed;
    bottom: 10px;
    left: 10px;
    background: rgba(0,0,0,0.7);
    color: #0f0;
    font-family: 'Share Tech Mono', monospace;
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 4px;
    z-index: 1000;
    pointer-events: none;
    backdrop-filter: blur(4px);
    border: 1px solid rgba(255,255,255,0.2);
`;
document.body.appendChild(performanceDiv);

// TERRENO
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

    for (let i = 0; i < 35; i++) {
        const x = rng() * MAP_WIDTH;
        const y = rng() * MAP_HEIGHT;
        const w = 35 + rng() * 55;
        const h = 25 + rng() * 35;
        terrainObjects.push({
            type: "rock",
            x, y,
            r: (w + h) / 4,
            color: "#4a4a52"
        });
    }

    for (let i = 0; i < 35; i++) {
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
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
generateTerrain();

// Ping periódico
setInterval(() => {
    if (myId) {
        lastPingRequest = Date.now();
        socket.emit("ping_request");
    }
}, 2000);

socket.on("pong_response", () => {
    ping = Date.now() - lastPingRequest;
});

// Calcular FPS
function updatePerformance() {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    
    frameTimes.push(delta);
    if (frameTimes.length > 60) frameTimes.shift();
    
    const avgDelta = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    fps = Math.round(1000 / avgDelta);
    
    const pingColor = ping < 100 ? "#0f0" : (ping < 200 ? "#ff0" : "#f00");
    const interpInfo = interpolationFactor ? `| INTERP: ${Math.round(interpolationFactor * 100)}%` : '';
    performanceDiv.innerHTML = `FPS: ${fps} | PING: <span style="color:${pingColor}">${ping}ms</span> ${interpInfo}`;
}

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

    // Inicializar jugador local
    localPlayer = {
        id: myId,
        x: data.x,
        y: data.y,
        hp: 100,
        team: myTeam,
        shape: myShape,
        angle: 0
    };

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

// Rate limiting para UI
let lastScoreUpdate = 0;

socket.on("game_state", data => {
    const now = Date.now();
    
    // Actualizar scores
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

    // ACTUALIZACIÓN DE JUGADORES CON INTERPOLACIÓN
    const currentTime = performance.now() / 1000;
    
    if (lastServerState && nextServerState) {
        // Mover el estado anterior al next para interpolación
        lastServerState = nextServerState;
        lastStateTime = nextStateTime;
    } else if (!lastServerState) {
        lastServerState = data;
        lastStateTime = currentTime;
        return;
    }
    
    nextServerState = data;
    nextStateTime = currentTime;
    
    // Actualizar proyectiles directamente (son muchos cambios)
    gameState.projectiles = data.projectiles;
    
    // Actualizar vida del jugador local
    if (myId && data.players[myId]) {
        const serverMe = data.players[myId];
        if (localPlayer) {
            // Corrección del servidor si es necesario
            const dx = Math.abs(localPlayer.x - serverMe.x);
            const dy = Math.abs(localPlayer.y - serverMe.y);
            if (dx > 50 || dy > 50) {
                // Si hay mucha diferencia, corregir posición
                localPlayer.x = serverMe.x;
                localPlayer.y = serverMe.y;
            }
            localPlayer.hp = serverMe.hp;
            localPlayer.angle = serverMe.angle;
            localPlayer.dead = serverMe.dead;
        }
        
        // Actualizar UI de vida
        const hp = Math.max(0, serverMe.hp);
        healthFill.style.width = hp + "%";
        healthText.textContent = hp;
    }
});

// Función para obtener jugador interpolado
function getInterpolatedPlayer(playerId) {
    if (!lastServerState || !nextServerState) return null;
    
    // Calcular factor de interpolación (0 a 1)
    const currentTime = performance.now() / 1000;
    const totalTime = nextStateTime - lastStateTime;
    let t = totalTime > 0 ? (currentTime - lastStateTime) / totalTime : 1;
    t = Math.min(1, Math.max(0, t));
    interpolationFactor = t;
    
    const lastPlayer = lastServerState.players[playerId];
    const nextPlayer = nextServerState.players[playerId];
    
    if (!lastPlayer || !nextPlayer) return nextPlayer || lastPlayer;
    if (playerId === myId && localPlayer) return localPlayer;
    
    // Interpolar posición
    return {
        ...nextPlayer,
        x: lastPlayer.x + (nextPlayer.x - lastPlayer.x) * t,
        y: lastPlayer.y + (nextPlayer.y - lastPlayer.y) * t,
        angle: lastPlayer.angle + (nextPlayer.angle - lastPlayer.angle) * t
    };
}

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
        if (localPlayer) localPlayer.dead = false;
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

// INPUT con predicción
let lastInputTime = 0;
const INPUT_INTERVAL = 1000 / 30; // 30 inputs por segundo

// Movimiento local del jugador
let lastMoveTime = 0;
const PLAYER_SPEED = 280;

function updateLocalMovement(dt) {
    if (!localPlayer || isDead) return;
    
    let dx = 0, dy = 0;
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;
    
    if (dx !== 0 || dy !== 0) {
        const length = Math.hypot(dx, dy);
        dx /= length;
        dy /= length;
    }
    
    // Movimiento local (predicción)
    localPlayer.x += dx * PLAYER_SPEED * dt;
    localPlayer.y += dy * PLAYER_SPEED * dt;
    
    // Limitar al mapa
    localPlayer.x = Math.max(20, Math.min(MAP_WIDTH - 20, localPlayer.x));
    localPlayer.y = Math.max(20, Math.min(MAP_HEIGHT - 20, localPlayer.y));
    localPlayer.angle = mouseAngle;
}

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

// Envío de input al servidor
setInterval(() => {
    if (!myId || isDead || !localPlayer) return;
    const now = Date.now();
    if (now - lastInputTime >= INPUT_INTERVAL) {
        socket.emit("player_input", {
            keys: { ...keys },
            angle: mouseAngle,
            x: localPlayer.x,
            y: localPlayer.y,
            dt: 0.033
        });
        lastInputTime = now;
    }
}, INPUT_INTERVAL);

// CAMPOS DE VISIÓN
function inFOV(wx, wy, margin) {
    const m = margin || FOV_MARGIN;
    const sx = wx - camera.x;
    const sy = wy - camera.y;
    return sx > -m && sx < canvas.width + m && sy > -m && sy < canvas.height + m;
}

// RENDER
function drawMap() {
    const vx = camera.x;
    const vy = camera.y;
    const vw = canvas.width;
    const vh = canvas.height;

    ctx.fillStyle = "#13131b";
    ctx.fillRect(0, 0, vw, vh);

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
    ctx.arc(sx, sy, 160, 0, Math.PI * 2);
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
        }
    }
}

function drawPlayer(plr, isLocal = false) {
    if (!plr) return;
    if (!inFOV(plr.x, plr.y, 50)) return;

    const sx = plr.x - camera.x;
    const sy = plr.y - camera.y;
    const r = 18;

    const teamColor = plr.team === "red" ? "#cc2828" : "#1850cc";
    const teamBorder = plr.team === "red" ? "#e84444" : "#3d78f5";

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(plr.angle || 0);

    if (plr.dead) {
        ctx.globalAlpha = 0.35;
    }

    ctx.fillStyle = teamColor;
    ctx.strokeStyle = isLocal ? "rgba(255,255,255,0.9)" : teamBorder;
    ctx.lineWidth = isLocal ? 2.5 : 1.5;

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
        const hpRatio = (plr.hp || 100) / 100;

        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);

        ctx.fillStyle = hpRatio > 0.6 ? "#2ecc71" : hpRatio > 0.3 ? "#f39c12" : "#e74c3c";
        ctx.fillRect(bx, by, barW * hpRatio, barH);

        if (isLocal) {
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
    if (!localPlayer) return;
    const tx = localPlayer.x - canvas.width / 2;
    const ty = localPlayer.y - canvas.height / 2;
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

let lastFrameRender = 0;
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

function gameLoop(now) {
    requestAnimationFrame(gameLoop);
    
    const delta = now - lastFrameRender;
    if (delta < FRAME_INTERVAL) return;
    
    lastFrameRender = now - (delta % FRAME_INTERVAL);
    const dt = Math.min((now - lastTime) / 1000, 0.033);
    lastTime = now;

    // Actualizar movimiento local (predicción)
    updateLocalMovement(dt);
    
    updatePerformance();
    updateCamera();
    updateDeathTimer(dt);

    drawMap();
    drawTerrain();

    // Dibujar proyectiles
    for (const pid in gameState.projectiles) {
        drawProjectile(gameState.projectiles[pid]);
    }

    // Dibujar otros jugadores con interpolación
    if (lastServerState && nextServerState) {
        for (const pid in lastServerState.players) {
            if (pid !== myId) {
                const interpolatedPlayer = getInterpolatedPlayer(pid);
                if (interpolatedPlayer) {
                    drawPlayer(interpolatedPlayer, false);
                }
            }
        }
    }

    // Dibujar jugador local
    if (localPlayer) {
        drawPlayer(localPlayer, true);
    }
}

window.addEventListener('load', () => {
    lastTime = performance.now();
    lastFrameRender = performance.now();
    lastFrameTime = performance.now();
});
