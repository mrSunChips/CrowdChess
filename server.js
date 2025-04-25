// Import required libraries
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const { Chess } = require('chess.js');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Set up Socket.IO for WebSockets
const io = new Server(server, {
  cors: {
    origin: "*", // In production, you may want to restrict this
    methods: ["GET", "POST"]
  }
});

// Lichess API configuration
const LICHESS_API_TOKEN = process.env.LICHESS_API_TOKEN;
const LICHESS_API_BASE = 'https://lichess.org/api';

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

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    gameInProgress,
    currentGameId,
    currentFen,
    botColor,
    colorDetermined,
    legalMoves: legalMoves.length,
    votes: Object.keys(votes).length,
    lastEventTime,
    streamReconnectAttempts
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
    io.emit('gameConnected', { gameId });

    // Handle data streaming
    response.data.on('data', (chunk) => {
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
    }
    
    gameInProgress = false;
    io.emit('gameError', { error: error.message });
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
  // Reset the voting end time to indicate voting is over
  votingEndTime = null;
  
  // Find the move(s) with the most votes
  let maxVotes = 0;
  let topMoves = [];
  
  for (const [move, voteCount] of Object.entries(votes)) {
    if (voteCount > maxVotes) {
      maxVotes = voteCount;
      topMoves = [move];
    } else if (voteCount === maxVotes) {
      topMoves.push(move);
    }
  }
  
  console.log('Vote counting complete. Top moves:', topMoves, 'with', maxVotes, 'votes each');
  
  // If we have winning moves, randomly select one and execute it
  if (topMoves.length > 0 && maxVotes > 0) {
    // Randomly select one of the top moves to break ties
    const winningMove = topMoves[Math.floor(Math.random() * topMoves.length)];
    io.emit('moveSelected', { move: winningMove, votes: votes[winningMove] });
    
    try {
      await makeMove(winningMove);
      // Voting period will be restarted when new game state is received
    } catch (error) {
      console.error('Error making move:', error);
      // If move fails, restart voting
      startVotingPeriod();
    }
  } else {
    console.log('No valid votes received or no legal moves');
    
    // If there are legal moves but no votes, just pick a random legal move
    if (legalMoves.length > 0) {
      // Filter for moves that belong to the bot's color
      const botColorMoves = legalMoves.filter(move => {
        const from = move.uci.substring(0, 2);
        const piece = currentChess.get(from);
        return piece && ((botColor === 'white' && piece.color === 'w') || 
                         (botColor === 'black' && piece.color === 'b'));
      });
      
      if (botColorMoves.length > 0) {
        const randomMove = botColorMoves[Math.floor(Math.random() * botColorMoves.length)].uci;
        console.log(`Selecting random ${botColor} move:`, randomMove);
        io.emit('moveSelected', { move: randomMove, votes: 0, random: true });
        
        try {
          await makeMove(randomMove);
        } catch (error) {
          console.error('Error making random move:', error);
          startVotingPeriod();
        }
      } else {
        console.log(`No legal moves found for ${botColor} pieces`);
        gameInProgress = false;
        io.emit('gameEnded', { gameId: currentGameId, reason: 'No legal moves' });
      }
    } else {
      // No legal moves, game is probably over
      console.log('No legal moves available, game may be over');
      gameInProgress = false;
      io.emit('gameEnded', { gameId: currentGameId, reason: 'No legal moves' });
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
  
  console.log('Broadcasting game state - FEN:', currentFen, 'Turn:', currentChess.turn(), 'Bot color:', botColor);
  io.emit('gameState', payload);
}

// Listen for incoming events from Lichess
async function streamEvents() {
  try {
    console.log('Starting to stream events from Lichess');
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

    response.data.on('data', (chunk) => {
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
    });

    response.data.on('end', () => {
      console.log('Event stream ended');
      // Try to reconnect after a delay
      setTimeout(streamEvents, 5000);
    });

    response.data.on('error', (error) => {
      console.error('Event stream error:', error.message);
      // Try to reconnect after a delay
      setTimeout(streamEvents, 5000);
    });

    console.log('Event stream connected');
  } catch (error) {
    console.error('Error connecting to event stream:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
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

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Store client IP for vote tracking
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  socket.clientIP = clientIP;
  
  // Send current game state to new client
  if (gameInProgress && currentGameId && currentFen) {
    socket.emit('gameState', {
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
    });
    
    // If voting is in progress, inform the client
    if (votingEndTime) {
      socket.emit('votingStarted', {
        endTime: votingEndTime,
        legalMoves: legalMoves,
        botColor: botColor
      });
    }
  } else {
    socket.emit('noActiveGame');
  }
  
  // Handle vote submission
  socket.on('submitVote', (move) => {
    console.log('Vote received:', move, 'from IP:', socket.clientIP);
    
    if (!votingEndTime || Date.now() >= votingEndTime) {
      socket.emit('voteRejected', { reason: 'Voting period has ended' });
      return;
    }
    
    // Validate that the move is legal
    const isLegal = legalMoves.some(m => m.uci === move);
    if (!isLegal) {
      socket.emit('voteRejected', { reason: 'Invalid move' });
      return;
    }
    
    // Check if this IP has already voted
    if (voterIPs[socket.clientIP]) {
      // Allow changing vote
      const oldMove = voterIPs[socket.clientIP];
      if (oldMove !== move) {
        // Remove old vote
        votes[oldMove]--;
        if (votes[oldMove] <= 0) {
          delete votes[oldMove];
        }
      } else {
        // Same vote again, reject
        socket.emit('voteRejected', { reason: 'You have already voted for this move' });
        return;
      }
    }
    
    // Record vote and IP
    votes[move] = (votes[move] || 0) + 1;
    voterIPs[socket.clientIP] = move;
    
    // Confirm vote to the client
    socket.emit('voteAccepted', { move });
    
    // Broadcast updated votes to all clients
    io.emit('votesUpdated', votes);
    
    console.log(`Vote for ${move} from IP ${socket.clientIP}, current count: ${votes[move]}`);
  });
  
  // Handle game status request
  socket.on('getGameStatus', () => {
    if (gameInProgress && currentGameId) {
      socket.emit('gameStatus', {
        inProgress: gameInProgress,
        gameId: currentGameId,
        fen: currentFen,
        turn: currentChess.turn(),
        botColor: botColor
      });
    } else {
      socket.emit('noActiveGame');
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start streaming events from Lichess
streamEvents();

// Start health check interval
setInterval(healthCheck, 60000); // Check every minute

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
