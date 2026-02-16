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

// Game State
const players = {};
const projectiles = {};
const powerups = {};
let projectileId = 0;
let powerupId = 0;

// Config
const MAX_POWERUPS = 50;
const POWER_TYPES = ['dash', 'shield', 'tripleshot', 'speed', 'teleport', 'invisible'];

function spawnPowerup() {
    const id = `pu_${powerupId++}`;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    powerups[id] = {
        id: id,
        x: Math.random() * MAP_SIZE,
        y: Math.random() * MAP_SIZE,
        type: type
    };
    io.emit('powerupSpawn', powerups[id]);
}

// Initial Spawn
for (let i = 0; i < MAX_POWERUPS; i++) spawnPowerup();

app.get('/', (req, res) => {
    res.send(`PowerSwap.io Server Running! Players online: ${Object.keys(players).length}`);
});

io.on('connection', (socket) => {
    console.log('Player joined:', socket.id);

    socket.on('playerJoin', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: (data.name || 'Player').substring(0, 15),
            x: Math.random() * MAP_SIZE,
            y: Math.random() * MAP_SIZE,
            angle: 0,
            hp: 100,
            maxHp: 100,
            color: '#4facfe',
            currentPower: null,
            score: 0,
            isAdmin: (data.email === 'redadarwichepaypal@gmail.com')
        };

        socket.emit('initGame', { 
            players, 
            powerups, 
            id: socket.id 
        });
        socket.broadcast.emit('newPlayer', players[socket.id]);
    });

    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            const p = players[socket.id];
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            
            // Check Powerup Collision
            for (let id in powerups) {
                const pu = powerups[id];
                const dist = Math.hypot(p.x - pu.x, p.y - pu.y);
                if (dist < 40) {
                    p.currentPower = pu.type;
                    delete powerups[id];
                    io.emit('powerupTaken', { id: id, playerId: socket.id, type: pu.type });
                    spawnPowerup();
                    break; 
                }
            }

            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                x: p.x, 
                y: p.y, 
                angle: p.angle 
            });
        }
    });

    socket.on('usePower', (data) => {
        const p = players[socket.id];
        if (!p || !p.currentPower) return;

        io.emit('powerUsed', { playerId: socket.id, type: p.currentPower, data: data });

        if (p.currentPower === 'tripleshot') {
            for(let i = -1; i <= 1; i++) {
                const angle = p.angle + (i * 0.2);
                const pid = `proj_${projectileId++}`;
                projectiles[pid] = {
                    id: pid,
                    owner: socket.id,
                    x: p.x + Math.cos(angle) * 30,
                    y: p.y + Math.sin(angle) * 30,
                    vx: Math.cos(angle) * 15,
                    vy: Math.sin(angle) * 15,
                    life: 60
                };
                io.emit('projectileSpawn', projectiles[pid]);
            }
        }
    });

    socket.on('playerHit', (data) => {
        if (players[data.targetId]) {
            players[data.targetId].hp -= data.damage;
            io.to(data.targetId).emit('gotHit', { damage: data.damage, attackerId: socket.id });

            if (players[data.targetId].hp <= 0) {
                io.emit('playerDied', { id: data.targetId, killerId: socket.id });
                if(players[socket.id]) players[socket.id].score += 100;
                delete players[data.targetId];
            }
        }
    });

    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });

    socket.on('adminCommand', (cmd) => {
        const p = players[socket.id];
        if (!p || !p.isAdmin) {
            socket.emit('chatMessage', { playerName: 'Server', text: 'Access denied' });
            return;
        }

        if (cmd === 'spawn50') {
            for (let i = 0; i < 50; i++) spawnPowerup();
        } else if (cmd === 'clearpowerups') {
            powerups = {};
            io.emit('clearPowerups');
        } else if (cmd === 'resetgame') {
            powerups = {};
            io.emit('clearPowerups');
            console.log('Game reset by admin');
        } else if (cmd === 'spawnbot') {
            console.log('Bot spawn not implemented yet');
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// Server Loop for Projectiles
setInterval(() => {
    for (let id in projectiles) {
        const p = projectiles[id];
        p.x += p.vx;
        p.y += p.vy;
        p.life--;
        if (p.life <= 0) {
            delete projectiles[id];
        }
    }
}, 1000 / 60);

server.listen(PORT, () => {
    console.log(`PowerSwap Server running on port ${PORT}`);
});
