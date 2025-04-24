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

// Game and voting state
let currentGameId = null;
let currentFen = null;
let currentChess = new Chess(); // Initialize chess.js
let legalMoves = [];
let votes = {};
let voterIPs = {}; // Track IPs that have voted
let votingEndTime = null;
const VOTING_DURATION = 90000; // 1 minute 30 seconds in milliseconds
let gameInProgress = false;
let challengeCreatedTime = null;

// Connect to a Lichess game
async function connectToLichessGame(gameId) {
  try {
    console.log(`Attempting to connect to game: ${gameId}`);
    currentGameId = gameId;
    votes = {};
    voterIPs = {};
    
    // Stream game state from Lichess
    const response = await axios({
      method: 'get',
      url: `${LICHESS_API_BASE}/board/game/stream/${gameId}`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      responseType: 'stream'
    });

    gameInProgress = true;

    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          handleGameUpdate(data);
        } catch (e) {
          console.error('Error parsing game data:', e);
        }
      }
    });

    response.data.on('end', () => {
      console.log(`Game stream ended for game: ${gameId}`);
      gameInProgress = false;
      io.emit('gameEnded', { gameId });
    });

    console.log(`Connected to Lichess game: ${gameId}`);
    return true;
  } catch (error) {
    console.error('Error connecting to Lichess game:', error.message);
    return false;
  }
}

// Process game updates from Lichess
function handleGameUpdate(data) {
  console.log('Received game update:', JSON.stringify(data).substring(0, 200) + '...');
  
  // Handle different types of game state data
  if (data.type === 'gameFull') {
    // Full game data received
    currentFen = data.initialFen === 'startpos' ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : data.initialFen;
    currentChess.load(currentFen);
    
    // Apply moves if any
    if (data.state && data.state.moves) {
      applyMoves(data.state.moves);
    }
    
    updateLegalMoves();
    
    // Start voting if it's our turn
    const isOurTurn = (data.white.id.toLowerCase() === 'mrsunchips' && currentChess.turn() === 'w') || 
                      (data.black.id.toLowerCase() === 'mrsunchips' && currentChess.turn() === 'b');
    
    if (isOurTurn && !votingEndTime) {
      startVotingPeriod();
    }
    
    broadcastGameState();
  } else if (data.type === 'gameState') {
    // Game state update received
    if (data.moves) {
      // Reset the chess instance and replay all moves
      currentChess = new Chess();
      applyMoves(data.moves);
      
      // Check if it's our turn
      const lastMove = data.moves.trim().split(' ').pop();
      console.log('Last move:', lastMove, 'Current turn:', currentChess.turn());
      
      // If a move was just made and it's our turn now, start voting
      if (lastMove && ((currentChess.turn() === 'w' && data.wdraw === false) || (currentChess.turn() === 'b' && data.bdraw === false))) {
        // Clear existing voting if in progress
        clearTimeout(votingTimeoutId);
        
        // Start new voting period
        votes = {};
        voterIPs = {};
        updateLegalMoves();
        startVotingPeriod();
      }
    }
    
    broadcastGameState();
  }
}

// Apply a series of moves to the chess instance
function applyMoves(movesString) {
  const moves = movesString.trim().split(' ').filter(m => m);
  currentChess = new Chess();
  
  for (const move of moves) {
    try {
      // Convert from UCI format (e2e4) to chess.js format ({ from: 'e2', to: 'e4' })
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move.substring(4, 5) : undefined;
      
      currentChess.move({ from, to, promotion });
    } catch (e) {
      console.error('Error applying move:', move, e.message);
    }
  }
  
  // Update FEN
  currentFen = currentChess.fen();
  updateLegalMoves();
}

// Update legal moves based on current position
function updateLegalMoves() {
  const moves = currentChess.moves({ verbose: true });
  legalMoves = moves.map(move => {
    // Convert chess.js move format to UCI format
    let uci = move.from + move.to;
    if (move.promotion) {
      uci += move.promotion;
    }
    return uci;
  });
  
  console.log('Legal moves updated:', legalMoves);
}

// Variable to store the voting timeout ID
let votingTimeoutId;

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
    legalMoves: legalMoves
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
    
    try {
      await makeMove(winningMove);
      // Voting period will be restarted when new game state is received
    } catch (error) {
      console.error('Error making move:', error);
      // If move fails, restart voting
      startVotingPeriod();
    }
  } else {
    console.log('No valid votes received, restarting voting period');
    // No votes or winning move not legal, restart voting
    startVotingPeriod();
  }
}

