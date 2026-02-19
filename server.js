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

// Prevent silent crashes — log uncaught exceptions instead of dying
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

// State
const players = {};
const powerups = {};
const activeSessions = {};
let powerupId = 0;

const POWER_TYPES = [
    'dash', 'teleport', 'clone', 'blackhole', 'nuke', 'heal', 'emp',
    'swap', 'shockwave', 'speed', 'phase', 'berserker', 'shield',
    'vampire', 'rage', 'tank', 'magnet', 'thorns', 'regeneration',
    'tripleshot', 'laser', 'rocket', 'scatter', 'sniper', 'minigun',
    'explosive', 'freeze', 'poison', 'lightning',
    'timebomb', 'orbitallaser', 'shadowclone', 'frostnova',
    'soulrip', 'voidbeam', 'gravitypull', 'mirror', 'chaos'
];

const LEGENDARY_DROPS = ['orbitallaser', 'frostnova', 'chaos', 'voidbeam', 'nuke', 'blackhole', 'clone', 'lightning'];
const MYTHIC_DROPS = ['baby', 'phoenix', 'soulsteal'];

// ── NPC System ──────────────────────────────────────────────────
const NPC_CONFIGS = {
    common:    { maxHp: 60,   speed: 1.4, attackDmg: 5,  attackRange: 100, radius: 18, color: '#9ca3af', respawnMs: 1000,   dropCount: 2 },
    rare:      { maxHp: 150,  speed: 1.8, attackDmg: 10, attackRange: 110, radius: 20, color: '#3b82f6', respawnMs: 2000,   dropCount: 2 },
    epic:      { maxHp: 320,  speed: 2.1, attackDmg: 18, attackRange: 120, radius: 23, color: '#a855f7', respawnMs: 3000,   dropCount: 2 },
    legendary: { maxHp: 750,  speed: 2.8, attackDmg: 28, attackRange: 130, radius: 27, color: '#f59e0b', respawnMs: 4000,   dropCount: 2 },
    mythic:    { maxHp: 1500, speed: 0.9, attackDmg: 35, attackRange: 380, radius: 32, color: '#ff00cc', respawnMs: 300000, dropCount: 2 }
};

const RARITY_POWER_POOL = {
    common:    ['dash', 'heal', 'speed', 'shield', 'magnet', 'tripleshot'],
    rare:      ['teleport', 'emp', 'shockwave', 'berserker', 'rage', 'tank', 'thorns', 'regeneration', 'scatter', 'minigun', 'freeze', 'poison', 'laser'],
    epic:      ['clone', 'swap', 'phase', 'vampire', 'rocket', 'explosive', 'timebomb', 'shadowclone', 'gravitypull', 'mirror', 'sniper', 'lightning'],
    legendary: ['blackhole', 'nuke', 'orbitallaser', 'frostnova', 'soulrip', 'voidbeam', 'chaos'],
    mythic:    ['baby', 'phoenix', 'soulsteal']
};

const NPC_SPAWN_SLOTS = [
    { rarity: 'common' }, { rarity: 'common' }, { rarity: 'common' },
    { rarity: 'rare' }, { rarity: 'rare' },
    { rarity: 'epic' }, { rarity: 'epic' },
    { rarity: 'legendary' },
    { rarity: 'mythic' }
];

const npcs = {};
let npcIdCounter = 0;

function spawnNPC(rarity, slotIdx) {
    const cfg = NPC_CONFIGS[rarity];
    if (!cfg) return null;
    const id = `npc_${npcIdCounter++}_${rarity}`;
    npcs[id] = {
        id, rarity, slotIdx,
        x: Math.random() * (MAP_SIZE - 600) + 300,
        y: Math.random() * (MAP_SIZE - 600) + 300,
        hp: cfg.maxHp, maxHp: cfg.maxHp,
        angle: 0, attackTimer: 0, phase: 'alive',
        color: cfg.color, radius: cfg.radius,
        speed: cfg.speed, attackDmg: cfg.attackDmg,
        attackRange: cfg.attackRange, dropCount: cfg.dropCount,
        respawnMs: cfg.respawnMs
    };
    io.emit('npcSpawn', npcs[id]);
    return id;
}

