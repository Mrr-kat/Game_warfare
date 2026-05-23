"use strict";

const socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

const MAP_WIDTH = 2500;
const MAP_HEIGHT = 2500;
const TILE_SIZE = 70;
const FOV_MARGIN = 100;
const PLAYER_SPEED = 280;
const PLAYER_RADIUS = 20;
const INTERP_DELAY = 100;

let myId = null;
let myTeam = null;
let myShape = null;
let myName = "";
let killsToWin = 20;

let serverState = { players: {}, projectiles: {}, team_kills: { red: 0, blue: 0 } };
let stateBuffer = [];

let keys = { w: false, a: false, s: false, d: false };
let mouseAngle = 0;
let mouseX = 0;
let mouseY = 0;

let camera = { x: 0, y: 0 };
let lastTime = performance.now();
let deathTimer = 0;
let isDead = false;
let isGameOver = false;
let victoryCountdown = 8;

// Predicción local
let localPlayer = { x: 0, y: 0, angle: 0 };

// Leaderboard
let currentLeaderboard = [];
let teamKills = { red: 0, blue: 0 };
let boardVisible = false;

// FPS / Ping
let fps = 60;
let ping = 0;
let lastPingRequest = 0;
let frameTimes = [];
let lastFrameTime = performance.now();

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d", { alpha: false });

const lobbySel = document.getElementById("lobby-screen");
const gameSel = document.getElementById("game-screen");
const deathOverlay = document.getElementById("death-overlay");
const victoryOverlay = document.getElementById("victory-overlay");
const killFeed = document.getElementById("kill-feed");
const healthFill = document.getElementById("health-bar-fill");
const healthText = document.getElementById("health-bar-text");
const crosshair = document.getElementById("crosshair");
const lbPanel = document.getElementById("leaderboard-panel");
const lbBody = document.getElementById("lb-body");
const toggleBoardBtn = document.getElementById("toggle-board-btn");
const victoryTimer = document.getElementById("victory-timer");

// Performance monitor
const performanceDiv = document.createElement("div");
performanceDiv.id = "performance-monitor";
performanceDiv.style.cssText = `
    position:fixed;bottom:10px;left:10px;background:rgba(0,0,0,0.7);
    color:#0f0;font-family:'Share Tech Mono',monospace;font-size:12px;
    padding:5px 10px;border-radius:4px;z-index:1000;pointer-events:none;
    backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.2);`;
document.body.appendChild(performanceDiv);

// TERRAIN
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
        const x = rng() * MAP_WIDTH, y = rng() * MAP_HEIGHT;
        const w = 35 + rng() * 55, h = 25 + rng() * 35;
        terrainObjects.push({ type: "rock", x, y, r: (w + h) / 4, color: "#4a4a52" });
    }
    for (let i = 0; i < 35; i++) {
        const x = rng() * MAP_WIDTH, y = rng() * MAP_HEIGHT;
        const r = 14 + rng() * 20;
        terrainObjects.push({ type: "bush", x, y, r, color: "#2d6e2d" });
    }
}

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
generateTerrain();

// Ping
setInterval(() => {
    if (myId) { lastPingRequest = Date.now(); socket.emit("ping_request"); }
}, 2000);
socket.on("pong_response", () => { ping = Date.now() - lastPingRequest; });

function updatePerformance() {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    frameTimes.push(delta);
    if (frameTimes.length > 60) frameTimes.shift();
    fps = Math.round(1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length));
    const pingColor = ping < 100 ? "#0f0" : ping < 200 ? "#ff0" : "#f00";
    performanceDiv.innerHTML = `FPS: ${fps} | PING: <span style="color:${pingColor}">${ping}ms</span>`;
}

