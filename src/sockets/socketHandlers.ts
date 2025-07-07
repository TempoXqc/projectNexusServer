import { Server, Socket } from 'socket.io';
import { GameRepository } from '../database/gameRepository.js';
import { GameCache } from '../cache/gameCache.js';
import { GameLogic } from '../game/gameLogic.js';
import { CardManager } from '../game/cardManager.js';
import { PlayerManager } from '../game/playerManager.js';
import { JoinGameSchema, PlayCardSchema } from './socketSchemas.js';
import { Db, ObjectId } from 'mongodb';
import { GameState, ServerGameState } from "@tempoxqc/project-nexus-types";
import { Card } from "@tempoxqc/project-nexus-types";
import { z } from 'zod';

function generateGameId(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const getRandom = (chars: string) => chars[Math.floor(Math.random() * chars.length)];
  return (
      getRandom(letters) +
      getRandom(digits) +
      getRandom(letters) +
      getRandom(digits) +
      getRandom(letters) +
      getRandom(digits)
  );
}

// Helper function to draw a card on the server
function drawCardServer(game: ServerGameState, playerKey: 'player1' | 'player2'): Card | null {
  if (game.state[playerKey].deck.length === 0) return null;
  const [drawnCard] = game.state[playerKey].deck.slice(0, 1);
  game.state[playerKey].deck = game.state[playerKey].deck.slice(1);
  game.state[playerKey].hand = [...game.state[playerKey].hand, drawnCard];
  return drawnCard;
}

// Helper function to check win condition
async function checkWinCondition(gameId: string, game: ServerGameState, gameRepository: GameRepository, gameCache: GameCache, io: Server) {
  if (game.state.player1.lifePoints <= 0) {
    game.state.gameOver = true;
    game.state.winner = 'player2';
  } else if (game.state.player2.lifePoints <= 0) {
    game.state.gameOver = true;
    game.state.winner = 'player1';
  }
  if (game.state.gameOver) {
    await gameRepository.updateGame(gameId, { state: game.state, status: 'finished' });
    gameCache.setGame(gameId, game);
    game.players.forEach((playerSocketId) => {
      const clientGameState = mapServerToClientGameState(game, playerSocketId);
      io.to(playerSocketId).emit('updateGameState', clientGameState);
    });
  }
}

// Existing mapServerToClientGameState function (unchanged)
function mapServerToClientGameState(serverGame: ServerGameState, playerSocketId: string): GameState {
  const playerId = serverGame.players.indexOf(playerSocketId) + 1;
  const isPlayer1 = playerId === 1;
  const playerKey = isPlayer1 ? 'player1' : 'player2';
  const opponentKey = isPlayer1 ? 'player2' : 'player1';

  const opponentHand: Card[] = Array(serverGame.state[opponentKey].hand.length).fill({
    id: 'hidden',
    name: 'Hidden Card',
    image: 'unknown',
    exhausted: false,
  } as Card);

  return {
    player: {
      hand: serverGame.state[playerKey].hand,
      deck: serverGame.state[playerKey].deck,
      graveyard: serverGame.state[playerKey].graveyard,
      field: serverGame.state[playerKey].field,
      mustDiscard: serverGame.state[playerKey].mustDiscard,
      hasPlayedCard: serverGame.state[playerKey].hasPlayedCard,
      lifePoints: serverGame.state[playerKey].lifePoints,
      tokenCount: serverGame.state[playerKey].tokenCount,
      tokenType: serverGame.state[playerKey].tokenType,
    },
    opponent: {
      hand: opponentHand,
      deck: serverGame.state[opponentKey].deck,
      graveyard: serverGame.state[opponentKey].graveyard,
      field: serverGame.state[opponentKey].field,
      mustDiscard: serverGame.state[opponentKey].mustDiscard,
      hasPlayedCard: serverGame.state[opponentKey].hasPlayedCard,
      lifePoints: serverGame.state[opponentKey].lifePoints,
      tokenCount: serverGame.state[opponentKey].tokenCount,
      tokenType: serverGame.state[opponentKey].tokenType,
    },
    game: {
      turn: serverGame.state.turn,
      currentPhase: serverGame.state.phase,
      isMyTurn: serverGame.state.activePlayer === playerSocketId,
      activePlayerId: serverGame.state.activePlayer,
      gameOver: serverGame.state.gameOver,
      winner: serverGame.state.winner,
    },
    ui: {
      hoveredCardId: null,
      hoveredTokenId: null,
      isCardHovered: false,
      isGraveyardOpen: false,
      isOpponentGraveyardOpen: false,
      isRightPanelOpen: false,
      isRightPanelHovered: false,
      isTokenZoneOpen: false,
      isOpponentTokenZoneOpen: false,
    },
    chat: {
      messages: serverGame.chatHistory,
      input: '',
    },
    deckSelection: {
      selectedDecks: [...serverGame.deckChoices['1'], ...serverGame.deckChoices['2']],
      player1DeckId: serverGame.deckChoices['1'],
      player1Deck: serverGame.state['player1'].deck,
      player2Deck: serverGame.state['player2'].deck,
      hasChosenDeck: playerId === 1 ? !!serverGame.deckChoices['1'].length : serverGame.deckChoices['2'].length > 0,
      deckSelectionDone: serverGame.deckChoices['1'].length >= 2 && serverGame.deckChoices['2'].length >= 2,
      initialDraw: serverGame.state[playerKey].hand,
      selectedForMulligan: [],
      mulliganDone: serverGame.state[playerKey].mulliganDone,
      isReady: serverGame.playersReady.has(playerId),
      bothReady: serverGame.playersReady.size === 2,
      opponentReady: serverGame.playersReady.has(playerId === 1 ? 2 : 1),
      deckSelectionData: {
        player1DeckId: serverGame.deckChoices['1'],
        player2DeckIds: serverGame.deckChoices['2'],
        selectedDecks: [...serverGame.deckChoices['1'], ...serverGame.deckChoices['2']],
      },
      randomizers: [],
      waitingForPlayer1: !serverGame.deckChoices['1'].length,
    },
    connection: {
      playerId,
      isConnected: true,
      canInitializeDraw: false,
    },
  };
}

