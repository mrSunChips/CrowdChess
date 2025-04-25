// Initialize socket.io connection
const socket = io();

// Chess board configuration and game state
let board = null;
let game = new Chess();
let selectedPiece = null;
let selectedMove = null;
let votingEndTime = null;
let timerInterval = null;
let hasVoted = false;
let yourVote = null;
let boardOrientation = 'white';
let isVotingPeriod = false;
let legalMovesMap = {};
let botColor = null;

// DOM Elements
const connectionStatus = document.getElementById('connection-status');
const gameStatus = document.getElementById('game-status');
const statusIndicator = document.getElementById('status-indicator');
const currentTurn = document.getElementById('current-turn');
const timerDisplay = document.getElementById('timer');
const selectedMoveDisplay = document.getElementById('selected-move');
const voteListContainer = document.getElementById('vote-list');
const voteButton = document.getElementById('vote-button');
const gameStatusMessage = document.getElementById('game-status-message');

// Initialize the chess board
function initializeBoard() {
    // Board configuration
    const config = {
        draggable: false, // We'll handle our own piece selection
        position: 'start',
        pieceTheme: 'https://lichess1.org/assets/piece/cburnett/{piece}.svg',
        orientation: boardOrientation
    };
    
    // Initialize the chess board
    board = Chessboard('board', config);
    
    // Add click event listeners for squares
    setupBoardClickHandlers();
    
    // Adjust board size on window resize
    window.addEventListener('resize', board.resize);
}

// Set up click handlers for the chess board
function setupBoardClickHandlers() {
    // Select all squares on the board
    const squares = document.querySelectorAll('.square-55d63');
    
    // Add click event listeners to each square
    squares.forEach(square => {
        square.addEventListener('click', (event) => {
            // Only enable clicks during voting period
            if (!isVotingPeriod) return;
            
            // Get the square name (e.g., "e4")
            const squareName = square.getAttribute('data-square');
            handleSquareClick(squareName);
        });
    });
}

// Handle a click on a chess square
function handleSquareClick(square) {
    console.log('Square clicked:', square);
    
    // If a piece is already selected, try to move it
    if (selectedPiece) {
        tryMove(selectedPiece, square);
    } else {
        // Otherwise, try to select a piece
        selectPiece(square);
    }
}

// Try to select a piece
function selectPiece(square) {
    // Get the piece at the clicked square
    const piece = game.get(square);
    
    // Only select pieces of the correct color (botColor)
    if (piece && ((botColor === 'white' && piece.color === 'w') || 
                 (botColor === 'black' && piece.color === 'b'))) {
        selectedPiece = square;
        
        // Highlight the selected square
        highlightSquare(square, 'highlight-square');
        
        // Highlight legal moves for this piece
        highlightLegalMoves(square);
        
        // Update selected move display
        selectedMoveDisplay.innerHTML = `<p>Selected: ${getPieceName(piece)} at ${square.toUpperCase()}. Click on a destination square.</p>`;
        selectedMoveDisplay.classList.add('active');
    } else {
        showNotification('You can only move the bot\'s pieces', true);
    }
}

// Try to move a piece
function tryMove(from, to) {
    // Check if the move is legal
    const moveUci = from + to;
    const isLegal = legalMovesMap[moveUci];
    
    // Clear current highlights
    clearHighlights();
    
    if (isLegal) {
        // Set the selected move
        selectedMove = moveUci;
        
        // Update the display
        const piece = game.get(from);
        selectedMoveDisplay.innerHTML = `<p>Ready to vote: ${getPieceName(piece)} ${from.toUpperCase()} → ${to.toUpperCase()}</p>`;
        
        // Enable vote button
        voteButton.disabled = false;
    } else {
        // Reset selection
        selectedPiece = null;
        selectedMove = null;
        selectedMoveDisplay.innerHTML = `<p>Invalid move. Click on a piece to select it.</p>`;
        selectedMoveDisplay.classList.remove('active');
    }
}