// --- LEADERBOARD ---
function renderLeaderboard(lb) {
    currentLeaderboard = lb;
    lbBody.innerHTML = "";
    lb.forEach((entry, i) => {
        const tr = document.createElement("tr");
        if (entry.name === myName && entry.team === myTeam) tr.classList.add("lb-me");
        const teamClass = entry.team === "red" ? "lb-team-red" : "lb-team-blue";
        const teamLabel = entry.team === "red" ? "ROJO" : "AZUL";
        tr.innerHTML = `
            <td class="lb-rank">${i + 1}</td>
            <td class="lb-name">${entry.name}</td>
            <td class="${teamClass}">${teamLabel}</td>
            <td class="lb-kills">${entry.kills}</td>`;
        lbBody.appendChild(tr);
    });
}

function updateTeamKillsHUD(tk) {
    teamKills = tk;
    document.getElementById("red-kills").textContent = tk.red;
    document.getElementById("blue-kills").textContent = tk.blue;
    
    // Actualizar contadores de jugadores por equipo
    let redCount = 0;
    let blueCount = 0;
    if (serverState && serverState.players) {
        for (const pid in serverState.players) {
            const p = serverState.players[pid];
            if (p && !p.dead) {
                if (p.team === "red") redCount++;
                else if (p.team === "blue") blueCount++;
            }
        }
    }
    // También incluir jugadores muertos para conteo total
    for (const pid in players) {
        const p = players[pid];
        if (p && p.dead) {
            if (p.team === "red") redCount++;
            else if (p.team === "blue") blueCount++;
        }
    }
    document.getElementById("red-count").textContent = redCount;
    document.getElementById("blue-count").textContent = blueCount;
}

function buildVictoryBoard(lb) {
    let html = `<table><thead><tr><th>#</th><th>JUGADOR</th><th>EQUIPO</th><th>KILLS</th></tr></thead><tbody>`;
    lb.forEach((e, i) => {
        const tc = e.team === "red" ? "#ff5555" : "#4488ff";
        html += `<tr>
            <td style="color:var(--text-dim);padding:5px 8px">${i+1}</td>
            <td style="color:white;padding:5px 8px">${e.name}</td>
            <td style="color:${tc};padding:5px 8px;font-size:10px">${e.team === "red" ? "ROJO" : "AZUL"}</td>
            <td style="color:var(--accent);padding:5px 8px;font-weight:700">${e.kills}</td>
        </tr>`;
    });
    html += `</tbody></table>`;
    return html;
}

// LOBBY
let selectedTeam = "red";
const redHalf = document.getElementById("select-red");
const blueHalf = document.getElementById("select-blue");
const joinBtn = document.getElementById("join-btn");
const nameInput = document.getElementById("name-input");

function updateTeamSelectionUI(team) {
    redHalf && redHalf.classList.toggle("selected", team === "red");
    blueHalf && blueHalf.classList.toggle("selected", team === "blue");
}

redHalf && redHalf.addEventListener("click", () => { selectedTeam = "red"; updateTeamSelectionUI("red"); });
blueHalf && blueHalf.addEventListener("click", () => { selectedTeam = "blue"; updateTeamSelectionUI("blue"); });
updateTeamSelectionUI(selectedTeam);

function setLobbyCursor() { document.body.style.cursor = "default"; crosshair && (crosshair.style.display = "none"); }
function setGameCursor() { document.body.style.cursor = "none"; crosshair && (crosshair.style.display = "block"); }
setLobbyCursor();

joinBtn && joinBtn.addEventListener("click", () => {
    const name = (nameInput.value || "Jugador").trim().slice(0, 16) || "Jugador";
    myName = name;
    myTeam = selectedTeam;
    socket.emit("join_game", { team: selectedTeam, name });
});

nameInput && nameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") joinBtn.click();
});

// Toggle leaderboard
toggleBoardBtn && toggleBoardBtn.addEventListener("click", () => {
    boardVisible = !boardVisible;
    lbPanel.classList.toggle("hidden", !boardVisible);
});

