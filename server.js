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

const players = {};
const activeBots = {}; // NEW - Server tracks all bots
let botIdCounter = 0;

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
        
        players[socket.id] = {
            id: socket.id,
            userId: data.userId || null,
            x: data.x || 4000,
            y: data.y || 4000,
            angle: data.angle || 0,
            name: data.name || 'Player',
            color: data.color || '#ff6b6b',
            size: data.size || 30,
            tier: data.tier || 1,
            hp: data.hp || 100,
            xp: data.xp || 0,
            animalType: data.animalType || 'Mouse'
        };

        socket.emit('currentPlayers', players);
        socket.emit('existingBots', activeBots); // NEW - Send existing bots
        socket.broadcast.emit('newPlayer', players[socket.id]);

        console.log(`Player ${data.name} joined the game`);
    });

    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].angle = data.angle;

            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle
            });
        }
    });

    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id].size = data.size;
            players[socket.id].tier = data.tier;
            players[socket.id].hp = data.hp;
            players[socket.id].xp = data.xp;
            players[socket.id].color = data.color;
            players[socket.id].animalType = data.animalType;
            players[socket.id].animalIndex = data.animalIndex;

            socket.broadcast.emit('playerUpdated', {
                id: socket.id,
                size: data.size,
                tier: data.tier,
                hp: data.hp,
                xp: data.xp,
                color: data.color,
                animalType: data.animalType,
                animalIndex: data.animalIndex
            });
        }
    });

    socket.on('chatMessage', (data) => {
        socket.broadcast.emit('chatMessage', {
            text: data.text,
            playerName: data.playerName
        });
    });

    // === NEW BOT EVENTS ===
    socket.on('botSpawned', (data) => {
        // Use client-provided botId or generate one if not provided
        const botId = data.botId || ('bot_' + botIdCounter++);
        
        // Store bot in server state
        activeBots[botId] = {
            id: botId,
            x: data.x,
            y: data.y,
            tier: data.tier || 1,
            animalIndex: data.animalIndex || 0,
            hp: data.hp || 100,
            maxHp: data.maxHp || 100,
            isDead: false,
            ownerId: socket.id // Track which player spawned this bot
        };
        
        // Send bot ID confirmation to spawner (in case server generated it)
        socket.emit('botSpawnConfirmed', { botId: botId, serverBot: activeBots[botId] });
        
        // Broadcast to other players
        socket.broadcast.emit('remoteBotSpawned', activeBots[botId]);
    });

    socket.on('botMoved', (data) => {
        if (!data.botId) {
            console.error('botMoved: Missing botId');
            return;
        }
        if (activeBots[data.botId]) {
            activeBots[data.botId].x = data.x;
            activeBots[data.botId].y = data.y;
            activeBots[data.botId].angle = data.angle;
            socket.broadcast.emit('remoteBotMoved', {
                botId: data.botId,
                x: data.x,
                y: data.y,
                angle: data.angle
            });
        } else {
            console.warn(`botMoved: Bot ${data.botId} not found in activeBots`);
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
        } else {
            console.warn(`botDamaged: Bot ${data.botId} not found in activeBots`);
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
        } else {
            console.warn(`botDied: Bot ${data.botId} not found in activeBots`);
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
                x: data.x,
                y: data.y,
                isDead: false,
                hp: data.hp,
                tier: data.tier,
                animalIndex: data.animalIndex
            };
            socket.broadcast.emit('remoteBotRespawned', activeBots[data.botId]);
        } else {
            console.warn(`botRespawned: Bot ${data.botId} not found in activeBots`);
        }
    });

    socket.on('playerHit', (data) => {
        io.to(data.targetId).emit('gotHit', {
            attackerId: socket.id,
            damage: data.damage
        });
    });

    socket.on('playerDied', () => {
        socket.broadcast.emit('playerDeath', socket.id);
        delete players[socket.id];
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
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

app.get('/', (req, res) => {
    res.send('SkyFight.io Server Running! Players: ' + Object.keys(players).length + ' | Bots: ' + Object.keys(activeBots).length);
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
