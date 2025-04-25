/**
 * CrowdChess - Frontend JavaScript
 * Handles the user interface and WebSocket communication
 */

// Initialize global variables
let socket;
let board = null;
let game = new Chess();
let selectedMove = null;
let votingEndTime = null;
let timerInterval = null;
let hasVoted = false;
let yourVote = null;
let boardOrientation = 'white';
let isVotingPeriod = false;
let legalMovesMap = {};
let botColor = null;
let connectionAttempts = 0;
let lastGameState = null;
let isSpectatorMode = false;
let moveHistory = [];
let totalVotes = 0;

// Read settings from URL and session storage
function readUserSettings() {
  try {
    // Get URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    
    // Check for Lichess token in session storage
    const lichessToken = sessionStorage.getItem('lichessToken');
    if (lichessToken) {
      // Send token to server when connecting
      socket.auth = { token: lichessToken };
      console.log('Lichess token found and will be used for authentication');
    }
    
    // Set board orientation from URL or localStorage
    const orientationParam = urlParams.get('orientation');
    if (orientationParam && ['white', 'black'].includes(orientationParam)) {
      boardOrientation = orientationParam;
      console.log(`Board orientation set to: ${boardOrientation}`);
    } else {
      // Try to get from localStorage
      const savedSettings = localStorage.getItem('crowdChessSettings');
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        if (settings.boardOrientation && settings.boardOrientation !== 'auto') {
          boardOrientation = settings.boardOrientation;
          console.log(`Board orientation set from saved settings: ${boardOrientation}`);
        }
      }
    }
    
    // Update board if it's already initialized
    if (board) {
      board.orientation(boardOrientation);
    }
    
    // Send configuration to server
    sendConfigToServer(urlParams);
  } catch (error) {
    console.error('Error reading user settings:', error);
  }
}

/**
 * Send configuration to server based on URL parameters
 * @param {URLSearchParams} urlParams - URL parameters
 */
function sendConfigToServer(urlParams) {
  // Get configuration parameters
  const botParam = urlParams.get('bot');
  const challengerParam = urlParams.get('challenger');
  const votingTimeParam = urlParams.get('votingTime');
  
  // Check if any parameters need to be sent
  if (botParam || challengerParam || votingTimeParam) {
    // Build query parameters
    const configParams = new URLSearchParams();
    if (botParam) configParams.append('bot', botParam);
    if (challengerParam) configParams.append('challenger', challengerParam);
    if (votingTimeParam) configParams.append('voting_time', votingTimeParam);
    
    // Determine server URL (same as socket connection)
    const serverUrl = urlParams.get('server') || 
                      (localStorage.getItem('crowdChessSettings') ? 
                      JSON.parse(localStorage.getItem('crowdChessSettings')).serverUrl || 
                      window.location.origin : window.location.origin);
    
    // Send configuration to server
    fetch(`${serverUrl}/update-config?${configParams.toString()}`)
      .then(response => response.json())
      .then(data => {
        if (data.status === 'ok') {
          console.log('Server configuration updated:', data.updated);
          showNotification('Game configuration updated', 'success');
        } else {
          console.error('Failed to update server configuration:', data.message);
          showNotification(`Configuration error: ${data.message}`, 'error');
        }
      })
      .catch(error => {
        console.error('Error sending configuration to server:', error);
        showNotification(`Failed to update configuration: ${error.message}`, 'error');
      });
  }
}

// DOM Elements
const connectionStatus = document.getElementById('connection-status');
const statusIndicator = document.getElementById('status-indicator');
const gameStatusMessage = document.getElementById('game-status-message');
const timerDisplay = document.getElementById('timer');
const selectedMoveDisplay = document.getElementById('selected-move');
const voteListContainer = document.getElementById('vote-list');
const voteButton = document.getElementById('vote-button');
const notificationContainer = document.getElementById('notification-container');
const spectatorModeCheckbox = document.getElementById('spectator-mode');
const totalUsersElement = document.getElementById('total-users');
const activeVotersElement = document.getElementById('active-voters');
const crowdColorElement = document.getElementById('crowd-color');
const historyContentElement = document.getElementById('history-content');

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  initializeBoard();
  connectToServer();
  setupEventListeners();
  
  // Initialize crowd color display
  crowdColorElement.classList.add('waiting');
  crowdColorElement.textContent = 'waiting for game';
});