function handleNPCDeath(npc, killerId) {
    const cfg = NPC_CONFIGS[npc.rarity];
    if (!cfg) return;
    const pool = RARITY_POWER_POOL[npc.rarity] || RARITY_POWER_POOL.common;
    const drops = [];
    for (let i = 0; i < npc.dropCount; i++) {
        const type = pool[Math.floor(Math.random() * pool.length)];
        const angle = (i / npc.dropCount) * Math.PI * 2;
        const id = `npc_drop_${Date.now()}_${i}`;
        const drop = { id, type, x: npc.x + Math.cos(angle) * 50, y: npc.y + Math.sin(angle) * 50 };
        powerups[id] = drop;
        drops.push(drop);
    }
    io.emit('npcDied', { npcId: npc.id, killerId, x: npc.x, y: npc.y, rarity: npc.rarity, drops });
    const killerName = players[killerId] ? players[killerId].name : 'Someone';
    if (npc.rarity === 'legendary' || npc.rarity === 'mythic') {
        io.emit('announcement', { message: `⚔️ ${killerName} slew a ${npc.rarity.toUpperCase()} NPC!` });
    }
    const slotIdx = npc.slotIdx;
    delete npcs[npc.id];
    setTimeout(() => spawnNPC(npc.rarity, slotIdx), cfg.respawnMs);
}

// NPC AI loop
let npcAIInterval = null;
function startNPCAI() {
    if (npcAIInterval) return;
    npcAIInterval = setInterval(() => {
        try {
            for (const npcId in npcs) {
                const npc = npcs[npcId];
                if (!npc || npc.phase !== 'alive') continue;

                let nearest = null, nearestDist = Infinity;
                for (const pid in players) {
                    const p = players[pid];
                    if (!p || (p.hp || 0) <= 0) continue;
                    const d = Math.sqrt((npc.x - p.x) ** 2 + (npc.y - p.y) ** 2);
                    if (d < nearestDist) { nearestDist = d; nearest = { id: pid, ...p }; }
                }
                if (!nearest) continue;

                const dx = nearest.x - npc.x;
                const dy = nearest.y - npc.y;
                const dist = nearestDist;
                if (dist === 0) continue;

                if (npc.rarity === 'mythic') {
                    npc.angle = Math.atan2(-dy, -dx);
                    if (dist < 600) {
                        npc.x -= (dx / dist) * npc.speed * 15;
                        npc.y -= (dy / dist) * npc.speed * 15;
                        npc.x = Math.max(100, Math.min(MAP_SIZE - 100, npc.x));
                        npc.y = Math.max(100, Math.min(MAP_SIZE - 100, npc.y));
                    }
                    npc.attackTimer++;
                    if (npc.attackTimer >= 5) {
                        npc.attackTimer = 0;
                        for (const pid in players) {
                            const p = players[pid];
                            if (!p || (p.hp || 0) <= 0) continue;
                            const d = Math.sqrt((npc.x - p.x) ** 2 + (npc.y - p.y) ** 2);
                            if (d < npc.attackRange) {
                                players[pid].hp = Math.max(0, (players[pid].hp || 100) - npc.attackDmg);
                                io.to(pid).emit('playerHit', { targetId: pid, damage: npc.attackDmg, attackerId: npc.id });
                            }
                        }
                    }
                } else {
                    npc.angle = Math.atan2(dy, dx);
                    if (dist > 80) {
                        npc.x += (dx / dist) * npc.speed * 15;
                        npc.y += (dy / dist) * npc.speed * 15;
                        npc.x = Math.max(100, Math.min(MAP_SIZE - 100, npc.x));
                        npc.y = Math.max(100, Math.min(MAP_SIZE - 100, npc.y));
                    }
                    npc.attackTimer++;
                    const attackFreq = npc.rarity === 'legendary' ? 2 : 3;
                    if (npc.attackTimer >= attackFreq) {
                        npc.attackTimer = 0;
                        for (const pid in players) {
                            const p = players[pid];
                            if (!p || (p.hp || 0) <= 0) continue;
                            const d = Math.sqrt((npc.x - p.x) ** 2 + (npc.y - p.y) ** 2);
                            if (d < npc.attackRange) {
                                players[pid].hp = Math.max(0, (players[pid].hp || 100) - npc.attackDmg);
                                io.to(pid).emit('playerHit', { targetId: pid, damage: npc.attackDmg, attackerId: npc.id });
                            }
                        }
                    }
                }
                io.emit('npcMoved', { npcId: npc.id, x: npc.x, y: npc.y, angle: npc.angle, hp: npc.hp });
            }
        } catch (e) {
            console.error('[NPC AI ERROR]', e.message);
        }
    }, 200);
}