// Get the name of a chess piece
function getPieceName(piece) {
    if (!piece) return '';
    
    const pieceNames = {
        'p': 'Pawn',
        'n': 'Knight',
        'b': 'Bishop',
        'r': 'Rook',
        'q': 'Queen',
        'k': 'King'
    };
    
    return pieceNames[piece.type] || 'Piece';
}

// Highlight a square with a specific class
function highlightSquare(square, className) {
    const highlightClass = className || 'highlight-square';
    $(`#board .square-${square}`).addClass(highlightClass);
}

// Highlight legal moves for a selected piece
function highlightLegalMoves(square) {
    // Find all legal moves for this piece
    for (const [moveUci, move] of Object.entries(legalMovesMap)) {
        if (moveUci.substring(0, 2) === square) {
            // This is a legal move for the selected piece
            const targetSquare = moveUci.substring(2, 4);
            highlightSquare(targetSquare, 'highlight-legal');
        }
    }
}

// Clear all highlights from the board
function clearHighlights() {
    $('.square-55d63').removeClass('highlight-square highlight-legal');
    selectedPiece = null;
}

// Create map of legal moves
function createLegalMovesMap(legalMoves) {
    legalMovesMap = {};
    
    for (const move of legalMoves) {
        legalMovesMap[move.uci] = move.move;
    }
    
    console.log('Legal moves map created:', legalMovesMap);
}

// Update board orientation based on bot color
function updateBoardOrientation(color) {
  if (!board || !color) return;
  
  // Set the board orientation to see the board from the bot's perspective
  // This means the bot's pieces will be at the bottom
  boardOrientation = color;
  
  // Update the board orientation
  board.orientation(boardOrientation);
  
  // Re-attach click handlers since the board was redrawn
  setTimeout(setupBoardClickHandlers, 100);
  
  console.log('Board orientation updated to:', boardOrientation);
}

// Socket event handlers
socket.on('connect', () => {
    connectionStatus.className = 'connection-status connected';
    connectionStatus.textContent = 'Connected to server';
    
    // Check if there's an active game
    socket.emit('getGameStatus');
});

socket.on('disconnect', () => {
    connectionStatus.className = 'connection-status disconnected';
    connectionStatus.textContent = 'Disconnected from server';
    clearInterval(timerInterval);
    showNotification('Lost connection to server', true);
});

