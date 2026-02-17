const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const MAP_SIZE = 4000;

// State
const players = {};
const powerups = {};
const activeSessions = {};
let powerupId = 0;

// Power types (removed: warpgate, juggernaut, necromancer)
const POWER_TYPES = [
    'dash', 'teleport', 'clone', 'blackhole', 'nuke', 'heal', 'emp',
    'swap', 'shockwave', 'speed', 'phase', 'berserker', 'shield',
    'vampire', 'rage', 'tank', 'magnet', 'thorns', 'regeneration',
    'tripleshot', 'laser', 'rocket', 'scatter', 'sniper', 'minigun',
    'explosive', 'freeze', 'poison', 'lightning',
    'timebomb', 'orbitallaser', 'shadowclone', 'frostnova', 'bloodpact',
    'chainsplit', 'voidbeam',
    // New high-quality regular powers
    'chainlightning', 'tornado', 'inferno', 'soulshield', 'gravitybomb',
    'deathmark', 'mirror', 'chronostasis', 'pulsar', 'barrier'
];

// Omega/legendary power - spawns very rarely (2% chance per spawn)
const OMEGA_SPAWN_TYPE = 'meteor';

// Spawn powerup
function spawnPowerup() {
    const id = `pu_${powerupId++}`;
    // 2% chance to spawn the omega meteor power
    let type;
    if (Math.random() < 0.02) {
        type = OMEGA_SPAWN_TYPE;
    } else {
        type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    }
    powerups[id] = {
        id,
        x: Math.random() * (MAP_SIZE - 100) + 50,
        y: Math.random() * (MAP_SIZE - 100) + 50,
        type
    };
    io.emit('powerupSpawn', powerups[id]);
}

// Initialize powerups
console.log('Spawning initial powerups...');
for (let i = 0; i < 50; i++) {
    const id = `pu_${powerupId++}`;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    powerups[id] = {
        id,
        x: Math.random() * (MAP_SIZE - 100) + 50,
        y: Math.random() * (MAP_SIZE - 100) + 50,
        type
    };
}
console.log(`✅ Spawned ${Object.keys(powerups).length} initial powerups`);

// Health endpoints
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        players: Object.keys(players).length,
        powerups: Object.keys(powerups).length,
        uptime: process.uptime()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now() });
});

