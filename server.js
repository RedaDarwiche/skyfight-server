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

// ✅ ENHANCED: Added 5 new powers + maintained all existing powers
const POWER_TYPES = [
    'dash', 'teleport', 'clone', 'blackhole', 'nuke', 'heal', 'emp', 
    'swap', 'shockwave', 'phase', 'berserker', 'shield', 
    'vampire', 'rage', 'tank', 'magnet', 'thorns', 'regeneration', 
    'tripleshot', 'laser', 'rocket', 'scatter', 'sniper', 'minigun', 
    'explosive', 'freeze', 'poison', 'lightning',
    'timebomb', 'orbitallaser', 'shadowclone', 'frostnova',
    'soulrip', 'voidbeam', 'gravitypull', 'mirror', 'chaos'
    // NOTE: 'baby' intentionally excluded - spawned via admin/special only
    // NOTE: 'speed' removed - replaced by sprint mechanic
];

const LEGENDARY_DROPS = ['orbitallaser', 'frostnova', 'chaos', 'voidbeam', 'nuke', 'blackhole', 'clone', 'lightning'];
const MYTHIC_DROPS = ['baby', 'phoenix', 'soulsteal'];

// Boss state — supports multiple simultaneous bosses
const bosses = {};
let bossSpawnTimer = null;

function spawnBoss(label) {
    const id = `boss_${Date.now()}_${label}`;
    // Spawn the two bosses on opposite sides of the map
    const side = label === 'A'
        ? { x: 500 + Math.random() * 1000, y: 500 + Math.random() * 1000 }
        : { x: MAP_SIZE - 1500 + Math.random() * 1000, y: MAP_SIZE - 1500 + Math.random() * 1000 };
    bosses[id] = {
        id,
        label,
        x: side.x,
        y: side.y,
        hp: 1000,
        maxHp: 1000,
        angle: 0,
        speed: 1.2,
        phase: 'alive',
        attackTimer: 0
    };
    console.log(`[BOSS ${label}] Spawned at (${Math.round(side.x)}, ${Math.round(side.y)})`);
    io.emit('bossSpawn', bosses[id]);
}

let bossAIInterval = null;
function startBossAI() {
    if (bossAIInterval) return; // already running
    bossAIInterval = setInterval(() => {
        for (const bossId in bosses) {
            const b = bosses[bossId];
            if (!b || b.phase !== 'alive') continue;

            // Find nearest player
            let nearest = null, nearestDist = Infinity;
            for (const id in players) {
                const p = players[id];
                if ((p.hp || 0) <= 0) continue; // skip dead players
                const d = Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
                if (d < nearestDist) { nearestDist = d; nearest = { id, ...p }; }
            }

            if (nearest) {
                const dx = nearest.x - b.x;
                const dy = nearest.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                b.angle = Math.atan2(dy, dx);
                if (dist > 80) {
                    b.x += (dx / dist) * b.speed * 15;
                    b.y += (dy / dist) * b.speed * 15;
                    b.x = Math.max(100, Math.min(MAP_SIZE - 100, b.x));
                    b.y = Math.max(100, Math.min(MAP_SIZE - 100, b.y));
                }

                b.attackTimer++;
                if (b.attackTimer >= 3) {
                    b.attackTimer = 0;
                    for (const id in players) {
                        const p = players[id];
                        if ((p.hp || 0) <= 0) continue; // skip dead players
                        const d = Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
                        if (d < 120) {
                            players[id].hp = Math.max(0, (players[id].hp || 100) - 15);
                            io.to(id).emit('playerHit', { targetId: id, damage: 15, attackerId: 'boss' });
                        }
                    }
                }
            }

            // Always emit bossMoved so clients stay in sync (even when idle)
            io.emit('bossMoved', { bossId, x: b.x, y: b.y, angle: b.angle, hp: b.hp, maxHp: b.maxHp });
        }
    }, 200);
}

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

