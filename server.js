// Import required libraries
try {
  require('dotenv').config();
} catch (e) {
  console.warn('dotenv module not found or .env file missing, using environment variables');
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const { Chess } = require('chess.js');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Set up Socket.IO for WebSockets
const io = new Server(server, {
  cors: {
    origin: "*", // In production, you may want to restrict this
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Add CORS headers for HTTP requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// CORS test endpoint
app.get('/cors-test', (req, res) => {
  res.json({
    message: 'CORS is working properly',
    timestamp: new Date().toISOString()
  });
});

// Lichess API configuration
const LICHESS_API_TOKEN = process.env.LICHESS_API_TOKEN;
const LICHESS_API_BASE = 'https://lichess.org/api';

// Check if API token is working
app.get('/api-status', async (req, res) => {
  try {
    if (!LICHESS_API_TOKEN) {
      return res.status(500).json({
        status: 'error',
        message: 'No API token configured',
        tokenProvided: false
      });
    }
    
    const response = await axios({
      method: 'get',
      url: `${LICHESS_API_BASE}/account`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      timeout: 10000
    });
    
    res.json({
      status: 'ok',
      message: 'API token is valid',
      account: {
        id: response.data.id,
        username: response.data.username
      }
    });
  } catch (error) {
    console.error('API status check failed:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'API token check failed',
      error: error.message,
      tokenProvided: !!LICHESS_API_TOKEN
    });
  }
});

// Specific account to auto-accept challenges from
const ALLOWED_CHALLENGER = 'thatsjustchips';
const BOT_ACCOUNT = 'thatsjustchipschat';

// Game and voting state
let currentGameId = null;
let currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let currentChess = new Chess();
let legalMoves = [];
let votes = {};
let voterIPs = {}; // Track IPs that have voted
let votingEndTime = null;
const VOTING_DURATION = 90000; // 1 minute 30 seconds in milliseconds
let gameInProgress = false;
let votingTimeoutId = null;
let lastEventTime = Date.now();
let streamReconnectAttempts = 0;
let botColor = null; // 'white' or 'black'
let colorDetermined = false;
let lastGameFullData = null;
let apiConnectionStatus = 'disconnected';
let connectedUsers = new Set(); // Track connected sockets
let activeVoters = new Set(); // Track active voters
let moveVoteHistory = []; // Track vote distribution history
let isSpectatorMode = false; // Track if a user is in spectator mode

// Update connected users count and broadcast to all clients
function updateConnectedUsers() {
  io.emit('userCount', {
    total: connectedUsers.size,
    activeVoters: activeVoters.size
  });
}

// Query parameter endpoint for configuration updates
app.get('/update-config', (req, res) => {
  try {
    const { bot, challenger, voting_time } = req.query;
    let configUpdated = false;
    let response = { updated: {}, status: 'ok' };
    
    // Update BOT_ACCOUNT if provided
    if (bot && typeof bot === 'string' && bot.trim()) {
      BOT_ACCOUNT = bot.trim();
      configUpdated = true;
      response.updated.botAccount = BOT_ACCOUNT;
    }
    
    // Update ALLOWED_CHALLENGER if provided
    if (challenger && typeof challenger === 'string' && challenger.trim()) {
      ALLOWED_CHALLENGER = challenger.trim();
      configUpdated = true;
      response.updated.allowedChallenger = ALLOWED_CHALLENGER;
    }
    
    // Update VOTING_DURATION if provided
    if (voting_time && !isNaN(parseInt(voting_time))) {
      const newDuration = parseInt(voting_time) * 1000; // Convert to milliseconds
      if (newDuration >= 30000 && newDuration <= 300000) { // Between 30s and 5min
        VOTING_DURATION = newDuration;
        configUpdated = true;
        response.updated.votingDuration = VOTING_DURATION / 1000; // Send back in seconds
      }
    }
    
    if (configUpdated) {
      console.log('Configuration updated via API:', response.updated);
      res.json(response);
    } else {
      res.status(400).json({
        status: 'error',
        message: 'No valid configuration parameters provided'
      });
    }
  } catch (error) {
    console.error('Error updating configuration:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Debug endpoint with enhanced API information
app.get('/debug', (req, res) => {
  try {
    // Get connected clients count
    const connectedClients = io.sockets.sockets.size;
    
    // Get a list of connected socket IDs
    const socketIds = Array.from(io.sockets.sockets.keys());
    
    // Construct debug information
    const debugInfo = {
      serverUptime: process.uptime(),
      gameInProgress,
      currentGameId,
      currentFen,
      botColor,
      colorDetermined,
      turn: currentChess ? currentChess.turn() : null,
      legalMoves: {
        count: legalMoves.length,
        moves: legalMoves.slice(0, 10) // Only include first 10 moves to avoid huge response
      },
      votes: {
        count: Object.keys(votes).length,
        votes: votes
      },
      voterCount: Object.keys(voterIPs).length,
      lastEventTime: new Date(lastEventTime).toISOString(),
      streamReconnectAttempts,
      votingStatus: {
        isActive: !!votingEndTime,
        endsAt: votingEndTime ? new Date(votingEndTime).toISOString() : null,
        timeRemaining: votingEndTime ? Math.max(0, votingEndTime - Date.now()) : null
      },
      socketInfo: {
        connectedClients,
        socketIds: socketIds.slice(0, 20) // Limit to first 20 if there are many
      },
      lichessApiStatus: {
        tokenPresent: !!LICHESS_API_TOKEN,
        tokenFirstChars: LICHESS_API_TOKEN ? `${LICHESS_API_TOKEN.substring(0, 5)}...` : 'none',
        lastApiCallTime: lastEventTime ? new Date(lastEventTime).toISOString() : null,
        connectionStatus: apiConnectionStatus
      }
    };
    
    // Add config info excluding sensitive values
    debugInfo.config = {
      allowedChallenger: ALLOWED_CHALLENGER,
      botAccount: BOT_ACCOUNT,
      votingDurationSeconds: VOTING_DURATION / 1000
    };
    
    res.json(debugInfo);
  } catch (error) {
    console.error('Error in /debug endpoint:', error);
    res.status(500).json({
      error: 'Error generating debug information',
      message: error.message,
      stack: process.env.NODE_ENV === 'production' ? null : error.stack
    });
  }
});

// Add a ping endpoint for quick status checks
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gameActive: gameInProgress,
    votingActive: !!votingEndTime
  });
});

// Connect to a Lichess game
async function connectToLichessGame(gameId) {
  try {
    console.log(`Attempting to connect to game: ${gameId}`);
    
    // Reset game state
    currentGameId = gameId;
    votes = {};
    voterIPs = {};
    
    // Use the correct API endpoint for bot accounts
    const streamUrl = `${LICHESS_API_BASE}/bot/game/stream/${gameId}`;
    console.log(`Connecting to: ${streamUrl}`);
    
    const response = await axios({
      method: 'get',
      url: streamUrl,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      responseType: 'stream',
      timeout: 30000 // Add timeout to prevent hanging connections
    });

    gameInProgress = true;
    console.log(`Successfully connected to game ${gameId}, broadcasting to all clients`);
    io.emit('gameConnected', { gameId });

    // Handle data streaming
    response.data.on('data', (chunk) => {
      try {
        lastEventTime = Date.now();
        const lines = chunk.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            console.log('Raw game data:', line);
            if (line.trim()) {
              const data = JSON.parse(line);
              handleGameUpdate(data);
            }
          } catch (e) {
            console.error('Error parsing game data:', e, 'Line:', line);
          }
        }
      } catch (streamError) {
        console.error(`Error processing stream data for game ${gameId}:`, streamError);
      }
    });

    // Handle stream end
    response.data.on('end', () => {
      console.log(`Game stream ended for game: ${gameId}`);
      gameInProgress = false;
      io.emit('gameEnded', { gameId });
    });

    // Handle stream errors
    response.data.on('error', (error) => {
      console.error(`Game stream error for game ${gameId}:`, error.message);
      gameInProgress = false;
      io.emit('gameError', { error: error.message });
      
      // Try to reconnect after a delay
      setTimeout(() => {
        if (currentGameId === gameId) {
          console.log(`Attempting to reconnect to game ${gameId} after stream error`);
          connectToLichessGame(gameId);
        }
      }, 5000);
    });

    console.log(`Connected to Lichess game: ${gameId}`);
    
    // Determine bot color immediately
    determinePlayerColors(gameId);
    
    return true;
  } catch (error) {
    console.error('Error connecting to Lichess game:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error details:', error.stack);
    }
    
    gameInProgress = false;
    io.emit('gameError', { error: error.message });
    
    // Try to reconnect after a delay
    setTimeout(() => {
      console.log(`Attempting to reconnect to game ${gameId} after connection error`);
      connectToLichessGame(gameId);
    }, 10000);
    
    return false;
  }
}