// Socket.IO connection
io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);

    socket.on('join', (data) => {
        console.log(`[JOIN] ${data.name} attempting to join (userId: ${data.userId || 'guest'})`);

        if (!data || !data.name) {
            console.log(`[ERROR] Invalid join data from ${socket.id}`);
            socket.emit('joinError', { message: 'Invalid join data' });
            return;
        }

        if (data.userId && activeSessions[data.userId]) {
            const existingSocketId = activeSessions[data.userId];
            const existingSocket = io.sockets.sockets.get(existingSocketId);
            if (existingSocket && existingSocket.connected) {
                console.log(`[BLOCKED] Duplicate session for userId: ${data.userId}`);
                socket.emit('duplicateSession', { message: 'This account is already playing in another session!' });
                return;
            } else {
                console.log(`[CLEANUP] Removing stale session for userId: ${data.userId}`);
                delete activeSessions[data.userId];
                if (players[existingSocketId]) delete players[existingSocketId];
            }
        }

        if (data.userId) {
            activeSessions[data.userId] = socket.id;
            console.log(`[SESSION] Registered userId ${data.userId} → ${socket.id}`);
        }

        const playerName = String(data.name).substring(0, 15).trim() || 'Guest';
        players[socket.id] = {
            id: socket.id,
            userId: data.userId || null,
            name: playerName,
            x: Math.random() * (MAP_SIZE - 200) + 100,
            y: Math.random() * (MAP_SIZE - 200) + 100,
            angle: 0,
            hp: 100,
            kills: 0,
            currentPower: null,
            speedActive: false,
            berserkerActive: false,
            phaseActive: false,
            frozen: 0
        };

        console.log(`[✓] ${playerName} (${socket.id}) spawned`);

        socket.emit('init', {
            player: players[socket.id],
            players: players,
            powerups: powerups,
            projectiles: {}
        });

        socket.emit('joinSuccess');
        socket.broadcast.emit('playerJoined', players[socket.id]);
        console.log(`[PLAYERS] Total online: ${Object.keys(players).length}`);
    });

    // Movement
    socket.on('move', (data) => {
        if (players[socket.id]) {
            Object.assign(players[socket.id], data);
            socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
        }
    });

    // Shooting
    socket.on('shoot', (data) => {
        if (!players[socket.id]) return;
        data.ownerId = socket.id;
        socket.broadcast.emit('remoteShoot', data);
    });

    // Abilities
    socket.on('abilityUsed', (data) => {
        if (!players[socket.id]) return;
        socket.broadcast.emit('abilityEffect', data);
    });

    // Hits
    socket.on('playerHit', (data) => {
        if (players[data.targetId]) {
            players[data.targetId].hp -= data.damage;
            if (players[data.targetId].hp < 0) players[data.targetId].hp = 0;
        }
        if (data.targetId && io.sockets.sockets.get(data.targetId)) {
            io.to(data.targetId).emit('playerHit', data);
        }
        socket.broadcast.emit('playerHit', data);
    });

    // Freeze player (new - reworked freeze power)
    socket.on('freezePlayer', (data) => {
        if (!players[socket.id]) return;
        const targetSocket = io.sockets.sockets.get(data.targetId);
        if (targetSocket && targetSocket.connected) {
            io.to(data.targetId).emit('gotFrozen', { duration: 3, attackerId: socket.id });
        }
        // Broadcast freeze visual to all other players
        socket.broadcast.emit('playerFrozen', { targetId: data.targetId, duration: 3 });
    });

    // Death
    socket.on('playerDied', (data) => {
        console.log(`[DEATH] ${data.victimId} killed by ${data.killerId}`);
        if (players[data.victimId]) {
            players[data.victimId].hp = 100;
            players[data.victimId].kills = 0;
            players[data.victimId].x = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].y = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].currentPower = null;
            players[data.victimId].frozen = 0;
        }
        if (data.killerId && players[data.killerId]) {
            players[data.killerId].kills = (players[data.killerId].kills || 0) + 1;
        }
        io.emit('playerDied', data);
    });

    // Powerups
    socket.on('powerupTaken', (data) => {
        if (powerups[data.id]) {
            delete powerups[data.id];
            io.emit('powerupTaken', data.id);
            setTimeout(() => spawnPowerup(), 5000);
        }
    });

    socket.on('dropPower', (data) => {
        const id = `drop_${Date.now()}_${socket.id}`;
        powerups[id] = { id, type: data.type, x: data.x, y: data.y };
        io.emit('powerupSpawn', powerups[id]);
    });

    // Chat
    socket.on('chatMessage', (data) => {
        if (!data.text || !data.playerName) return;
        const sanitized = {
            text: String(data.text).substring(0, 100),
            playerName: String(data.playerName).substring(0, 15)
        };
        io.emit('chatMessage', sanitized);
    });

    // === ADMIN EVENTS (server-wide) ===
    socket.on('triggerEvent', (data) => {
        if (!players[socket.id]) return;
        const eventType = data.type;
        console.log(`[ADMIN_EVENT] ${players[socket.id].name} triggered event: ${eventType}`);

        switch (eventType) {
            case 'richEvent': {
                // Spawn 30 legendary powerups at random positions
                const legendaryPowers = ['blackhole', 'nuke', 'orbitallaser', 'frostnova', 'chainsplit', 'voidbeam', 'soulshield', 'chainlightning', 'deathmark', 'chronostasis'];
                for (let i = 0; i < 30; i++) {
                    const id = `event_${powerupId++}`;
                    const type = legendaryPowers[Math.floor(Math.random() * legendaryPowers.length)];
                    powerups[id] = {
                        id,
                        x: Math.random() * (MAP_SIZE - 200) + 100,
                        y: Math.random() * (MAP_SIZE - 200) + 100,
                        type
                    };
                    io.emit('powerupSpawn', powerups[id]);
                }
                io.emit('serverEvent', { type: 'richEvent', message: '💰 RICH EVENT HAS BEEN ACTIVATED 💰', subtitle: '30 Legendary Powers Spawned Everywhere!' });
                break;
            }
            case 'killFrenzy': {
                // Announce kill frenzy - double kills
                io.emit('serverEvent', { type: 'killFrenzy', message: '⚔️ KILL FRENZY HAS BEEN ACTIVATED ⚔️', subtitle: 'All kills count DOUBLE for 30 seconds!' });
                // Auto-end after 30 seconds
                setTimeout(() => {
                    io.emit('serverEvent', { type: 'killFrenzyEnd', message: '⚔️ KILL FRENZY HAS ENDED ⚔️', subtitle: '' });
                }, 30000);
                break;
            }
            case 'healingWave': {
                // Heal all players to 100
                for (let id in players) {
                    players[id].hp = 100;
                }
                io.emit('serverEvent', { type: 'healingWave', message: '❤️ HEALING WAVE HAS BEEN ACTIVATED ❤️', subtitle: 'All players fully restored to 100 HP!' });
                break;
            }
            case 'meteorStorm': {
                // Trigger global meteor storm
                io.emit('serverEvent', { type: 'meteorStorm', message: '☄️ METEOR STORM HAS BEGUN ☄️', subtitle: 'Meteors raining down everywhere! Take cover!' });
                break;
            }
            case 'powerExplosion': {
                // Spawn 50 random powers all over the map
                for (let i = 0; i < 50; i++) {
                    const id = `event_${powerupId++}`;
                    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
                    powerups[id] = {
                        id,
                        x: Math.random() * (MAP_SIZE - 200) + 100,
                        y: Math.random() * (MAP_SIZE - 200) + 100,
                        type
                    };
                    io.emit('powerupSpawn', powerups[id]);
                }
                io.emit('serverEvent', { type: 'powerExplosion', message: '🌈 POWER EXPLOSION HAS BEEN ACTIVATED 🌈', subtitle: '50 Powers Spawned Across the Entire Map!' });
                break;
            }
        }
    });

    // Admin announcement
    socket.on('sendAnnouncement', (data) => {
        if (!players[socket.id]) return;
        const text = String(data.text || '').substring(0, 120).trim();
        if (!text) return;
        console.log(`[ANNOUNCEMENT] ${players[socket.id].name}: ${text}`);
        io.emit('serverAnnouncement', { text });
    });

    // Disconnect
    socket.on('disconnect', (reason) => {
        console.log(`[DISCONNECT] ${socket.id} - Reason: ${reason}`);
        if (players[socket.id] && players[socket.id].userId) {
            delete activeSessions[players[socket.id].userId];
        }
        const playerName = players[socket.id] ? players[socket.id].name : 'Unknown';
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
        console.log(`[LEFT] ${playerName} - Total online: ${Object.keys(players).length}`);
    });
});

// Cleanup stale sessions
setInterval(() => {
    const connectedSockets = Array.from(io.sockets.sockets.keys());
    for (const playerId in players) {
        if (!connectedSockets.includes(playerId)) {
            if (players[playerId].userId) delete activeSessions[players[playerId].userId];
            delete players[playerId];
            io.emit('playerLeft', playerId);
        }
    }
    for (const userId in activeSessions) {
        const socketId = activeSessions[userId];
        if (!connectedSockets.includes(socketId)) delete activeSessions[userId];
    }
}, 30000);

// Maintain minimum powerups
setInterval(() => {
    const minPowerups = 30;
    const currentCount = Object.keys(powerups).length;
    if (currentCount < minPowerups) {
        const toSpawn = minPowerups - currentCount;
        for (let i = 0; i < toSpawn; i++) spawnPowerup();
    }
}, 10000);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down...');
    io.emit('serverShutdown', { message: 'Server restarting...' });
    server.close(() => process.exit(0));
});

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   PowerSwap Server Running               ║
║   Port: ${PORT}                          ║
║   Map: ${MAP_SIZE}x${MAP_SIZE}           ║
║   Powerups: ${Object.keys(powerups).length}                            ║
╚══════════════════════════════════════════╝
    `);
});
