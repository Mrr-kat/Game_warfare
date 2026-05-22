import math
import time
import uuid
import os

from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder="static", template_folder=".")
app.config["SECRET_KEY"] = "battleground2025"

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading"
)

MAP_WIDTH = 5000
MAP_HEIGHT = 5000

PLAYER_SPEED = 250
PLAYER_RADIUS = 20

PROJECTILE_SPEED = 600
PROJECTILE_LIFETIME = 3.0

TICK_RATE = 30
VISION_DISTANCE = 1200
VISION_DISTANCE_SQ = VISION_DISTANCE * VISION_DISTANCE

PROJECTILE_RADIUS = 6

RED_SPAWN = {"x": 200, "y": 200}
BLUE_SPAWN = {"x": 4800, "y": 4800}

SHAPE_DAMAGE = {
    "circle": 20,
    "square": 10,
    "triangle": 10
}

SHAPE_FIRE_RATE = {
    "circle": 1.0,
    "square": 1.0,
    "triangle": 0.3
}

SHAPE_PROJECTILE_COUNT = {
    "circle": 1,
    "square": 3,
    "triangle": 1
}

SHAPE_SPREAD = {
    "circle": 0.0,
    "square": 0.25,
    "triangle": 0.0
}

players = {}
projectiles = {}

last_update = time.time()


def clamp(v, mn, mx):
    return max(mn, min(mx, v))


def get_spawn(team):
    if team == "red":
        return RED_SPAWN
    return BLUE_SPAWN


def dist_sq(x1, y1, x2, y2):
    dx = x2 - x1
    dy = y2 - y1
    return dx * dx + dy * dy


# =========================================================
# GAME LOOP
# =========================================================

def game_loop():
    global last_update

    tick_interval = 1.0 / TICK_RATE

    while True:

        start = time.time()

        dt = min(start - last_update, 0.05)
        last_update = start

        # =========================================
        # UPDATE PROJECTILES
        # =========================================

        dead_projectiles = []

        for pid, proj in list(projectiles.items()):

            proj["x"] += proj["dx"] * PROJECTILE_SPEED * dt
            proj["y"] += proj["dy"] * PROJECTILE_SPEED * dt

            proj["lifetime"] -= dt

            if proj["lifetime"] <= 0:
                dead_projectiles.append(pid)
                continue

            if (
                proj["x"] < 0 or
                proj["x"] > MAP_WIDTH or
                proj["y"] < 0 or
                proj["y"] > MAP_HEIGHT
            ):
                dead_projectiles.append(pid)
                continue

            # HIT PLAYERS

            for sid, plr in players.items():

                if sid == proj["owner_id"]:
                    continue

                if plr["team"] == proj["owner_team"]:
                    continue

                if plr["dead"]:
                    continue

                if dist_sq(
                    proj["x"],
                    proj["y"],
                    plr["x"],
                    plr["y"]
                ) < (PLAYER_RADIUS + PROJECTILE_RADIUS) ** 2:

                    plr["hp"] -= proj["damage"]

                    dead_projectiles.append(pid)

                    if plr["hp"] <= 0:

                        plr["hp"] = 0
                        plr["dead"] = True
                        plr["dead_timer"] = 3

                        socketio.emit("player_died", {
                            "id": sid,
                            "killer_id": proj["owner_id"],
                            "killer_team": proj["owner_team"],
                            "victim_team": plr["team"]
                        })

                    break

        for pid in dead_projectiles:
            projectiles.pop(pid, None)

        # =========================================
        # RESPAWN
        # =========================================

        for sid, plr in players.items():

            if not plr["dead"]:
                continue

            plr["dead_timer"] -= dt

            if plr["dead_timer"] <= 0:

                spawn = get_spawn(plr["team"])

                plr["x"] = spawn["x"]
                plr["y"] = spawn["y"]

                plr["hp"] = 100
                plr["dead"] = False

                socketio.emit("player_respawned", {
                    "id": sid
                })

        # =========================================
        # SEND PLAYER SPECIFIC STATE
        # =========================================

        for sid, current_player in players.items():

            visible_players = {}
            visible_projectiles = {}

            px = current_player["x"]
            py = current_player["y"]

            # PLAYERS

            for other_sid, plr in players.items():

                if dist_sq(px, py, plr["x"], plr["y"]) > VISION_DISTANCE_SQ:
                    continue

                visible_players[other_sid] = {
                    "id": other_sid,
                    "x": round(plr["x"], 1),
                    "y": round(plr["y"], 1),
                    "hp": plr["hp"],
                    "team": plr["team"],
                    "shape": plr["shape"],
                    "dead": plr["dead"],
                    "angle": round(plr["angle"], 2)
                }

            # PROJECTILES

            for proj_id, proj in projectiles.items():

                if dist_sq(px, py, proj["x"], proj["y"]) > VISION_DISTANCE_SQ:
                    continue

                visible_projectiles[proj_id] = {
                    "x": round(proj["x"], 1),
                    "y": round(proj["y"], 1),
                    "dx": round(proj["dx"], 2),
                    "dy": round(proj["dy"], 2),
                    "owner_team": proj["owner_team"]
                }

            socketio.emit("game_state", {
                "players": visible_players,
                "projectiles": visible_projectiles
            }, to=sid)

        elapsed = time.time() - start

        socketio.sleep(max(0, tick_interval - elapsed))


