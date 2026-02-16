const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// Bot management constants
const MAX_BOTS = 30;
const MAP_SIZE = 8000;

const players = {};
const activeBots = {};
let botIdCounter = 0;

// Admin email whitelist
const ADMIN_EMAILS = ['redadarwichepaypal@gmail.com'];

io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    socket.on('playerJoin', (data) => {
        if (data.userId) {
            const existingUser = Object.values(players).find(p => p.userId === data.userId);
            if (existingUser) {
                socket.emit('joinError', { message: 'You are already connected on another tab/browser!' });
                return;
            }
        }
        
        const existingPlayer = Object.values(players).find(p => p.name === data.name);
        if (existingPlayer) {
            socket.emit('joinError', { message: 'A player with this name is already in the game!' });
            return;
        }
        
        // Validate and truncate input data
        const sanitizedName = (data.name || 'Player').substring(0, 20);
        const clampedX = Math.max(0, Math.min(MAP_SIZE, data.x || 4000));
        const clampedY = Math.max(0, Math.min(MAP_SIZE, data.y || 4000));
        
        players[socket.id] = {
            id: socket.id,
            userId: data.userId || null,
            email: data.email || null, // Store for admin verification
            x: clampedX,
            y: clampedY,
            angle: data.angle || 0,
            name: sanitizedName,
            color: data.color || '#ff6b6b',
            size: data.size || 30,
            tier: data.tier || 1,
            hp: data.hp || 100,
            maxHp: data.hp || 100,
            xp: data.xp || 0,
            animalType: data.animalType || 'Mouse',
            animalIndex: data.animalIndex || 0
        };

        socket.emit('currentPlayers', players);
        socket.emit('existingBots', activeBots);
        socket.broadcast.emit('newPlayer', players[socket.id]);

        console.log(`Player ${sanitizedName} joined as ${data.animalType} (index: ${data.animalIndex})`);
    });

    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            // Clamp coordinates to prevent out-of-bounds exploits
            players[socket.id].x = Math.max(0, Math.min(MAP_SIZE, data.x));
            players[socket.id].y = Math.max(0, Math.min(MAP_SIZE, data.y));
            players[socket.id].angle = data.angle;

            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y,
                angle: data.angle
            });
        }
    });

    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id].size = data.size;
            players[socket.id].tier = data.tier;
            players[socket.id].hp = data.hp;
            players[socket.id].maxHp = data.maxHp || data.hp;
            players[socket.id].xp = data.xp;
            players[socket.id].color = data.color;
            players[socket.id].animalType = data.animalType;
            players[socket.id].animalIndex = data.animalIndex;

            socket.broadcast.emit('playerUpdated', {
                id: socket.id,
                size: data.size,
                tier: data.tier,
                hp: data.hp,
                maxHp: data.maxHp || data.hp,
                xp: data.xp,
                color: data.color,
                animalType: data.animalType,
                animalIndex: data.animalIndex,
                hasShield: data.hasShield,
                hasRage: data.hasRage,
                hasSpeedBoost: data.hasSpeedBoost,
                isInvisible: data.isInvisible
            });
        }
    });

    socket.on('chatMessage', (data) => {
        // Sanitize chat messages
        const sanitizedText = (data.text || '').substring(0, 200);
        const sanitizedName = (data.playerName || 'Player').substring(0, 20);
        
        socket.broadcast.emit('chatMessage', {
            text: sanitizedText,
            playerName: sanitizedName
        });
    });

    socket.on('botSpawned', (data) => {
        const botId = data.botId || ('bot_' + botIdCounter++);
        
        activeBots[botId] = {
            id: botId,
            x: Math.max(0, Math.min(MAP_SIZE, data.x)),
            y: Math.max(0, Math.min(MAP_SIZE, data.y)),
            tier: data.tier || 1,
            animalIndex: data.animalIndex || 0,
            hp: data.hp || 100,
            maxHp: data.maxHp || 100,
            isDead: false,
            ownerId: socket.id
        };
        
        socket.emit('botSpawnConfirmed', { botId: botId, serverBot: activeBots[botId] });
        socket.broadcast.emit('remoteBotSpawned', activeBots[botId]);
    });

    socket.on('botMoved', (data) => {
        if (!data.botId) {
            console.error('botMoved: Missing botId');
            return;
        }
        if (activeBots[data.botId]) {
            activeBots[data.botId].x = Math.max(0, Math.min(MAP_SIZE, data.x));
            activeBots[data.botId].y = Math.max(0, Math.min(MAP_SIZE, data.y));
            activeBots[data.botId].angle = data.angle;
            socket.broadcast.emit('remoteBotMoved', {
                botId: data.botId,
                x: activeBots[data.botId].x,
                y: activeBots[data.botId].y,
                angle: data.angle
            });
        }
    });

    socket.on('botDamaged', (data) => {
        if (!data.botId) {
            console.error('botDamaged: Missing botId');
            return;
        }
        if (activeBots[data.botId]) {
            activeBots[data.botId].hp = data.hp;
            socket.broadcast.emit('remoteBotDamaged', {
                botId: data.botId,
                hp: data.hp,
                damage: data.damage
            });
        }
    });

    socket.on('botDied', (data) => {
        if (!data.botId) {
            console.error('botDied: Missing botId');
            return;
        }
        if (activeBots[data.botId]) {
            activeBots[data.botId].isDead = true;
            socket.broadcast.emit('remoteBotDied', { botId: data.botId });
        }
    });

    socket.on('botRespawned', (data) => {
        if (!data.botId) {
            console.error('botRespawned: Missing botId');
            return;
        }
        if (activeBots[data.botId]) {
            activeBots[data.botId] = {
                ...activeBots[data.botId],
                x: Math.max(0, Math.min(MAP_SIZE, data.x)),
                y: Math.max(0, Math.min(MAP_SIZE, data.y)),
                isDead: false,
                hp: data.hp,
                tier: data.tier,
                animalIndex: data.animalIndex
            };
            socket.broadcast.emit('remoteBotRespawned', activeBots[data.botId]);
        }
    });

    socket.on('playerHit', (data) => {
        io.to(data.targetId).emit('gotHit', {
            attackerId: socket.id,
            damage: data.damage
        });
    });

    socket.on('playerDied', (data) => {
        const deadPlayer = players[socket.id];
        if (deadPlayer) {
            // Broadcast death BEFORE deleting
            socket.broadcast.emit('playerDeath', {
                playerId: socket.id,
                xp: data.xp || deadPlayer.xp || 0,
                tier: data.tier || deadPlayer.tier || 1,
                x: data.x || deadPlayer.x,
                y: data.y || deadPlayer.y
            });
            
            // Small delay before deleting to ensure message is sent
            setTimeout(() => {
                delete players[socket.id];
            }, 100);
        }
    });

    // ADMIN COMMANDS - Server-side verification
    socket.on('adminCommand', (data) => {
        const player = players[socket.id];
        if (!player) return;
        
        // Verify admin status (in production, use proper server-side auth)
        if (!ADMIN_EMAILS.includes(player.email)) {
            console.log('Unauthorized admin command attempt from:', player.email);
            return;
        }
        
        console.log('Admin command executed:', data.command, 'by', player.email);
        
        switch(data.command) {
            case 'killBots':
                Object.keys(activeBots).forEach(key => {
                    activeBots[key].isDead = true;
                    activeBots[key].hp = 0;
                });
                io.emit('allBotsKilled');
                break;
                
            case 'clearBots':
                Object.keys(activeBots).forEach(key => {
                    delete activeBots[key];
                });
                io.emit('allBotsCleared');
                break;
        }
    });

    // STATUS EFFECT APPLICATION - Server relays status effects to target players
    socket.on('applyStatus', (data) => {
        if (data.targetId && players[data.targetId]) {
            io.to(data.targetId).emit('statusApplied', {
                type: data.type,
                duration: data.duration,
                sourceId: socket.id
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        const disconnectedPlayer = players[socket.id];
        
        // FIXED: Drop loot if player disconnects while alive
        if (disconnectedPlayer && disconnectedPlayer.hp > 0) {
            io.emit('playerDeath', {
                playerId: socket.id,
                xp: disconnectedPlayer.xp || 0,
                tier: disconnectedPlayer.tier || 1,
                x: disconnectedPlayer.x,
                y: disconnectedPlayer.y
            });
        }
        
        // Remove player's bots when they disconnect
        const playerBots = Object.keys(activeBots).filter(botId => activeBots[botId].ownerId === socket.id);
        playerBots.forEach(botId => {
            delete activeBots[botId];
            socket.broadcast.emit('remoteBotRemoved', { botId });
        });
        
        delete players[socket.id];
        socket.broadcast.emit('playerDisconnected', socket.id);
    });
});

// SERVER-SIDE BOT MANAGEMENT (Future implementation)
// Uncomment this section to move bots to server-side
/*
setInterval(() => {
    // 1. Respawn bots if low
    const currentBotCount = Object.keys(activeBots).length;
    if (currentBotCount < MAX_BOTS) {
        const botId = 'server_bot_' + botIdCounter++;
        activeBots[botId] = {
            id: botId,
            x: Math.random() * MAP_SIZE,
            y: Math.random() * MAP_SIZE,
            angle: Math.random() * Math.PI * 2,
            tier: Math.floor(Math.random() * 3) + 1,
            animalIndex: 0,
            hp: 100,
            maxHp: 100,
            isDead: false,
            targetX: Math.random() * MAP_SIZE,
            targetY: Math.random() * MAP_SIZE,
            ownerId: 'server'
        };
        io.emit('remoteBotSpawned', activeBots[botId]);
    }

    // 2. Move Bots (Simple AI on server)
    Object.values(activeBots).forEach(bot => {
        if (bot.isDead || bot.ownerId !== 'server') return;

        // Simple wandering logic
        const dx = bot.targetX - bot.x;
        const dy = bot.targetY - bot.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < 50) {
            bot.targetX = Math.random() * MAP_SIZE;
            bot.targetY = Math.random() * MAP_SIZE;
        } else {
            const angle = Math.atan2(dy, dx);
            const speed = 3;
            bot.x += Math.cos(angle) * speed;
            bot.y += Math.sin(angle) * speed;
            bot.angle = angle;
        }
    });

    // 3. Send Bot updates to all players (20 times per second)
    io.emit('botUpdates', Object.values(activeBots)
        .filter(b => b.ownerId === 'server')
        .map(b => ({
            id: b.id, 
            x: Math.round(b.x), 
            y: Math.round(b.y), 
            angle: b.angle
        }))
    );

}, 1000 / 20); // 20 Ticks per second
*/

app.get('/', (req, res) => {
    res.send('SkyFight.io Server Running! Players: ' + Object.keys(players).length + ' | Bots: ' + Object.keys(activeBots).length);
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