// ── Boss system ────────────────────────────────────────────────
const bosses = {};
let bossSpawnTimer = null;

function spawnBoss(label) {
    const id = `boss_${Date.now()}_${label}`;
    const side = label === 'A'
        ? { x: 500 + Math.random() * 1000, y: 500 + Math.random() * 1000 }
        : { x: MAP_SIZE - 1500 + Math.random() * 1000, y: MAP_SIZE - 1500 + Math.random() * 1000 };
    bosses[id] = { id, label, x: side.x, y: side.y, hp: 1000, maxHp: 1000, angle: 0, speed: 1.2, phase: 'alive', attackTimer: 0 };
    console.log(`[BOSS ${label}] Spawned at (${Math.round(side.x)}, ${Math.round(side.y)})`);
    io.emit('bossSpawn', bosses[id]);
}

let bossAIInterval = null;
function startBossAI() {
    if (bossAIInterval) return;
    bossAIInterval = setInterval(() => {
        try {
            for (const bossId in bosses) {
                const b = bosses[bossId];
                if (!b || b.phase !== 'alive') continue;
                let nearest = null, nearestDist = Infinity;
                for (const id in players) {
                    const p = players[id];
                    if (!p) continue;
                    const d = Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
                    if (d < nearestDist) { nearestDist = d; nearest = { id, ...p }; }
                }
                if (!nearest) continue;
                const dx = nearest.x - b.x, dy = nearest.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist === 0) continue;
                b.angle = Math.atan2(dy, dx);
                if (dist > 80) {
                    b.x += (dx / dist) * b.speed * 15; b.y += (dy / dist) * b.speed * 15;
                    b.x = Math.max(100, Math.min(MAP_SIZE - 100, b.x));
                    b.y = Math.max(100, Math.min(MAP_SIZE - 100, b.y));
                }
                b.attackTimer++;
                if (b.attackTimer >= 3) {
                    b.attackTimer = 0;
                    for (const id in players) {
                        const p = players[id];
                        if (!p || (p.hp || 0) <= 0) continue;
                        const d = Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
                        if (d < 120) {
                            players[id].hp = Math.max(0, (players[id].hp || 100) - 15);
                            io.to(id).emit('playerHit', { targetId: id, damage: 15, attackerId: 'boss' });
                        }
                    }
                }
                io.emit('bossMoved', { bossId, x: b.x, y: b.y, angle: b.angle, hp: b.hp });
            }
        } catch (e) {
            console.error('[BOSS AI ERROR]', e.message);
        }
    }, 200);
}

// ── Powerup spawn ─────────────────────────────────────────────
function spawnPowerup() {
    const id = `pu_${powerupId++}`;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    powerups[id] = { id, x: Math.random() * (MAP_SIZE - 100) + 50, y: Math.random() * (MAP_SIZE - 100) + 50, type };
    io.emit('powerupSpawn', powerups[id]);
}

console.log('Spawning initial powerups...');
for (let i = 0; i < 80; i++) {
    const id = `pu_${powerupId++}`;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    powerups[id] = { id, x: Math.random() * (MAP_SIZE - 100) + 50, y: Math.random() * (MAP_SIZE - 100) + 50, type };
}

// Spawn initial NPCs
NPC_SPAWN_SLOTS.forEach((slot, idx) => spawnNPC(slot.rarity, idx));
startNPCAI();
console.log(`✅ Spawned ${Object.keys(powerups).length} powerups and ${Object.keys(npcs).length} NPCs`);