// Determine which color the bot is playing with rate limit handling
async function determinePlayerColors(gameId) {
  try {
    // First, try to determine from the gameFull data we already have
    // This avoids an extra API call
    if (gameInProgress && currentGameId === gameId && botColor) {
      console.log(`Bot color already determined: ${botColor}`);
      return botColor;
    }
    
    // Only make this call if we absolutely need to
    console.log(`Determining player colors for game ${gameId}`);
    
    const response = await axios({
      method: 'get',
      url: `${LICHESS_API_BASE}/bot/game/stream/${gameId}`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      responseType: 'json',
      timeout: 5000 // Shorter timeout for this call
    });

    if (response.data) {
      const gameData = response.data;
      
      if (gameData.white && gameData.white.id.toLowerCase() === BOT_ACCOUNT.toLowerCase()) {
        botColor = 'white';
        colorDetermined = true;
        console.log('Bot is playing as white');
        return 'white';
      } else if (gameData.black && gameData.black.id.toLowerCase() === BOT_ACCOUNT.toLowerCase()) {
        botColor = 'black';
        colorDetermined = true;
        console.log('Bot is playing as black');
        return 'black';
      }
    }
    
    // If we couldn't determine the color, use a fallback method
    return inferBotColor();
  } catch (error) {
    console.error('Error determining player colors:', error.message);
    
    // If we hit rate limits, wait before trying again
    if (error.response && error.response.status === 429) {
      console.log('Rate limited, waiting 60 seconds before retrying');
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    
    // Use fallback method - attempt to infer from game state
    return inferBotColor();
  }
}

// Infer bot color from the current game state
function inferBotColor() {
  // If we already have a determined color, return it
  if (colorDetermined && botColor) {
    return botColor;
  }
  
  // Try to infer from the current position and turn
  if (currentChess) {
    const turn = currentChess.turn();
    
    // If we've received a full game update, we can use the white/black player info
    if (lastGameFullData) {
      if (lastGameFullData.white && lastGameFullData.white.id && 
          lastGameFullData.white.id.toLowerCase() === BOT_ACCOUNT.toLowerCase()) {
        botColor = 'white';
        colorDetermined = true;
        console.log('Bot is playing as white (inferred from lastGameFullData)');
        return 'white';
      } else if (lastGameFullData.black && lastGameFullData.black.id && 
                lastGameFullData.black.id.toLowerCase() === BOT_ACCOUNT.toLowerCase()) {
        botColor = 'black';
        colorDetermined = true;
        console.log('Bot is playing as black (inferred from lastGameFullData)');
        return 'black';
      }
    }
    
    // Last resort - check if we need to vote based on current turn
    if (isVotingNeeded() && !botColor) {
      botColor = turn === 'w' ? 'white' : 'black';
      colorDetermined = true;
      console.log(`Bot is playing as ${botColor} (inferred from voting state)`);
      return botColor;
    }
  }
  
  // If all else fails, assume black (this is just a fallback)
  console.log('Could not determine bot color, defaulting to black');
  return 'black';
}

// Check if voting is needed based on whose turn it is
function isVotingNeeded() {
  return (botColor === 'white' && currentChess.turn() === 'w') || 
         (botColor === 'black' && currentChess.turn() === 'b');
}

// Process game updates from Lichess
function handleGameUpdate(data) {
  console.log('Received game update type:', data.type);
  
  // Handle different types of game state data
  if (data.type === 'gameFull') {
    lastGameFullData = data;
    // Full game data received
    console.log('Game full data:', JSON.stringify(data).substring(0, 500) + '...');
    
    // Determine bot color from the full game data
    if (data.white && data.white.id && data.white.id.toLowerCase() === BOT_ACCOUNT.toLowerCase()) {
      botColor = 'white';
      colorDetermined = true;
      console.log('Bot is playing as white');
    } else if (data.black && data.black.id && data.black.id.toLowerCase() === BOT_ACCOUNT.toLowerCase()) {
      botColor = 'black';
      colorDetermined = true;
      console.log('Bot is playing as black');
    }
    
    // Set the initial position
    currentFen = data.initialFen === 'startpos' ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : data.initialFen;
    currentChess = new Chess(currentFen);
    
    // Apply moves if any
    if (data.state && data.state.moves) {
      applyMoves(data.state.moves);
    }
    
    updateLegalMoves();
    
    // Start voting if it's our turn
    if (isVotingNeeded()) {
      // Clear any existing timeout
      if (votingTimeoutId) {
        clearTimeout(votingTimeoutId);
      }
      startVotingPeriod();
    }
    
    broadcastGameState();
  } else if (data.type === 'gameState') {
    // Game state update received
    console.log('Game state update:', JSON.stringify(data).substring(0, 500) + '...');
    
    if (data.moves !== undefined) {
      // Reset the chess instance and replay all moves
      currentChess = new Chess();
      applyMoves(data.moves);
      
      // Update legal moves
      updateLegalMoves();
      
      // Check if it's our turn now
      if (isVotingNeeded()) {
        // Clear any existing timeout
        if (votingTimeoutId) {
          clearTimeout(votingTimeoutId);
        }
        
        console.log('Starting new voting period after moves update');
        // Start new voting period
        votes = {};
        voterIPs = {};
        startVotingPeriod();
      }
      
      broadcastGameState();
    }
  } else if (data.type === 'chatLine') {
    // Chat message received - could be used for announcements
    console.log('Chat message:', data);
    io.emit('chatMessage', data);
  }
}

// Apply a series of moves to the chess instance
function applyMoves(movesString) {
  const moves = movesString.trim().split(' ').filter(m => m);
  console.log('Applying moves:', moves);
  
  // Reset the chess instance to the starting position
  currentChess = new Chess();
  
  for (const move of moves) {
    try {
      // Convert from UCI format (e2e4) to chess.js format ({ from: 'e2', to: 'e4' })
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move.substring(4, 5) : undefined;
      
      const moveResult = currentChess.move({ from, to, promotion });
      if (!moveResult) {
        console.error('Invalid move:', move);
      }
    } catch (e) {
      console.error('Error applying move:', move, e.message);
    }
  }
  
  // Update FEN
  currentFen = currentChess.fen();
  console.log('Updated FEN:', currentFen);
}

// Update legal moves based on current position
function updateLegalMoves() {
  try {
    const chessMoves = currentChess.moves({ verbose: true });
    
    // Filter moves based on the bot's color
    const filteredMoves = botColor ? 
      chessMoves.filter(move => {
        const piece = currentChess.get(move.from);
        return piece && ((botColor === 'white' && piece.color === 'w') || 
                         (botColor === 'black' && piece.color === 'b'));
      }) : 
      chessMoves;
    
    legalMoves = filteredMoves.map(move => {
      // Convert chess.js move format to UCI format
      let uci = move.from + move.to;
      if (move.promotion) {
        uci += move.promotion;
      }
      return { uci, move };
    });
    
    console.log(`Legal moves updated, count: ${legalMoves.length}, bot color: ${botColor}`);
  } catch (e) {
    console.error('Error updating legal moves:', e.message);
    legalMoves = [];
  }
}

// Check if voting is needed based on whose turn it is
function isVotingNeeded() {
  if (!botColor) return false;
  
  const isOurTurn = (botColor === 'white' && currentChess.turn() === 'w') || 
                   (botColor === 'black' && currentChess.turn() === 'b');
                   
  console.log(`Checking if voting is needed: botColor=${botColor}, current turn=${currentChess.turn()}, isOurTurn=${isOurTurn}`);
  
  return isOurTurn;
}

// Start voting period timer
function startVotingPeriod() {
  // Reset votes
  votes = {};
  voterIPs = {};
  
  // Set end time
  votingEndTime = Date.now() + VOTING_DURATION;
  
  // Schedule vote counting
  votingTimeoutId = setTimeout(countVotesAndMove, VOTING_DURATION);
  
  // Broadcast voting started
  io.emit('votingStarted', {
    endTime: votingEndTime,
    legalMoves: legalMoves,
    botColor: botColor
  });
  
  console.log('Voting period started, ends at:', new Date(votingEndTime).toISOString());
}

// Count votes and execute move
async function countVotesAndMove() {
  if (!isVotingNeeded() || !gameInProgress) {
    console.log('Voting ended but no move needed or game not in progress');
    return;
  }
  
  votingEndTime = null;
  
  console.log('Counting votes:', votes);
  console.log('Voter IPs:', Object.keys(voterIPs).length);
  
  // Find the move with the most votes
  let bestMove = null;
  let bestVoteCount = 0;
  
  for (const [move, count] of Object.entries(votes)) {
    if (count > bestVoteCount) {
      bestMove = move;
      bestVoteCount = count;
    }
  }
  
  // In case of a tie, randomly select one of the tied moves
  const tiedMoves = Object.entries(votes)
    .filter(([_, count]) => count === bestVoteCount)
    .map(([move, _]) => move);
  
  if (tiedMoves.length > 1) {
    console.log(`Tie between ${tiedMoves.join(', ')}. Randomly selecting one.`);
    bestMove = tiedMoves[Math.floor(Math.random() * tiedMoves.length)];
  }
  
  // Save vote history before clearing
  const voteHistoryEntry = {
    fen: currentFen,
    move: bestMove,
    votes: {...votes},
    totalVoters: Object.keys(voterIPs).length,
    timestamp: new Date().toISOString()
  };
  moveVoteHistory.push(voteHistoryEntry);
  // Keep only last 10 moves in history
  if (moveVoteHistory.length > 10) {
    moveVoteHistory.shift();
  }
  
  // Clear votes for next round
  votes = {};
  voterIPs = {};
  
  if (bestMove) {
    io.emit('moveSelected', {
      move: bestMove,
      voteCount: bestVoteCount,
      totalVotes: Object.values(votes).reduce((a, b) => a + b, 0) || bestVoteCount,
      wasRandomTiebreaker: tiedMoves.length > 1
    });
    
    console.log(`Selected move: ${bestMove} with ${bestVoteCount} votes`);
    
    // Make the move on lichess
    try {
      await makeMove(bestMove);
    } catch (error) {
      console.error('Error making move:', error);
    }
  } else {
    console.log('No votes received during voting period');
    if (legalMoves.length > 0) {
      // If no votes, make a random legal move
      const randomMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      
      io.emit('moveSelected', {
        move: randomMove,
        voteCount: 0,
        totalVotes: 0,
        wasRandom: true
      });
      
      console.log(`No votes received. Making random move: ${randomMove}`);
      
      try {
        await makeMove(randomMove);
      } catch (error) {
        console.error('Error making random move:', error);
      }
    }
  }
}

// Make a move on Lichess
async function makeMove(move) {
  try {
    console.log(`Attempting to make move ${move} on game ${currentGameId}`);
    
    // Use the bot API endpoint for making moves
    const response = await axios({
      method: 'post',
      url: `${LICHESS_API_BASE}/bot/game/${currentGameId}/move/${move}`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // Add timeout to prevent hanging requests
    });
    
    console.log(`Move ${move} executed successfully:`, response.data);
    return true;
  } catch (error) {
    console.error('Error making move on Lichess:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return false;
  }
}

// Broadcast current game state to all clients
function broadcastGameState() {
  try {
    const payload = {
      gameId: currentGameId,
      fen: currentFen,
      turn: currentChess.turn(),
      legalMoves: legalMoves,
      votes: votes,
      votingEndTime: votingEndTime,
      isGameOver: currentChess.isGameOver(),
      isCheck: currentChess.isCheck(),
      isCheckmate: currentChess.isCheckmate(),
      inProgress: gameInProgress,
      botColor: botColor
    };
    
    const connectedClients = io.sockets.sockets.size;
    console.log(`Broadcasting game state to ${connectedClients} connected clients - FEN: ${currentFen} Turn: ${currentChess.turn()} Bot color: ${botColor}`);
    
    if (connectedClients === 0) {
      console.warn('No clients connected to receive game state updates!');
    }
    
    // Add a timestamp to track when updates are sent
    payload.timestamp = Date.now();
    
    io.emit('gameState', payload);
    
    // Log a sample of the payload for debugging
    const payloadSample = JSON.stringify({
      gameId: payload.gameId,
      fen: payload.fen,
      turn: payload.turn,
      votingEndTime: payload.votingEndTime,
      inProgress: payload.inProgress,
      botColor: payload.botColor,
      legalMovesCount: legalMoves.length
    });
    
    console.log(`Game state payload sample: ${payloadSample}`);
    
    return true;
  } catch (error) {
    console.error('Error broadcasting game state:', error);
    return false;
  }
}

// Listen for incoming events from Lichess
async function streamEvents() {
  try {
    console.log('Starting to stream events from Lichess');
    console.log(`Using API token: ${LICHESS_API_TOKEN ? 'Token provided' : 'No token found'}`);
    streamReconnectAttempts++;
    
    const response = await axios({
      method: 'get',
      url: `${LICHESS_API_BASE}/stream/event`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      responseType: 'stream',
      timeout: 30000 // Add timeout to prevent hanging connections
    });

    // Reset reconnect attempts on successful connection
    streamReconnectAttempts = 0;
    apiConnectionStatus = 'connected';
    console.log('Successfully connected to Lichess event stream');
    io.emit('apiStatus', { status: 'connected', message: 'Connected to Lichess API' });

    response.data.on('data', (chunk) => {
      try {
        lastEventTime = Date.now();
        const lines = chunk.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            if (line.trim()) {
              console.log('Raw event data:', line);
              const event = JSON.parse(line);
              handleLichessEvent(event);
            }
          } catch (e) {
            console.error('Error parsing event data:', e, 'Line:', line);
          }
        }
      } catch (streamError) {
        console.error('Error processing event stream data:', streamError);
      }
    });

    response.data.on('end', () => {
      console.log('Event stream ended');
      apiConnectionStatus = 'disconnected';
      io.emit('apiStatus', { status: 'disconnected', message: 'Lichess API stream ended' });
      // Try to reconnect after a delay
      setTimeout(streamEvents, 5000);
    });

    response.data.on('error', (error) => {
      console.error('Event stream error:', error.message);
      apiConnectionStatus = 'error';
      io.emit('apiStatus', { status: 'error', message: `API Error: ${error.message}` });
      // Try to reconnect after a delay
      setTimeout(streamEvents, 5000);
    });

    console.log('Event stream connected');
  } catch (error) {
    console.error('Error connecting to event stream:', error.message);
    apiConnectionStatus = 'error';
    io.emit('apiStatus', { status: 'error', message: `Failed to connect to Lichess API: ${error.message}` });
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    } else if (error.request) {
      console.error('No response received:', error.request._currentUrl || 'unknown URL');
      // Simplified error logging to avoid overly verbose logs
      console.error('Connection failed, possibly network issue or invalid token');
    } else {
      console.error('Error details:', error.stack);
    }
    
    // Exponential backoff for reconnect attempts
    const delay = Math.min(30000, 1000 * Math.pow(2, streamReconnectAttempts));
    console.log(`Retrying in ${delay}ms (attempt ${streamReconnectAttempts})`);
    
    // Try to reconnect after a delay
    setTimeout(streamEvents, delay);
  }
}