// ✅ ENHANCED: Increased initial powerup spawn from 50 to 80
console.log('Spawning initial powerups...');
for (let i = 0; i < 80; i++) {
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
            phaseActive: false
        };

        console.log(`[✓] ${playerName} (${socket.id}) spawned at (${Math.round(players[socket.id].x)}, ${Math.round(players[socket.id].y)})`);

        // Send init data
        socket.emit('init', {
            player: players[socket.id],
            players: players,
            powerups: powerups,
            projectiles: {},
            bosses: bosses
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
        if (!players[socket.id] || !data) return;
        // Whitelist only safe fields - never allow overwriting id/userId/name/etc.
        const allowed = ['x','y','angle','kills','currentPower','hp','speedActive','berserkerActive','phaseActive','mirrorActive','isOwner'];
        for (const key of allowed) {
            if (data[key] !== undefined) players[socket.id][key] = data[key];
        }
        socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
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
        if (!data || !data.targetId || typeof data.damage !== 'number') return;
        if (players[data.targetId]) {
            players[data.targetId].hp = Math.min(100, Math.max(0, (players[data.targetId].hp || 100) - data.damage));
        }
        // Send directly to target only once, then broadcast to others for visual effects
        const targetSock = io.sockets.sockets.get(data.targetId);
        if (targetSock) io.to(data.targetId).emit('playerHit', data);
        // Skip target in broadcast to prevent double-hit
        socket.broadcast.except(data.targetId).emit('playerHit', data);
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
        if (!data || !data.type || !POWER_TYPES.includes(data.type)) return;
        if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
        const safeX = Math.max(50, Math.min(MAP_SIZE - 50, data.x));
        const safeY = Math.max(50, Math.min(MAP_SIZE - 50, data.y));
        const id = `drop_${Date.now()}_${socket.id}`;
        powerups[id] = { id, type: data.type, x: safeX, y: safeY };
        io.emit('powerupSpawn', powerups[id]);
    });

    // Swap positions (true position swap between two players)
    socket.on('swapPositions', (data) => {
        const { targetId, myOldX, myOldY } = data;
        if (!players[socket.id] || !players[targetId]) return;
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket && targetSocket.connected) {
            targetSocket.emit('forceMovePlayer', { x: myOldX, y: myOldY });
        }
        players[targetId].x = myOldX;
        players[targetId].y = myOldY;
        io.emit('playerMoved', { id: targetId, x: myOldX, y: myOldY, angle: players[targetId].angle });
    });

    // Boss hit — client must send bossId
    socket.on('bossHit', (data) => {
        const b = bosses[data.bossId];
        if (!b || b.phase !== 'alive') return;
        if (typeof data.damage !== 'number' || data.damage <= 0) return; // reject invalid/negative damage
        b.hp -= data.damage;
        if (b.hp <= 0) b.hp = 0;
        io.emit('bossMoved', { bossId: b.id, x: b.x, y: b.y, angle: b.angle, hp: b.hp });

        if (b.hp <= 0 && b.phase === 'alive') {
            b.phase = 'dead';
            const killerName = players[socket.id]?.name || 'Unknown';
            console.log(`[BOSS ${b.label}] Defeated by ${killerName}`);

            // 4 legendary drops + 1 mythic drop (from extended mythic list)
            const drops = [];
            for (let i = 0; i < 4; i++) {
                const type = LEGENDARY_DROPS[Math.floor(Math.random() * LEGENDARY_DROPS.length)];
                const id = `boss_drop_${Date.now()}_${i}`;
                const angle = (i / 4) * Math.PI * 2;
                const drop = { id, type, x: b.x + Math.cos(angle) * 80, y: b.y + Math.sin(angle) * 80 };
                powerups[id] = drop;
                drops.push(drop);
            }
            // Mythic drop — random from all 4 mythics
            const mythicType = MYTHIC_DROPS[Math.floor(Math.random() * MYTHIC_DROPS.length)];
            const mythicId = `boss_mythic_${Date.now()}`;
            const mythicDrop = { id: mythicId, type: mythicType, x: b.x, y: b.y };
            powerups[mythicId] = mythicDrop;
            drops.push(mythicDrop);

            io.emit('bossDied', {
                bossId: b.id,
                killerId: socket.id,
                killerName,
                bossX: b.x,
                bossY: b.y,
                drops
            });
            io.emit('announcement', { message: `💀 Boss ${b.label} slain by ${killerName}! Legendary loot dropped!` });

            delete bosses[b.id];

            // Respawn this boss slot after 5 minutes
            setTimeout(() => { spawnBoss(b.label); startBossAI(); }, 5 * 60 * 1000);
        }
    });

    // Admin spawn boss
    socket.on('adminSpawnBoss', () => {
        if (!players[socket.id]) return;
        const count = Object.keys(bosses).length;
        if (count >= 2) { io.to(socket.id).emit('announcement', { message: 'Both bosses are already alive!' }); return; }
        const label = Object.values(bosses).some(b => b.label === 'A') ? 'B' : 'A';
        spawnBoss(label);
        startBossAI();
        io.emit('announcement', { message: '⚠️ Bosses that drop Mythic/Legendary powers have spawned!' });
    });

    // Admin announcement
    socket.on('adminAnnouncement', (data) => {
        if (!data || !data.message) return;
        const sanitized = String(data.message).substring(0, 150);
        io.emit('announcement', { message: sanitized });
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

// ✅ ENHANCED: Increased minimum powerup threshold from 30 to 50
setInterval(() => {
    const minPowerups = 50;
    const currentCount = Object.keys(powerups).length;
    
    if (currentCount < minPowerups) {
        const toSpawn = minPowerups - currentCount;
        console.log(`[POWERUP] Spawning ${toSpawn} powerups to maintain minimum (current: ${currentCount})`);
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
╔═══════════════════════════════════════╗
║   PowerSwap Server Running             ║
║   Port: ${PORT}                        ║
║   Map: ${MAP_SIZE}x${MAP_SIZE}         ║
║   Initial Powerups: ${Object.keys(powerups).length}                    ║
║   Minimum Powerups: 50                 ║
╚═══════════════════════════════════════╝
    `);

    // Spawn 2 bosses after 5 minutes
    bossSpawnTimer = setTimeout(() => {
        spawnBoss('A');
        spawnBoss('B');
        startBossAI();
        io.emit('announcement', { message: '⚠️ Bosses that drop Mythic/Legendary powers have spawned!' });
    }, 5 * 60 * 1000);
    console.log('[BOSS] 2 Bosses spawn in 5 minutes!');
});
