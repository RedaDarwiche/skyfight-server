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
const activeSessions = {}; // Track active userIds to prevent duplicates
let powerupId = 0;

// Match these exactly to your Frontend POWERS list
const POWER_TYPES = [
    'dash', 'teleport', 'clone', 'blackhole', 'nuke', 'heal', 'emp', 
    'swap', 'shockwave', 'speed', 'phase', 'berserker', 'shield', 
    'vampire', 'rage', 'tank', 'magnet', 'thorns', 'regeneration', 
    'tripleshot', 'laser', 'rocket', 'scatter', 'sniper', 'minigun', 
    'explosive', 'freeze', 'poison', 'lightning'
];

// Spawn a powerup at random location
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
    console.log(`Spawned powerup: ${type} at (${Math.round(powerups[id].x)}, ${Math.round(powerups[id].y)})`);
}

// Spawn initial powerups
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
console.log(`Spawned ${Object.keys(powerups).length} initial powerups`);

// Health check endpoint for Render/Heroku
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

io.on('connection', (socket) => {
    console.log(`[CONNECT] Player connected: ${socket.id}`);

    // Send immediate acknowledgment that connection is established
    socket.emit('connected', { id: socket.id });

    socket.on('join', (data) => {
        console.log(`[JOIN] Player attempting to join: ${data.name} (userId: ${data.userId || 'guest'})`);

        // Validate data
        if (!data || !data.name) {
            console.log(`[JOIN ERROR] Invalid join data from ${socket.id}`);
            socket.emit('joinError', { message: 'Invalid join data' });
            return;
        }

        // Check for duplicate session
        if (data.userId && activeSessions[data.userId]) {
            const existingSocketId = activeSessions[data.userId];
            
            // Check if the existing socket is still connected
            const existingSocket = io.sockets.sockets.get(existingSocketId);
            if (existingSocket && existingSocket.connected) {
                console.log(`[JOIN BLOCKED] Duplicate session for userId: ${data.userId}`);
                socket.emit('duplicateSession', { 
                    message: 'This account is already playing in another session!' 
                });
                return; // Don't disconnect, just reject the join
            } else {
                // Old session is dead, clean it up
                console.log(`[CLEANUP] Removing stale session for userId: ${data.userId}`);
                delete activeSessions[data.userId];
                if (players[existingSocketId]) {
                    delete players[existingSocketId];
                }
            }
        }

        // Register this session
        if (data.userId) {
            activeSessions[data.userId] = socket.id;
            console.log(`[SESSION] Registered userId ${data.userId} to socket ${socket.id}`);
        }

        // Create player object
        const playerName = String(data.name).substring(0, 15).trim() || 'Guest';
        players[socket.id] = {
            id: socket.id,
            oderId: data.userId || null,
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

        console.log(`[JOIN SUCCESS] Player ${playerName} (${socket.id}) spawned at (${Math.round(players[socket.id].x)}, ${Math.round(players[socket.id].y)})`);

        // Send current state to new player
        socket.emit('init', {
            player: players[socket.id],
            players: players,
            powerups: powerups,
            projectiles: {}
        });

        // CRITICAL: Explicitly emit joinSuccess AFTER init
        socket.emit('joinSuccess');
        console.log(`[JOIN] Sent joinSuccess to ${socket.id}`);

        // Tell others a new player joined
        socket.broadcast.emit('playerJoined', players[socket.id]);
        
        console.log(`[PLAYERS] Total players online: ${Object.keys(players).length}`);
    });

    // MOVEMENT & STATE RELAY
    socket.on('move', (data) => {
        if (players[socket.id]) {
            const p = players[socket.id];
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            p.kills = data.kills;
            p.currentPower = data.currentPower;
            p.hp = data.hp;
            p.speedActive = data.speedActive;
            p.berserkerActive = data.berserkerActive;
            p.phaseActive = data.phaseActive;

            // Broadcast to everyone else
            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                ...data 
            });
        }
    });

    // SHOOTING RELAY
    socket.on('shoot', (data) => {
        if (!players[socket.id]) return;
        
        data.ownerId = socket.id;
        socket.broadcast.emit('remoteShoot', data);
    });

    // ABILITY RELAY
    socket.on('abilityUsed', (data) => {
        if (!players[socket.id]) return;
        
        // Relay the effect to everyone else so they see particles/explosions
        socket.broadcast.emit('abilityEffect', data);
    });

    // HIT & DAMAGE RELAY
    socket.on('playerHit', (data) => {
        // data = { targetId, damage, attackerId }
        
        // Update server-side HP for reference
        if (players[data.targetId]) {
            players[data.targetId].hp -= data.damage;
            
            // Clamp HP
            if (players[data.targetId].hp < 0) {
                players[data.targetId].hp = 0;
            }
        }

        // Tell the target they were hit
        if (data.targetId && io.sockets.sockets.get(data.targetId)) {
            io.to(data.targetId).emit('playerHit', data);
        }
        
        // Also broadcast for damage number effects
        socket.broadcast.emit('playerHit', data);
    });

    // DEATH RELAY
    socket.on('playerDied', (data) => {
        // data = { victimId, killerId }
        console.log(`[DEATH] Player ${data.victimId} killed by ${data.killerId}`);
        
        if (players[data.victimId]) {
            players[data.victimId].hp = 100;
            players[data.victimId].kills = 0;
            players[data.victimId].x = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].y = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].currentPower = null;
        }

        if (data.killerId && players[data.killerId]) {
            players[data.killerId].kills = (players[data.killerId].kills || 0) + 1;
            console.log(`[KILL] ${players[data.killerId].name} now has ${players[data.killerId].kills} kills`);
        }

        io.emit('playerDied', data);
    });

    // POWERUP HANDLING
    socket.on('powerupTaken', (data) => {
        if (powerups[data.id]) {
            const powerType = powerups[data.id].type;
            delete powerups[data.id];
            io.emit('powerupTaken', data.id);
            console.log(`[POWERUP] ${socket.id} took ${powerType}`);
            
            // Spawn a new one after 5 seconds
            setTimeout(() => {
                spawnPowerup();
            }, 5000);
        }
    });

    socket.on('dropPower', (data) => {
        const id = `drop_${Date.now()}_${socket.id}`;
        powerups[id] = {
            id: id,
            type: data.type,
            x: data.x,
            y: data.y
        };
        io.emit('powerupSpawn', powerups[id]);
        console.log(`[POWERUP] ${socket.id} dropped ${data.type}`);
    });

    // CHAT
    socket.on('chatMessage', (data) => {
        if (!data.text || !data.playerName) return;
        
        // Sanitize message
        const sanitizedData = {
            text: String(data.text).substring(0, 100),
            playerName: String(data.playerName).substring(0, 15)
        };
        
        io.emit('chatMessage', sanitizedData);
        console.log(`[CHAT] ${sanitizedData.playerName}: ${sanitizedData.text}`);
    });

    // PING for connection health
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            callback();
        }
    });

    // DISCONNECT
    socket.on('disconnect', (reason) => {
        console.log(`[DISCONNECT] Player ${socket.id} disconnected. Reason: ${reason}`);
        
        // Remove from active sessions if they had a userId
        if (players[socket.id] && players[socket.id].userId) {
            delete activeSessions[players[socket.id].userId];
            console.log(`[SESSION] Removed userId ${players[socket.id].userId} from active sessions`);
        }
        
        const playerName = players[socket.id]?.name || 'Unknown';
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
        
        console.log(`[PLAYERS] ${playerName} left. Total players online: ${Object.keys(players).length}`);
    });

    // ERROR HANDLING
    socket.on('error', (error) => {
        console.error(`[ERROR] Socket ${socket.id} error:`, error);
    });
});