# =========================================================
# ROUTES
# =========================================================

@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/game.js")
def gamejs():
    return send_from_directory(".", "game.js")


@app.route("/style.css")
def stylecss():
    return send_from_directory(".", "style.css")


# =========================================================
# SOCKET EVENTS
# =========================================================

@socketio.on("join_game")
def join_game(data):

    sid = request.sid

    import random

    team = data.get("team", "red")

    shape = random.choice([
        "circle",
        "square",
        "triangle"
    ])

    spawn = get_spawn(team)

    players[sid] = {
        "id": sid,
        "x": spawn["x"],
        "y": spawn["y"],
        "hp": 100,
        "team": team,
        "shape": shape,
        "dead": False,
        "dead_timer": 0,
        "angle": 0,
        "last_shot": 0
    }

    emit("joined", {
        "id": sid,
        "team": team,
        "shape": shape
    })


@socketio.on("player_input")
def player_input(data):

    sid = request.sid

    if sid not in players:
        return

    plr = players[sid]

    if plr["dead"]:
        return

    dt = min(data.get("dt", 0.016), 0.05)

    keys = data.get("keys", {})

    dx = 0
    dy = 0

    if keys.get("w"):
        dy -= 1

    if keys.get("s"):
        dy += 1

    if keys.get("a"):
        dx -= 1

    if keys.get("d"):
        dx += 1

    if dx != 0 or dy != 0:

        length = math.sqrt(dx * dx + dy * dy)

        dx /= length
        dy /= length

    plr["x"] += dx * PLAYER_SPEED * dt
    plr["y"] += dy * PLAYER_SPEED * dt

    plr["x"] = clamp(plr["x"], 0, MAP_WIDTH)
    plr["y"] = clamp(plr["y"], 0, MAP_HEIGHT)

    plr["angle"] = data.get("angle", 0)


@socketio.on("shoot")
def shoot(data):

    sid = request.sid

    if sid not in players:
        return

    plr = players[sid]

    if plr["dead"]:
        return

    now = time.time()

    fire_rate = SHAPE_FIRE_RATE[plr["shape"]]

    if now - plr["last_shot"] < fire_rate:
        return

    plr["last_shot"] = now

    count = SHAPE_PROJECTILE_COUNT[plr["shape"]]
    spread = SHAPE_SPREAD[plr["shape"]]

    angle = data.get("angle", 0)

    for i in range(count):

        shot_angle = angle

        if count > 1:
            shot_angle += (i - (count - 1) / 2) * spread

        pid = str(uuid.uuid4())

        projectiles[pid] = {
            "x": plr["x"],
            "y": plr["y"],
            "dx": math.cos(shot_angle),
            "dy": math.sin(shot_angle),
            "damage": SHAPE_DAMAGE[plr["shape"]],
            "owner_id": sid,
            "owner_team": plr["team"],
            "lifetime": PROJECTILE_LIFETIME
        }


@socketio.on("disconnect")
def disconnect_event():

    sid = request.sid

    if sid in players:
        del players[sid]

        emit("player_left", {
            "id": sid
        }, broadcast=True)


if __name__ == "__main__":
    socketio.start_background_task(game_loop)
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app,host="0.0.0.0",port=port,debug=False,allow_unsafe_werkzeug=True)