/**
 * Initialize the chess board
 */
function initializeBoard() {
  const config = {
    position: 'start',
    orientation: boardOrientation,
    pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
    draggable: true,
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: onSnapEnd,
    onMouseoutSquare: onMouseoutSquare,
    onMouseoverSquare: onMouseoverSquare
  };
  
  board = Chessboard('board', config);
  
  // Handle window resize
  window.addEventListener('resize', () => board.resize());
}

/**
 * Connect to the WebSocket server
 */
function connectToServer() {
  // Read user settings before initializing socket
  const urlParams = new URLSearchParams(window.location.search);
  const customServerUrl = urlParams.get('server') || localStorage.getItem('serverUrl');
  
  // Initialize Socket.IO connection
  const socketOptions = {
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  };
  
  // Use custom server URL if provided
  if (customServerUrl) {
    socket = io(customServerUrl, socketOptions);
    console.log(`Connecting to custom server: ${customServerUrl}`);
  } else {
    socket = io(socketOptions);
  }
  
  // Apply user settings
  readUserSettings();
  
  // Socket connection events
  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  socket.on('connect_error', handleConnectionError);
  socket.on('reconnect', handleReconnect);
  socket.on('reconnect_attempt', handleReconnectAttempt);
  
  // Game and voting events
  socket.on('noActiveGame', handleNoActiveGame);
  socket.on('gameState', handleGameState);
  socket.on('votingStarted', handleVotingStart);
  socket.on('votesUpdated', handleVotesUpdated);
  socket.on('voteAccepted', handleVoteAccepted);
  socket.on('voteRejected', handleVoteRejected);
  socket.on('moveSelected', handleMoveSelected);
  socket.on('gameConnected', handleGameConnected);
  socket.on('gameEnded', handleGameEnded);
  socket.on('challengeReceived', handleChallengeReceived);
  
  // New user interface events
  socket.on('userCount', handleUserCount);
  socket.on('spectatorModeSet', handleSpectatorModeSet);
}

/**
 * Set up UI event listeners
 */
function setupEventListeners() {
  voteButton.addEventListener('click', submitVote);
  
  // Listen for URL parameter changes
  window.addEventListener('popstate', () => {
    readUserSettings();
    // If board orientation changed, update it
    if (board && boardOrientation) {
      board.orientation(boardOrientation);
    }
  });
  
  // Spectator mode toggle
  spectatorModeCheckbox.addEventListener('change', function() {
    isSpectatorMode = this.checked;
    
    // Toggle spectator class on body
    if (isSpectatorMode) {
      document.body.classList.add('spectator-mode-active');
      showNotification('Spectator mode enabled - you can only watch the game', 'info');
    } else {
      document.body.classList.remove('spectator-mode-active');
      showNotification('Voter mode enabled - you can now vote on moves', 'info');
    }
    
    // Tell the server about the spectator mode change
    if (socket && socket.connected) {
      socket.emit('setSpectatorMode', isSpectatorMode);
    }
  });
}

/**
 * Handle socket connection
 */
function handleConnect() {
  updateConnectionStatus('connected', 'Connected to server');
  connectionAttempts = 0;
  
  // Check if there's an active game
  socket.emit('getGameStatus');
}

/**
 * Handle socket disconnection
 * @param {string} reason - Reason for disconnection
 */
