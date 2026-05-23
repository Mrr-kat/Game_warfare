import math
import time
import uuid
from flask import Flask, send_from_directory
from flask_socketio import SocketIO, emit
import os

app = Flask(__name__, static_folder="static", template_folder=".")
app.config["SECRET_KEY"] = "battleground2025"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading", ping_timeout=60, ping_interval=25)

MAP_WIDTH = 2500
MAP_HEIGHT = 2500

RED_SPAWN = {"x": 150, "y": 150}
BLUE_SPAWN = {"x": 2350, "y": 2350}

SHAPE_DAMAGE = {"circle": 18, "square": 12, "triangle": 14}
SHAPE_FIRE_RATE = {"circle": 0.8, "square": 0.9, "triangle": 0.35}
SHAPE_PROJECTILE_COUNT = {"circle": 1, "square": 3, "triangle": 1}
SHAPE_SPREAD = {"circle": 0.0, "square": 0.25, "triangle": 0.0}

PROJECTILE_SPEED = 550
PROJECTILE_LIFETIME = 2.5
PLAYER_SPEED = 280
PLAYER_RADIUS = 20
PROJECTILE_WIDTH = 10
PROJECTILE_HEIGHT = 5

TICK_RATE = 20
GAME_TICK = 1.0 / TICK_RATE
KILLS_TO_WIN = 50

players = {}
projectiles = {}
last_update = time.time()

# Tabla de kills global (persiste hasta reset)
kill_scores = {}   # sid -> { name, team, kills }
team_kills = {"red": 0, "blue": 0}
game_over = False

TERRAIN_SEED = 42

def seeded_random_gen(seed):
    s = [seed & 0xFFFFFFFF]
    def rng():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return s[0] / 0xFFFFFFFF
    return rng

def generate_solid_obstacles():
    rng = seeded_random_gen(TERRAIN_SEED)
    obstacles = []
    for i in range(35):
        x = rng() * MAP_WIDTH
        y = rng() * MAP_HEIGHT
        w = 35 + rng() * 55
        h = 25 + rng() * 35
        r = (w + h) / 4
        obstacles.append({"type": "rock", "x": x, "y": y, "r": r})
    for i in range(35):
        x = rng() * MAP_WIDTH
        y = rng() * MAP_HEIGHT
        size = 20 + rng() * 12
        half = size / 2
        obstacles.append({"type": "crate", "x": x, "y": y, "rw": half, "rh": half, "size": size})
    return obstacles

solid_obstacles = generate_solid_obstacles()
print(f"[INFO] {len(solid_obstacles)} solid obstacles generated")

def get_spawn(team):
    import random
    if team == "red":
        return {"x": RED_SPAWN["x"] + random.randint(-50, 50),
                "y": RED_SPAWN["y"] + random.randint(-50, 50)}
    else:
        return {"x": BLUE_SPAWN["x"] + random.randint(-50, 50),
                "y": BLUE_SPAWN["y"] + random.randint(-50, 50)}

def clamp(val, min_val, max_val):
    return max(min_val, min(max_val, val))

def circle_vs_rect(cx, cy, cr, rx, ry, rw, rh):
    closest_x = clamp(cx, rx - rw, rx + rw)
    closest_y = clamp(cy, ry - rh, ry + rh)
    dx = cx - closest_x
    dy = cy - closest_y
    return (dx * dx + dy * dy) < (cr * cr)

def resolve_player_obstacle(plr):
    r = PLAYER_RADIUS
    for obs in solid_obstacles:
        ox, oy = obs["x"], obs["y"]
        if obs["type"] == "rock":
            or_ = obs["r"]
            if abs(plr["x"] - ox) > or_ + r + 5: continue
            if abs(plr["y"] - oy) > or_ + r + 5: continue
            dx = plr["x"] - ox
            dy = plr["y"] - oy
            dist = math.sqrt(dx * dx + dy * dy)
            min_dist = or_ + r
            if dist < min_dist:
                if dist == 0:
                    plr["x"] += min_dist
                    continue
                nx = dx / dist
                ny = dy / dist
                plr["x"] = ox + nx * min_dist
                plr["y"] = oy + ny * min_dist
        elif obs["type"] == "crate":
            ow, oh = obs["rw"], obs["rh"]
            if abs(plr["x"] - ox) > ow + r + 5: continue
            if abs(plr["y"] - oy) > oh + r + 5: continue
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
    for obs in solid_obstacles:
        ox, oy = obs["x"], obs["y"]
        if obs["type"] == "rock":
            or_ = obs["r"]
            if abs(px - ox) > or_ + pr + 5: continue
            if abs(py - oy) > or_ + pr + 5: continue
            dx = px - ox
            dy = py - oy
            if (dx * dx + dy * dy) < (or_ + pr) * (or_ + pr):
                return True
        elif obs["type"] == "crate":
            ow, oh = obs["rw"], obs["rh"]
            if abs(px - ox) > ow + pr + 5: continue
            if abs(py - oy) > oh + pr + 5: continue
            if circle_vs_rect(px, py, pr, ox, oy, ow, oh):
                return True
    return False