// Make a move on Lichess
async function makeMove(move) {
  try {
    console.log(`Attempting to make move ${move} on game ${currentGameId}`);
    
    const response = await axios({
      method: 'post',
      url: `${LICHESS_API_BASE}/board/game/${currentGameId}/move/${move}`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
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
  io.emit('gameState', {
    gameId: currentGameId,
    fen: currentFen,
    turn: currentChess.turn(),
    legalMoves: legalMoves,
    votes: votes,
    votingEndTime: votingEndTime,
    isGameOver: currentChess.isGameOver(),
    isCheck: currentChess.isCheck(),
    isCheckmate: currentChess.isCheckmate()
  });
}

// Create a challenge to Lichess AI
async function createAIChallenge(level = 1) {
  try {
    // Prevent creating multiple challenges in quick succession
    const now = Date.now();
    if (challengeCreatedTime && now - challengeCreatedTime < 10000) {
      console.log('Challenge creation rate limited');
      return { success: false, message: 'Please wait before creating another challenge' };
    }

    challengeCreatedTime = now;
    
    console.log(`Creating challenge to Lichess AI level ${level}`);
    
    const response = await axios({
      method: 'post',
      url: `${LICHESS_API_BASE}/challenge/ai`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: `level=${level}&clock.limit=900&clock.increment=10`
    });
    
    console.log('Challenge created:', response.data);
    
    if (response.data && response.data.game && response.data.game.id) {
      // Connect to the new game
      await connectToLichessGame(response.data.game.id);
      return { success: true, gameId: response.data.game.id };
    } else {
      return { success: false, message: 'Failed to create game' };
    }
  } catch (error) {
    console.error('Error creating AI challenge:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return { success: false, message: error.message };
  }
}

// Create an open challenge for anyone to accept
async function createOpenChallenge() {
  try {
    // Prevent creating multiple challenges in quick succession
    const now = Date.now();
    if (challengeCreatedTime && now - challengeCreatedTime < 10000) {
      console.log('Challenge creation rate limited');
      return { success: false, message: 'Please wait before creating another challenge' };
    }

    challengeCreatedTime = now;
    
    console.log('Creating open challenge');
    
    const response = await axios({
      method: 'post',
      url: `${LICHESS_API_BASE}/challenge/open`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: 'clock.limit=900&clock.increment=10'
    });
    
    console.log('Open challenge created:', response.data);
    
    if (response.data && response.data.challenge && response.data.challenge.id) {
      // Return the challenge URL
      return { 
        success: true, 
        challengeId: response.data.challenge.id,
        url: response.data.challenge.url
      };
    } else {
      return { success: false, message: 'Failed to create challenge' };
    }
  } catch (error) {
    console.error('Error creating open challenge:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return { success: false, message: error.message };
  }
}

// Listen for incoming events from Lichess
async function streamEvents() {
  try {
    console.log('Starting to stream events from Lichess');
    
    const response = await axios({
      method: 'get',
      url: `${LICHESS_API_BASE}/stream/event`,
      headers: {
        'Authorization': `Bearer ${LICHESS_API_TOKEN}`
      },
      responseType: 'stream'
    });

    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          handleLichessEvent(event);
        } catch (e) {
          console.error('Error parsing event data:', e);
        }
      }
    });

    console.log('Event stream connected');
  } catch (error) {
    console.error('Error connecting to event stream:', error.message);
    // Try to reconnect after a delay
    setTimeout(streamEvents, 10000);
  }
}

// Handle events from Lichess
function handleLichessEvent(event) {
  console.log('Received Lichess event:', JSON.stringify(event).substring(0, 200) + '...');
  
  if (event.type === 'gameStart') {
    // A game has started, connect to it
    connectToLichessGame(event.game.id);
  } else if (event.type === 'gameFinish') {
    // A game has finished
    console.log(`Game ${event.game.id} has finished`);
    gameInProgress = false;
    io.emit('gameEnded', { gameId: event.game.id });
  } else if (event.type === 'challenge') {
    // Someone challenged us or we created a challenge
    console.log(`Challenge ${event.challenge.id} received/created`);
    io.emit('challengeReceived', event.challenge);
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
      }
    });
    
    console.log('Challenge accepted:', response.data);
    return { success: true };
  } catch (error) {
    console.error('Error accepting challenge:', error.message);
    return { success: false, message: error.message };
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Store client IP for vote tracking
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  socket.clientIP = clientIP;
  
  // Send current game state to new client
  if (currentGameId && currentFen) {
    socket.emit('gameState', {
      gameId: currentGameId,
      fen: currentFen,
      turn: currentChess.turn(),
      legalMoves: legalMoves,
      votes: votes,
      votingEndTime: votingEndTime,
      isGameOver: currentChess.isGameOver(),
      isCheck: currentChess.isCheck(),
      isCheckmate: currentChess.isCheckmate()
    });
  }
  
  // Handle vote submission
  socket.on('submitVote', (move) => {
    if (!votingEndTime || Date.now() >= votingEndTime) {
      socket.emit('voteRejected', { reason: 'Voting period has ended' });
      return;
    }
    
    if (!legalMoves.includes(move)) {
      socket.emit('voteRejected', { reason: 'Invalid move' });
      return;
    }
    
    if (voterIPs[socket.clientIP]) {
      socket.emit('voteRejected', { reason: 'You have already voted for this move' });
      return;
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
  
  // Handle game connection request
  socket.on('connectToGame', async (gameId) => {
    const success = await connectToLichessGame(gameId);
    socket.emit('gameConnectionResult', { success, gameId });
  });
  
  // Handle AI challenge request
  socket.on('createAIChallenge', async (level) => {
    const result = await createAIChallenge(parseInt(level) || 1);
    socket.emit('challengeResult', result);
  });
  
  // Handle open challenge request
  socket.on('createOpenChallenge', async () => {
    const result = await createOpenChallenge();
    socket.emit('openChallengeResult', result);
    // Broadcast to all clients
    if (result.success) {
      io.emit('openChallengeCreated', result);
    }
  });
  
  // Handle challenge acceptance
  socket.on('acceptChallenge', async (challengeId) => {
    const result = await acceptChallenge(challengeId);
    socket.emit('acceptChallengeResult', result);
  });
  
  // Handle game status request
  socket.on('getGameStatus', () => {
    socket.emit('gameStatus', {
      inProgress: gameInProgress,
      gameId: currentGameId,
      fen: currentFen
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // If the client had voted, we could optionally remove their vote
    // However, for this application we'll let votes persist
  });
});

// Start streaming events from Lichess
streamEvents();

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
