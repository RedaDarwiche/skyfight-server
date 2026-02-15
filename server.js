const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();

// Enable CORS for all routes
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

// Store all connected players
const players = {};

io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    // When a player joins the game
    // When a player joins the game
    socket.on('playerJoin', (data) => {
        // Check if this user account is already connected
        if (data.userId) {
            const existingUser = Object.values(players).find(p => p.userId === data.userId);
            if (existingUser) {
                socket.emit('joinError', { message: 'You are already connected on another tab/browser!' });
                console.log(`Blocked duplicate account: ${data.userId}`);
                return;
            }
        }
        
        // Also check if a player with this name already exists
        const existingPlayer = Object.values(players).find(p => p.name === data.name);
        if (existingPlayer) {
            socket.emit('joinError', { message: 'A player with this name is already in the game!' });
            console.log(`Blocked duplicate join attempt: ${data.name}`);
            return;
        }
        
        players[socket.id] = {
            id: socket.id,
            userId: data.userId || null, // ADD THIS LINE
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

        // Send current players to the new player
        socket.emit('currentPlayers', players);

        // Tell all other players about the new player
        socket.broadcast.emit('newPlayer', players[socket.id]);

        console.log(`Player ${data.name} joined the game`);
    });

    // When a player moves
    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].angle = data.angle;

            // Broadcast to all other players
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle
            });
        }
    });

    // When a player updates their stats
    // When a player updates their stats
socket.on('playerUpdate', (data) => {
    if (players[socket.id]) {
        players[socket.id].size = data.size;
        players[socket.id].tier = data.tier;
        players[socket.id].hp = data.hp;
        players[socket.id].xp = data.xp;
        players[socket.id].color = data.color;
        players[socket.id].animalType = data.animalType;
        players[socket.id].animalIndex = data.animalIndex;

        // Broadcast to all other players
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
// When a player sends a chat message
socket.on('chatMessage', (data) => {
    socket.broadcast.emit('chatMessage', {
        text: data.text,
        playerName: data.playerName
    });
});

// When a player damages a bot
socket.on('botDamaged', (data) => {
    socket.broadcast.emit('botDamaged', data);
});
    // When a player hits another player
socket.on('playerHit', (data) => {
    // Tell the target player they got hit
    io.to(data.targetId).emit('gotHit', {
        attackerId: socket.id,
        damage: data.damage
    });
});

// When a player dies
socket.on('playerDied', () => {
    socket.broadcast.emit('playerDeath', socket.id);
    delete players[socket.id];
});

    // When a player disconnects
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        socket.broadcast.emit('playerDisconnected', socket.id);
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    res.send('SkyFight.io Server Running! Connected players: ' + Object.keys(players).length);
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