function handleDisconnect(reason) {
  updateConnectionStatus('disconnected', `Disconnected: ${reason}`);
  clearInterval(timerInterval);
  showNotification(`Lost connection to server: ${reason}`, 'error');
}

/**
 * Handle connection error
 * @param {Object} error - Error object
 */
function handleConnectionError(error) {
  connectionAttempts++;
  updateConnectionStatus('disconnected', `Connection error (attempt ${connectionAttempts})`);
  showNotification(`Connection error: ${error.message}. Retrying...`, 'error');
}

/**
 * Handle successful reconnection
 * @param {number} attemptNumber - Number of attempts before successful reconnection
 */
function handleReconnect(attemptNumber) {
  updateConnectionStatus('connected', 'Reconnected to server');
  showNotification('Reconnected to server!', 'success');
  
  // Re-check game status after reconnection
  socket.emit('getGameStatus');
}

/**
 * Handle reconnection attempt
 * @param {number} attemptNumber - Current attempt number
 */
function handleReconnectAttempt(attemptNumber) {
  updateConnectionStatus('connecting', `Reconnecting (attempt ${attemptNumber})...`);
}

/**
 * Handle when there's no active game
 */
function handleNoActiveGame() {
  updateGameStatus('waiting', 'Waiting for a game');
  updateGameStatusMessage('No active game. Waiting for a challenge from thatsjustchips...');
}

/**
 * Handle game state update
 * @param {Object} state - Game state from server
 */
function handleGameState(state) {
  lastGameState = state;
  
  // Update bot color if available
  if (state.botColor && state.botColor !== botColor) {
    botColor = state.botColor;
    updateBoardOrientation(botColor);
    
    // Update the crowd color display
    crowdColorElement.classList.remove('waiting');
    crowdColorElement.classList.add(botColor);
    crowdColorElement.textContent = botColor;
  }
  
  if (state.fen) {
    try {
      // Load the new position
      game = new Chess(state.fen);
      board.position(state.fen);
      
      // Update game status
      if (state.inProgress) {
        updateGameStatus('active', 'Game in progress');
        
        // Update game status message based on whose turn it is
        if ((botColor === 'white' && state.turn === 'w') || 
            (botColor === 'black' && state.turn === 'b')) {
          updateGameStatusMessage('Your turn to vote!');
        } else {
          updateGameStatusMessage('Waiting for thatsjustchips to move...');
        }
      }
      
      // Create map of legal moves if provided
      if (state.legalMoves) {
        createLegalMovesMap(state.legalMoves);
      }
    } catch (e) {
      console.error('Error updating game state:', e);
      showNotification('Error updating game state: ' + e.message, 'error');
    }
  }
  
  // Update voting timer
  if (state.votingEndTime) {
    votingEndTime = state.votingEndTime;
    isVotingPeriod = true;
    updateTimer();
  } else {
    clearInterval(timerInterval);
    isVotingPeriod = false;
  }
  
  // Update game status for special states
  if (state.isGameOver) {
    updateGameStatus('ended', 'Game over');
    updateGameStatusMessage('Game over. The match has ended.');
    clearInterval(timerInterval);
    isVotingPeriod = false;
  } else if (state.isCheck) {
    if (state.isCheckmate) {
      updateGameStatus('ended', 'Checkmate');
      updateGameStatusMessage('Checkmate! Game over.');
      isVotingPeriod = false;
    } else {
      updateGameStatusMessage('Check!');
    }
  }
}

/**
 * Handle voting period start
 * @param {Object} data - Voting data
 */
function handleVotingStart(data) {
  console.log('Voting started:', data);
  isVotingPeriod = true;
  
  // Get end time
  if (data.endTime) {
    votingEndTime = new Date(data.endTime).getTime();
    
    // Start timer
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }
  
  // Update UI
  updateGameStatusMessage('Vote for the next move!');
  
  // If not in spectator mode, enable vote button
  if (!isSpectatorMode) {
    voteButton.disabled = !selectedMove;
  }
  
  // Update votes if provided
  if (data.votes) {
    handleVotesUpdated(data.votes);
  }
  
  showNotification('Voting has started! Cast your vote for the next move.', 'info');
}

