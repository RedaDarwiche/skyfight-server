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

const players = {};
const projectiles = {};
const powerups = {};
let projectileId = 0;
let powerupId = 0;

const MAX_POWERUPS = 50;
const POWER_TYPES = [
    'dash', 'shield', 'tripleshot', 'speed', 'teleport', 'invisible', 'timeslow',
    'magnet', 'ghost', 'rage', 'freeze', 'laser', 'clone', 'gravity', 'shock'
];

const POWER_DURATIONS = {
    shield: 6000,
    speed: 8000,
    invisible: 5000,
    ghost: 7000,
    rage: 6000,
    magnet: 10000
};

function spawnPowerup() {
    const id = `pu_${powerupId++}`;
    const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
    powerups[id] = { 
        id, 
        x: Math.random() * MAP_SIZE, 
        y: Math.random() * MAP_SIZE, 
        type 
    };
    io.emit('powerupSpawn', powerups[id]);
}

for (let i = 0; i < MAX_POWERUPS; i++) spawnPowerup();

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('join', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name,
            x: Math.random() * MAP_SIZE,
            y: Math.random() * MAP_SIZE,
            angle: 0,
            hp: 100,
            maxHp: 100,
            currentPower: null,
            powerEndTime: null,
            score: 0
        };

        socket.emit('init', {
            player: players[socket.id],
            players: players,
            projectiles: projectiles,
            powerups: powerups
        });

        socket.broadcast.emit('playerJoined', players[socket.id]);
    });

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].angle = data.angle;
            io.emit('playerMoved', { id: socket.id, x: data.x, y: data.y, angle: data.angle });
        }
    });

    socket.on('shoot', (data) => {
        const p = players[socket.id];
        if (!p) return;

        const shootProjectile = (angleOffset = 0) => {
            const id = `proj_${projectileId++}`;
            const speed = p.currentPower === 'rage' ? 12 : 8;
            projectiles[id] = {
                id,
                x: p.x,
                y: p.y,
                vx: Math.cos(p.angle + angleOffset) * speed,
                vy: Math.sin(p.angle + angleOffset) * speed,
                owner: socket.id,
                pierce: p.currentPower === 'laser'
            };
            io.emit('projectileSpawned', projectiles[id]);
        };

        if (p.currentPower === 'tripleshot') {
            shootProjectile(-0.2);
            shootProjectile(0);
            shootProjectile(0.2);
        } else {
            shootProjectile();
        }
    });

    socket.on('powerupTaken', (data) => {
        if (powerups[data.id]) {
            const p = players[socket.id];
            if (p) {
                p.currentPower = powerups[data.id].type;
                
                if (POWER_DURATIONS[p.currentPower]) {
                    p.powerEndTime = Date.now() + POWER_DURATIONS[p.currentPower];
                }
                
                io.emit('powerupTaken', data.id);
                delete powerups[data.id];
                
                setTimeout(() => spawnPowerup(), 3000);
            }
        }
    });

    socket.on('usePower', (data) => {
        const p = players[socket.id];
        if (!p || !p.currentPower) return;

        const onUsePowers = ['dash', 'teleport', 'tripleshot', 'timeslow', 'freeze', 'clone', 'gravity', 'shock'];
        
        if (onUsePowers.includes(p.currentPower)) {
            if (p.currentPower === 'timeslow') {
                io.emit('timeSlowActivated', { activator: socket.id });
            } else if (p.currentPower === 'freeze') {
                io.emit('freezeActivated', { activator: socket.id, x: p.x, y: p.y });
            } else if (p.currentPower === 'clone') {
                io.emit('cloneActivated', { activator: socket.id, x: p.x, y: p.y });
            } else if (p.currentPower === 'gravity') {
                io.emit('gravityActivated', { activator: socket.id, x: p.x, y: p.y });
            }
            
            p.currentPower = null;
            p.powerEndTime = null;
        }
    });

    socket.on('playerHit', (data) => {
        if (players[data.targetId]) {
            let damage = data.damage || 20;
            
            if (players[data.targetId].currentPower === 'shield') {
                damage = Math.floor(damage / 2);
            }
            
            if (players[data.targetId].currentPower === 'ghost') {
                damage = 0;
            }
            
            players[data.targetId].hp -= damage;
            
            if (players[data.targetId].hp <= 0) {
                players[data.targetId].hp = 0;
                io.emit('playerDied', data.targetId);
                
                setTimeout(() => {
                    if (players[data.targetId]) {
                        players[data.targetId].hp = 100;
                        players[data.targetId].x = Math.random() * MAP_SIZE;
                        players[data.targetId].y = Math.random() * MAP_SIZE;
                        players[data.targetId].currentPower = null;
                        io.emit('playerUpdate', players[data.targetId]);
                    }
                }, 3000);
            } else {
                io.emit('playerUpdate', players[data.targetId]);
            }
        }
    });

    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });

    socket.on('adminCommand', (cmd) => {
        console.log('Admin command:', cmd);
        
        if (cmd === 'spawn50') {
            for (let i = 0; i < 50; i++) spawnPowerup();
        } else if (cmd === 'clearpowerups') {
            Object.keys(powerups).forEach(id => delete powerups[id]);
            io.emit('clearPowerups');
        } else if (cmd === 'resetgame') {
            Object.keys(players).forEach(id => {
                players[id].hp = 100;
                players[id].currentPower = null;
                players[id].score = 0;
            });
            Object.keys(projectiles).forEach(id => delete projectiles[id]);
            Object.keys(powerups).forEach(id => delete powerups[id]);
            for (let i = 0; i < MAX_POWERUPS; i++) spawnPowerup();
            io.emit('gameReset');
        } else if (cmd === 'spawnbot') {
            const botId = `bot_${Date.now()}`;
            players[botId] = {
                id: botId,
                name: 'TestBot',
                x: Math.random() * MAP_SIZE,
                y: Math.random() * MAP_SIZE,
                angle: 0,
                hp: 100,
                maxHp: 100,
                currentPower: null,
                score: 0
            };
            io.emit('playerJoined', players[botId]);
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

setInterval(() => {
    const updates = [];
    Object.keys(projectiles).forEach(id => {
        const proj = projectiles[id];
        proj.x += proj.vx;
        proj.y += proj.vy;
        
        if (proj.x < 0 || proj.x > MAP_SIZE || proj.y < 0 || proj.y > MAP_SIZE) {
            delete projectiles[id];
            io.emit('projectileRemoved', id);
        } else {
            updates.push(proj);
        }
    });
    
    if (updates.length > 0) {
        io.emit('projectileUpdate', updates);
    }
    
    Object.keys(players).forEach(id => {
        const p = players[id];
        if (p.powerEndTime && Date.now() > p.powerEndTime) {
            p.currentPower = null;
            p.powerEndTime = null;
            io.emit('powerExpired', { playerId: id });
        }
    });
}, 50);

server.listen(PORT, () => {
    console.log('PowerSwap.io server running on port ' + PORT);
    console.log('Available powers: ' + POWER_TYPES.join(', '));
});
