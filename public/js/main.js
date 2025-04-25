// Initialize socket.io connection
const socket = io();

// Chess board configuration
let board = null;
let game = new Chess();
let selectedMove = null;
let votingEndTime = null;
let timerInterval = null;
let hasVoted = false;

// DOM Elements
const connectionStatus = document.getElementById('connection-status');
const gameIdDisplay = document.getElementById('game-id');
const gameStatus = document.getElementById('game-status');
const statusIndicator = document.getElementById('status-indicator');
const currentTurn = document.getElementById('current-turn');
const timerDisplay = document.getElementById('timer');
const voteOptionsContainer = document.getElementById('vote-options');
const voteButton = document.getElementById('vote-button');
const challengeThatsjustchipsBtn = document.getElementById('challenge-thatsjustchips');
const challengeUrlContainer = document.getElementById('challenge-url-container');
const gameStatusMessage = document.getElementById('game-status-message');

// Initialize the chess board
function initializeBoard() {
    // Board configuration
    const config = {
        draggable: false,
        position: 'start',
        pieceTheme: 'https://lichess1.org/assets/piece/cburnett/{piece}.svg'
    };
    
    // Initialize the chess board
    board = Chessboard('board', config);
    
    // Adjust board size on window resize
    window.addEventListener('resize', board.resize);
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
    updateGameState(state);
});

// Voting period start
socket.on('votingStarted', (data) => {
    startVotingPeriod(data);
});

// Vote updates
socket.on('votesUpdated', (votes) => {
    updateVoteCounts(votes);
});

// Vote acceptance/rejection
socket.on('voteAccepted', (data) => {
    hasVoted = true;
    voteButton.disabled = true;
    voteButton.textContent = 'Vote Submitted!';
    showNotification('Your vote has been recorded!');
});

socket.on('voteRejected', (data) => {
    showNotification(`Vote rejected: ${data.reason}`, true);
});

// Challenge results
socket.on('challengeResult', (result) => {
    if (result.success) {
        showNotification('Challenge sent to thatsjustchips!');
        updateGameStatusMessage('Challenge sent to thatsjustchips. Waiting for acceptance...');
    } else {
        showNotification(`Failed to create challenge: ${result.message}`, true);
        updateGameStatusMessage(`Failed to create challenge: ${result.message}`);
    }
});