/**
 * Handle votes updated
 * @param {Object} data - Votes data
 */
function handleVotesUpdated(data) {
  console.log('Votes updated:', data);
  
  // Calculate total votes
  totalVotes = Object.values(data.votes).reduce((sum, count) => sum + count, 0);
  
  // Update the vote list with percentage bars
  updateVoteList(data.votes, yourVote);
  
  // Update stats display
  if (data.totalVoters !== undefined) {
    activeVotersElement.textContent = data.activeVoters || 0;
  }
}

/**
 * Handle vote acceptance
 * @param {Object} data - Vote data
 */
function handleVoteAccepted(data) {
  console.log('Vote accepted:', data);
  hasVoted = true;
  yourVote = data.move;
  
  // Update UI
  updateSelectedMoveDisplay(formatMove(data.move), true);
  
  if (data.changed) {
    showNotification(`Vote changed from ${formatMove(data.previousVote)} to ${formatMove(data.move)}`, 'success');
  } else {
    showNotification(`Vote for ${formatMove(data.move)} accepted!`, 'success');
  }
  
  // Disable vote button until move changes
  voteButton.disabled = true;
}

/**
 * Handle vote rejection
 * @param {Object} data - Rejection data
 */
function handleVoteRejected(data) {
  showNotification(`Vote rejected: ${data.reason}`, 'error');
}

/**
 * Handle move selection
 * @param {Object} data - Selected move data
 */
function handleMoveSelected(data) {
  console.log('Move selected:', data);
  
  // Add to move history
  const historyEntry = {
    move: data.move,
    voteCount: data.voteCount,
    totalVotes: data.totalVotes,
    wasRandom: data.wasRandom || false,
    wasTiebreaker: data.wasRandomTiebreaker || false,
    timestamp: new Date().toISOString()
  };
  moveHistory.push(historyEntry);
  
  // Update history display
  updateMoveHistory();
  
  // Show notification
  if (data.wasRandom) {
    showNotification(`No votes received. Random move selected: ${formatMove(data.move)}`, 'warning');
  } else if (data.wasRandomTiebreaker) {
    showNotification(`Tie broken randomly! Selected move: ${formatMove(data.move)} with ${data.voteCount} votes`, 'info');
  } else {
    showNotification(`Move selected: ${formatMove(data.move)} with ${data.voteCount} votes (${Math.round(data.voteCount / data.totalVotes * 100)}%)`, 'success');
  }
  
  // Reset voting state
  isVotingPeriod = false;
  votingEndTime = null;
  clearInterval(timerInterval);
  hasVoted = false;
  yourVote = null;
  
  // Clear UI
  updateSelectedMoveDisplay('No move selected');
  voteButton.disabled = true;
}

/**
 * Handle game connection
 * @param {Object} data - Game connection data
 */
function handleGameConnected(data) {
  showNotification(`Connected to game ${data.gameId}`, 'success');
  updateGameStatusMessage('Game connected. Waiting for moves...');
}

/**
 * Handle game ended
 * @param {Object} data - Game end data
 */
function handleGameEnded(data) {
  clearInterval(timerInterval);
  votingEndTime = null;
  isVotingPeriod = false;
  updateGameStatus('ended', 'Game over');
  updateGameStatusMessage('Game over. The match has ended.');
  showNotification('Game has ended', 'info');
  
  // Reset UI elements
  voteButton.disabled = true;
  hasVoted = false;
  yourVote = null;
  selectedMoveDisplay.innerHTML = `<p>Game has ended.</p>`;
}

/**
 * Handle challenge received
 * @param {Object} challenge - Challenge data
 */
