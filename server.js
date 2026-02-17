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

// Power types
const POWER_TYPES = [
    'dash', 'teleport', 'clone', 'blackhole', 'nuke', 'heal', 'emp', 
    'swap', 'shockwave', 'speed', 'phase', 'berserker', 'shield', 
    'vampire', 'rage', 'tank', 'magnet', 'thorns', 'regeneration', 
    'tripleshot', 'laser', 'rocket', 'scatter', 'sniper', 'minigun', 
    'explosive', 'freeze', 'poison', 'lightning'
];

// Spawn powerup
function spawnPowerup() {
    const id = `pu_${powerupId++}`;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
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

        // Validate
        if (!data || !data.name) {
            console.log(`[ERROR] Invalid join data from ${socket.id}`);
            socket.emit('joinError', { message: 'Invalid join data' });
            return;
        }

        // Check duplicate session
        if (data.userId && activeSessions[data.userId]) {
            const existingSocketId = activeSessions[data.userId];
            const existingSocket = io.sockets.sockets.get(existingSocketId);
            
            if (existingSocket && existingSocket.connected) {
                console.log(`[BLOCKED] Duplicate session for userId: ${data.userId}`);
                socket.emit('duplicateSession', { 
                    message: 'This account is already playing in another session!' 
                });
                return;
            } else {
                console.log(`[CLEANUP] Removing stale session for userId: ${data.userId}`);
                delete activeSessions[data.userId];
                if (players[existingSocketId]) {
                    delete players[existingSocketId];
                }
            }
        }

        // Register session
        if (data.userId) {
            activeSessions[data.userId] = socket.id;
            console.log(`[SESSION] Registered userId ${data.userId} → ${socket.id}`);
        }

        // Create player
        const playerName = String(data.name).substring(0, 15).trim() || 'Guest';
        players[socket.id] = {
            id: socket.id,
            userId: data.userId || null,  // ✅ FIXED: was "oderId"
            name: playerName,
            x: Math.random() * (MAP_SIZE - 200) + 100,
            y: Math.random() * (MAP_SIZE - 200) + 100,
            angle: 0,
            hp: 100,
            kills: 0,
            currentPower: null,
            speedActive: false,
            berserkerActive: false,
            phaseActive: false
        };

        console.log(`[✓] ${playerName} (${socket.id}) spawned at (${Math.round(players[socket.id].x)}, ${Math.round(players[socket.id].y)})`);

        // Send init data
        socket.emit('init', {
            player: players[socket.id],
            players: players,
            powerups: powerups,
            projectiles: {}
        });

        // Send join success
        socket.emit('joinSuccess');
        console.log(`[SUCCESS] joinSuccess sent to ${socket.id}`);

        // Notify others
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

    // Death
    socket.on('playerDied', (data) => {
        console.log(`[DEATH] ${data.victimId} killed by ${data.killerId}`);
        
        if (players[data.victimId]) {
            players[data.victimId].hp = 100;
            players[data.victimId].kills = 0;
            players[data.victimId].x = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].y = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].currentPower = null;
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

    // Disconnect
    socket.on('disconnect', (reason) => {
        console.log(`[DISCONNECT] ${socket.id} - Reason: ${reason}`);
        
        if (players[socket.id] && players[socket.id].userId) {
            delete activeSessions[players[socket.id].userId];
        }
        
        const playerName = players[socket.id]?.name || 'Unknown';
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
            if (players[playerId].userId) {
                delete activeSessions[players[playerId].userId];
            }
            delete players[playerId];
            io.emit('playerLeft', playerId);
        }
    }
    
    for (const userId in activeSessions) {
        const socketId = activeSessions[userId];
        if (!connectedSockets.includes(socketId)) {
            delete activeSessions[userId];
        }
    }
}, 30000);

// Maintain minimum powerups
setInterval(() => {
    const minPowerups = 30;
    const currentCount = Object.keys(powerups).length;
    
    if (currentCount < minPowerups) {
        const toSpawn = minPowerups - currentCount;
        for (let i = 0; i < toSpawn; i++) {
            spawnPowerup();
        }
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
╔════════════════════════════════════════╗
║   PowerSwap Server Running             ║
║   Port: ${PORT}                        ║
║   Map: ${MAP_SIZE}x${MAP_SIZE}         ║
║   Powerups: ${Object.keys(powerups).length}                         ║
╚════════════════════════════════════════╝
    `);
});