// Health endpoints
app.get('/', (req, res) => res.json({ status: 'ok', players: Object.keys(players).length, powerups: Object.keys(powerups).length, npcs: Object.keys(npcs).length, uptime: process.uptime() }));
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: Date.now() }));

// ── Socket.IO connection ──────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);

    socket.on('join', (data) => {
        try {
            if (!data || !data.name) { socket.emit('joinError', { message: 'Invalid join data' }); return; }
            if (data.userId && activeSessions[data.userId]) {
                const existingSocketId = activeSessions[data.userId];
                // Don't block reconnects — if same userId joins with a NEW socket,
                // kick the old session rather than rejecting the new one.
                if (existingSocketId !== socket.id) {
                    const existingSocket = io.sockets.sockets.get(existingSocketId);
                    if (existingSocket && existingSocket.connected) {
                        existingSocket.emit('forceDisconnect', { message: 'Joined from another device or tab.' });
                        existingSocket.disconnect(true);
                    }
                    if (players[existingSocketId]) {
                        io.emit('playerLeft', existingSocketId);
                        delete players[existingSocketId];
                    }
                    delete activeSessions[data.userId];
                }
            }
            if (data.userId) activeSessions[data.userId] = socket.id;
            const playerName = (String(data.name || '').substring(0, 15).trim()) || 'Guest';
            players[socket.id] = {
                id: socket.id, userId: data.userId || null, name: playerName,
                x: Math.random() * (MAP_SIZE - 200) + 100, y: Math.random() * (MAP_SIZE - 200) + 100,
                angle: 0, hp: 100, kills: 0, currentPower: null,
                speedActive: false, berserkerActive: false, phaseActive: false
            };
            socket.emit('joinSuccess');
            socket.broadcast.emit('playerJoined', players[socket.id]);
            socket.emit('init', {
                player: players[socket.id],
                players: players,
                powerups: powerups,
                bosses: bosses,
                npcs: npcs
            });
            console.log(`[JOIN] ${playerName} | Total: ${Object.keys(players).length}`);
        } catch (e) { console.error('[JOIN ERROR]', e.message); }
    });

    socket.on('move', (data) => {
        try {
            if (!data || !players[socket.id]) return;
            const p = players[socket.id];
            if (typeof data.x === 'number') p.x = Math.max(0, Math.min(MAP_SIZE, data.x));
            if (typeof data.y === 'number') p.y = Math.max(0, Math.min(MAP_SIZE, data.y));
            p.angle = data.angle || 0;
            p.currentPower = data.currentPower || null;
            p.speedActive = !!data.speedActive;
            p.berserkerActive = !!data.berserkerActive;
            p.phaseActive = !!data.phaseActive;
            p.mirrorActive = !!data.mirrorActive;
            p.isOwner = !!data.isOwner;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y, angle: p.angle, currentPower: p.currentPower, hp: p.hp, kills: p.kills, speedActive: p.speedActive, berserkerActive: p.berserkerActive, phaseActive: p.phaseActive, mirrorActive: p.mirrorActive, isOwner: p.isOwner });
        } catch (e) { console.error('[MOVE ERROR]', e.message); }
    });

    socket.on('shoot', (data) => {
        try { socket.broadcast.emit('remoteShoot', { ...data, ownerId: socket.id }); }
        catch (e) { console.error('[SHOOT ERROR]', e.message); }
    });

    socket.on('abilityUsed', (data) => {
        try { socket.broadcast.emit('abilityEffect', { ...data, id: socket.id }); }
        catch (e) { console.error('[ABILITY ERROR]', e.message); }
    });

    // Restored original playerHit — sends to target + broadcasts to all others for visual effects
    socket.on('playerHit', (data) => {
        try {
            if (!data || !data.targetId) return;
            const targetSock = io.sockets.sockets.get(data.targetId);
            if (targetSock) io.to(data.targetId).emit('playerHit', data);
            socket.broadcast.emit('playerHit', data);
        } catch (e) { console.error('[PLAYERHIT ERROR]', e.message); }
    });

    // Restored original playerDied — always broadcasts io.emit so ALL clients update state
    socket.on('playerDied', (data) => {
        try {
            if (!data) return;
            if (data.victimId && players[data.victimId]) {
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
        } catch (e) { console.error('[PLAYERDIED ERROR]', e.message); }
    });

    socket.on('powerupTaken', (data) => {
        try {
            if (!data || !data.id) return;
            if (powerups[data.id]) { delete powerups[data.id]; io.emit('powerupTaken', data.id); setTimeout(() => spawnPowerup(), 5000); }
        } catch (e) { console.error('[POWERUPTAKEN ERROR]', e.message); }
    });

    socket.on('dropPower', (data) => {
        try {
            if (!data || !data.type || !POWER_TYPES.includes(data.type)) return;
            if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
            const id = `drop_${Date.now()}_${socket.id}`;
            powerups[id] = { id, type: data.type, x: Math.max(50, Math.min(MAP_SIZE - 50, data.x)), y: Math.max(50, Math.min(MAP_SIZE - 50, data.y)) };
            io.emit('powerupSpawn', powerups[id]);
        } catch (e) { console.error('[DROPPOWER ERROR]', e.message); }
    });

    socket.on('swapPositions', (data) => {
        try {
            const { targetId, myOldX, myOldY } = data;
            if (!players[socket.id] || !players[targetId]) return;
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket && targetSocket.connected) targetSocket.emit('forceMovePlayer', { x: myOldX, y: myOldY });
            players[targetId].x = myOldX; players[targetId].y = myOldY;
            io.emit('playerMoved', { id: targetId, x: myOldX, y: myOldY, angle: players[targetId].angle });
        } catch (e) { console.error('[SWAP ERROR]', e.message); }
    });

    socket.on('npcHit', (data) => {
        try {
            if (!data || !data.npcId) return;
            const npc = npcs[data.npcId];
            if (!npc || npc.phase !== 'alive') return;
            if (typeof data.damage !== 'number' || data.damage <= 0) return;
            npc.hp -= data.damage;
            if (npc.hp < 0) npc.hp = 0;
            io.emit('npcMoved', { npcId: npc.id, x: npc.x, y: npc.y, angle: npc.angle, hp: npc.hp });
            if (npc.hp <= 0 && npc.phase === 'alive') { npc.phase = 'dead'; handleNPCDeath(npc, socket.id); }
        } catch (e) { console.error('[NPCHIT ERROR]', e.message); }
    });

    socket.on('useEmote', (data) => {
        try {
            if (!players[socket.id] || !data || !data.emote) return;
            socket.broadcast.emit('playerEmote', { playerId: socket.id, emote: data.emote });
        } catch (e) { console.error('[EMOTE ERROR]', e.message); }
    });

    socket.on('bossHit', (data) => {
        try {
            if (!data || !data.bossId) return;
            const b = bosses[data.bossId];
            if (!b || b.phase !== 'alive') return;
            if (typeof data.damage !== 'number' || data.damage <= 0) return;
            b.hp = Math.max(0, b.hp - data.damage);
            io.emit('bossMoved', { bossId: b.id, x: b.x, y: b.y, angle: b.angle, hp: b.hp });
            if (b.hp <= 0 && b.phase === 'alive') {
                b.phase = 'dead';
                const killerName = players[socket.id] ? players[socket.id].name : 'Unknown';
                const bLabel = b.label;
                const bX = b.x, bY = b.y;
                const drops = [];
                for (let i = 0; i < 4; i++) {
                    const type = LEGENDARY_DROPS[Math.floor(Math.random() * LEGENDARY_DROPS.length)];
                    const id = `boss_drop_${Date.now()}_${i}`;
                    const angle = (i / 4) * Math.PI * 2;
                    const drop = { id, type, x: bX + Math.cos(angle) * 80, y: bY + Math.sin(angle) * 80 };
                    powerups[id] = drop; drops.push(drop);
                }
                const mythicType = MYTHIC_DROPS[Math.floor(Math.random() * MYTHIC_DROPS.length)];
                const mythicId = `boss_mythic_${Date.now()}`;
                const mythicDrop = { id: mythicId, type: mythicType, x: bX, y: bY };
                powerups[mythicId] = mythicDrop; drops.push(mythicDrop);
                io.emit('bossDied', { bossId: b.id, killerId: socket.id, killerName, bossX: bX, bossY: bY, drops });
                io.emit('announcement', { message: `💀 Boss ${bLabel} slain by ${killerName}! Legendary loot dropped!` });
                delete bosses[b.id];
                setTimeout(() => { spawnBoss(bLabel); startBossAI(); }, 5 * 60 * 1000);
            }
        } catch (e) { console.error('[BOSSHIT ERROR]', e.message); }
    });

    socket.on('adminSpawnBoss', () => {
        try {
            if (!players[socket.id]) return;
            const count = Object.keys(bosses).length;
            if (count >= 2) { io.to(socket.id).emit('announcement', { message: 'Both bosses are already alive!' }); return; }
            const label = Object.values(bosses).some(b => b.label === 'A') ? 'B' : 'A';
            spawnBoss(label); startBossAI();
            io.emit('announcement', { message: '⚠️ Bosses that drop Mythic/Legendary powers have spawned!' });
        } catch (e) { console.error('[ADMINSPAWNBOSS ERROR]', e.message); }
    });

    socket.on('adminAnnouncement', (data) => {
        try {
            if (!data || !data.message) return;
            io.emit('announcement', { message: String(data.message).substring(0, 150) });
        } catch (e) { console.error('[ANNOUNCEMENT ERROR]', e.message); }
    });

    socket.on('chatMessage', (data) => {
        try {
            if (!data || !data.text || !data.playerName) return;
            io.emit('chatMessage', { text: String(data.text).substring(0, 100), playerName: String(data.playerName).substring(0, 15) });
        } catch (e) { console.error('[CHAT ERROR]', e.message); }
    });

    socket.on('disconnect', (reason) => {
        try {
            if (players[socket.id] && players[socket.id].userId) delete activeSessions[players[socket.id].userId];
            const name = players[socket.id] ? players[socket.id].name : 'Unknown';
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
            console.log(`[LEFT] ${name} (${reason}) | Total: ${Object.keys(players).length}`);
        } catch (e) { console.error('[DISCONNECT ERROR]', e.message); }
    });
});