// --- SOCKET EVENTS ---
socket.on("joined", data => {
    myId = data.id;
    myTeam = data.team;
    myShape = data.shape;
    myName = data.name;
    killsToWin = data.kills_to_win || 20; // Cambiado a 20 por defecto

    localPlayer.x = data.x;
    localPlayer.y = data.y;

    lobbySel.classList.remove("active");
    gameSel.classList.add("active");
    setGameCursor();

    const shapeNames = { circle: "CIRCULO", square: "CUADRADO", triangle: "TRIANGULO" };
    document.getElementById("player-name-hud").textContent = myName;
    document.getElementById("player-shape-hud").textContent = shapeNames[myShape] || myShape.toUpperCase();
    const teamEl = document.getElementById("player-team-hud");
    teamEl.textContent = myTeam === "red" ? "BANDO ROJO" : "BANDO AZUL";
    teamEl.className = myTeam === "red" ? "red-team-text" : "blue-team-text";

    if (data.leaderboard) renderLeaderboard(data.leaderboard);
    if (data.team_kills) updateTeamKillsHUD(data.team_kills);

    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
});

socket.on("game_state", data => {
    serverState = data;
    const now = Date.now();
    stateBuffer.push({ time: now, players: data.players, projectiles: data.projectiles });
    while (stateBuffer.length > 2 && stateBuffer[stateBuffer.length - 1].time - stateBuffer[0].time > 1000) {
        stateBuffer.shift();
    }

    if (data.team_kills) updateTeamKillsHUD(data.team_kills);
    
    // Actualizar contadores de jugadores por equipo
    let redCount = 0, blueCount = 0;
    for (const pid in data.players) {
        const p = data.players[pid];
        if (p && !p.dead) {
            if (p.team === "red") redCount++;
            else if (p.team === "blue") blueCount++;
        }
    }
    document.getElementById("red-count").textContent = redCount;
    document.getElementById("blue-count").textContent = blueCount;

    if (myId && data.players[myId]) {
        const me = data.players[myId];
        const hp = Math.max(0, me.hp);
        healthFill.style.width = hp + "%";
        healthText.textContent = hp;
        if (!isDead) {
            const dx = me.x - localPlayer.x;
            const dy = me.y - localPlayer.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 80) { localPlayer.x = me.x; localPlayer.y = me.y; }
            else if (dist > 2) { localPlayer.x += dx * 0.3; localPlayer.y += dy * 0.3; }
        } else {
            localPlayer.x = me.x; localPlayer.y = me.y;
        }
    }
});

socket.on("leaderboard_update", data => {
    if (data.leaderboard) renderLeaderboard(data.leaderboard);
    if (data.team_kills) updateTeamKillsHUD(data.team_kills);
});

socket.on("player_died", data => {
    if (data.leaderboard) renderLeaderboard(data.leaderboard);
    if (data.team_kills) updateTeamKillsHUD(data.team_kills);

    if (data.id === myId) {
        isDead = true;
        deathTimer = 3;
        deathOverlay.classList.remove("hidden");
        document.getElementById("death-by-text").textContent =
            data.killer_name ? `Eliminado por ${data.killer_name}` : "";
        document.getElementById("death-timer-text").textContent = "Reapareciendo en 3...";
    }
    addKillFeedEntry(data.killer_name, data.killer_team, data.victim_name, data.victim_team);
});

socket.on("player_respawned", data => {
    if (data.id === myId) {
        isDead = false;
        deathOverlay.classList.add("hidden");
    }
});

socket.on("game_over", data => {
    isGameOver = true;
    const wt = data.winner_team;
    victoryOverlay.classList.remove("hidden");
    const titleEl = document.getElementById("victory-title");
    titleEl.textContent = wt === myTeam ? "¡VICTORIA!" : "DERROTA";
    titleEl.className = `victory-title ${wt}`;
    document.getElementById("victory-sub").textContent =
        `El equipo ${wt === "red" ? "ROJO" : "AZUL"} ganó con ${data.team_kills[wt]} kills`;
    document.getElementById("victory-board").innerHTML = buildVictoryBoard(data.leaderboard || []);
    victoryCountdown = 8;
});

