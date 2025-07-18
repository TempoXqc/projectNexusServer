import { ServerGameState, Card } from "@tempoxqc/project-nexus-types";
import { GameRepository } from '../database/gameRepository.js';
import { CardManager } from './cardManager.js';

export class GameLogic {
  private gameRepository: GameRepository;
  private cardManager: CardManager;

  constructor(gameRepository: GameRepository, cardManager: CardManager) {
    this.gameRepository = gameRepository;
    this.cardManager = cardManager;
  }

  async drawCard(game: ServerGameState, playerKey: 'player1' | 'player2'): Promise<Card | null> {
    if (!game || game.state[playerKey].deck.length === 0) return null;
    const [drawnCard] = game.state[playerKey].deck.splice(0, 1);
    game.state[playerKey].hand.push(drawnCard);
    return drawnCard;
  }

  async checkWinCondition(game: ServerGameState): Promise<boolean> {
    const player1Life = game.state.player1.lifePoints;
    const player2Life = game.state.player2.lifePoints;

    if (player1Life! <= 0 || player2Life! <= 0) {
      return true;
    }
    return false;
  }

  async emitActiveGames(io: any, lastUpdate: string | null, callback: (newUpdate: string) => void): Promise<void> {
    const games = await this.gameRepository.findActiveGames();
    const newUpdate = new Date().toISOString();
    io.to('lobby').emit('activeGamesUpdate', {
      games: games.map((game) => ({
        gameId: game.gameId,
        players: game.players,
        createdAt: game.createdAt,
        status: game.status,
      })),
      lastUpdate: newUpdate,
    });
    callback(newUpdate);
  }
}