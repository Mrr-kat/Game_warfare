# BATTLEGROUND

Juego multijugador en tiempo real para dos equipos, construido con Flask, Socket.IO y HTML5 Canvas.
Real-time two-team multiplayer game built with Flask, Socket.IO and HTML5 Canvas.

[Español](#español) | [English](#english)

---

## Español

### Contenido

- [Descripción general](#descripción-general)
- [Características principales](#características-principales)
- [Tecnologías utilizadas](#tecnologías-utilizadas)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Requisitos](#requisitos)
- [Instalación y ejecución local](#instalación-y-ejecución-local)
- [Cómo jugar](#cómo-jugar)
- [Despliegue en Railway](#despliegue-en-railway)
- [Configuración del juego](#configuración-del-juego)
- [Notas técnicas](#notas-técnicas)
- [Licencia](#licencia)

### Descripción general

BATTLEGROUND es un shooter multijugador 2D por equipos que se ejecuta directamente en el navegador. Los jugadores eligen entre los bandos rojo y azul, reciben una forma geométrica aleatoria con estadísticas propias y compiten por alcanzar 20 eliminaciones en equipo.

El servidor, escrito en Python con Flask y Flask-SocketIO, mantiene el estado autoritativo del juego a 20 ticks por segundo. El cliente renderiza en HTML5 Canvas con predicción local e interpolación de entidades remotas, de modo que la experiencia se mantiene fluida incluso con latencia.

El primer equipo que acumule 20 eliminaciones gana la partida. Al finalizar, se muestra una pantalla de victoria con la tabla de clasificación y el servidor reinicia automáticamente la ronda tras ocho segundos.

### Características principales

- **Dos equipos:** rojo y azul, cada uno con su propia zona de aparición en esquinas opuestas del mapa.
- **Formas con estadísticas distintas:** cada jugador recibe al azar un círculo, un cuadrado o un triángulo, con daño, cadencia y cantidad de proyectiles diferentes.
- **Mapa de 2500 x 2500 píxeles:** obstáculos sólidos generados de forma determinista (rocas y cajas) que bloquean tanto el movimiento como los proyectiles.
- **Puntuación por equipo:** marcador en pantalla y condición de victoria a 20 eliminaciones.
- **Tabla de clasificación en vivo:** top 10 de jugadores por eliminaciones, con resaltado del jugador local.
- **Feed de eliminaciones:** notificaciones en tiempo real de cada baja, con los colores de equipo correspondientes.
- **Reaparición automática:** tras tres segundos de espera con cuenta regresiva en pantalla.
- **Predicción local e interpolación:** el cliente predice su propio movimiento y suaviza el de los jugadores remotos para reducir la sensación de latencia.
- **Monitor de rendimiento:** FPS y ping visibles en la esquina inferior izquierda.
- **Interfaz completa en español:** lobby, HUD, pantalla de muerte y pantalla de victoria.

### Tecnologías utilizadas

| Capa        | Tecnología                      |
|-------------|---------------------------------|
| Servidor    | Python 3, Flask, Flask-SocketIO |
| Tiempo real | Socket.IO 4.7                   |
| Cliente     | HTML5 Canvas, JavaScript vanilla |
| Estilos     | CSS3 con variables personalizadas |
| Despliegue  | Railway (Nixpacks)              |

### Estructura del repositorio

```text
.
├── server.py          # Servidor autoritativo, lógica de juego y eventos Socket.IO
├── game.js            # Cliente: render, predicción, interpolación y entrada
├── index.html         # Estructura del lobby y la pantalla de juego
├── style.css          # Estilos de toda la interfaz
├── requirements.txt   # Dependencias de Python
└── railway.json       # Configuración de despliegue en Railway
```

### Requisitos

- Python 3.9 o superior
- pip
- Navegador moderno con soporte para Canvas y WebSockets

### Instalación y ejecución local

1. Clona el repositorio:

   ```bash
   git clone https://github.com/tu-usuario/battleground.git
   cd battleground
   ```

2. Crea un entorno virtual e instala las dependencias:

   ```bash
   python -m venv venv
   source venv/bin/activate        # En Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Inicia el servidor:

   ```bash
   python server.py
   ```

4. Abre `http://localhost:5000` en el navegador.

Para probar el multijugador, abre varias pestañas o comparte la dirección en tu red local.

### Cómo jugar

| Acción                       | Control                                   |
|------------------------------|-------------------------------------------|
| Moverse                      | `W`, `A`, `S`, `D`                        |
| Apuntar                      | Movimiento del ratón                      |
| Disparar                     | Clic izquierdo                            |
| Mostrar u ocultar la tabla   | Botón "TOP 10" en la esquina superior derecha |

Al entrar, selecciona un equipo, escribe tu nombre y pulsa **ENTRAR AL CAMPO**. La forma asignada determina tu estilo de combate:

| Forma     | Daño | Proyectiles        | Cadencia   |
|-----------|------|--------------------|------------|
| Círculo   | 20   | 1                  | Media      |
| Cuadrado  | 15   | 3, en abanico      | Media      |
| Triángulo | 12   | 1                  | Muy alta   |

### Despliegue en Railway

El repositorio incluye un `railway.json` listo para usar. Solo necesitas conectar el repositorio a Railway y la plataforma detectará automáticamente el proyecto Python mediante Nixpacks. El servidor escucha en el puerto definido por la variable de entorno `PORT`.

### Configuración del juego

Los parámetros principales están al inicio de `server.py` y pueden ajustarse a gusto:

```python
MAP_WIDTH = 2500
MAP_HEIGHT = 2500
PLAYER_SPEED = 280
PROJECTILE_SPEED = 550
KILLS_TO_WIN = 20
```

Las estadísticas de cada forma se definen en los diccionarios `SHAPE_DAMAGE`, `SHAPE_FIRE_RATE`, `SHAPE_PROJECTILE_COUNT` y `SHAPE_SPREAD`.

### Notas técnicas

- El servidor utiliza `async_mode="threading"` con Flask-SocketIO, por lo que no requiere eventlet ni gevent en ejecución, aunque están incluidos en `requirements.txt`.
- Los obstáculos se generan con un generador pseudoaleatorio determinista a partir de una semilla fija, lo que garantiza que cliente y servidor coincidan sin necesidad de transmitir el terreno.
- La entrada del cliente se envía al servidor a 20 Hz, alineada con el tick del servidor.
- El estado se emite a todos los clientes en cada tick; la interpolación del lado del cliente se encarga de suavizar la representación.

### Licencia

Este proyecto se distribuye bajo la licencia MIT.

---

## English

### Contents

- [Overview](#overview)
- [Key features](#key-features)
- [Tech stack](#tech-stack)
- [Repository structure](#repository-structure)
- [Requirements](#requirements)
- [Local installation and run](#local-installation-and-run)
- [How to play](#how-to-play)
- [Railway deployment](#railway-deployment)
- [Game configuration](#game-configuration)
- [Technical notes](#technical-notes)
- [License](#license)

### Overview

BATTLEGROUND is a 2D team-based multiplayer shooter that runs directly in the browser. Players pick between the red and blue sides, are assigned a random geometric shape with its own stats, and compete to reach 20 team eliminations.

The server, written in Python with Flask and Flask-SocketIO, maintains the authoritative game state at 20 ticks per second. The client renders with HTML5 Canvas using local prediction and interpolation of remote entities, keeping the experience smooth even under latency.

The first team to reach 20 eliminations wins the match. When the match ends, a victory screen with the leaderboard is shown and the server automatically resets the round after eight seconds.

### Key features

- **Two teams:** red and blue, each with its own spawn zone in opposite corners of the map.
- **Shapes with distinct stats:** every player is randomly assigned a circle, square or triangle, each with different damage, fire rate and projectile count.
- **2500 x 2500 pixel map:** deterministic solid obstacles (rocks and crates) that block both movement and projectiles.
- **Team scoring:** on-screen scoreboard and a 20-elimination victory condition.
- **Live leaderboard:** top 10 players by eliminations, with the local player highlighted.
- **Kill feed:** real-time notifications for each elimination, using the corresponding team colors.
- **Automatic respawn:** three-second wait with an on-screen countdown.
- **Local prediction and interpolation:** the client predicts its own movement and smooths remote players to reduce perceived latency.
- **Performance monitor:** FPS and ping displayed in the bottom-left corner.
- **Fully Spanish interface:** lobby, HUD, death screen and victory screen.

### Tech stack

| Layer      | Technology                      |
|------------|---------------------------------|
| Server     | Python 3, Flask, Flask-SocketIO |
| Realtime   | Socket.IO 4.7                   |
| Client     | HTML5 Canvas, vanilla JavaScript |
| Styling    | CSS3 with custom properties     |
| Deployment | Railway (Nixpacks)              |

### Repository structure

```text
.
├── server.py          # Authoritative server, game logic and Socket.IO events
├── game.js            # Client: rendering, prediction, interpolation and input
├── index.html         # Lobby and game screen markup
├── style.css          # Interface styles
├── requirements.txt   # Python dependencies
└── railway.json       # Railway deployment configuration
```

### Requirements

- Python 3.9 or higher
- pip
- A modern browser with Canvas and WebSocket support

### Local installation and run

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/battleground.git
   cd battleground
   ```

2. Create a virtual environment and install dependencies:

   ```bash
   python -m venv venv
   source venv/bin/activate        # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Start the server:

   ```bash
   python server.py
   ```

4. Open `http://localhost:5000` in your browser.

To test multiplayer, open several tabs or share the address on your local network.

### How to play

| Action              | Control                                  |
|---------------------|------------------------------------------|
| Move                | `W`, `A`, `S`, `D`                       |
| Aim                 | Mouse movement                           |
| Shoot               | Left click                               |
| Toggle leaderboard  | "TOP 10" button in the top-right corner  |

On entry, pick a team, type your name and press **ENTRAR AL CAMPO** ("enter the field"). The assigned shape determines your combat style:

| Shape    | Damage | Projectiles    | Fire rate |
|----------|--------|----------------|-----------|
| Circle   | 20     | 1              | Medium    |
| Square   | 15     | 3, spread      | Medium    |
| Triangle | 12     | 1              | Very high |

### Railway deployment

The repository ships with a ready-to-use `railway.json`. Simply connect the repository to Railway and the platform will automatically detect the Python project through Nixpacks. The server listens on the port defined by the `PORT` environment variable.

### Game configuration

The main parameters live at the top of `server.py` and can be tuned as needed:

```python
MAP_WIDTH = 2500
MAP_HEIGHT = 2500
PLAYER_SPEED = 280
PROJECTILE_SPEED = 550
KILLS_TO_WIN = 20
```

Per-shape stats are defined in the `SHAPE_DAMAGE`, `SHAPE_FIRE_RATE`, `SHAPE_PROJECTILE_COUNT` and `SHAPE_SPREAD` dictionaries.

### Technical notes

- The server uses `async_mode="threading"` with Flask-SocketIO, so it does not require eventlet or gevent at runtime, although they are listed in `requirements.txt`.
- Obstacles are generated with a deterministic pseudo-random generator from a fixed seed, ensuring client and server stay in sync without transmitting the terrain.
- Client-to-server input is sent at 20 Hz, aligned with the server tick.
- State is broadcast to all clients on every tick; client-side interpolation smooths the representation.

### License

This project is distributed under the MIT License.