socket.on('challengeCreated', (result) => {
    // This is broadcast to all clients
    updateGameStatusMessage('Challenge sent to thatsjustchips. Waiting for acceptance...');
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

socket.on('challengeCanceled', (challenge) => {
    showNotification(`Challenge was canceled`, true);
    updateGameStatusMessage('Challenge was canceled.');
});

socket.on('challengeDeclined', (challenge) => {
    showNotification(`Challenge was declined`, true);
    updateGameStatusMessage('Challenge was declined.');
});

// Game status
socket.on('gameStatus', (status) => {
    if (status.inProgress && status.gameId) {
        gameIdDisplay.textContent = status.gameId;
        updateGameStatus('active', 'Game in progress');
        updateGameStatusMessage('Game in progress. Enjoy!');
        
        if (status.fen) {
            game.load(status.fen);
            board.position(game.fen());
        }
    } else {
        updateGameStatus('waiting', 'Waiting for a game to start');
        updateGameStatusMessage('No active game. Click "Challenge thatsjustchips" to start a new game.');
    }
});

// Game ended
socket.on('gameEnded', (data) => {
    clearInterval(timerInterval);
    votingEndTime = null;
    updateGameStatus('ended', 'Game over');
    updateGameStatusMessage('Game over. Click "Challenge thatsjustchips" to start a new game.');
    showNotification('Game has ended');
    
    // Reset UI elements
    voteOptionsContainer.innerHTML = '<p>Game has ended. Start a new game to continue.</p>';
    voteButton.disabled = true;
    hasVoted = false;
});

// Update the game state
function updateGameState(state) {
    if (state.gameId) {
        gameIdDisplay.textContent = state.gameId;
        updateGameStatus('active', 'Game in progress');
    }
    
    if (state.fen) {
        game.load(state.fen);
        board.position(game.fen());
        
        // Update current turn
        const turn = state.turn === 'w' ? 'White' : 'Black';
        currentTurn.textContent = turn;
    }
    
    // Update legal moves
    if (state.legalMoves) {
        updateMoveOptions(state.legalMoves, state.votes || {});
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
        updateGameStatusMessage('Game over. Click "Challenge thatsjustchips" to start a new game.');
        clearInterval(timerInterval);
    } else if (state.isCheck) {
        // We could highlight the king here
        if (state.isCheckmate) {
            updateGameStatus('ended', 'Checkmate');
            updateGameStatusMessage('Checkmate! Game over. Click "Challenge thatsjustchips" to start a new game.');
        }
    }
}

// Start a new voting period
function startVotingPeriod(data) {
    votingEndTime = data.endTime;
    selectedMove = null;
    hasVoted = false;
    
    updateMoveOptions(data.legalMoves, {});
    
    // Reset and start timer
    clearInterval(timerInterval);
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
    
    // Enable vote button
    voteButton.disabled = false;
    voteButton.textContent = 'Submit Vote';
    
    showNotification('Voting has started! Choose your move');
}

// Update move options in the UI
function updateMoveOptions(moves, votes) {
    voteOptionsContainer.innerHTML = '';
    
    if (moves.length === 0) {
        voteOptionsContainer.innerHTML = '<p>No legal moves available.</p>';
        return;
    }
    
    for (const move of moves) {
        const moveElement = document.createElement('div');
        moveElement.className = 'vote-option';
        if (move === selectedMove) {
            moveElement.className += ' selected';
        }
        
        // Convert from UCI format (e2e4) to more readable format
        const from = move.substring(0, 2);
        const to = move.substring(2, 4);
        const promotion = move.length > 4 ? move.substring(4, 5) : null;
        
        // Get move information for display
        const moveText = formatMove(from, to, promotion);
        
        moveElement.innerHTML = `
            <div class="vote-move-text">${moveText}</div>
            <div class="vote-count">${votes[move] || 0}</div>
        `;
        
        moveElement.addEventListener('click', () => {
            selectMove(move);
        });
        
        voteOptionsContainer.appendChild(moveElement);
    }
}

// Format a move for display
function formatMove(from, to, promotion) {
    // Get piece at the 'from' square
    const piece = game.get(from);
    if (!piece) return `${from} to ${to}`;
    
    // Determine piece name
    let pieceName = '';
    switch (piece.type) {
        case 'p': pieceName = 'Pawn'; break;
        case 'n': pieceName = 'Knight'; break;
        case 'b': pieceName = 'Bishop'; break;
        case 'r': pieceName = 'Rook'; break;
        case 'q': pieceName = 'Queen'; break;
        case 'k': pieceName = 'King'; break;
    }
    
    // Add promotion info if applicable
    let promotionText = '';
    if (promotion) {
        let promotionPiece = '';
        switch (promotion) {
            case 'q': promotionPiece = 'Queen'; break;
            case 'r': promotionPiece = 'Rook'; break;
            case 'b': promotionPiece = 'Bishop'; break;
            case 'n': promotionPiece = 'Knight'; break;
        }
        promotionText = ` (promote to ${promotionPiece})`;
    }
    
    return `${pieceName} ${from.toUpperCase()} → ${to.toUpperCase()}${promotionText}`;
}

// Select a move to vote for
function selectMove(move) {
    if (hasVoted) return;
    
    selectedMove = move;
    
    // Update UI to show selection
    const options = document.querySelectorAll('.vote-option');
    options.forEach(option => {
        option.classList.remove('selected');
    });
    
    // Find and select the right element
    options.forEach(option => {
        const from = move.substring(0, 2);
        const to = move.substring(2, 4);
        const promotion = move.length > 4 ? move.substring(4, 5) : null;
        const moveText = formatMove(from, to, promotion);
        
        if (option.querySelector('.vote-move-text').textContent === moveText) {
            option.classList.add('selected');
        }
    });
}

// Update vote counts in the UI
function updateVoteCounts(votes) {
    const options = document.querySelectorAll('.vote-option');
    
    options.forEach(option => {
        const moveText = option.querySelector('.vote-move-text').textContent;
        
        // Find the corresponding move in our legalMoves
        for (const [move, voteCount] of Object.entries(votes)) {
            const from = move.substring(0, 2);
            const to = move.substring(2, 4);
            const promotion = move.length > 4 ? move.substring(4, 5) : null;
            
            if (moveText === formatMove(from, to, promotion)) {
                option.querySelector('.vote-count').textContent = voteCount;
                break;
            }
        }
    });
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
    } else if (!selectedMove) {
        showNotification('Please select a move first', true);
    }
}

// Challenge thatsjustchips
function challengeThatsjustchips() {
    socket.emit('challengeThatsjustchips');
    challengeThatsjustchipsBtn.disabled = true;
    setTimeout(() => {
        challengeThatsjustchipsBtn.disabled = false;
    }, 5000); // Re-enable after 5 seconds to prevent spam
    updateGameStatusMessage('Sending challenge to thatsjustchips...');
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
    updateGameStatusMessage('No active game. Click "Challenge thatsjustchips" to start a new game.');
    
    // Button event listeners
    voteButton.addEventListener('click', submitVote);
    challengeThatsjustchipsBtn.addEventListener('click', challengeThatsjustchips);
});