// Handle events from Lichess
function handleLichessEvent(event) {
  console.log('Received Lichess event type:', event.type);
  
  if (event.type === 'gameStart') {
    // A game has started, connect to it
    console.log('Game started:', event.game.id);
    connectToLichessGame(event.game.id);
  } else if (event.type === 'gameFinish') {
    // A game has finished
    console.log(`Game ${event.game.id} has finished`);
    
    if (currentGameId === event.game.id) {
      gameInProgress = false;
      // Clear any voting timeout
      if (votingTimeoutId) {
        clearTimeout(votingTimeoutId);
        votingTimeoutId = null;
      }
      io.emit('gameEnded', { gameId: event.game.id });
    }
  } else if (event.type === 'challenge') {
    // Someone challenged us
    console.log(`Challenge ${event.challenge.id} received from ${event.challenge.challenger.name}`);
    io.emit('challengeReceived', event.challenge);
    
    // Auto-accept if it's from the allowed challenger
    if (event.challenge.challenger.name.toLowerCase() === ALLOWED_CHALLENGER.toLowerCase()) {
      console.log(`Auto-accepting challenge from ${ALLOWED_CHALLENGER}`);
      acceptChallenge(event.challenge.id);
    }
  } else if (event.type === 'challengeCanceled') {
    // A challenge was canceled
    console.log(`Challenge ${event.challenge.id} canceled`);
    io.emit('challengeCanceled', event.challenge);
  } else if (event.type === 'challengeDeclined') {
    // A challenge was declined
    console.log(`Challenge ${event.challenge.id} declined`);
    io.emit('challengeDeclined', event.challenge);
  }
}

