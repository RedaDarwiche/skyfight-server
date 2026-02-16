const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const MAP_SIZE = 4000;

// State
const players = {};
const powerups = {};
let powerupId = 0;

// Match these exactly to your Frontend POWERS list
const POWER_TYPES = [
    'dash', 'teleport', 'clone', 'blackhole', 'nuke', 'heal', 'emp', 
    'swap', 'shockwave', 'speed', 'phase', 'berserker', 'shield', 
    'vampire', 'rage', 'tank', 'magnet', 'thorns', 'regeneration', 
    'tripleshot', 'laser', 'rocket', 'scatter', 'sniper', 'minigun', 
    'explosive', 'freeze', 'poison', 'lightning'
];

// Initial Powerups
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

// Spawn initial powerups
for (let i = 0; i < 50; i++) spawnPowerup();

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('join', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name.substring(0, 15),
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

        // Send current state to new player
        socket.emit('init', {
            player: players[socket.id],
            players: players,
            powerups: powerups,
            projectiles: {} // Client handles projectiles
        });

        // Tell others a new player joined
        socket.broadcast.emit('playerJoined', players[socket.id]);
    });

    // 1. MOVEMENT & STATE RELAY
    socket.on('move', (data) => {
        if (players[socket.id]) {
            const p = players[socket.id];
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            p.kills = data.kills;
            p.currentPower = data.currentPower;
            p.hp = data.hp; // Trust client HP for sync
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

    // 2. SHOOTING RELAY (Fixes "Invisible Projectiles")
    socket.on('shoot', (data) => {
        // Add ownerId and send as 'remoteShoot' to others
        data.ownerId = socket.id;
        socket.broadcast.emit('remoteShoot', data);
    });

    // 3. ABILITY RELAY (Fixes "Invisible Abilities")
    socket.on('abilityUsed', (data) => {
        // Relay the effect to everyone else so they see particles/explosions
        socket.broadcast.emit('abilityEffect', data);
    });

    // 4. HIT & DAMAGE RELAY
    socket.on('playerHit', (data) => {
        // data = { targetId, damage, attackerId }
        
        // Update server-side HP for reference (though client is authoritative here)
        if (players[data.targetId]) {
            players[data.targetId].hp -= data.damage;
        }

        // Tell everyone a hit happened (for damage numbers and particles)
        socket.broadcast.emit('playerHit', data);
    });

    // 5. DEATH RELAY (Fixes "Ghost Death")
    socket.on('playerDied', (data) => {
        // data = { victimId, killerId }
        
        if (players[data.victimId]) {
            players[data.victimId].hp = 100; // Reset HP on server
            players[data.victimId].kills = 0;
            players[data.victimId].x = Math.random() * (MAP_SIZE - 200) + 100;
            players[data.victimId].y = Math.random() * (MAP_SIZE - 200) + 100;
        }

        if (data.killerId && players[data.killerId]) {
            players[data.killerId].kills = (players[data.killerId].kills || 0) + 1;
        }

        io.emit('playerDied', data);
    });

    // 6. POWERUP HANDLING
    socket.on('powerupTaken', (data) => {
        if (powerups[data.id]) {
            delete powerups[data.id];
            io.emit('powerupTaken', data.id);
            // Spawn a new one after 5 seconds to keep map populated
            setTimeout(() => spawnPowerup(), 5000);
        }
    });

    socket.on('dropPower', (data) => {
        const id = `drop_${Date.now()}`;
        powerups[id] = {
            id: id,
            type: data.type,
            x: data.x,
            y: data.y
        };
        io.emit('powerupSpawn', powerups[id]);
    });

    // CHAT
    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`PowerSwap Server running on port ${PORT}`);
});