// Cleanup stale sessions
setInterval(() => {
    try {
        const connectedSockets = Array.from(io.sockets.sockets.keys());
        for (const playerId in players) {
            if (!connectedSockets.includes(playerId)) {
                if (players[playerId] && players[playerId].userId) delete activeSessions[players[playerId].userId];
                delete players[playerId]; io.emit('playerLeft', playerId);
            }
        }
        for (const userId in activeSessions) {
            if (!connectedSockets.includes(activeSessions[userId])) delete activeSessions[userId];
        }
    } catch (e) { console.error('[CLEANUP ERROR]', e.message); }
}, 30000);

setInterval(() => {
    try {
        const minPowerups = 50, currentCount = Object.keys(powerups).length;
        if (currentCount < minPowerups) {
            const toSpawn = minPowerups - currentCount;
            for (let i = 0; i < toSpawn; i++) spawnPowerup();
        }
    } catch (e) { console.error('[POWERUP TOPUP ERROR]', e.message); }
}, 10000);

process.on('SIGTERM', () => { io.emit('serverShutdown', { message: 'Server restarting...' }); server.close(() => process.exit(0)); });

server.listen(PORT, () => {
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║   PowerSwap Server Running             ║`);
    console.log(`║   Port: ${PORT}                        ║`);
    console.log(`║   Map: ${MAP_SIZE}x${MAP_SIZE}         ║`);
    console.log(`║   NPCs: ${Object.keys(npcs).length} | Powerups: ${Object.keys(powerups).length}        ║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
    bossSpawnTimer = setTimeout(() => {
        spawnBoss('A'); spawnBoss('B'); startBossAI();
        io.emit('announcement', { message: '⚠️ Bosses that drop Mythic/Legendary powers have spawned!' });
    }, 5 * 60 * 1000);
    console.log('[BOSS] 2 Bosses spawn in 5 minutes!');
});
