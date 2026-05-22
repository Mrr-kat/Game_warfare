import math
import time
import uuid
import json
import gc
from flask import Flask, send_from_directory
from flask_socketio import SocketIO, emit
import os

app = Flask(__name__, static_folder="static", template_folder=".")
app.config["SECRET_KEY"] = "battleground2025"

# Configurar garbage collector para mejor rendimiento
gc.set_threshold(700, 10, 5)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading",
                    ping_timeout=25, ping_interval=12,
                    max_http_buffer_size=500_000,
                    logger=False, engineio_logger=False,
                    compress=True)

MAP_WIDTH  = 4000
MAP_HEIGHT = 4000

RED_SPAWN  = {"x": 200,  "y": 200}
BLUE_SPAWN = {"x": 4800, "y": 4800}

SHAPE_DAMAGE           = {"circle": 20, "square": 10, "triangle": 10}
SHAPE_FIRE_RATE        = {"circle": 1.0, "square": 1.0, "triangle": 0.3}
SHAPE_PROJECTILE_COUNT = {"circle": 1,  "square": 3,   "triangle": 1}
SHAPE_SPREAD           = {"circle": 0.0, "square": 0.25, "triangle": 0.0}

PROJECTILE_SPEED  = 500
PROJECTILE_LIFETIME = 2.0
PLAYER_SPEED      = 250
PLAYER_RADIUS     = 20
PROJECTILE_RADIUS = 6
HIT_DIST_SQ       = (PLAYER_RADIUS + PROJECTILE_RADIUS) ** 2

# Reducido de 20 a 15 ticks para menos carga CPU
TICK_RATE = 15
MAX_PROJECTILES = 50  # Límite de proyectiles activos

players     = {}
projectiles = {}
last_update = time.time()

# ──────────────────────────────────────────────────────────
# TERRENO + SPATIAL GRID (Reducido para mejor rendimiento)
# ──────────────────────────────────────────────────────────
TERRAIN_SEED = 42
GRID_CELL    = 200

def seeded_random_gen(seed):
    s = [seed & 0xFFFFFFFF]
    def rng():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return s[0] / 0xFFFFFFFF
    return rng

def generate_solid_obstacles():
    rng = seeded_random_gen(TERRAIN_SEED)
    obs = []
    # Reducido de 70 a 40 rocas
    for _ in range(40):
        x = rng() * MAP_WIDTH
        y = rng() * MAP_HEIGHT
        w = 40 + rng() * 70
        h = 28 + rng() * 50
        rng()
        obs.append({"type":"rock","x":x,"y":y,"r":(w+h)/4})
    # Reducido de 100 a 60 bushes
    for _ in range(60):
        rng();rng();rng();rng();rng();rng()
    # Reducido de 50 a 30 crates
    for _ in range(30):
        x = rng() * MAP_WIDTH
        y = rng() * MAP_HEIGHT
        size = 22 + rng() * 14
        rng()
        half = size / 2
        obs.append({"type":"crate","x":x,"y":y,"rw":half,"rh":half})
    return obs

def build_spatial_grid(obstacles, cell):
    grid = {}
    for o in obstacles:
        rad = o.get("r", max(o.get("rw",0), o.get("rh",0))) + 10
        cx0 = int((o["x"] - rad) / cell)
        cx1 = int((o["x"] + rad) / cell)
        cy0 = int((o["y"] - rad) / cell)
        cy1 = int((o["y"] + rad) / cell)
        for cx in range(cx0, cx1+1):
            for cy in range(cy0, cy1+1):
                grid.setdefault((cx,cy), []).append(o)
    return grid

solid_obstacles = generate_solid_obstacles()
obstacle_grid   = build_spatial_grid(solid_obstacles, GRID_CELL)
print(f"[INFO] {len(solid_obstacles)} obstacles, grid built")

def nearby(x, y):
    cx = int(x / GRID_CELL)
    cy = int(y / GRID_CELL)
    seen = set()
    out = []
    for dcx in (-1,0,1):
        for dcy in (-1,0,1):
            cell = obstacle_grid.get((cx+dcx, cy+dcy))
            if cell:
                for o in cell:
                    oid = id(o)
                    if oid not in seen:
                        seen.add(oid)
                        out.append(o)
    return out

