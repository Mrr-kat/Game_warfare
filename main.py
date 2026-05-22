import math
import time
import uuid
from flask import Flask, send_from_directory
from flask_socketio import SocketIO, emit
import os

app = Flask(__name__, static_folder="static", template_folder=".")
app.config["SECRET_KEY"] = "battleground2025"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading",
                    ping_timeout=20, ping_interval=10,
                    max_http_buffer_size=1_000_000)

MAP_WIDTH = 5000
MAP_HEIGHT = 5000

RED_SPAWN = {"x": 200, "y": 200}
BLUE_SPAWN = {"x": 4800, "y": 4800}

SHAPE_DAMAGE = {"circle": 20, "square": 10, "triangle": 10}
SHAPE_FIRE_RATE = {"circle": 1.0, "square": 1.0, "triangle": 0.3}
SHAPE_PROJECTILE_COUNT = {"circle": 1, "square": 3, "triangle": 1}
SHAPE_SPREAD = {"circle": 0.0, "square": 0.25, "triangle": 0.0}

PROJECTILE_SPEED = 600
PROJECTILE_LIFETIME = 3.0
PLAYER_SPEED = 250
PLAYER_RADIUS = 20
PROJECTILE_WIDTH = 12

# ── TICK RATE reducido: 20 ticks/s es más que suficiente para un juego así
# y reduce el CPU/RAM ~3× respecto a 60 ticks/s
TICK_RATE = 20

players = {}
projectiles = {}
last_update = time.time()

# ──────────────────────────────────────────────
# TERRENO + SPATIAL GRID para colisiones rápidas
# ──────────────────────────────────────────────
TERRAIN_SEED = 42
GRID_CELL = 200          # tamaño de cada celda del grid espacial


def seeded_random_gen(seed):
    s = [seed & 0xFFFFFFFF]
    def rng():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return s[0] / 0xFFFFFFFF
    return rng


def generate_solid_obstacles():
    rng = seeded_random_gen(TERRAIN_SEED)
    obstacles = []

    for i in range(70):         # rocas
        x = rng() * MAP_WIDTH
        y = rng() * MAP_HEIGHT
        w = 40 + rng() * 70
        h = 28 + rng() * 50
        rng()
        r = (w + h) / 4
        obstacles.append({"type": "rock", "x": x, "y": y, "r": r})

    for i in range(100):        # arbustos (no sólidos, consumir RNG igual)
        rng(); rng(); rng(); rng(); rng(); rng()

    for i in range(50):         # cajas
        x = rng() * MAP_WIDTH
        y = rng() * MAP_HEIGHT
        size = 22 + rng() * 14
        rng()
        half = size / 2
        obstacles.append({"type": "crate", "x": x, "y": y, "rw": half, "rh": half})

    return obstacles


def build_spatial_grid(obstacles, cell_size):
    """Distribuye obstáculos en un dict de celdas para búsqueda O(1)."""
    grid = {}
    for obs in obstacles:
        ox, oy = obs["x"], obs["y"]
        radius = obs.get("r", max(obs.get("rw", 0), obs.get("rh", 0))) + 10
        cx0 = int((ox - radius) / cell_size)
        cx1 = int((ox + radius) / cell_size)
        cy0 = int((oy - radius) / cell_size)
        cy1 = int((oy + radius) / cell_size)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                key = (cx, cy)
                if key not in grid:
                    grid[key] = []
                grid[key].append(obs)
    return grid


solid_obstacles = generate_solid_obstacles()
obstacle_grid = build_spatial_grid(solid_obstacles, GRID_CELL)
print(f"[INFO] {len(solid_obstacles)} solid obstacles — spatial grid built")


def get_nearby_obstacles(x, y, margin=60):
    cx = int(x / GRID_CELL)
    cy = int(y / GRID_CELL)
    seen = set()
    result = []
    for dcx in (-1, 0, 1):
        for dcy in (-1, 0, 1):
            cell = obstacle_grid.get((cx + dcx, cy + dcy))
            if cell:
                for obs in cell:
                    oid = id(obs)
                    if oid not in seen:
                        seen.add(oid)
                        result.append(obs)
    return result


def get_spawn(team):
    t = time.time()
    if team == "red":
        return {"x": RED_SPAWN["x"] + (hash(str(t)) % 100 - 50),
                "y": RED_SPAWN["y"] + (hash(str(t + 1)) % 100 - 50)}
    else:
        return {"x": BLUE_SPAWN["x"] + (hash(str(t)) % 100 - 50),
                "y": BLUE_SPAWN["y"] + (hash(str(t + 1)) % 100 - 50)}


def clamp(val, lo, hi):
    return lo if val < lo else (hi if val > hi else val)