// Periodic cleanup of stale sessions
setInterval(() => {
    const connectedSockets = Array.from(io.sockets.sockets.keys());
    
    // Clean up players that don't have active sockets
    for (const playerId in players) {
        if (!connectedSockets.includes(playerId)) {
            console.log(`[CLEANUP] Removing stale player: ${playerId}`);
            if (players[playerId].userId) {
                delete activeSessions[players[playerId].userId];
            }
            delete players[playerId];
            io.emit('playerLeft', playerId);
        }
    }
    
    // Clean up active sessions for disconnected sockets
    for (const oderId in activeSessions) {
        const socketId = activeSessions[oderId];
        if (!connectedSockets.includes(socketId)) {
            console.log(`[CLEANUP] Removing stale session for userId: ${oderId}`);
            delete activeSessions[oderId];
        }
    }
}, 30000); // Run every 30 seconds

// Ensure minimum powerups on map
setInterval(() => {
    const minPowerups = 30;
    const currentCount = Object.keys(powerups).length;
    
    if (currentCount < minPowerups) {
        const toSpawn = minPowerups - currentCount;
        console.log(`[POWERUPS] Only ${currentCount} powerups on map, spawning ${toSpawn} more`);
        for (let i = 0; i < toSpawn; i++) {
            spawnPowerup();
        }
    }
}, 10000); // Check every 10 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    io.emit('serverShutdown', { message: 'Server is restarting...' });
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    io.emit('serverShutdown', { message: 'Server is shutting down...' });
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`==========================================`);
    console.log(`  PowerSwap Server running on port ${PORT}`);
    console.log(`  Map Size: ${MAP_SIZE}x${MAP_SIZE}`);
    console.log(`  Initial Powerups: ${Object.keys(powerups).length}`);
    console.log(`==========================================`);
});