export async function registerSocketHandlers(io: Server, db: Db) {
  const gameRepository = new GameRepository(db);
  const cardManager = new CardManager(db);
  await cardManager.initialize();
  console.log('[WebSocket] CardManager initialisé avec succès', 'timestamp:', new Date().toISOString());
  const deckLists = cardManager.getDeckLists();
  const allCards = cardManager.getAllCards();
  const gameLogic = new GameLogic(gameRepository, cardManager);
  const playerManager = new PlayerManager();
  const gameCache = new GameCache();
  let lastActiveGamesUpdate: string | null = null;
  let pendingUpdateTimeout: NodeJS.Timeout | null = null;
  const connectedSockets: Set<string> = new Set();

  const scheduleActiveGamesUpdate = () => {
    if (pendingUpdateTimeout) {
      return;
    }
    pendingUpdateTimeout = setTimeout(() => {
      gameLogic.emitActiveGames(io, lastActiveGamesUpdate, (newUpdate) => {
        lastActiveGamesUpdate = newUpdate;
      });
      pendingUpdateTimeout = null;
    }, 100);
  };

  const sendActiveGamesToSocket = async (socket: Socket) => {
    const games = await gameRepository.findActiveGames();
    const activeGames = games.map((game) => ({
      gameId: game.gameId,
      players: game.players,
      createdAt: game.createdAt,
      status: game.status,
    }));
    socket.emit('activeGamesUpdate', activeGames);
  };

  io.on('connection', (socket: Socket) => {
    console.log('[WebSocket] Nouvelle connexion:', socket.id, 'depuis:', socket.handshake.headers.origin);
    if (connectedSockets.has(socket.id)) {
      socket.disconnect(true);
      return;
    }
    connectedSockets.add(socket.id);

    socket.removeAllListeners('createGame');
    socket.removeAllListeners('joinLobby');
    socket.removeAllListeners('leaveLobby');
    socket.removeAllListeners('refreshLobby');

    if (!socket.rooms.has('lobby')) {
      socket.join('lobby');
      sendActiveGamesToSocket(socket);
    }

    socket.on('joinLobby', () => {
      if (socket.rooms.has('lobby')) {
        return;
      }
      socket.join('lobby');
      sendActiveGamesToSocket(socket);
    });

    socket.on('leaveLobby', () => {
      if (socket.rooms.has('lobby')) {
        socket.leave('lobby');
        scheduleActiveGamesUpdate();
      }
    });

    socket.on('refreshLobby', async () => {
      if (!socket.rooms.has('lobby')) {
        socket.join('lobby');
        console.log(`Socket ${socket.id} a rejoint le lobby, timestamp: ${new Date().toISOString()}`);
      }
      const games = await gameRepository.findActiveGames();
      games.forEach((game) => gameCache.deleteGame(game.gameId));
      await sendActiveGamesToSocket(socket);
    });

    socket.on('disconnect', () => {
      console.log('[WebSocket] Déconnexion:', socket.id);
      connectedSockets.delete(socket.id);
      playerManager.removePlayer(socket.id);
      if (socket.rooms.has('lobby')) {
        socket.leave('lobby');
        scheduleActiveGamesUpdate();
      }
    });

    socket.on('createGame', async (data, ack) => {
      console.log('[WebSocket] Événement createGame reçu:', data, 'socket.id:', socket.id, 'timestamp:', new Date().toISOString());
      try {
        const { isRanked, gameFormat } = z
            .object({
              isRanked: z.boolean(),
              gameFormat: z.enum(['BO1', 'BO3']),
            })
            .parse(data);

        const playerInfo = playerManager.getPlayer(socket.id);
        if (playerInfo && playerInfo.gameId) {
          console.log('[WebSocket] Erreur: Joueur déjà dans une partie:', playerInfo.gameId);
          ack({ error: 'Vous avez déjà une partie en cours' });
          return;
        }

        let gameId: string;
        let attempts = 0;
        const maxAttempts = 5;

        do {
          gameId = generateGameId();
          const existingGame = await gameRepository.findGameById(gameId);
          if (existingGame) {
            attempts++;
            if (attempts >= maxAttempts) {
              console.log('[WebSocket] Erreur: Impossible de générer un ID de partie unique');
              ack({ error: 'Impossible de générer un ID de partie unique' });
              return;
            }
          } else {
            break;
          }
        } while (true);

        const availableDecks = await cardManager.getRandomDecks();

        const newGame: ServerGameState = {
          gameId,
          players: [socket.id],
          chatHistory: [],
          state: {
            player1: {
              hand: [],
              field: Array(8).fill(null),
              opponentField: Array(8).fill(null),
              opponentHand: [],
              deck: [],
              graveyard: [],
              mustDiscard: false,
              hasPlayedCard: false,
              lifePoints: 30,
              tokenCount: 0,
              tokenType: null,
              mulliganDone: false,
            },
            player2: {
              hand: [],
              field: Array(8).fill(null),
              opponentField: Array(8).fill(null),
              opponentHand: [],
              deck: [],
              graveyard: [],
              mustDiscard: false,
              hasPlayedCard: false,
              lifePoints: 30,
              tokenCount: 0,
              tokenType: null,
              mulliganDone: false,
            },
            turn: 1,
            activePlayer: null,
            phase: 'Main',
            gameOver: false,
            winner: null,
          },
          deckChoices: { '1': [], '2': [] },
          availableDecks,
          createdAt: new Date(),
          status: 'waiting',
          playersReady: new Set<number>(),
        };

        await gameRepository.insertGame(newGame);
        gameCache.setGame(gameId, newGame);
        playerManager.addPlayer(socket.id, { gameId, playerId: 1 });

        socket.join(gameId);
        if (socket.rooms.has('lobby')) {
          socket.leave('lobby');
        }
        scheduleActiveGamesUpdate();

        const ackResponse = {
          gameId,
          playerId: 1,
          chatHistory: newGame.chatHistory,
          availableDecks: newGame.availableDecks,
        };
        ack(ackResponse);
      } catch (error) {
        console.error('[WebSocket] Erreur lors de la création de la partie:', error);
        ack({ error: 'Erreur lors de la création de la partie' });
      }
    });

    socket.on('joinGame', async (data) => {
      console.log('[WebSocket] Événement joinGame reçu:', data, 'socket.id:', socket.id);
      try {
        const gameId = JoinGameSchema.parse(data);
        const game = await gameRepository.findGameById(gameId);
        if (!game) {
          console.log('[WebSocket] Partie non trouvée:', gameId);
          socket.emit('gameNotFound');
          return;
        }

        if (game.players.length >= 2) {
          console.log('[WebSocket] Erreur: La partie est pleine:', gameId);
          socket.emit('error', 'La partie est pleine');
          return;
        }

        const playerInfo = playerManager.getPlayer(socket.id);
        if (playerInfo && playerInfo.gameId) {
          console.log('[WebSocket] Erreur: Joueur déjà dans une partie:', playerInfo.gameId);
          socket.emit('error', 'Vous êtes déjà dans une partie');
          return;
        }

        if (game.players.includes(socket.id)) {
          console.log('[WebSocket] Erreur: Joueur déjà dans cette partie:', gameId);
          socket.emit('error', 'Vous êtes déjà dans cette partie');
          return;
        }

        game.players.push(socket.id);
        socket.join(gameId);

        if (game.players.length === 2) {
          const [player1SocketId, player2SocketId] = game.players.sort(() => Math.random() - 0.5);
          playerManager.addPlayer(player1SocketId, { gameId, playerId: 1 });
          playerManager.addPlayer(player2SocketId, { gameId, playerId: 2 });
          game.state.activePlayer = player1SocketId;
          console.log('[WebSocket] activePlayer défini:', game.state.activePlayer, 'pour gameId:', gameId, 'timestamp:', new Date().toISOString());
          try {
            await gameRepository.updateGame(gameId, {
              players: [player1SocketId, player2SocketId],
              state: { ...game.state, activePlayer: player1SocketId },
              status: 'started',
            });
            gameCache.setGame(gameId, game);
            console.log(`[WebSocket] Partie ${gameId} mise à jour, statut: started, joueurs: ${game.players}, timestamp: ${new Date().toISOString()}`);
            game.players.forEach((playerSocketId) => {
              const clientGameState = mapServerToClientGameState(game, playerSocketId);
              io.to(playerSocketId).emit('updateGameState', clientGameState);
            });
            io.to(gameId).emit('updatePhase', { gameId, phase: game.state.phase, turn: game.state.turn });
          } catch (error) {
            console.error(`[WebSocket] Erreur lors de la mise à jour de la partie ${gameId}:`, error);
            socket.emit('error', 'Erreur lors de la mise à jour de la partie');
            return;
          }

          const gameStartDataPlayer1 = {
            playerId: 1,
            gameId,
            chatHistory: game.chatHistory,
            availableDecks: game.availableDecks,
          };
          const gameStartDataPlayer2 = {
            playerId: 2,
            gameId,
            chatHistory: game.chatHistory,
            availableDecks: game.availableDecks,
          };

          io.to(player1SocketId).emit('gameStart', gameStartDataPlayer1);
          io.to(player2SocketId).emit('gameStart', gameStartDataPlayer2);
          io.to(gameId).emit('playerJoined', { playerId: 2 });
          io.to(gameId).emit('initialDeckList', game.availableDecks);
          io.to(gameId).emit('deckSelectionUpdate', game.deckChoices);

          if (!game.deckChoices['1'].length) {
            console.log(`[WebSocket] Émission de waitingForPlayer1Choice à player2 (${player2SocketId}):`, { waiting: true }, 'timestamp:', new Date().toISOString());
            io.to(player2SocketId).emit('waitingForPlayer1Choice', { waiting: true });
          }
        } else {
          playerManager.addPlayer(socket.id, { gameId, playerId: null });
          socket.emit('waiting', { gameId, message: 'En attente d\'un autre joueur...' });
          console.log(`[WebSocket] Socket ${socket.id} en attente d'un autre joueur pour ${gameId}, timestamp: ${new Date().toISOString()}`);
        }

        if (socket.rooms.has('lobby')) {
          socket.leave('lobby');
        }
        scheduleActiveGamesUpdate();
      } catch (error) {
        console.error('[WebSocket] Erreur lors de la jointure de la partie:', error);
        socket.emit('error', 'Erreur lors de la jointure de la partie');
      }
    });

    socket.on('checkPlayerGame', async (data, callback) => {
      console.log('[WebSocket] Événement checkPlayerGame reçu:', data, 'socket.id:', socket.id);
      try {
        const { playerId } = z.object({ playerId: z.string().transform((val) => parseInt(val, 10)) }).parse(data);
        const games = await gameRepository.findActiveGames();
        const playerGame = games.find((game) => game.players.includes(String(playerId)) || game.players.includes(socket.id));
        if (playerGame) {
          const fullGame = await gameRepository.findGameById(playerGame.gameId);
          if (fullGame) {
            callback({ exists: true, gameId: fullGame.gameId, availableDecks: fullGame.availableDecks });
          } else {
            callback({ exists: false });
          }
        } else {
          callback({ exists: false });
        }
      } catch (error) {
        console.error('[WebSocket] Erreur lors de checkPlayerGame:', error);
        callback({ exists: false });
      }
    });

    socket.on('checkGameExists', async (gameId, callback) => {
      console.log('[WebSocket] Événement checkGameExists reçu:', gameId, 'socket.id:', socket.id);
      try {
        const game = await gameRepository.findGameById(gameId);
        callback(!!game);
      } catch (error) {
        console.error('[WebSocket] Erreur lors de checkGameExists:', error);
        callback(false);
      }
    });

    socket.on('leaveGame', async (data) => {
      console.log('[WebSocket] Événement leaveGame reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, playerId } = z.object({ gameId: z.string(), playerId: z.number() }).parse(data);
        const game = await gameRepository.findGameById(gameId);
        if (game && (game.players.includes(String(playerId)) || game.players.includes(socket.id))) {
          await gameRepository.deleteGame(gameId);
          gameCache.deleteGame(gameId);
          io.to(gameId).emit('gameNotFound');
        } else {
          console.log('[WebSocket] Erreur: Joueur non autorisé à quitter la partie:', gameId);
          socket.emit('error', 'Vous n\'êtes pas autorisé à quitter cette partie.');
        }
      } catch (error) {
        console.error('[WebSocket] Erreur lors de leaveGame:', error);
        socket.emit('error', 'Erreur lors de la suppression de la partie.');
      }
    });

    socket.on('playCard', async (data) => {
      console.log('[WebSocket] Événement playCard reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, card, fieldIndex } = PlayCardSchema.parse(data);
        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.activePlayer !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour playCard, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        const opponentKey = playerInfo.playerId === 1 ? 'player2' : 'player1';
        if (game.state.phase !== 'Main') return;

        game.state[playerKey].field[fieldIndex] = { ...card, exhausted: false } as Card;
        game.state[playerKey].hand = game.state[playerKey].hand.filter((c: Card) => c.id !== card.id);
        game.state[playerKey].opponentHand = Array(game.state[opponentKey].hand.length).fill({});
        game.state[opponentKey].opponentHand = Array(game.state[playerKey].hand.length).fill({});
        game.state[playerKey].mulliganDone = true;

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          console.log('[WebSocket] Envoi de updateGameState pour playerSocketId:', playerSocketId, 'avec isMyTurn:', game.state.activePlayer === playerSocketId, 'timestamp:', new Date().toISOString());
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action playCard:', error);
        socket.emit('error', 'Erreur lors de l\'action playCard');
      }
    });

    socket.on('chooseDeck', async (data) => {
      console.log('[WebSocket] Événement chooseDeck reçu:', data, 'socket.id:', socket.id);
      try {
        const game = await gameRepository.findGameById(data.gameId);
        if (!game) {
          console.log(`[WebSocket] Erreur : Partie non trouvée pour gameId: ${data.gameId}`);
          socket.emit('error', 'Partie non trouvée');
          return;
        }
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!playerInfo || playerInfo.playerId !== data.playerId) {
          console.log(`[WebSocket] Erreur : Joueur non autorisé pour socketId: ${socket.id}, playerId: ${data.playerId}`);
          socket.emit('error', 'Joueur non autorisé');
          return;
        }

        if (data.playerId === 1) {
          if (game.deckChoices['1'].length >= 1) {
            console.log(`[WebSocket] Erreur : Joueur 1 a déjà choisi un deck pour gameId: ${data.gameId}`);
            socket.emit('error', 'Le joueur 1 a déjà choisi un deck');
            return;
          }
          if (!game.availableDecks.some((deck) => deck.id === data.deckId)) {
            console.log(`[WebSocket] Erreur : Deck invalide ${data.deckId} pour gameId: ${data.gameId}`);
            socket.emit('error', 'Deck invalide');
            return;
          }
          game.deckChoices['1'] = [data.deckId];
          await gameRepository.updateGame(data.gameId, { deckChoices: game.deckChoices });
          gameCache.setGame(data.gameId, game);
          console.log(`[WebSocket] Joueur 1 a choisi le deck: ${data.deckId}, gameId: ${data.gameId}, timestamp: ${new Date().toISOString()}`);
          console.log('[WebSocket] Émission de player1ChoseDeck:', { player1DeckId: data.deckId }, 'to gameId:', data.gameId, 'timestamp:', new Date().toISOString());
          io.to(data.gameId).emit('player1ChoseDeck', { player1DeckId: data.deckId });
          console.log('[WebSocket] Émission de deckSelectionUpdate:', game.deckChoices, 'to gameId:', data.gameId, 'timestamp:', new Date().toISOString());
          io.to(data.gameId).emit('deckSelectionUpdate', game.deckChoices);
          if (game.players[1]) {
            console.log('[WebSocket] Émission de waitingForPlayer1Choice:', { waiting: false }, 'to player2:', game.players[1], 'timestamp:', new Date().toISOString());
            io.to(game.players[1]).emit('waitingForPlayer1Choice', { waiting: false });
          } else {
            console.log('[WebSocket] Joueur 2 non connecté, waitingForPlayer1Choice non émis, timestamp:', new Date().toISOString());
          }
        } else if (data.playerId === 2) {
          if (!game.deckChoices['1'].length) {
            console.log(`[WebSocket] Erreur : Joueur 1 doit choisir un deck en premier pour gameId: ${data.gameId}`);
            socket.emit('error', 'Le joueur 1 doit choisir un deck en premier');
            return;
          }
          if (game.deckChoices['2'].length >= 2) {
            console.log(`[WebSocket] Erreur : Joueur 2 a déjà choisi deux decks pour gameId: ${data.gameId}`);
            socket.emit('error', 'Le joueur 2 a déjà choisi deux decks');
            return;
          }
          if (game.deckChoices['2'].includes(data.deckId) || game.deckChoices['1'].includes(data.deckId)) {
            console.log(`[WebSocket] Erreur : Deck déjà choisi ${data.deckId} pour gameId: ${data.gameId}`);
            socket.emit('error', 'Deck déjà choisi');
            return;
          }
          if (!game.availableDecks.some((deck) => deck.id === data.deckId)) {
            console.log(`[WebSocket] Erreur : Deck invalide ${data.deckId} pour gameId: ${data.gameId}`);
            socket.emit('error', 'Deck invalide');
            return;
          }
          game.deckChoices['2'].push(data.deckId);
          await gameRepository.updateGame(data.gameId, { deckChoices: game.deckChoices });
          gameCache.setGame(data.gameId, game);
          console.log(`[WebSocket] Joueur 2 a choisi le deck: ${data.deckId}, gameId: ${data.gameId}, timestamp: ${new Date().toISOString()}`);
          console.log('[WebSocket] Émission de deckSelectionUpdate:', game.deckChoices, 'to gameId:', data.gameId, 'timestamp:', new Date().toISOString());
          io.to(data.gameId).emit('deckSelectionUpdate', game.deckChoices);
          if (game.deckChoices['2'].length === 2) {
            const remainingDeck = game.availableDecks.find(
                (deck) => !game.deckChoices['1'].includes(deck.id) && !game.deckChoices['2'].includes(deck.id)
            );
            if (remainingDeck) {
              game.deckChoices['1'].push(remainingDeck.id);
              await gameRepository.updateGame(data.gameId, { deckChoices: game.deckChoices });
              gameCache.setGame(data.gameId, game);
              console.log(`[WebSocket] Deck restant ${remainingDeck.id} attribué au joueur 1 pour gameId: ${data.gameId}, timestamp: ${new Date().toISOString()}`);
              console.log('[WebSocket] Émission de deckSelectionUpdate:', game.deckChoices, 'to gameId:', data.gameId, 'timestamp:', new Date().toISOString());
              io.to(data.gameId).emit('deckSelectionUpdate', game.deckChoices);
            }
            console.log('[WebSocket] Émission de deckSelectionDone:', {
              player1DeckId: game.deckChoices['1'],
              player2DeckIds: game.deckChoices['2'],
              selectedDecks: [...game.deckChoices['1'], ...game.deckChoices['2']],
            }, 'to gameId:', data.gameId, 'timestamp:', new Date().toISOString());
            io.to(data.gameId).emit('deckSelectionDone', {
              player1DeckId: game.deckChoices['1'],
              player2DeckIds: game.deckChoices['2'],
              selectedDecks: [...game.deckChoices['1'], ...game.deckChoices['2']],
            });
          }
        }
      } catch (error) {
        console.error('[WebSocket] Erreur lors du choix du deck:', error);
        socket.emit('error', 'Erreur lors du choix du deck');
      }
    });

    socket.on('playerReady', async (data: { gameId: string; playerId: number }) => {
      console.log('[WebSocket] Événement playerReady reçu:', data, 'socket.id:', socket.id);
      try {
        const game = await gameRepository.findGameById(data.gameId);
        if (!game) {
          console.log(`[WebSocket] Erreur : Partie non trouvée pour gameId: ${data.gameId}`);
          socket.emit('error', 'Partie non trouvée');
          return;
        }
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!playerInfo || playerInfo.playerId !== data.playerId) {
          console.log(`[WebSocket] Erreur : Joueur non autorisé pour socketId: ${socket.id}, playerId: ${data.playerId}`);
          socket.emit('error', 'Joueur non autorisé');
          return;
        }

        game.playersReady = game.playersReady || new Set<number>();
        game.playersReady.add(data.playerId);
        await gameRepository.updateGame(data.gameId, { playersReady: Array.from(game.playersReady) });
        console.log(`[WebSocket] Joueur ${data.playerId} est prêt, gameId: ${data.gameId}, playersReady: ${Array.from(game.playersReady)}`, 'timestamp:', new Date().toISOString());
        io.to(data.gameId).emit('playerReady', { playerId: data.playerId });

        if (game.playersReady.size === 2 && game.deckChoices['1'].length >= 2 && game.deckChoices['2'].length >= 2) {
          console.log('[WebSocket] bothPlayersReady, envoi de l\'état initial pour gameId:', data.gameId, 'activePlayer:', game.state.activePlayer, 'timestamp:', new Date().toISOString());
          io.to(data.gameId).emit('bothPlayersReady', { bothReady: true });

          for (const playerId of ['1', '2'] as const) {
            const playerSocketId = game.players.find(p => playerManager.getPlayer(p)?.playerId === Number(playerId));
            if (!playerSocketId) {
              console.error(`[WebSocket] Erreur : Socket non trouvé pour playerId: ${playerId}`, 'timestamp:', new Date().toISOString());
              continue;
            }
            const selectedDeckIds = game.deckChoices[playerId];
            const deck: Card[] = [];
            selectedDeckIds.forEach((deckId: string) => {
              const cardIds = deckLists[deckId];
              const deckCards = cardIds.map((cardId: string) => {
                const card = allCards.find(c => c.id === cardId);
                if (!card) {
                  console.error(`[WebSocket] Erreur : Carte ${cardId} non trouvée dans allCards`, 'timestamp:', new Date().toISOString());
                  return null;
                }
                return { ...card, exhausted: false } as Card;
              }).filter((card): card is Card => card !== null);
              deck.push(...deckCards);
            });

            const shuffledDeck = deck.sort(() => Math.random() - 0.5);
            const initialDraw = shuffledDeck.slice(0, 5);
            const remainingDeck = shuffledDeck.slice(5);

            const primaryDeckId = selectedDeckIds[0];
            const deckList = await db.collection('decklists').findOne({ id: primaryDeckId });
            const tokenType = deckList?.id || null;
            const tokenCount = tokenType === 'assassin' ? 8 : tokenType === 'viking' ? 1 : 0;

            console.log(`[WebSocket] Émission de initializeDeck pour playerId: ${playerId}, deckLength: ${remainingDeck.length}, initialDrawLength: ${initialDraw.length}, tokenType: ${tokenType}, tokenCount: ${tokenCount}`, 'timestamp:', new Date().toISOString());
            io.to(playerSocketId).emit('initializeDeck', {
              deck: remainingDeck,
              initialDraw,
              tokenType,
              tokenCount,
            });

            const playerKey = playerId === '1' ? 'player1' : 'player2';
            game.state[playerKey].deck = remainingDeck;
            game.state[playerKey].hand = initialDraw;
            game.state[playerKey].tokenType = tokenType;
            game.state[playerKey].tokenCount = tokenCount;
            game.state[playerKey].mulliganDone = false; // Garder false jusqu'à confirmation explicite
          }

          // Mettre à jour l'état dans la base de données et le cache
          await gameRepository.updateGame(data.gameId, { state: game.state });
          gameCache.setGame(data.gameId, game);

          // Envoyer l'état mis à jour à tous les joueurs
          game.players.forEach((playerSocketId) => {
            const clientGameState = mapServerToClientGameState(game, playerSocketId);
            console.log('[WebSocket] Envoi de updateGameState après bothPlayersReady pour playerSocketId:', playerSocketId, 'isMyTurn:', clientGameState.game.isMyTurn, 'timestamp:', new Date().toISOString());
            io.to(playerSocketId).emit('updateGameState', clientGameState);
          });

          // Émettre un événement pour indiquer que la phase de mulligan commence
          io.to(data.gameId).emit('mulliganPhaseStart', { gameId: data.gameId });
        }
      } catch (error) {
        console.error('[WebSocket] Erreur lors de la confirmation de préparation:', error, 'timestamp:', new Date().toISOString());
        socket.emit('error', 'Erreur lors de la confirmation de préparation');
      }
    });

    socket.on('updateGameState', async (data) => {
      console.log('[WebSocket] Événement updateGameState reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, state: clientState } = z.object({
          gameId: z.string(),
          state: z.object({
            hand: z.array(z.any()).optional(),
            deck: z.array(z.any()).optional(),
            field: z.array(z.any()).optional(),
            graveyard: z.array(z.any()).optional(),
            deckSelection: z.object({ mulliganDone: z.boolean() }).optional(),
          }),
        }).parse(data);

        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId) {
          console.log('[WebSocket] Erreur: Non autorisé pour updateGameState, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        const opponentKey = playerInfo.playerId === 1 ? 'player2' : 'player1';

        // Autoriser la mise à jour de mulliganDone même si le joueur n'est pas actif
        if (clientState.deckSelection?.mulliganDone && !game.state[playerKey].mulliganDone) {
          game.state[playerKey].mulliganDone = clientState.deckSelection.mulliganDone;
        } else if (game.state.activePlayer !== socket.id) {
          // Vérifier activePlayer pour les autres mises à jour
          console.log('[WebSocket] Erreur: Non autorisé pour updateGameState (pas le joueur actif), gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé - pas votre tour');
          return;
        }

        // Appliquer les autres mises à jour si le joueur est autorisé
        if (clientState.hand) {
          game.state[playerKey].hand = clientState.hand;
          game.state[opponentKey].opponentHand = Array(clientState.hand.length).fill({});
        }
        if (clientState.deck) {
          game.state[playerKey].deck = clientState.deck;
        }
        if (clientState.field) {
          game.state[playerKey].field = clientState.field;
          game.state[opponentKey].opponentField = clientState.field;
        }
        if (clientState.graveyard) {
          game.state[playerKey].graveyard = clientState.graveyard;
        }

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action updateGameState:', error);
        socket.emit('error', 'Erreur lors de la mise à jour de l\'état du jeu');
      }
    });

    socket.on('exhaustCard', async (data) => {
      console.log('[WebSocket] Événement exhaustCard reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, cardId, fieldIndex } = z.object({
          gameId: z.string(),
          cardId: z.string(),
          fieldIndex: z.number(),
        }).parse(data);

        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.activePlayer !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour exhaustCard, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        if (game.state.phase !== 'Main') {
          socket.emit('error', 'Épuisement de carte non autorisé en dehors de la phase Main');
          return;
        }

        const card = game.state[playerKey].field[fieldIndex];
        if (!card || card.id !== cardId) {
          console.log('[WebSocket] Erreur: Carte non trouvée à l\'index', fieldIndex);
          socket.emit('error', 'Carte non trouvée');
          return;
        }

        game.state[playerKey].field[fieldIndex] = { ...card, exhausted: !card.exhausted };
        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action exhaustCard:', error);
        socket.emit('error', 'Erreur lors de l\'épuisement de la carte');
      }
    });

    socket.on('updatePhase', async (data) => {
      console.log('[WebSocket] Événement updatePhase reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, phase, turn } = z.object({
          gameId: z.string(),
          phase: z.enum(['Standby', 'Main', 'Battle', 'End']),
          turn: z.number(),
        }).parse(data);

        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.activePlayer !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour updatePhase, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        game.state.phase = phase;
        game.state.turn = turn;
        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });

        io.to(gameId).emit('updatePhase', { gameId, phase, turn });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action updatePhase:', error);
        socket.emit('error', 'Erreur lors du changement de phase');
      }
    });

    socket.on('endTurn', async (data) => {
      console.log('[WebSocket] Événement endTurn reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, nextPlayerId } = z.object({
          gameId: z.string(),
          nextPlayerId: z.number(),
        }).parse(data);

        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.activePlayer !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour endTurn, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const currentPlayerId = playerInfo.playerId;
        const nextPlayerSocketId = game.players.find((_, idx) => playerManager.getPlayer(game.players[idx])?.playerId === nextPlayerId);
        if (!nextPlayerSocketId) {
          console.log('[WebSocket] Erreur: nextPlayerSocketId non trouvé pour playerId:', nextPlayerId);
          socket.emit('error', 'Joueur suivant non trouvé');
          return;
        }

        console.log('[DEBUG] endTurn - Avant changement de activePlayer:', {
          currentPlayerId,
          currentSocketId: socket.id,
          nextPlayerId,
          nextPlayerSocketId,
        });

        // Update game state
        game.state.activePlayer = nextPlayerSocketId;
        game.state.turn += 1;
        game.state.phase = 'Standby';
        const currentPlayerKey = currentPlayerId === 1 ? 'player1' : 'player2';
        const nextPlayerKey = nextPlayerId === 1 ? 'player1' : 'player2';
        const opponentKey = nextPlayerId === 1 ? 'player2' : 'player1';

        // Reset hasPlayedCard and mustDiscard for both players
        game.state.player1.hasPlayedCard = false;
        game.state.player2.hasPlayedCard = false;
        game.state.player1.mustDiscard = false;
        game.state.player2.mustDiscard = false;

        // Reset exhausted state for all cards on both fields
        game.state.player1.field = game.state.player1.field.map((card) =>
            card ? { ...card, exhausted: false } : null,
        );
        game.state.player2.field = game.state.player2.field.map((card) =>
            card ? { ...card, exhausted: false } : null,
        );

        // Sync opponentField
        game.state.player1.opponentField = [...game.state.player2.field];
        game.state.player2.opponentField = [...game.state.player1.field];

        // Automatic card draw for the next player
        if (game.state.turn > 1 && game.state[nextPlayerKey].deck.length > 0 && game.state[nextPlayerKey].hand.length < 10) {
          const drawnCard = drawCardServer(game, nextPlayerKey);
          console.log('[DEBUG] Automatic draw in endTurn:', { nextPlayerKey, drawnCard });

          if (drawnCard && drawnCard.name === 'Assassin Token' && game.state[opponentKey].tokenType === 'assassin') {
            console.log('[DEBUG] Assassin Token drawn in endTurn, applying effects');
            game.state[nextPlayerKey].lifePoints = Math.max(0, game.state[nextPlayerKey].lifePoints - 2);
            game.state[opponentKey].tokenCount = Math.min(game.state[opponentKey].tokenCount + 1, 8);

            // Attempt to draw another card if deck is not empty
            let newDrawnCard: Card | null = null;
            if (game.state[nextPlayerKey].deck.length > 0) {
              newDrawnCard = drawCardServer(game, nextPlayerKey);
              console.log('[DEBUG] Repioche after Assassin Token in endTurn:', { newDrawnCard });
            } else {
              console.log('[DEBUG] No cards left to repioche');
            }

            // Update opponentHand for both players
            game.state[nextPlayerKey].opponentHand = Array(game.state[opponentKey].hand.length).fill({});
            game.state[opponentKey].opponentHand = Array(game.state[nextPlayerKey].hand.length).fill({});

            // Emit assassin token draw event
            io.to(gameId).emit('handleAssassinTokenDraw', {
              playerLifePoints: game.state[nextPlayerKey].lifePoints,
              opponentTokenCount: game.state[opponentKey].tokenCount,
            });
          }
        }

        // Update opponentHand for both players
        game.state.player1.opponentHand = Array(game.state.player2.hand.length).fill({});
        game.state.player2.opponentHand = Array(game.state.player1.hand.length).fill({});

        console.log('[DEBUG] endTurn - Avant émission:', {
          gameId,
          activePlayer: game.state.activePlayer,
          phase: game.state.phase,
          turn: game.state.turn,
        });

        // Persist game state
        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        // Emit updated game state to all players
        game.players.forEach((playerSocketId) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });

        // Emit additional events
        io.to(gameId).emit('endTurn');
        io.to(nextPlayerSocketId).emit('yourTurn');
        io.to(gameId).emit('updatePhase', { gameId, phase: game.state.phase, turn: game.state.turn });
        io.to(gameId).emit('phaseChangeMessage', { phase: 'Standby', turn: game.state.turn, nextPlayerId });

        // Check win condition
        await checkWinCondition(gameId, game, gameRepository, gameCache, io);
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action endTurn:', error);
        socket.emit('error', 'Erreur lors du changement de tour');
      }
    });
  });
}