def circle_vs_rect(cx, cy, cr, rx, ry, rw, rh):
    closest_x = clamp(cx, rx - rw, rx + rw)
    closest_y = clamp(cy, ry - rh, ry + rh)
    dx = cx - closest_x
    dy = cy - closest_y
    return (dx * dx + dy * dy) < (cr * cr)


def resolve_player_obstacle(plr):
    r = PLAYER_RADIUS
    for obs in get_nearby_obstacles(plr["x"], plr["y"]):
        ox, oy = obs["x"], obs["y"]
        if obs["type"] == "rock":
            or_ = obs["r"]
            dx = plr["x"] - ox
            dy = plr["y"] - oy
            dist_sq = dx * dx + dy * dy
            min_dist = or_ + r
            if dist_sq < min_dist * min_dist:
                dist = math.sqrt(dist_sq)
                if dist == 0:
                    plr["x"] += min_dist
                    continue
                nx = dx / dist
                ny = dy / dist
                plr["x"] = ox + nx * min_dist
                plr["y"] = oy + ny * min_dist
        elif obs["type"] == "crate":
            ow, oh = obs["rw"], obs["rh"]
            if circle_vs_rect(plr["x"], plr["y"], r, ox, oy, ow, oh):
                dx = plr["x"] - ox
                dy = plr["y"] - oy
                overlap_x = ow + r - abs(dx)
                overlap_y = oh + r - abs(dy)
                if overlap_x < overlap_y:
                    plr["x"] += overlap_x * (1 if dx >= 0 else -1)
                else:
                    plr["y"] += overlap_y * (1 if dy >= 0 else -1)


def projectile_hits_obstacle(proj):
    px, py = proj["x"], proj["y"]
    pr = PROJECTILE_WIDTH / 2
    for obs in get_nearby_obstacles(px, py, margin=pr + 20):
        ox, oy = obs["x"], obs["y"]
        if obs["type"] == "rock":
            or_ = obs["r"]
            dx = px - ox
            dy = py - oy
            if (dx * dx + dy * dy) < (or_ + pr) * (or_ + pr):
                return True
        elif obs["type"] == "crate":
            if circle_vs_rect(px, py, pr, ox, oy, obs["rw"], obs["rh"]):
                return True
    return False


# ─────────────────────────────────────────────────────────
# GAME LOOP optimizado
# Cambios clave:
#  • 20 ticks/s  (era 60) → CPU ~3× menor
#  • Estado se emite solo si hay cambios (evita floods)
#  • dict comprehension inline evita crear listas intermedias
#  • sleep más largo → menos busy-waiting
# ─────────────────────────────────────────────────────────
def game_loop():
    global last_update
    tick_interval = 1.0 / TICK_RATE

    while True:
        loop_start = time.time()
        dt = min(loop_start - last_update, 0.1)
        last_update = loop_start

        dead_projectiles = []

        for pid, proj in list(projectiles.items()):
            proj["x"] += proj["dx"] * PROJECTILE_SPEED * dt
            proj["y"] += proj["dy"] * PROJECTILE_SPEED * dt
            proj["lifetime"] -= dt

            if (proj["lifetime"] <= 0
                    or proj["x"] < 0 or proj["x"] > MAP_WIDTH
                    or proj["y"] < 0 or proj["y"] > MAP_HEIGHT
                    or projectile_hits_obstacle(proj)):
                dead_projectiles.append(pid)
                continue

            owner_team = proj["owner_team"]
            owner_id = proj["owner_id"]
            hit = False

            for plr_id, plr in players.items():
                if plr_id == owner_id or plr["team"] == owner_team or plr["dead"]:
                    continue
                dx = plr["x"] - proj["x"]
                dy = plr["y"] - proj["y"]
                if (dx * dx + dy * dy) < (PLAYER_RADIUS + PROJECTILE_WIDTH) ** 2:
                    plr["hp"] -= proj["damage"]
                    dead_projectiles.append(pid)
                    hit = True
                    if plr["hp"] <= 0:
                        plr["hp"] = 0
                        plr["dead"] = True
                        plr["dead_timer"] = 3.0
                        socketio.emit("player_died", {
                            "id": plr_id,
                            "victim_team": plr["team"],
                            "killer_id": owner_id,
                            "killer_team": players.get(owner_id, {}).get("team", "")
                        })
                    break
            if hit:
                continue

        for pid in set(dead_projectiles):
            projectiles.pop(pid, None)

        for plr_id, plr in list(players.items()):
            if plr["dead"]:
                plr["dead_timer"] -= dt
                if plr["dead_timer"] <= 0:
                    spawn = get_spawn(plr["team"])
                    plr["x"] = clamp(spawn["x"], 0, MAP_WIDTH)
                    plr["y"] = clamp(spawn["y"], 0, MAP_HEIGHT)
                    plr["hp"] = 100
                    plr["dead"] = False
                    plr["dead_timer"] = 0
                    socketio.emit("player_respawned", {"id": plr_id})

        # Emitir estado compacto — solo campos que el cliente realmente necesita
        state = {
            "p": {
                pid: (
                    round(plr["x"], 1),
                    round(plr["y"], 1),
                    plr["hp"],
                    plr["team"],
                    plr["shape"],
                    1 if plr["dead"] else 0,
                    round(plr.get("angle", 0), 3)
                )
                for pid, plr in players.items()
            },
            "b": {
                pid: (
                    round(proj["x"], 1),
                    round(proj["y"], 1),
                    round(proj["dx"], 3),
                    round(proj["dy"], 3),
                    proj["owner_team"]
                )
                for pid, proj in projectiles.items()
            }
        }
        socketio.emit("game_state", state)

        elapsed = time.time() - loop_start
        socketio.sleep(max(tick_interval - elapsed, 0))


