const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Game constants
const MAX_PLAYERS = 50;
const ARENA_WIDTH = 2000;
const ARENA_HEIGHT = 1000;
const BOT_UPDATE_INTERVAL = 500; // ms
const INACTIVE_TIMEOUT = 120000; // 2 minutes in ms
const GAME_UPDATE_INTERVAL = 50; // 20 updates per second

// Game state
const gameState = {
  players: {},
  queue: [],
  lastActivity: {} // Track last activity time for each player
};

// Player class
class Player {
  constructor(id, isBot = false) {
    this.id = id;
    this.isBot = isBot;
    this.x = Math.random() * ARENA_WIDTH;
    this.y = Math.random() * ARENA_HEIGHT;
    this.health = 100;
    this.score = 0;
    this.isDead = false;
    this.direction = 'right';
    this.action = 'idle';
    this.lastAttackTime = 0;
    this.color = isBot ? '#FF6347' : '#4169E1'; // Red for bots, blue for players
    this.startTime = Date.now(); // Track when player joined for survival time
    this.survivalTime = 0; // Time survived in seconds
    
    // Only log real player creation, not bots
    if (!isBot) {
      console.log(`Player created: ${id}`);
    }
    
    // Initialize last activity for real players
    if (!isBot) {
      gameState.lastActivity[id] = Date.now();
    }
  }

  takeDamage(amount, attackerId) {
    if (this.action === 'block') {
      amount = amount / 2; // Block reduces damage by half
    }
    
    this.health -= amount;
    
    if (this.health <= 0) {
      this.health = 0;
      this.isDead = true;
      
      // Calculate final survival time
      this.survivalTime = Math.floor((Date.now() - this.startTime) / 1000);
      
      // Add survival points (1 point per second survived)
      this.score += this.survivalTime;
      
      // Award points to attacker
      if (gameState.players[attackerId]) {
        gameState.players[attackerId].score += 10;
      }
      
      // Emit death event with final stats for real players
      if (!this.isBot) {
        const socket = io.sockets.sockets.get(this.id);
        if (socket) {
          socket.emit('playerDied', {
            score: this.score,
            survivalTime: this.survivalTime,
            killerId: attackerId
          });
        }
      }
      
      // We'll keep the player in the game state temporarily to show death animation
      // They'll be removed after a short delay
      setTimeout(() => {
        if (this.isBot) {
          // Remove bot immediately
          delete gameState.players[this.id];
          fillWithBots(); // Maintain bot count
        }
        // Real players will be removed when they choose to restart or disconnect
      }, this.isBot ? 1000 : 5000); // Remove bots faster than players
    }
    
    // Award points for damage
    if (gameState.players[attackerId]) {
      gameState.players[attackerId].score += Math.floor(amount / 5);
    }
  }

  respawn() {
    this.x = Math.random() * ARENA_WIDTH;
    this.y = Math.random() * ARENA_HEIGHT;
    this.health = 100;
    this.isDead = false;
    this.action = 'idle';
    this.startTime = Date.now(); // Reset survival timer
    this.survivalTime = 0;
  }
  
  // Update last activity timestamp
  updateActivity() {
    if (!this.isBot) {
      gameState.lastActivity[this.id] = Date.now();
    }
  }
  
  // Update survival time for active players
  updateSurvivalTime() {
    if (!this.isDead) {
      this.survivalTime = Math.floor((Date.now() - this.startTime) / 1000);
    }
  }
}

// Calculate the current number of players (real + bots)
function countPlayers() {
  return Object.keys(gameState.players).length;
}

// Calculate the number of real players (non-bots)
function countRealPlayers() {
  return Object.values(gameState.players).filter(p => !p.isBot).length;
}

// Calculate the number of bot players
function countBotPlayers() {
  return Object.values(gameState.players).filter(p => p.isBot).length;
}

// Check for inactive players and remove them
function checkInactivePlayers() {
  const now = Date.now();
  const inactivePlayers = [];
  
  // Find inactive players
  Object.values(gameState.players).forEach(player => {
    if (!player.isBot && gameState.lastActivity[player.id]) {
      const timeSinceLastActivity = now - gameState.lastActivity[player.id];
      if (timeSinceLastActivity > INACTIVE_TIMEOUT) {
        inactivePlayers.push(player.id);
      }
    }
  });
  
  // Remove inactive players
  inactivePlayers.forEach(playerId => {
    console.log(`Removing inactive player: ${playerId}`);
    delete gameState.players[playerId];
    delete gameState.lastActivity[playerId];
    
    // Try to add someone from the queue
    processQueue();
  });
  
  // If we removed any players, we need to fill with bots
  if (inactivePlayers.length > 0) {
    fillWithBots();
  }
}

