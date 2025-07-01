export class GameLogic {
    constructor(gameRepository, cardManager) {
        this.gameRepository = gameRepository;
        this.cardManager = cardManager;
    }
    async emitActiveGames(io, lastUpdate, updateCallback) {
        const games = await this.gameRepository.findActiveGames();
        const activeGames = games.map((game) => ({
            gameId: game.gameId,
            players: game.players,
            createdAt: game.createdAt,
            status: game.status,
        }));
        const currentUpdate = JSON.stringify(activeGames);
        if (currentUpdate !== lastUpdate) {
            console.log('Émission de activeGamesUpdate:', activeGames);
            io.to('lobby').emit('activeGamesUpdate', activeGames);
            updateCallback(currentUpdate);
        }
        else {
            console.log('activeGamesUpdate inchangé, émission ignorée');
        }
    }
    async drawCardServer(gameId, playerKey) {
        const game = await this.gameRepository.findGameById(gameId);
        if (!game || game.state[playerKey].deck.length === 0)
            return null;
        const [drawnCard] = game.state[playerKey].deck.splice(0, 1);
        game.state[playerKey].hand.push(drawnCard);
        await this.gameRepository.updateGame(gameId, { state: game.state });
        return drawnCard;
    }
    async checkWinCondition(gameId) {
        const game = await this.gameRepository.findGameById(gameId);
        if (!game)
            return null;
        const player1Life = game.state.player1.lifePoints;
        const player2Life = game.state.player2.lifePoints;
        if (player1Life <= 0 || player2Life <= 0) {
            const winner = player1Life <= 0 ? 'player2' : 'player1';
            game.state.gameOver = true;
            game.state.winner = winner;
            await this.gameRepository.updateGame(gameId, { state: game.state });
            return { winner };
        }
        return null;
    }
}