// Game state update
socket.on('gameState', (state) => {
  console.log('Game state update received:', state);
  
  // Update bot color if available
  if (state.botColor && state.botColor !== botColor) {
    botColor = state.botColor;
    updateBoardOrientation(botColor);
  }
  
  if (state.fen) {
    try {
      // Load the new position
      game = new Chess(state.fen);
      board.position(state.fen, false); // false = don't animate for smoother updates
      
      // Update current turn
      const turn = state.turn === 'w' ? 'White' : 'Black';
      currentTurn.textContent = turn;
      
      // Update game status
      if (state.inProgress) {
        updateGameStatus('active', 'Game in progress');
        updateGameStatusMessage(`Game in progress. ${botColor === state.turn ? 'Your turn to vote!' : 'Waiting for opponent move...'}`);
      }
      
      // Create map of legal moves if provided
      if (state.legalMoves) {
        createLegalMovesMap(state.legalMoves);
      }
    } catch (e) {
      console.error('Error updating game state:', e);
      showNotification('Error updating game state', true);
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
  
  // Update game status
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
});

// Voting period start
socket.on('votingStarted', (data) => {
    console.log('Voting period started:', data);
    
    // Update bot color if available
    if (data.botColor && data.botColor !== botColor) {
        botColor = data.botColor;
        updateBoardOrientation(botColor);
    }
    
    startVotingPeriod(data);
});

// Vote updates
socket.on('votesUpdated', (votes) => {
    console.log('Votes updated:', votes);
    updateVoteList(votes);
});

// Vote acceptance/rejection
socket.on('voteAccepted', (data) => {
    hasVoted = true;
    yourVote = data.move;
    voteButton.disabled = true;
    voteButton.textContent = 'Vote Submitted!';
    showNotification('Your vote has been recorded!');
    
    // Update the selected move display
    const from = data.move.substring(0, 2);
    const to = data.move.substring(2, 4);
    const piece = game.get(from);
    
    selectedMoveDisplay.innerHTML = `<p>Your vote: ${getPieceName(piece)} ${from.toUpperCase()} → ${to.toUpperCase()}</p>`;
    updateVoteList(null, yourVote); // Update the vote list highlighting
});

socket.on('voteRejected', (data) => {
    showNotification(`Vote rejected: ${data.reason}`, true);
});

// Game connection events
socket.on('gameConnected', (data) => {
    showNotification(`Connected to game ${data.gameId}`);
    updateGameStatusMessage('Game connected. Waiting for moves...');
});

socket.on('gameEnded', (data) => {
    clearInterval(timerInterval);
    votingEndTime = null;
    isVotingPeriod = false;
    updateGameStatus('ended', 'Game over');
    updateGameStatusMessage('Game over. The match has ended.');
    showNotification('Game has ended');
    
    // Reset UI elements
    voteButton.disabled = true;
    hasVoted = false;
    yourVote = null;
    selectedMoveDisplay.innerHTML = `<p>Game has ended.</p>`;
    selectedMoveDisplay.classList.remove('active');
});

socket.on('gameError', (data) => {
    showNotification(`Game error: ${data.error}`, true);
    updateGameStatusMessage(`Error with the game: ${data.error}`);
});

// No active game notification
socket.on('noActiveGame', () => {
    updateGameStatus('waiting', 'Waiting for a game');
    updateGameStatusMessage('No active game. Waiting for a challenge from thatsjustchips...');
});

// Move selection notification
socket.on('moveSelected', (data) => {
    let message;
    if (data.random) {
        message = `No votes received. Random move selected: ${formatMove(data.move)}`;
    } else {
        message = `Move selected: ${formatMove(data.move)} with ${data.votes} votes`;
    }
    showNotification(message);
    updateGameStatusMessage(message);
});

// Challenge events
socket.on('challengeReceived', (challenge) => {
    showNotification(`Received challenge from ${challenge.challenger.name}`);
    updateGameStatusMessage(`Received challenge from ${challenge.challenger.name}. Auto-accepting...`);
});

socket.on('challengeAccepted', (data) => {
    showNotification('Challenge accepted! Game starting...');
    updateGameStatusMessage('Challenge accepted! Game starting...');
});

// Update the game state
function updateGameState(state) {
    console.log('Updating game state with FEN:', state.fen);
    
    if (state.fen) {
        // Load the new position
        game = new Chess(state.fen);
        board.position(state.fen);
        
        // Update current turn
        const turn = state.turn === 'w' ? 'White' : 'Black';
        currentTurn.textContent = turn;
        
        // Update game status
        if (state.inProgress) {
            updateGameStatus('active', 'Game in progress');
        }
        
        // Create map of legal moves if provided
        if (state.legalMoves) {
            createLegalMovesMap(state.legalMoves);
        }
    }
    
    // Update voting timer
    if (state.votingEndTime) {
        votingEndTime = state.votingEndTime;
        updateTimer();
    } else {
        clearInterval(timerInterval);
    }
    
    // Update game status
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

// Start a new voting period
function startVotingPeriod(data) {
    isVotingPeriod = true;
    votingEndTime = data.endTime;
    selectedPiece = null;
    selectedMove = null;
    hasVoted = false;
    yourVote = null;
    
    // Create map of legal moves
    createLegalMovesMap(data.legalMoves);
    
    // Reset the vote button
    voteButton.disabled = true;
    voteButton.textContent = 'Submit Vote';
    
    // Update the selected move display
    selectedMoveDisplay.innerHTML = `<p>Click on a ${botColor} piece to select it, then click on a destination square.</p>`;
    selectedMoveDisplay.classList.remove('active');
    
    // Reset and start timer
    clearInterval(timerInterval);
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
    
    // Setup board click handlers again (in case the board was redrawn)
    setupBoardClickHandlers();
    
    // Reset vote list
    voteListContainer.innerHTML = '<p>No votes yet</p>';
    
    showNotification('Voting has started! Choose your move');
    updateGameStatusMessage(`Your turn to vote! Select a ${botColor} piece and destination.`);
}

// Format a move for display
function formatMove(moveUci) {
    if (!moveUci || moveUci.length < 4) return moveUci;
    
    const from = moveUci.substring(0, 2);
    const to = moveUci.substring(2, 4);
    const piece = game.get(from);
    const pieceName = getPieceName(piece);
    
    return `${pieceName} ${from.toUpperCase()} → ${to.toUpperCase()}`;
}

// Update the vote list display
function updateVoteList(votes, highlightMove = null) {
    if (!votes && !highlightMove) {
        voteListContainer.innerHTML = '<p>No votes yet</p>';
        return;
    }
    
    if (votes) {
        // Sort votes by count (descending)
        const sortedVotes = Object.entries(votes).sort((a, b) => b[1] - a[1]);
        
        if (sortedVotes.length === 0) {
            voteListContainer.innerHTML = '<p>No votes yet</p>';
            return;
        }
        
        let voteListHTML = '';
        for (const [move, count] of sortedVotes) {
            const isYourVote = move === yourVote;
            const moveDisplay = formatMove(move);
            
            voteListHTML += `
                <div class="vote-item ${isYourVote ? 'your-vote' : ''}">
                    <span class="vote-item-move">${moveDisplay}</span>
                    <span class="vote-item-count">${count}</span>
                </div>
            `;
        }
        
        voteListContainer.innerHTML = voteListHTML;
    } else if (highlightMove) {
        // Just update the highlighting for your vote
        const voteItems = document.querySelectorAll('.vote-item');
        voteItems.forEach(item => {
            item.classList.remove('your-vote');
            
            const moveText = item.querySelector('.vote-item-move').textContent;
            const formattedHighlight = formatMove(highlightMove);
            
            if (moveText === formattedHighlight) {
                item.classList.add('your-vote');
            }
        });
    }
}

// Update the timer display
function updateTimer() {
    if (!votingEndTime) {
        timerDisplay.textContent = '00:00';
        return;
    }
    
    const now = Date.now();
    const timeLeft = Math.max(0, votingEndTime - now);
    
    // Format as MM:SS
    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);
    
    timerDisplay.textContent = 
        `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // Disable voting if time is up
    if (timeLeft === 0) {
        clearInterval(timerInterval);
        voteButton.disabled = true;
        isVotingPeriod = false;
    }
}

// Update game status display
function updateGameStatus(status, message) {
    gameStatus.textContent = message;
    
    // Update the status indicator
    statusIndicator.className = 'status-indicator';
    statusIndicator.classList.add(`status-${status}`);
}

// Update game status message
function updateGameStatusMessage(message) {
    gameStatusMessage.innerHTML = `<p>${message}</p>`;
}

// Submit vote
function submitVote() {
    if (selectedMove && !hasVoted) {
        socket.emit('submitVote', selectedMove);
        clearHighlights();
    } else if (!selectedMove) {
        showNotification('Please select a move first', true);
    }
}

// Show notification
function showNotification(message, isError = false) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'notification';
    if (isError) {
        notification.classList.add('error');
    }
    notification.textContent = message;
    
    // Add to document
    document.body.appendChild(notification);
    
    // Show notification
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);
    
    // Remove after a delay
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initialize chess board
    initializeBoard();
    
    // Set initial game status message
    updateGameStatusMessage('Waiting for a game to start...');
    
    // Button event listeners
    voteButton.addEventListener('click', submitVote);
});