// Process the queue, moving players from queue to game
function processQueue() {
  // If there are players in the queue, try to add them
  while (gameState.queue.length > 0) {
    const nextPlayerId = gameState.queue[0];
    const nextSocket = io.sockets.sockets.get(nextPlayerId);
    
    // If the socket is still connected
    if (nextSocket) {
      // Remove from queue and add to game
      gameState.queue.shift();
      
      // Replace a bot if possible
      replaceBotWithPlayer();
      
      // Add player to game
      gameState.players[nextPlayerId] = new Player(nextPlayerId);
      
      console.log(`Player ${nextPlayerId} moved from queue to game. Queue length: ${gameState.queue.length}`);
      
      nextSocket.emit('playerJoined', nextPlayerId);
      nextSocket.emit('gameState', gameState);
      
      // Update queue positions for remaining players
      updateQueuePositions();
      
      // We only add one player per call
      break;
    } else {
      // If socket is disconnected, remove from queue
      gameState.queue.shift();
    }
  }
}

// Update queue positions for all players in queue
function updateQueuePositions() {
  for (let i = 0; i < gameState.queue.length; i++) {
    const queuedId = gameState.queue[i];
    const queuedSocket = io.sockets.sockets.get(queuedId);
    if (queuedSocket) {
      queuedSocket.emit('queued', i + 1);
    }
  }
}

// Fill with bots up to MAX_PLAYERS
function fillWithBots() {
  const realPlayerCount = countRealPlayers();
  const currentPlayerCount = countPlayers();
  const botsNeeded = MAX_PLAYERS - currentPlayerCount;
  
  if (botsNeeded <= 0) return;
  
  // Only log when actually adding bots
  if (botsNeeded > 0) {
    console.log(`Adding ${botsNeeded} bots. Real players: ${realPlayerCount}, Total players: ${currentPlayerCount + botsNeeded}`);
  }
  
  for (let i = 0; i < botsNeeded; i++) {
    const botId = `bot-${Date.now()}-${i}`;
    gameState.players[botId] = new Player(botId, true);
  }
}

// Update bot actions
function updateBots() {
  Object.values(gameState.players).forEach(player => {
    if (!player.isBot || player.isDead) return;
    
    // Random movement
    if (Math.random() < 0.7) {
      const moveX = (Math.random() - 0.5) * 20;
      const moveY = (Math.random() - 0.5) * 20;
      
      player.x = Math.max(0, Math.min(ARENA_WIDTH, player.x + moveX));
      player.y = Math.max(0, Math.min(ARENA_HEIGHT, player.y + moveY));
      
      // Set direction based on movement
      if (moveX > 0) player.direction = 'right';
      else if (moveX < 0) player.direction = 'left';
      
      player.action = 'move';
    }
    
    // Random attacks
    if (Math.random() < 0.1) {
      player.action = 'attack';
      player.lastAttackTime = Date.now();
      
      // Find potential targets (players close to the bot)
      Object.values(gameState.players).forEach(target => {
        if (target.id === player.id || target.isDead) return;
        
        const distance = Math.sqrt(
          Math.pow(target.x - player.x, 2) + 
          Math.pow(target.y - player.y, 2)
        );
        
        if (distance < 50) {
          target.takeDamage(10, player.id);
        }
      });
    }
    
    // Random blocks
    if (Math.random() < 0.05) {
      player.action = 'block';
    }
    
    // Reset to idle
    if (Math.random() < 0.3) {
      player.action = 'idle';
    }
  });
}

// Simulate collisions and attacks
function processPlayerActions() {
  Object.values(gameState.players).forEach(attacker => {
    if (attacker.isDead || attacker.action !== 'attack') return;
    
    Object.values(gameState.players).forEach(target => {
      if (target.id === attacker.id || target.isDead) return;
      
      const distance = Math.sqrt(
        Math.pow(target.x - attacker.x, 2) + 
        Math.pow(target.y - attacker.y, 2)
      );
      
      // Check if target is in attack range
      if (distance < 50) {
        target.takeDamage(10, attacker.id);
      }
    });
  });
}