function handleChallengeReceived(challenge) {
  showNotification(`Received challenge from ${challenge.challenger.name}`, 'info');
  updateGameStatusMessage(`Received challenge from ${challenge.challenger.name}. Auto-accepting...`);
}

/**
 * Create a map of legal moves for easier use
 * @param {Array} legalMoves - Legal moves array
 */
function createLegalMovesMap(legalMoves) {
  legalMovesMap = {};
  
  legalMoves.forEach(move => {
    const from = move.uci.substring(0, 2);
    if (!legalMovesMap[from]) {
      legalMovesMap[from] = [];
    }
    legalMovesMap[from].push(move.uci.substring(2, 4));
  });
}

/**
 * Handle start of piece drag
 * @param {string} source - Source square
 * @param {string} piece - Piece type
 * @param {Object} position - Current position
 * @param {string} orientation - Board orientation
 * @returns {boolean} - Whether drag is allowed
 */
function onDragStart(source, piece, position, orientation) {
  // Do not allow drag if not in voting period
  if (!isVotingPeriod) return false;
  
  // Only allow dragging our color pieces
  if ((botColor === 'white' && piece.search(/^b/) !== -1) ||
      (botColor === 'black' && piece.search(/^w/) !== -1)) {
    return false;
  }
  
  // Only allow squares that have legal moves
  return !!legalMovesMap[source];
}

/**
 * Handle piece drop
 * @param {string} source - Source square
 * @param {string} target - Target square
 * @returns {string} - 'snapback' to cancel move, or nothing to allow
 */
function onDrop(source, target) {
  // Check if the target is a legal destination for this piece
  if (!legalMovesMap[source] || !legalMovesMap[source].includes(target)) {
    return 'snapback';
  }
  
  // Store the selected move
  selectedMove = source + target;
  
  // Check if we need to handle promotion
  const movingPiece = game.get(source);
  if (movingPiece && movingPiece.type === 'p' &&
      ((target[1] === '8' && movingPiece.color === 'w') || 
       (target[1] === '1' && movingPiece.color === 'b'))) {
    selectedMove += 'q'; // Default to queen promotion
  }
  
  // Update selected move display
  updateSelectedMoveDisplay(selectedMove);
  
  // Enable vote button
  voteButton.disabled = false;
  
  return null;
}

/**
 * Handle snap end (after animation completes)
 */
function onSnapEnd() {
  // Reset board position to match game state
  board.position(game.fen());
}

/**
 * Handle mouse hover over a square
 * @param {string} square - Square being hovered
 * @param {Object} piece - Piece on the square
 */
function onMouseoverSquare(square, piece) {
  // Return if not in voting period or no piece
  if (!isVotingPeriod || !piece) return;
  
  // Check if it's our color's piece
  const isPieceOurColor = (botColor === 'white' && piece.charAt(0) === 'w') ||
                         (botColor === 'black' && piece.charAt(0) === 'b');
  
  if (!isPieceOurColor) return;
  
  // Highlight the square
  highlightSquare(square);
  
  // Highlight legal moves
  if (legalMovesMap[square]) {
    legalMovesMap[square].forEach(targetSquare => {
      highlightLegalMove(targetSquare);
    });
  }
}

/**
 * Handle mouse leaving a square
 */
function onMouseoutSquare() {
  // Remove all highlights
  removeHighlights();
}

/**
 * Update the board orientation based on bot color
 * @param {string} color - Bot color ('white' or 'black')
 */
function updateBoardOrientation(color) {
  if (color === boardOrientation) return;
  
  boardOrientation = color;
  board.orientation(color);
}

/**
 * Format a move for display
 * @param {string} moveUci - Move in UCI format
 * @returns {string} - Formatted move
 */