def get_leaderboard():
    """Top 10 jugadores por kills."""
    entries = []
    for sid, s in kill_scores.items():
        entries.append({"name": s["name"], "team": s["team"], "kills": s["kills"]})
    entries.sort(key=lambda e: e["kills"], reverse=True)
    return entries[:10]

def reset_game(winner_team):
    """Reinicia kills y respawnea a todos."""
    global team_kills, game_over, kill_scores
    team_kills = {"red": 0, "blue": 0}
    kill_scores = {}
    game_over = False
    # Respawnear a todos
    for sid, plr in list(players.items()):
        spawn = get_spawn(plr["team"])
        plr["x"] = clamp(spawn["x"], PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
        plr["y"] = clamp(spawn["y"], PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)
        plr["hp"] = 100
        plr["dead"] = False
        plr["dead_timer"] = 0
        # Reiniciar kills del jugador en la tabla
        kill_scores[sid] = {"name": plr["name"], "team": plr["team"], "kills": 0}
    socketio.emit("game_reset", {"winner_team": winner_team})
    print(f"[INFO] Game reset. Winner was: {winner_team}")

def game_loop():
    global last_update, game_over
    tick_interval = GAME_TICK

    while True:
        loop_start = time.time()
        dt = min(loop_start - last_update, 0.05)
        last_update = loop_start

        if game_over:
            elapsed = time.time() - loop_start
            sleep_time = tick_interval - elapsed
            if sleep_time > 0:
                socketio.sleep(min(sleep_time, 0.033))
            continue

        dead_projectiles = []
        for pid, proj in list(projectiles.items()):
            proj["x"] += proj["dx"] * PROJECTILE_SPEED * dt
            proj["y"] += proj["dy"] * PROJECTILE_SPEED * dt
            proj["lifetime"] -= dt

            if proj["lifetime"] <= 0:
                dead_projectiles.append(pid); continue
            if proj["x"] < 0 or proj["x"] > MAP_WIDTH or proj["y"] < 0 or proj["y"] > MAP_HEIGHT:
                dead_projectiles.append(pid); continue
            if projectile_hits_obstacle(proj):
                dead_projectiles.append(pid); continue

            owner_id = proj["owner_id"]
            owner_team = proj.get("owner_team", "")

            for plr_id, plr in list(players.items()):
                if plr_id == owner_id or plr["team"] == owner_team or plr["dead"]:
                    continue
                dx = plr["x"] - proj["x"]
                dy = plr["y"] - proj["y"]
                if abs(dx) > PLAYER_RADIUS + PROJECTILE_WIDTH + 20: continue
                if abs(dy) > PLAYER_RADIUS + PROJECTILE_WIDTH + 20: continue
                dist_sq = dx * dx + dy * dy
                if dist_sq < (PLAYER_RADIUS + PROJECTILE_WIDTH) ** 2:
                    plr["hp"] -= proj["damage"]
                    dead_projectiles.append(pid)

                    if plr["hp"] <= 0:
                        plr["hp"] = 0
                        plr["dead"] = True
                        plr["dead_timer"] = 3.0

                        # Registrar kill
                        killer = players.get(owner_id)
                        if killer:
                            team_kills[killer["team"]] = team_kills.get(killer["team"], 0) + 1
                            if owner_id not in kill_scores:
                                kill_scores[owner_id] = {"name": killer["name"], "team": killer["team"], "kills": 0}
                            kill_scores[owner_id]["kills"] += 1

                        socketio.emit("player_died", {
                            "id": plr_id,
                            "victim_name": plr["name"],
                            "victim_team": plr["team"],
                            "killer_id": owner_id,
                            "killer_name": killer["name"] if killer else "?",
                            "killer_team": killer["team"] if killer else "",
                            "team_kills": team_kills,
                            "leaderboard": get_leaderboard()
                        })

                        # Comprobar victoria
                        winning_team = None
                        if team_kills["red"] >= KILLS_TO_WIN:
                            winning_team = "red"
                        elif team_kills["blue"] >= KILLS_TO_WIN:
                            winning_team = "blue"

                        if winning_team:
                            game_over = True
                            socketio.emit("game_over", {
                                "winner_team": winning_team,
                                "team_kills": team_kills,
                                "leaderboard": get_leaderboard()
                            })
                            # Reiniciar tras 8 segundos
                            def delayed_reset(wt=winning_team):
                                socketio.sleep(8)
                                reset_game(wt)
                            socketio.start_background_task(delayed_reset)
                    break

        for pid in set(dead_projectiles):
            projectiles.pop(pid, None)

        # Respawn
        for plr_id, plr in list(players.items()):
            if plr["dead"]:
                plr["dead_timer"] -= dt
                if plr["dead_timer"] <= 0:
                    spawn = get_spawn(plr["team"])
                    plr["x"] = clamp(spawn["x"], PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
                    plr["y"] = clamp(spawn["y"], PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)
                    plr["hp"] = 100
                    plr["dead"] = False
                    plr["dead_timer"] = 0
                    socketio.emit("player_respawned", {"id": plr_id})

        current_state = {
            "players": {
                pid: {
                    "id": plr["id"],
                    "x": plr["x"],
                    "y": plr["y"],
                    "hp": plr["hp"],
                    "team": plr["team"],
                    "shape": plr["shape"],
                    "name": plr["name"],
                    "dead": plr["dead"],
                    "angle": plr.get("angle", 0)
                }
                for pid, plr in players.items()
            },
            "projectiles": {
                pid: {
                    "id": proj["id"],
                    "x": proj["x"],
                    "y": proj["y"],
                    "dx": proj["dx"],
                    "dy": proj["dy"],
                    "owner_team": proj["owner_team"],
                    "damage": proj["damage"]
                }
                for pid, proj in projectiles.items()
            },
            "team_kills": team_kills
        }
        socketio.emit("game_state", current_state)

        elapsed = time.time() - loop_start
        sleep_time = tick_interval - elapsed
        if sleep_time > 0:
            socketio.sleep(min(sleep_time, 0.033))

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
    print("Client connected")

@socketio.on("join_game")
def on_join(data):
    from flask import request
    import random
    sid = request.sid
    team = data.get("team", "red")
    name = str(data.get("name", "Jugador"))[:16].strip() or "Jugador"
    if team not in ["red", "blue"]:
        team = "red"

    shape = random.choice(["circle", "square", "triangle"])
    spawn = get_spawn(team)
    player = {
        "id": sid,
        "x": clamp(spawn["x"], PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS),
        "y": clamp(spawn["y"], PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS),
        "hp": 100,
        "team": team,
        "shape": shape,
        "name": name,
        "dead": False,
        "dead_timer": 0,
        "angle": 0,
        "last_shot": 0
    }
    players[sid] = player
    kill_scores[sid] = {"name": name, "team": team, "kills": 0}

    emit("joined", {
        "id": sid,
        "x": player["x"],
        "y": player["y"],
        "team": team,
        "shape": shape,
        "name": name,
        "map_width": MAP_WIDTH,
        "map_height": MAP_HEIGHT,
        "kills_to_win": KILLS_TO_WIN,
        "team_kills": team_kills,
        "leaderboard": get_leaderboard()
    })
    # Notificar a los demás el nuevo leaderboard
    socketio.emit("leaderboard_update", {"leaderboard": get_leaderboard(), "team_kills": team_kills})
    print(f"Player joined: [{team}] [{shape}] [{name}]")

@socketio.on("player_input")
def on_input(data):
    from flask import request
    sid = request.sid
    if sid not in players: return
    plr = players[sid]
    if plr["dead"]: return

    keys = data.get("keys", {})
    dt = min(data.get("dt", 0.016), 0.05)
    plr["angle"] = data.get("angle", 0)

    dx, dy = 0, 0
    if keys.get("w"): dy -= 1
    if keys.get("s"): dy += 1
    if keys.get("a"): dx -= 1
    if keys.get("d"): dx += 1

    if dx != 0 and dy != 0:
        length = math.sqrt(dx * dx + dy * dy)
        dx /= length
        dy /= length

    plr["x"] = clamp(plr["x"] + dx * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
    plr["y"] = clamp(plr["y"] + dy * PLAYER_SPEED * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)
    resolve_player_obstacle(plr)

@socketio.on("shoot")
def on_shoot(data):
    from flask import request
    sid = request.sid
    if sid not in players: return
    plr = players[sid]
    if plr["dead"]: return

    now = time.time()
    fire_rate = SHAPE_FIRE_RATE[plr["shape"]]
    if now - plr.get("last_shot", 0) < fire_rate: return
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
            "x": plr["x"], "y": plr["y"],
            "dx": math.cos(shot_angle), "dy": math.sin(shot_angle),
            "owner_id": sid, "owner_team": plr["team"],
            "damage": damage, "lifetime": PROJECTILE_LIFETIME
        }

@socketio.on("ping_request")
def on_ping():
    emit("pong_response")

@socketio.on("disconnect")
def on_disconnect():
    from flask import request
    sid = request.sid
    if sid in players:
        del players[sid]
        kill_scores.pop(sid, None)
        emit("player_left", {"id": sid}, broadcast=True)
        socketio.emit("leaderboard_update", {"leaderboard": get_leaderboard(), "team_kills": team_kills})
        print(f"Player disconnected: {sid}")

if __name__ == "__main__":
    socketio.start_background_task(game_loop)
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)