// Replace a bot with a real player
function replaceBotWithPlayer() {
  const bots = Object.values(gameState.players).filter(p => p.isBot);
  
  if (bots.length > 0) {
    const botToReplace = bots[0];
    console.log(`Replacing bot with real player`);
    delete gameState.players[botToReplace.id];
    return true;
  }
  
  return false;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // Always add the player to the game, replacing a bot if necessary
  // Only put in queue if there are NO bots to replace
  const botCount = countBotPlayers();
  
  if (botCount > 0) {
    // Replace a bot with this player
    replaceBotWithPlayer();
    
    // Add player to game
    gameState.players[socket.id] = new Player(socket.id);
    
    // Send initial game state to player
    socket.emit('gameState', gameState);
    socket.emit('playerJoined', socket.id);
  } else {
    // No bots to replace, check if we have room for more players
    const totalPlayers = countPlayers();
    
    if (totalPlayers < MAX_PLAYERS) {
      // We have room for this player
      gameState.players[socket.id] = new Player(socket.id);
      
      // Send initial game state to player
      socket.emit('gameState', gameState);
      socket.emit('playerJoined', socket.id);
    } else {
      // Game is full, add to queue
      if (!gameState.queue.includes(socket.id)) {
        gameState.queue.push(socket.id);
        const queuePosition = gameState.queue.indexOf(socket.id) + 1;
        socket.emit('queued', queuePosition);
        console.log(`Player ${socket.id} added to queue. Position: ${queuePosition}`);
      }
    }
  }
  
  // Handle player movement
  socket.on('playerMove', (data) => {
    const player = gameState.players[socket.id];
    if (!player || player.isDead) return;
    
    player.x = Math.max(0, Math.min(ARENA_WIDTH, data.x));
    player.y = Math.max(0, Math.min(ARENA_HEIGHT, data.y));
    player.direction = data.direction;
    player.action = 'move';
    
    // Update activity timestamp
    player.updateActivity();
  });
  
  // Handle player attack
  socket.on('playerAttack', () => {
    const player = gameState.players[socket.id];
    if (!player || player.isDead) return;
    
    // Prevent attack spam with cooldown
    const now = Date.now();
    if (now - player.lastAttackTime < 500) return;
    
    player.lastAttackTime = now;
    player.action = 'attack';
    
    // Update activity timestamp
    player.updateActivity();
  });
  
  // Handle player block
  socket.on('playerBlock', () => {
    const player = gameState.players[socket.id];
    if (!player || player.isDead) return;
    
    player.action = 'block';
    
    // Update activity timestamp
    player.updateActivity();
  });
  
  // Handle player idle
  socket.on('playerIdle', () => {
    const player = gameState.players[socket.id];
    if (!player || player.isDead) return;
    
    player.action = 'idle';
    
    // Update activity timestamp
    player.updateActivity();
  });
  
  // Handle respawn request
  socket.on('respawn', () => {
    const player = gameState.players[socket.id];
    if (!player) return;
    
    player.respawn();
    
    // Update activity timestamp
    player.updateActivity();
  });
  
  // Handle restart request after death
  socket.on('restart', () => {
    // Check if player exists but is dead
    if (gameState.players[socket.id] && gameState.players[socket.id].isDead) {
      // Just respawn the player
      gameState.players[socket.id].respawn();
      socket.emit('playerRestarted', socket.id);
    } else if (!gameState.players[socket.id]) {
      // Player was fully removed, create a new player
      gameState.players[socket.id] = new Player(socket.id);
      socket.emit('playerJoined', socket.id);
    }
    
    // Update activity timestamp
    if (gameState.players[socket.id]) {
      gameState.players[socket.id].updateActivity();
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      
      // Also clean up last activity
      if (gameState.lastActivity[socket.id]) {
        delete gameState.lastActivity[socket.id];
      }
      
      // Process queue to add waiting players
      processQueue();
      
      // Fill any remaining slots with bots
      fillWithBots();
    } else {
      // Check if player was in queue
      const queueIndex = gameState.queue.indexOf(socket.id);
      if (queueIndex > -1) {
        gameState.queue.splice(queueIndex, 1);
        
        // Update queue positions
        updateQueuePositions();
      }
    }
  });
});

// Split the game loop into separate concerns with different intervals
// Main game update loop - fast updates for player actions and state
setInterval(() => {
  // Process player actions
  processPlayerActions();
  
  // Update survival time for all active players
  Object.values(gameState.players).forEach(player => {
    if (!player.isDead) {
      player.updateSurvivalTime();
    }
  });
  
  // Send game state to clients
  const streamlinedState = {
    players: gameState.players
  };
  io.emit('gameState', streamlinedState);
}, GAME_UPDATE_INTERVAL);

// Bot update loop - slower updates
setInterval(() => {
  updateBots();
}, BOT_UPDATE_INTERVAL);

// Admin tasks - very infrequent
setInterval(() => {
  checkInactivePlayers();
  fillWithBots();
}, 10000); // Every 10 seconds

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Max players: ${MAX_PLAYERS}`);
  console.log(`Arena size: ${ARENA_WIDTH}x${ARENA_HEIGHT}`);
  
  // Initialize the game with bots
  fillWithBots();
}); 