function formatMove(moveUci) {
  if (!moveUci || moveUci.length < 4) return moveUci;
  
  const from = moveUci.substring(0, 2);
  const to = moveUci.substring(2, 4);
  let moveText = `${from.toUpperCase()} → ${to.toUpperCase()}`;
  
  try {
    const piece = game.get(from);
    if (piece) {
      const pieceNames = {
        p: 'Pawn',
        n: 'Knight',
        b: 'Bishop',
        r: 'Rook',
        q: 'Queen',
        k: 'King'
      };
      
      moveText = `${pieceNames[piece.type]} ${moveText}`;
    }
  } catch (e) {
    console.error('Error formatting move:', e);
  }
  
  return moveText;
}

/**
 * Update the vote list display
 * @param {Object} votes - Votes object
 * @param {string} highlightMove - Move to highlight as user's vote
 */
function updateVoteList(votes, highlightMove = null) {
  // Clear current vote list
  voteListContainer.innerHTML = '';
  
  if (!votes || Object.keys(votes).length === 0) {
    voteListContainer.innerHTML = '<div class="no-votes">No votes yet</div>';
    return;
  }
  
  // Find highest vote count to determine winning move
  const voteEntries = Object.entries(votes);
  const maxVotes = Math.max(...voteEntries.map(([_, count]) => count));
  
  // Sort moves by vote count (descending)
  voteEntries.sort((a, b) => b[1] - a[1]);
  
  voteEntries.forEach(([move, count]) => {
    const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const isWinning = count === maxVotes;
    const isYourVote = move === highlightMove;
    
    const voteItem = document.createElement('div');
    voteItem.className = 'vote-item';
    if (isWinning) voteItem.classList.add('winning');
    if (isYourVote) voteItem.classList.add('your-vote');
    
    voteItem.innerHTML = `
      <span class="vote-item-move">${formatMove(move)}</span>
      <div class="vote-item-count">
        <div class="vote-bar-container">
          <div class="vote-bar" style="width: ${percentage}%"></div>
        </div>
        <span class="vote-percentage">${percentage}%</span>
        <span class="vote-number">${count}</span>
      </div>
    `;
    
    // Add click event to select this move
    voteItem.addEventListener('click', () => {
      if (!isSpectatorMode && isVotingPeriod) {
        selectedMove = move;
        updateSelectedMoveDisplay(formatMove(move));
        voteButton.disabled = false;
      }
    });
    
    voteListContainer.appendChild(voteItem);
  });
}

/**
 * Update the timer display
 */
function updateTimer() {
  if (!votingEndTime) {
    timerDisplay.textContent = '00:00';
    return;
  }
  
  const now = Date.now();
  const timeLeft = Math.max(0, votingEndTime - now);
  
  if (timeLeft <= 0) {
    clearInterval(timerInterval);
    timerDisplay.textContent = '00:00';
    return;
  }
  
  // Calculate minutes and seconds
  const minutes = Math.floor(timeLeft / 60000);
  const seconds = Math.floor((timeLeft % 60000) / 1000);
  
  // Display timer
  timerDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  
  // Add urgency class when less than 10 seconds
  if (timeLeft < 10000) {
    timerDisplay.classList.add('urgent');
  } else {
    timerDisplay.classList.remove('urgent');
  }
}

/**
 * Update game status display
 * @param {string} status - Status code
 * @param {string} message - Status message
 */
function updateGameStatus(status, message) {
  statusIndicator.className = 'status-indicator';
  statusIndicator.classList.add(`status-${status}`);
  statusIndicator.textContent = `Game Status: ${message}`;
}

/**
 * Update connection status display
 * @param {string} status - Status code
 * @param {string} message - Status message
 */
function updateConnectionStatus(status, message) {
  connectionStatus.className = 'connection-status';
  connectionStatus.classList.add(status);
  connectionStatus.textContent = message;
}

/**
 * Update game status message
 * @param {string} message - Status message
 */
function updateGameStatusMessage(message) {
  gameStatusMessage.innerHTML = `<p>${message}</p>`;
}

/**
 * Update selected move display
 * @param {string} move - Selected move
 * @param {boolean} confirmed - Whether the move is confirmed
 */