socket.on("game_reset", () => {
    isGameOver = false;
    isDead = false;
    victoryOverlay.classList.add("hidden");
    deathOverlay.classList.add("hidden");
    teamKills = { red: 0, blue: 0 };
    updateTeamKillsHUD(teamKills);
    renderLeaderboard([]);
    killFeed.innerHTML = "";
});

function addKillFeedEntry(killerName, killerTeam, victimName, victimTeam) {
    const entry = document.createElement("div");
    entry.className = "kill-entry";
    const kColor = killerTeam === "red" ? "#ff5555" : "#4488ff";
    const vColor = victimTeam === "red" ? "#ff5555" : "#4488ff";
    entry.innerHTML = `<span style="color:${kColor}">${killerName || "?"}</span><span class="symbol"> ✕ </span><span style="color:${vColor}">${victimName || "?"}</span>`;
    killFeed.appendChild(entry);
    setTimeout(() => { entry.style.opacity = "0"; setTimeout(() => entry.remove(), 500); }, 3000);
    while (killFeed.children.length > 5) killFeed.removeChild(killFeed.firstChild);
}

// INPUT
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
    mouseX = e.clientX; mouseY = e.clientY;
    if (myId && crosshair) { crosshair.style.left = mouseX + "px"; crosshair.style.top = mouseY + "px"; }
    const sx = localPlayer.x - camera.x;
    const sy = localPlayer.y - camera.y;
    mouseAngle = Math.atan2(mouseY - sy, mouseX - sx);
});

window.addEventListener("mousedown", e => {
    if (e.button === 0 && myId && !isDead && !isGameOver) {
        socket.emit("shoot", { angle: mouseAngle });
    }
    e.preventDefault();
});

// Input al servidor a 20Hz
const SERVER_INPUT_INTERVAL = 50;
setInterval(() => {
    if (!myId || isDead || isGameOver) return;
    socket.emit("player_input", { keys: { ...keys }, angle: mouseAngle, dt: SERVER_INPUT_INTERVAL / 1000 });
}, SERVER_INPUT_INTERVAL);