def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)

def circle_vs_rect(cx, cy, cr, rx, ry, rw, rh):
    nx = clamp(cx, rx-rw, rx+rw)
    ny = clamp(cy, ry-rh, ry+rh)
    dx = cx-nx
    dy = cy-ny
    return dx*dx + dy*dy < cr*cr

def resolve_player(plr):
    r = PLAYER_RADIUS
    for o in nearby(plr["x"], plr["y"]):
        ox, oy = o["x"], o["y"]
        if o["type"] == "rock":
            or_ = o["r"]
            dx = plr["x"]-ox
            dy = plr["y"]-oy
            d2 = dx*dx+dy*dy
            md = or_+r
            if d2 < md*md:
                d = math.sqrt(d2) or 0.001
                plr["x"] = ox + dx/d*md
                plr["y"] = oy + dy/d*md
        else:
            ow, oh = o["rw"], o["rh"]
            if circle_vs_rect(plr["x"], plr["y"], r, ox, oy, ow, oh):
                dx = plr["x"]-ox
                dy = plr["y"]-oy
                ox_ = ow+r-abs(dx)
                oy_ = oh+r-abs(dy)
                if ox_ < oy_:
                    plr["x"] += ox_ * (1 if dx>=0 else -1)
                else:
                    plr["y"] += oy_ * (1 if dy>=0 else -1)

def proj_hits(px, py):
    pr = PROJECTILE_RADIUS
    for o in nearby(px, py):
        ox, oy = o["x"], o["y"]
        if o["type"] == "rock":
            dx=px-ox
            dy=py-oy
            if dx*dx+dy*dy < (o["r"]+pr)**2:
                return True
        else:
            if circle_vs_rect(px, py, pr, ox, oy, o["rw"], o["rh"]):
                return True
    return False

def get_spawn(team):
    t = time.time()
    base = RED_SPAWN if team=="red" else BLUE_SPAWN
    return {"x": base["x"]+(hash(str(t))%100-50),
            "y": base["y"]+(hash(str(t+1))%100-50)}

# ──────────────────────────────────────────────────────────
# GAME LOOP OPTIMIZADO
# ──────────────────────────────────────────────────────────
def game_loop():
    global last_update
    interval = 1.0 / TICK_RATE
    
    while True:
        t0 = time.time()
        
        dt = min(t0 - last_update, 0.1)
        last_update = t0
        
        dead = []
        
        # Mover proyectiles optimizado
        for pid, pr in list(projectiles.items()):
            pr["x"] += pr["dx"] * PROJECTILE_SPEED * dt
            pr["y"] += pr["dy"] * PROJECTILE_SPEED * dt
            pr["lifetime"] -= dt
            
            px, py = pr["x"], pr["y"]
            
            # Verificación rápida de bounds
            if (pr["lifetime"] <= 0 or px < -50 or px > MAP_WIDTH+50 
                or py < -50 or py > MAP_HEIGHT+50):
                dead.append(pid)
                continue
            
            if proj_hits(px, py):
                dead.append(pid)
                continue
            
            ot = pr["owner_team"]
            oi = pr["owner_id"]
            dmg = pr["damage"]
            hit = False
            
            for uid, plr in list(players.items()):
                if uid == oi or plr["team"] == ot or plr["dead"]:
                    continue
                dx = plr["x"] - px
                dy = plr["y"] - py
                if dx*dx + dy*dy < HIT_DIST_SQ:
                    plr["hp"] -= dmg
                    dead.append(pid)
                    hit = True
                    if plr["hp"] <= 0:
                        plr["hp"] = 0
                        plr["dead"] = True
                        plr["dead_timer"] = 3.0
                        socketio.emit("player_died", {
                            "id": uid,
                            "victim_team": plr["team"],
                            "killer_id": oi,
                            "killer_team": players.get(oi, {}).get("team", "")
                        })
                    break
            if hit:
                continue
        
        # Limpiar proyectiles muertos
        for pid in set(dead):
            projectiles.pop(pid, None)
        
        # Actualizar jugadores
        for uid, plr in list(players.items()):
            if plr["dead"]:
                plr["dead_timer"] -= dt
                if plr["dead_timer"] <= 0:
                    sp = get_spawn(plr["team"])
                    plr["x"] = clamp(sp["x"], PLAYER_RADIUS, MAP_WIDTH-PLAYER_RADIUS)
                    plr["y"] = clamp(sp["y"], PLAYER_RADIUS, MAP_HEIGHT-PLAYER_RADIUS)
                    plr["hp"] = 100
                    plr["dead"] = False
                    plr["dead_timer"] = 0
                    socketio.emit("player_respawned", {"id": uid})
        
        # Limitar proyectiles si exceden el máximo
        if len(projectiles) > MAX_PROJECTILES:
            to_remove = list(projectiles.keys())[:len(projectiles)-MAX_PROJECTILES]
            for pid in to_remove:
                projectiles.pop(pid, None)
        
        # Estado compacto
        state = {
            "p": {uid: [int(p["x"]), int(p["y"]), p["hp"], p["team"], p["shape"],
                        1 if p["dead"] else 0, round(p.get("angle", 0), 2)]
                  for uid, p in list(players.items())},
            "b": {bid: [int(b["x"]), int(b["y"]), round(b["dx"], 3), round(b["dy"], 3), b["owner_team"]]
                  for bid, b in list(projectiles.items())[:MAX_PROJECTILES]}
        }
        
        try:
            socketio.emit("game_state", state, compress=True)
        except:
            socketio.emit("game_state", state)
        
        elapsed = time.time() - t0
        sleep_time = max(interval - elapsed, 0.001)
        socketio.sleep(sleep_time)