function updateSelectedMoveDisplay(move, confirmed = false) {
  if (!move) {
    selectedMoveDisplay.innerHTML = `<p>No move selected</p>`;
    selectedMoveDisplay.classList.remove('active');
    return;
  }
  
  const formattedMove = formatMove(move);
  
  if (confirmed) {
    selectedMoveDisplay.innerHTML = `<p>Your vote: ${formattedMove}</p>`;
  } else {
    selectedMoveDisplay.innerHTML = `<p>Selected: ${formattedMove}</p>`;
  }
  
  selectedMoveDisplay.classList.add('active');
}

/**
 * Submit vote
 */
function submitVote() {
  if (!selectedMove || !isVotingPeriod || isSpectatorMode) {
    return;
  }
  
  socket.emit('submitVote', { move: selectedMove });
}

/**
 * Highlight a square
 * @param {string} square - Square to highlight
 */
function highlightSquare(square) {
  const squareEl = document.querySelector(`.square-${square}`);
  if (squareEl) {
    squareEl.classList.add('highlight-square');
  }
}

/**
 * Highlight a legal move
 * @param {string} square - Square to highlight
 */
function highlightLegalMove(square) {
  const squareEl = document.querySelector(`.square-${square}`);
  if (squareEl) {
    squareEl.classList.add('highlight-legal');
  }
}

/**
 * Remove all highlights
 */
function removeHighlights() {
  document.querySelectorAll('.highlight-square, .highlight-legal').forEach(el => {
    el.classList.remove('highlight-square', 'highlight-legal');
  });
}

/**
 * Show a notification
 * @param {string} message - Notification message
 * @param {string} type - Notification type ('error', 'success', 'info')
 */
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  
  notificationContainer.appendChild(notification);
  
  // Remove after a delay
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }, 5000);
}

/**
 * Handle user count updates
 * @param {Object} data - User count data
 */
function handleUserCount(data) {
  console.log('User count updated:', data);
  
  // Update UI
  totalUsersElement.textContent = data.total || 0;
  activeVotersElement.textContent = data.activeVoters || 0;
}

/**
 * Handle spectator mode confirmation
 * @param {boolean} isSpectator - Whether spectator mode is enabled
 */
function handleSpectatorModeSet(isSpectator) {
  console.log('Spectator mode set:', isSpectator);
  // Update checkbox to match server state
  spectatorModeCheckbox.checked = isSpectator;
  
  // Apply spectator mode styling
  if (isSpectator) {
    document.body.classList.add('spectator-mode-active');
  } else {
    document.body.classList.remove('spectator-mode-active');
  }
}

/**
 * Update the move history display
 */
function updateMoveHistory() {
  if (moveHistory.length === 0) {
    historyContentElement.innerHTML = '<p>No moves yet</p>';
    return;
  }
  
  // Create HTML for history
  let historyHTML = '';
  
  // Display only the last 5 moves, most recent first
  const recentMoves = [...moveHistory].reverse().slice(0, 5);
  
  recentMoves.forEach((entry) => {
    let moveText = formatMove(entry.move);
    let percentage = entry.totalVotes > 0 ? Math.round((entry.voteCount / entry.totalVotes) * 100) : 0;
    
    let specialText = '';
    if (entry.wasRandom) {
      specialText = ' <span class="history-random">(random)</span>';
    } else if (entry.wasTiebreaker) {
      specialText = ' <span class="history-tiebreaker">(tiebreaker)</span>';
    }
    
    historyHTML += `
      <div class="history-item">
        <div class="history-move">${moveText}${specialText}</div>
        <div class="history-vote-info">
          <span>${entry.voteCount} vote${entry.voteCount !== 1 ? 's' : ''}</span>
          <span>${percentage}% of total</span>
        </div>
      </div>
    `;
  });
  
  historyContentElement.innerHTML = historyHTML;
}
