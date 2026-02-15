const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Store all connected players
const players = {};
const bots = {};

// Game constants
const CANVAS_WIDTH = 8000;
const CANVAS_HEIGHT = 8000;

io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    // When a player joins the game
    socket.on('playerJoin', (data) => {
        players[socket.id] = {
            id: socket.id,
            x: data.x || Math.random() * CANVAS_WIDTH,
            y: data.y || Math.random() * CANVAS_HEIGHT,
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
            players[socket.id].vx = data.vx;
            players[socket.id].vy = data.vy;

            // Broadcast to all other players
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle,
                vx: data.vx,
                vy: data.vy
            });
        }
    });

    // When a player updates their stats
    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id].size = data.size;
            players[socket.id].tier = data.tier;
            players[socket.id].hp = data.hp;
            players[socket.id].xp = data.xp;
            players[socket.id].color = data.color;
            players[socket.id].animalType = data.animalType;

            // Broadcast to all other players
            socket.broadcast.emit('playerUpdated', {
                id: socket.id,
                size: data.size,
                tier: data.tier,
                hp: data.hp,
                xp: data.xp,
                color: data.color,
                animalType: data.animalType
            });
        }
    });

    // When a player dashes
    socket.on('playerDash', () => {
        socket.broadcast.emit('playerDashed', socket.id);
    });

    // When a player uses ability
    socket.on('playerAbility', (data) => {
        socket.broadcast.emit('playerUsedAbility', {
            id: socket.id,
            ability: data.ability
        });
    });

    // When a player attacks
    socket.on('playerAttack', (targetId) => {
        socket.broadcast.emit('playerAttacked', {
            attackerId: socket.id,
            targetId: targetId
        });
    });

    // When a player dies
    socket.on('playerDied', () => {
        socket.broadcast.emit('playerDeath', socket.id);
        delete players[socket.id];
    });

    // Chat message
    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', {
            id: socket.id,
            name: players[socket.id]?.name || 'Unknown',
            message: data.message
        });
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