// Predicción local
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function predictLocalMovement(dt) {
    if (!myId || isDead || isGameOver) return;
    let dx = 0, dy = 0;
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;
    if (dx !== 0 && dy !== 0) { const l = Math.sqrt(dx*dx+dy*dy); dx/=l; dy/=l; }
    localPlayer.x = clamp(localPlayer.x + dx * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
    localPlayer.y = clamp(localPlayer.y + dy * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);
    localPlayer.angle = mouseAngle;
}

// Interpolación de remotos
function getInterpolatedState(renderTime) {
    if (stateBuffer.length < 2) return stateBuffer.length > 0 ? stateBuffer[stateBuffer.length - 1] : null;
    let older = null, newer = null;
    for (let i = stateBuffer.length - 1; i >= 0; i--) {
        if (stateBuffer[i].time <= renderTime) {
            older = stateBuffer[i];
            newer = stateBuffer[i + 1] || stateBuffer[i];
            break;
        }
    }
    if (!older) return stateBuffer[0];
    if (older === newer) return older;
    const alpha = Math.max(0, Math.min(1, (renderTime - older.time) / (newer.time - older.time)));
    const interpPlayers = {};
    for (const pid in newer.players) {
        if (pid === myId) continue;
        const np = newer.players[pid], op = older.players[pid];
        if (!op) { interpPlayers[pid] = np; continue; }
        interpPlayers[pid] = { ...np, x: op.x + (np.x - op.x) * alpha, y: op.y + (np.y - op.y) * alpha };
    }
    const interpProj = {};
    for (const pid in newer.projectiles) {
        const np = newer.projectiles[pid], op = older.projectiles[pid];
        if (!op) { interpProj[pid] = np; continue; }
        interpProj[pid] = { ...np, x: op.x + (np.x - op.x) * alpha, y: op.y + (np.y - op.y) * alpha };
    }
    return { players: interpPlayers, projectiles: interpProj };
}

// RENDER
function inFOV(wx, wy, margin) {
    const m = margin || FOV_MARGIN, sx = wx - camera.x, sy = wy - camera.y;
    return sx > -m && sx < canvas.width + m && sy > -m && sy < canvas.height + m;
}

function drawMap() {
    const vx = camera.x, vy = camera.y, vw = canvas.width, vh = canvas.height;
    ctx.fillStyle = "#13131b"; ctx.fillRect(0, 0, vw, vh);
    const startTX = Math.max(0, Math.floor(vx / TILE_SIZE));
    const startTY = Math.max(0, Math.floor(vy / TILE_SIZE));
    const endTX = Math.min(Math.floor(MAP_WIDTH / TILE_SIZE), Math.ceil((vx + vw) / TILE_SIZE));
    const endTY = Math.min(Math.floor(MAP_HEIGHT / TILE_SIZE), Math.ceil((vy + vh) / TILE_SIZE));
    for (let tx = startTX; tx <= endTX; tx++) {
        for (let ty = startTY; ty <= endTY; ty++) {
            ctx.fillStyle = (tx + ty) % 2 === 0 ? "#14141d" : "#111119";
            ctx.fillRect(tx * TILE_SIZE - vx, ty * TILE_SIZE - vy, TILE_SIZE, TILE_SIZE);
        }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 3;
    ctx.strokeRect(-vx, -vy, MAP_WIDTH, MAP_HEIGHT);
    drawSpawnZone(150, 150, "red");
    drawSpawnZone(MAP_WIDTH - 150, MAP_HEIGHT - 150, "blue");
}

function drawSpawnZone(cx, cy, team) {
    if (!inFOV(cx, cy, 220)) return;
    const sx = cx - camera.x, sy = cy - camera.y;
    const color = team === "red" ? "224,48,48" : "32,96,224";
    ctx.beginPath(); ctx.arc(sx, sy, 160, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},0.04)`; ctx.fill();
    ctx.strokeStyle = `rgba(${color},0.12)`; ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${color},0.5)`;
    ctx.font = "bold 11px 'Share Tech Mono',monospace"; ctx.textAlign = "center";
    ctx.fillText(team === "red" ? "SPAWN ROJO" : "SPAWN AZUL", sx, sy);
}

function drawTerrain() {
    for (const obj of terrainObjects) {
        if (!inFOV(obj.x, obj.y, 100)) continue;
        const sx = obj.x - camera.x, sy = obj.y - camera.y;
        ctx.fillStyle = obj.color;
        if (obj.type === "rock") {
            ctx.beginPath(); ctx.arc(sx, sy, obj.r, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "rgba(160,80,255,0.85)"; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
            ctx.beginPath(); ctx.arc(sx, sy, obj.r, 0, Math.PI * 2); ctx.fill();
        }
    }
}

function drawPlayer(plr, isLocal) {
    const px = isLocal ? localPlayer.x : plr.x;
    const py = isLocal ? localPlayer.y : plr.y;
    const pangle = isLocal ? localPlayer.angle : plr.angle;
    if (!inFOV(px, py, 50)) return;
    const sx = px - camera.x, sy = py - camera.y;
    const r = 18, isMe = isLocal;
    const teamColor = plr.team === "red" ? "#cc2828" : "#1850cc";
    const teamBorder = plr.team === "red" ? "#e84444" : "#3d78f5";

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(pangle);
    if (plr.dead) ctx.globalAlpha = 0.35;
    ctx.fillStyle = teamColor;
    ctx.strokeStyle = isMe ? "rgba(255,255,255,0.9)" : teamBorder;
    ctx.lineWidth = isMe ? 2.5 : 1.5;

    if (plr.shape === "circle") {
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (plr.shape === "square") {
        const s = r * 1.4; ctx.fillRect(-s/2,-s/2,s,s); ctx.strokeRect(-s/2,-s/2,s,s);
    } else {
        ctx.beginPath(); ctx.moveTo(r,0); ctx.lineTo(-r*0.7,-r*0.75); ctx.lineTo(-r*0.7,r*0.75);
        ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (!plr.dead) {
        const barW = 38, barH = 4, bx = sx - barW/2, by = sy - r - 8;
        const hpRatio = plr.hp / 100;
        ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(bx-1,by-1,barW+2,barH+2);
        ctx.fillStyle = hpRatio > 0.6 ? "#2ecc71" : hpRatio > 0.3 ? "#f39c12" : "#e74c3c";
        ctx.fillRect(bx, by, barW * hpRatio, barH);

        // Nombre sobre el jugador
        const displayName = plr.name || "";
        ctx.fillStyle = isMe ? "rgba(255,255,255,0.9)" : "rgba(200,200,220,0.75)";
        ctx.font = `bold ${isMe ? 10 : 9}px 'Share Tech Mono',monospace`;
        ctx.textAlign = "center";
        ctx.fillText(displayName, sx, by - 4);
    }
}

function drawProjectile(proj) {
    if (!inFOV(proj.x, proj.y, 30)) return;
    const sx = proj.x - camera.x, sy = proj.y - camera.y;
    const angle = Math.atan2(proj.dy, proj.dx);
    const color = proj.owner_team === "red" ? "#ff6030" : "#30a8ff";
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(angle);
    ctx.fillStyle = color; ctx.fillRect(-5,-2,10,4);
    ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.fillRect(3,-1,3,2);
    ctx.restore();
}

function updateCamera() {
    const tx = localPlayer.x - canvas.width / 2;
    const ty = localPlayer.y - canvas.height / 2;
    const targetX = Math.max(0, Math.min(MAP_WIDTH - canvas.width, tx));
    const targetY = Math.max(0, Math.min(MAP_HEIGHT - canvas.height, ty));
    camera.x += (targetX - camera.x) * 0.15;
    camera.y += (targetY - camera.y) * 0.15;
}

function updateDeathTimer(dt) {
    if (!isDead) return;
    deathTimer = Math.max(0, deathTimer - dt);
    const sec = Math.ceil(deathTimer);
    const timerEl = document.getElementById("death-timer-text");
    if (timerEl) timerEl.textContent = sec > 0 ? "Reapareciendo en " + sec + "..." : "Reapareciendo...";
}

function updateVictoryTimer(dt) {
    if (!isGameOver) return;
    victoryCountdown = Math.max(0, victoryCountdown - dt);
    const sec = Math.ceil(victoryCountdown);
    if (victoryTimer) victoryTimer.textContent = sec > 0 ? `Reiniciando en ${sec}...` : "Reiniciando...";
}

function gameLoop(now) {
    requestAnimationFrame(gameLoop);
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    updatePerformance();
    if (myId && !isDead && !isGameOver) predictLocalMovement(dt);
    if (myId) updateCamera();
    updateDeathTimer(dt);
    updateVictoryTimer(dt);

    const renderTime = Date.now() - INTERP_DELAY;
    const interp = getInterpolatedState(renderTime);

    drawMap();
    drawTerrain();

    if (interp) {
        for (const pid in interp.projectiles) drawProjectile(interp.projectiles[pid]);
        for (const pid in interp.players) {
            if (pid === myId) continue;
            drawPlayer(interp.players[pid], false);
        }
    }

    if (myId && serverState.players[myId]) drawPlayer(serverState.players[myId], true);
}

window.addEventListener('load', () => {
    lastTime = performance.now();
    lastFrameTime = performance.now();
});