@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/style.css")
def css():
    return send_from_directory(".", "style.css")

@app.route("/game.js")
def js():
    return send_from_directory(".", "game.js")


@socketio.on("connect")
def on_connect():
    pass


@socketio.on("join_game")
def on_join(data):
    from flask import request
    import random
    sid = request.sid
    team = data.get("team", "red")
    if team not in ("red", "blue"):
        team = "red"
    shape = random.choice(["circle", "square", "triangle"])
    sp = get_spawn(team)
    players[sid] = {
        "id": sid, "x": clamp(sp["x"], 50, MAP_WIDTH-50),
        "y": clamp(sp["y"], 50, MAP_HEIGHT-50),
        "hp": 100, "team": team, "shape": shape,
        "dead": False, "dead_timer": 0, "angle": 0, "last_shot": 0
    }
    emit("joined", {
        "id": sid, "x": players[sid]["x"], "y": players[sid]["y"],
        "team": team, "shape": shape,
        "map_width": MAP_WIDTH, "map_height": MAP_HEIGHT
    })


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
    dt = min(data.get("dt", 0.05), 0.1)
    plr["angle"] = data.get("angle", 0)
    
    dx = dy = 0
    if keys.get("w"): dy -= 1
    if keys.get("s"): dy += 1
    if keys.get("a"): dx -= 1
    if keys.get("d"): dx += 1
    if dx and dy:
        inv = 0.7071067811865476
        dx *= inv
        dy *= inv
    
    plr["x"] = clamp(plr["x"] + dx * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
    plr["y"] = clamp(plr["y"] + dy * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)
    resolve_player(plr)
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
    
    # Limitar proyectiles totales
    if len(projectiles) >= MAX_PROJECTILES:
        oldest = min(projectiles.keys(), key=lambda k: projectiles[k].get("created", 0))
        projectiles.pop(oldest, None)
    
    for i in range(count):
        a = angle if count == 1 else angle + (i - (count-1)/2) * spread
        pid = str(uuid.uuid4())
        projectiles[pid] = {
            "x": plr["x"], "y": plr["y"],
            "dx": math.cos(a), "dy": math.sin(a),
            "owner_id": sid, "owner_team": plr["team"],
            "damage": damage, "lifetime": PROJECTILE_LIFETIME,
            "created": now
        }


@socketio.on("disconnect")
def on_disconnect():
    from flask import request
    sid = request.sid
    if sid in players:
        del players[sid]
        emit("player_left", {"id": sid}, broadcast=True)


if __name__ == "__main__":
    socketio.start_background_task(game_loop)
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port,
                 debug=False, allow_unsafe_werkzeug=True)