// Accept a challenge
async function acceptChallenge(challengeId) {
  try {
    console.log(`Accepting challenge ${challengeId}`);
    
    const response = await axios({
      method: 'post',
      url: `${LICHESS_API_BASE}/challenge/${challengeId}/accept`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      timeout: 10000 // Add timeout to prevent hanging requests
    });
    
    console.log('Challenge accepted:', response.data);
    io.emit('challengeAccepted', { challengeId });
    return { success: true };
  } catch (error) {
    console.error('Error accepting challenge:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    io.emit('challengeError', { error: error.message });
    return { success: false, message: error.message };
  }
}

// Health check - reconnect if needed
function healthCheck() {
  const now = Date.now();
  
  // If no events for 5 minutes, try to reconnect to the event stream
  if (now - lastEventTime > 5 * 60 * 1000) {
    console.log('No events received for 5 minutes, reconnecting...');
    streamEvents();
  }
  
  // If game in progress but no events for 2 minutes, try to reconnect to the game
  if (gameInProgress && currentGameId && now - lastEventTime > 2 * 60 * 1000) {
    console.log('No game events received for 2 minutes, reconnecting to game...');
    connectToLichessGame(currentGameId);
  }
}

// Start server and listen for connections
server.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${process.env.PORT || 3000}`);
  
  // Start event streaming
  streamEvents();
  
  // Start health check interval
  setInterval(healthCheck, 60000);
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);
  
  // Add user to connected users
  connectedUsers.add(socket.id);
  updateConnectedUsers();
  
  // Check for spectator mode preference
  socket.on('setSpectatorMode', (isSpectator) => {
    socket.isSpectator = !!isSpectator;
    
    // If user was an active voter and is now a spectator, remove from active voters
    if (isSpectator && activeVoters.has(socket.id)) {
      activeVoters.delete(socket.id);
      updateConnectedUsers();
    }
    
    // Confirm to the client
    socket.emit('spectatorModeSet', socket.isSpectator);
  });
  
  // Check for auth token in connection
  if (socket.handshake.auth && socket.handshake.auth.token) {
    const clientToken = socket.handshake.auth.token;
    console.log('Client provided Lichess token');
    
    // Use token if no server token is configured
    if (!LICHESS_API_TOKEN) {
      LICHESS_API_TOKEN = clientToken;
      console.log('Using client-provided Lichess token');
      
      // Restart event streaming with new token
      if (LICHESS_API_TOKEN) {
        streamEvents();
      }
    }
  }
  
  // Send current game state to new client
  if (currentGameId && gameInProgress) {
    socket.emit('gameConnected', {
      gameId: currentGameId,
      inProgress: gameInProgress,
      botColor: botColor
    });
    
    socket.emit('gameState', {
      fen: currentFen,
      turn: currentChess.turn(),
      inProgress: gameInProgress,
      legalMoves: legalMoves,
      botColor: botColor
    });
    
    if (isVotingNeeded() && votingEndTime) {
      socket.emit('votingStarted', {
        endTime: votingEndTime,
        votes: votes
      });
    }
  } else {
    socket.emit('noActiveGame');
  }
  
  // Listen for client events
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    connectedUsers.delete(socket.id);
    if (activeVoters.has(socket.id)) {
      activeVoters.delete(socket.id);
    }
    updateConnectedUsers();
  });
  
  socket.on('getGameStatus', () => {
    if (currentGameId && gameInProgress) {
      socket.emit('gameConnected', {
        gameId: currentGameId,
        inProgress: gameInProgress,
        botColor: botColor
      });
      
      socket.emit('gameState', {
        fen: currentFen,
        turn: currentChess.turn(),
        inProgress: gameInProgress,
        legalMoves: legalMoves,
        botColor: botColor
      });
      
      if (isVotingNeeded() && votingEndTime) {
        socket.emit('votingStarted', {
          endTime: votingEndTime,
          votes: votes
        });
      }
    } else {
      socket.emit('noActiveGame');
    }
  });
  
  // Add enhanced debug information
  console.log('===== CLIENT CONNECTION DEBUG INFO =====');
  console.log('Game in progress:', gameInProgress);
  console.log('Current game ID:', currentGameId);
  console.log('Current FEN:', currentFen);
  console.log('Bot color:', botColor);
  console.log('Voting end time:', votingEndTime ? new Date(votingEndTime).toISOString() : 'No active voting');
  console.log('Legal moves count:', legalMoves.length);
  console.log('Current votes:', JSON.stringify(votes));
  console.log('========================================');
  
  // Store client IP for vote tracking
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  socket.clientIP = clientIP;
  
  // Handle vote submission
  socket.on('submitVote', async (data) => {
    // Check if user is in spectator mode
    if (socket.isSpectator) {
      socket.emit('voteRejected', {
        move: data.move,
        reason: 'You are in spectator mode. Switch to voter mode to submit votes.'
      });
      return;
    }
    
    // Add user to active voters
    activeVoters.add(socket.id);
    updateConnectedUsers();
    
    // Existing vote handling code
    const { move } = data;
    
    // Validate the vote
    if (!gameInProgress || !isVotingNeeded() || !votingEndTime) {
      socket.emit('voteRejected', { move, reason: 'No active voting period' });
      return;
    }
    
    if (!legalMoves.includes(move)) {
      socket.emit('voteRejected', { move, reason: 'Illegal move' });
      return;
    }
    
    // Check if IP has already voted
    if (voterIPs[socket.clientIP]) {
      // Update the existing vote
      const oldVote = voterIPs[socket.clientIP];
      if (oldVote !== move) {
        // Remove old vote
        votes[oldVote]--;
        // Add new vote
        votes[move] = (votes[move] || 0) + 1;
        // Update IP's vote
        voterIPs[socket.clientIP] = move;
        socket.emit('voteAccepted', { move, changed: true, previousVote: oldVote });
      } else {
        socket.emit('voteAccepted', { move, changed: false });
      }
    } else {
      // New vote
      votes[move] = (votes[move] || 0) + 1;
      voterIPs[socket.clientIP] = move;
      socket.emit('voteAccepted', { move, changed: false });
    }
    
    // Broadcast updated votes to all clients
    io.emit('votesUpdated', {
      votes: votes,
      totalVoters: Object.keys(voterIPs).length,
      activeVoters: activeVoters.size
    });
    
    console.log(`Vote for ${move} from IP ${socket.clientIP}, current count: ${votes[move]}`);
  });
});

// Add route to get vote history
app.get('/vote-history', (req, res) => {
  res.json({
    history: moveVoteHistory,
    currentVotes: votes,
    activeVoters: activeVoters.size,
    totalConnected: connectedUsers.size
  });
});