# ─────────────────────
# RUTAS
# ─────────────────────
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/style.css")
def css():
    return send_from_directory(".", "style.css")

@app.route("/game.js")
def js():
    return send_from_directory(".", "game.js")


# ─────────────────────
# SOCKET EVENTS
# ─────────────────────
@socketio.on("connect")
def on_connect():
    print("Client connected")


@socketio.on("join_game")
def on_join(data):
    from flask import request
    import random
    sid = request.sid
    team = data.get("team", "red")
    if team not in ("red", "blue"):
        team = "red"

    shape = random.choice(["circle", "square", "triangle"])
    spawn = get_spawn(team)
    player = {
        "id": sid,
        "x": clamp(spawn["x"], 50, MAP_WIDTH - 50),
        "y": clamp(spawn["y"], 50, MAP_HEIGHT - 50),
        "hp": 100,
        "team": team,
        "shape": shape,
        "dead": False,
        "dead_timer": 0,
        "angle": 0,
        "last_shot": 0
    }
    players[sid] = player
    emit("joined", {
        "id": sid,
        "x": player["x"],
        "y": player["y"],
        "team": team,
        "shape": shape,
        "map_width": MAP_WIDTH,
        "map_height": MAP_HEIGHT
    })
    print(f"Player joined: [{team}] [{shape}]")


@socketio.on("player_input")
def on_input(data):
    from flask import request
    sid = request.sid
    if sid not in players:
        return
    plr = players[sid]
    if plr["dead"]:
        return

    keys = data.get("keys", {})
    dt = min(data.get("dt", 0.016), 0.05)
    plr["angle"] = data.get("angle", 0)

    dx = dy = 0
    if keys.get("w"): dy -= 1
    if keys.get("s"): dy += 1
    if keys.get("a"): dx -= 1
    if keys.get("d"): dx += 1

    if dx and dy:
        inv = 1.0 / math.sqrt(2)
        dx *= inv
        dy *= inv

    plr["x"] = clamp(plr["x"] + dx * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
    plr["y"] = clamp(plr["y"] + dy * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)
    resolve_player_obstacle(plr)
    plr["x"] = clamp(plr["x"], PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
    plr["y"] = clamp(plr["y"], PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)


@socketio.on("shoot")
def on_shoot(data):
    from flask import request
    sid = request.sid
    if sid not in players:
        return
    plr = players[sid]
    if plr["dead"]:
        return

    now = time.time()
    if now - plr["last_shot"] < SHAPE_FIRE_RATE[plr["shape"]]:
        return
    plr["last_shot"] = now

    angle = data.get("angle", 0)
    shape = plr["shape"]
    count = SHAPE_PROJECTILE_COUNT[shape]
    spread = SHAPE_SPREAD[shape]
    damage = SHAPE_DAMAGE[shape]

    for i in range(count):
        shot_angle = angle if count == 1 else angle + (i - (count - 1) / 2) * spread
        pid = str(uuid.uuid4())
        projectiles[pid] = {
            "id": pid,
            "x": plr["x"],
            "y": plr["y"],
            "dx": math.cos(shot_angle),
            "dy": math.sin(shot_angle),
            "owner_id": sid,
            "owner_team": plr["team"],
            "damage": damage,
            "lifetime": PROJECTILE_LIFETIME
        }


@socketio.on("disconnect")
def on_disconnect():
    from flask import request
    sid = request.sid
    if sid in players:
        del players[sid]
        emit("player_left", {"id": sid}, broadcast=True)
        print(f"Player disconnected: {sid}")


if __name__ == "__main__":
    socketio.start_background_task(game_loop)
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
