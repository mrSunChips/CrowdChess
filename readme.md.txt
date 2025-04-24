# CrowdChess

A real-time chess voting system that allows multiple users to vote on the next move in a Lichess game.

## Features

- Connect to Lichess API to stream and play chess games
- Real-time voting system using WebSockets
- One vote per IP address to ensure fairness
- 1:30 minute voting period for each move
- Random selection for breaking ties
- Play against Lichess AI or create open challenges
- Clean, responsive UI that works on desktop and mobile

## How It Works

1. Users connect to the web interface
2. A game is started (either vs AI or another player)
3. When it's the crowd's turn, a 90-second voting period begins
4. Users vote for their preferred move
5. The move with the most votes is played on Lichess
6. Process repeats for each turn

## Technical Stack

- **Frontend**: HTML, CSS, JavaScript
- **Chess Libraries**: chess.js and chessboard.js
- **Backend**: Node.js with Express
- **Real-time Communication**: Socket.IO
- **API Integration**: Lichess API

## Getting Started

Visit the live site at [your-deployment-url] to play immediately.

### Creating a Game

1. Click "Play vs AI" to play against Lichess AI (select level 1-8)
2. Click "Create Open Challenge" to generate a challenge link anyone can accept
3. Enter a game ID to connect to an existing Lichess game

### Voting

1. When it's the crowd's turn, all legal moves will be displayed
2. Click on a move to select it
3. Click "Submit Vote" to confirm your selection
4. The timer shows how much time is left to vote
5. After the voting period ends, the winning move is played automatically

## Development

This project is open source and contributions are welcome!

### Setup

1. Clone the repository
2. Install dependencies with `npm install`
3. Create a `.env` file with your Lichess API token
4. Run the server with `npm start`

## Credits

- Built with Lichess API
- Chess visualization powered by chess.js and chessboard.js
