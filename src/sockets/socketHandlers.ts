import {Server, Socket} from 'socket.io';
import {GameRepository} from '../database/gameRepository.js';
import {GameCache} from '../cache/gameCache.js';
import {CardManager} from '../game/cardManager.js';
import {PlayerManager} from '../game/playerManager.js';
import {JoinGameSchema, PlayCardSchema} from './socketSchemas.js';
import {Db, ObjectId} from 'mongodb';
import {Card, CardSchema, GameState, HiddenCard, ServerGameState } from "@tempoxqc/project-nexus-types";
import {z} from "zod";
import jwt from "jsonwebtoken";
import {User} from "../routes/authRoutes.js";
import EffectManager, {GameContext} from "../game/effectManager.js";

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

function drawCardServer(game: ServerGameState, playerKey: 'player1' | 'player2'): Card | null {
  if (game.state[playerKey].deck.length === 0) return null;
  const [drawnCard] = game.state[playerKey].deck.slice(0, 1);
  game.state[playerKey].deck = game.state[playerKey].deck.slice(1);
  game.state[playerKey].hand = [...game.state[playerKey].hand, drawnCard];
  return drawnCard;
}

function mapServerToClientGameState(serverGame: ServerGameState, playerSocketId: string): GameState {
  if (!serverGame.state.game) {
    console.error('[WebSocket] serverGame.state.game is undefined', {
      serverGame: JSON.stringify(serverGame, null, 2),
    });
    throw new Error('serverGame.state.game is undefined');
  }
  const playerId = serverGame.players.indexOf(playerSocketId) + 1;
  const isPlayer1 = playerId === 1;
  const playerKey = isPlayer1 ? 'player1' : 'player2';
  const opponentKey = isPlayer1 ? 'player2' : 'player1';

  console.log('[DEBUG] mapServerToClientGameState:', {
    playerSocketId,
    playerId,
    activePlayer: serverGame.state.game.activePlayerId,
    isMyTurn: serverGame.state.game.activePlayerId === playerSocketId,
  });

  // FIX: Use opponentKey for the opponent's hand length (was playerKey before)
  const opponentHand: HiddenCard[] = Array(serverGame.state[opponentKey].hand.length).fill({
    id: 'hidden',
    name: 'Hidden Card',
    image: 'unknown',
    exhausted: false,
  });

  // For symmetry, opponent's opponentHand (hidden view of player's hand)
  const playerHiddenHand: HiddenCard[] = Array(serverGame.state[playerKey].hand.length).fill({
    id: 'hidden',
    name: 'Hidden Card',
    image: 'unknown',
    exhausted: false,
  });

  const gameState: GameState = {
    player: {
      ...serverGame.state[playerKey],
      hand: serverGame.state[playerKey].hand,
      opponentField: serverGame.state[opponentKey].field,
      opponentHand: opponentHand,
      nexus: serverGame.state[playerKey].nexus || { health: serverGame.state[playerKey].lifePoints || 30 },
    },
    opponent: {
      ...serverGame.state[opponentKey],
      hand: opponentHand,
      opponentField: serverGame.state[playerKey].field,
      opponentHand: playerHiddenHand,
      nexus: serverGame.state[playerKey].nexus || { health: serverGame.state[playerKey].lifePoints || 30 },

    },
    revealedCards: serverGame.state.revealedCards,
    lastCardPlayed: serverGame.state.lastCardPlayed,
    lastDestroyedUnit: serverGame.state.lastDestroyedUnit,
    targetType: serverGame.state.targetType,
    detected: serverGame.state.detected,
    currentCard: serverGame.state.currentCard,
    turnState: serverGame.state.turnState,
    game: {
      turn: serverGame.state.game.turn,
      currentPhase: serverGame.state.game.currentPhase,
      isMyTurn: serverGame.state.game.activePlayerId === playerSocketId,
      activePlayerId: serverGame.state.game.activePlayerId,
      gameOver: serverGame.state.game.gameOver,
      winner: serverGame.state.game.winner,
      updateTimestamp: serverGame.state.game.updateTimestamp,
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
      isRevealedCardsOpen: false,
      isReorderCardsOpen: false,
      isSelectCardOpen: false,
      isChoiceOpen: false,
    },
    chat: {
      messages: serverGame.chatHistory,
      input: '',
    },
    deckSelection: {
      selectedDecks: [...serverGame.deckChoices['1'], ...serverGame.deckChoices['2']],
      player1DeckId: serverGame.deckChoices['1'],
      player1Deck: serverGame.state.player1.deck,
      player2Deck: serverGame.state.player2.deck,
      hasChosenDeck: playerId === 1 ? !!serverGame.deckChoices['1'].length : serverGame.deckChoices['2'].length > 0,
      deckSelectionDone: serverGame.deckChoices['1'].length >= 2 && serverGame.deckChoices['2'].length >= 2,
      initialDraw: serverGame.state[playerKey].hand,
      selectedForMulligan: [],
      mulliganDone: serverGame.state[playerKey].mulliganDone ?? false,
      isReady: serverGame.playersReady.has(playerId),
      bothReady: serverGame.playersReady.size === 2,
      opponentReady: serverGame.playersReady.has(playerId === 1 ? 2 : 1),
      deckSelectionData: {
        player1DeckId: serverGame.deckChoices['1'],
        player2DeckIds: serverGame.deckChoices['2'],
        selectedDecks: [...serverGame.deckChoices['1'], ...serverGame.deckChoices['2']],
      },
      randomizers: serverGame.availableDecks,
      waitingForPlayer1: !serverGame.deckChoices['1'].length,
    },
    connection: {
      playerId,
      isConnected: true,
      canInitializeDraw: false,
      gameId: serverGame.gameId,
    },
  };

  console.log('[DEBUG] Constructed gameState:', {
    isMyTurn: gameState.game.isMyTurn,
    currentPhase: gameState.game.currentPhase,
    turn: gameState.game.turn,
  });

  return gameState;
}

export async function registerSocketHandlers(io: Server, db: Db) {
  const gameRepository = new GameRepository(db);
  const cardManager = new CardManager(db);
  await cardManager.initialize();
  const playerManager = new PlayerManager();
  const gameCache = new GameCache();
  const connectedSockets: Set<string> = new Set();

  async function scheduleActiveGamesUpdate(io: Server, gameRepository: GameRepository) {
    const games = await gameRepository.findActiveGames();
    const activeGames = games.map((game) => ({
      gameId: game.gameId,
      players: game.players,
      createdAt: game.createdAt,
      status: game.status,
    }));
    io.to('lobby').emit('activeGamesUpdate', activeGames);
  }

  const sendActiveGamesToSocket = async (socket: Socket, gameRepository: GameRepository) => {
    const games = await gameRepository.findActiveGames();
    const activeGames = games.map((game) => ({
      gameId: game.gameId,
      players: game.players,
      createdAt: game.createdAt,
      status: game.status,
    }));
    socket.emit('activeGamesUpdate', activeGames);
  };

  async function checkWinCondition(gameId: string, game: ServerGameState, gameRepository: GameRepository, gameCache: GameCache, io: Server) {
    if (game.state.player1.lifePoints! <= 0) {
      game.state.game.gameOver = true;
      game.state.game.winner = 'player2';
    } else if (game.state.player2.lifePoints! <= 0) {
      game.state.game.gameOver = true;
      game.state.game.winner = 'player1';
    }
    if (game.state.game.gameOver) {
      await gameRepository.updateGame(gameId, { state: game.state, status: 'finished' });
      gameCache.setGame(gameId, game);
      game.players.forEach((playerSocketId: string) => {
        const clientGameState = mapServerToClientGameState(game, playerSocketId);
        io.to(playerSocketId).emit('updateGameState', clientGameState);
      });
      await scheduleActiveGamesUpdate(io, gameRepository);
    }
  }


  io.on('connection', (socket: Socket) => {
    console.log('[WebSocket] Nouvelle connexion:', socket.id, 'depuis:', socket.handshake.headers.origin);
    if (connectedSockets.has(socket.id)) {
      socket.disconnect(true);
      return;
    }
    connectedSockets.add(socket.id);

    socket.on('reconnectWithToken', async (data: { token: string }) => {
      try {
        const decoded = jwt.verify(data.token, process.env.JWT_SECRET as string) as { userId: string };
        const user = await db.collection<User>('users').findOne({ _id: new ObjectId(decoded.userId) });
        if (!user) {
          socket.emit('error', 'Utilisateur non trouvé');
          return;
        }

        const games = await gameRepository.findActiveGames();
        const playerGame = games.find((game) => game.players.includes(socket.id));
        if (playerGame) {
          const oldSocketId = playerGame.players.find((p: string) => p === socket.id);
          if (oldSocketId) {
            playerGame.players = playerGame.players.map((id: string) => (id === oldSocketId ? socket.id : id));
            playerManager.updatePlayerSocketId(oldSocketId, socket.id);
            await gameRepository.updateGame(playerGame.gameId, { players: playerGame.players });
            gameCache.setGame(playerGame.gameId, playerGame);
            socket.join(playerGame.gameId);
            const fullGame = await gameRepository.findGameById(playerGame.gameId);
            if (fullGame) {
              const clientGameState = mapServerToClientGameState(fullGame, socket.id);
              socket.emit('updateGameState', clientGameState);
              console.log('[WebSocket] Reconnexion réussie pour:', { gameId: playerGame.gameId, userId: user._id.toString(), newSocketId: socket.id });
              if (fullGame.state.game.activePlayerId === oldSocketId) {
                fullGame.state.game.activePlayerId = socket.id;
                await gameRepository.updateGame(playerGame.gameId, { state: fullGame.state });
                gameCache.setGame(playerGame.gameId, fullGame);
                socket.emit('yourTurn');
              }
            }
          }
        } else {
          playerManager.addPlayer(socket.id, { gameId: '', playerId: null });
          socket.join('lobby');
          await sendActiveGamesToSocket(socket, gameRepository);
        }
      } catch (error) {
        console.error('[WebSocket] Erreur lors de la reconnexion avec token:', error);
        socket.emit('error', 'Erreur lors de la reconnexion');
      }
    });

    const existingPlayerInfo = playerManager.getPlayer(socket.id);
    console.log('[DEBUG] connection - État PlayerManager:', { socketId: socket.id, existingPlayerInfo });

    socket.on('reconnectPlayer', async (data: { gameId: string, playerId: number }) => {
      console.log('[WebSocket] Événement reconnectPlayer reçu:', data, 'socket.id:', socket.id);
      const game = await gameRepository.findGameById(data.gameId);
      if (!game) {
        console.warn('[WebSocket] Reconnexion échouée - Partie non trouvée:', data.gameId);
        socket.emit('error', 'Reconnexion échouée - Partie non trouvée');
        return;
      }

      const oldSocketId = playerManager.findPlayerByGameIdAndPlayerId(data.gameId, data.playerId);
      if (oldSocketId && game.players.includes(oldSocketId)) {
        game.players = game.players.map((id: string) => (id === oldSocketId ? socket.id : id));
        playerManager.updatePlayerSocketId(oldSocketId, socket.id);
        await gameRepository.updateGame(data.gameId, { players: game.players });
        gameCache.setGame(data.gameId, game);
        socket.join(data.gameId);
        const clientGameState = mapServerToClientGameState(game, socket.id);
        io.to(socket.id).emit('updateGameState', clientGameState);
        console.log('[WebSocket] Reconnexion réussie pour:', {
          gameId: data.gameId,
          playerId: data.playerId,
          newSocketId: socket.id
        });
        if (game.state.game.activePlayerId === oldSocketId) {
          game.state.game.activePlayerId = socket.id;
          await gameRepository.updateGame(data.gameId, { state: game.state });
          gameCache.setGame(data.gameId, game);
          io.to(socket.id).emit('yourTurn');
        }
      } else {
        console.warn('[WebSocket] Reconnexion échouée:', { gameId: data.gameId, playerId: data.playerId });
        socket.emit('error', 'Reconnexion échouée - Joueur non trouvé');
      }
    });

    socket.removeAllListeners('createGame');
    socket.removeAllListeners('joinLobby');
    socket.removeAllListeners('leaveLobby');
    socket.removeAllListeners('refreshLobby');

    if (!socket.rooms.has('lobby')) {
      socket.join('lobby');
      sendActiveGamesToSocket(socket, gameRepository);
    }

    socket.on('joinLobby', () => {
      if (socket.rooms.has('lobby')) {
        return;
      }
      socket.join('lobby');
      sendActiveGamesToSocket(socket, gameRepository);
    });

    socket.on('leaveLobby', () => {
      if (socket.rooms.has('lobby')) {
        socket.leave('lobby');
        scheduleActiveGamesUpdate(io, gameRepository);
      }
    });

    socket.on('refreshLobby', async () => {
      if (!socket.rooms.has('lobby')) {
        socket.join('lobby');
        console.log(`Socket ${socket.id} a rejoint le lobby, timestamp: ${new Date().toISOString()}`);
      }
      const games = await gameRepository.findActiveGames();
      games.forEach((game) => gameCache.deleteGame(game.gameId));
      await sendActiveGamesToSocket(socket, gameRepository);
    });

    socket.on('disconnect', async () => {
      console.log('[WebSocket] Déconnexion:', socket.id);
      const playerInfo = playerManager.getPlayer(socket.id);
      if (playerInfo && playerInfo.gameId) {
        const game = await gameRepository.findGameById(playerInfo.gameId);
        if (game) {
          const remainingPlayers = game.players.filter((id: string) => id !== socket.id);
          if (remainingPlayers.length === 0) {
            console.log('[WebSocket] Suppression de la partie, aucun joueur restant:', playerInfo.gameId);
            await gameRepository.deleteGame(playerInfo.gameId);
            gameCache.deleteGame(playerInfo.gameId);
            io.to(playerInfo.gameId).emit('gameNotFound');
            await scheduleActiveGamesUpdate(io, gameRepository);
          } else {
            console.log('[WebSocket] Joueur restant dans la partie:', { gameId: playerInfo.gameId, remainingPlayers });
            game.state.game.activePlayerId = remainingPlayers[0];
            game.state.game.updateTimestamp = Date.now();
            await gameRepository.updateGame(playerInfo.gameId, { state: game.state });
            gameCache.setGame(playerInfo.gameId, game);
            remainingPlayers.forEach((playerSocketId: string) => {
              const clientGameState = mapServerToClientGameState(game, playerSocketId);
              io.to(playerSocketId).emit('updateGameState', clientGameState);
              io.to(playerSocketId).emit('opponentDisconnected', { disconnectedPlayerId: playerInfo.playerId });
              io.to(playerSocketId).emit('yourTurn');
            });
            await scheduleActiveGamesUpdate(io, gameRepository);
          }
        }
      }
      connectedSockets.delete(socket.id);
      playerManager.removePlayer(socket.id);
      if (socket.rooms.has('lobby')) {
        socket.leave('lobby');
        await scheduleActiveGamesUpdate(io, gameRepository);
      }
    });

    socket.on('createGame', async (data, ack) => {
      try {
        const { isRanked, gameFormat } = z
            .object({
              isRanked: z.boolean(),
              gameFormat: z.enum(['BO1', 'BO3']),
              username: z.string().optional(),
            })
            .parse(data);

        const gameId = generateGameId();
        const playerInfo = playerManager.getPlayer(socket.id);
        if (playerInfo && playerInfo.gameId) {
          console.log('[WebSocket] Erreur: Joueur déjà dans une partie:', playerInfo.gameId);
          ack({ error: 'Vous avez déjà une partie en cours' });
          return;
        }

        const deckListsCollection = db.collection('decklists');
        const totalDecks = await deckListsCollection.countDocuments();
        console.log('[DEBUG] Total decks in decklists:', totalDecks);
        if (totalDecks < 4) {
          console.error('[WebSocket] Erreur: Pas assez de decks disponibles', { totalDecks });
          ack({ error: 'Pas assez de decks disponibles' });
          return;
        }

        const availableDecksRaw = await deckListsCollection
            .aggregate([{ $sample: { size: 4 } }])
            .toArray();
        console.log('[DEBUG] availableDecksRaw:', availableDecksRaw);

        const playmatBottom = await db.collection('playmats').findOne({ id: 'playmat_bottom' });
        const playmatTop = await db.collection('playmats').findOne({ id: 'playmat_top' });
        const lifeToken = await db.collection('addons').findOne({ id: 'token_officiel' });

        if (!playmatBottom || !playmatTop || !lifeToken) {
          console.error('[WebSocket] Erreur: Playmats ou token_officiel non trouvés', {
            playmatBottom,
            playmatTop,
            lifeToken
          });
          ack({ error: 'Erreur lors de la récupération des playmats ou du token' });
          return;
        }

        const availableDecks = availableDecksRaw.map((deck: any) => ({
          id: deck.id,
          name: deck.name,
          image: deck.image,
          infoImage: deck.infoImage,
        }));
        console.log('[DEBUG] availableDecks:', availableDecks);

        const playmats = [
          {
            id: playmatBottom.id,
            name: playmatBottom.name,
            image: playmatBottom.image,
          },
          {
            id: playmatTop.id,
            name: playmatTop.name,
            image: playmatTop.image,
          },
        ];

        const lifeTokenData = {
          id: lifeToken.id,
          name: lifeToken.name,
          image: lifeToken.image,
        };

        const newGame: ServerGameState = {
          gameId,
          players: [socket.id],
          chatHistory: [],
          state: {
            player1: {
              id: 'player1',
              nexus: { health: 30 },
              hand: [],
              field: Array(8).fill(null),
              opponentField: [],
              opponentHand: [],
              deck: [],
              graveyard: [],
              tokenPool: [],
              mustDiscard: false,
              hasPlayedCard: false,
              lifePoints: 30,
              tokenCount: 0,
              tokenType: null,
              mulliganDone: false,
              playmat: playmats[0] || { id: '', name: '', image: '' },
              actionPoints: 1
            },
            player2: {
              id: 'player2',
              nexus: { health: 30 },
              hand: [],
              field: Array(8).fill(null),
              opponentField: [],
              opponentHand: [],
              deck: [],
              graveyard: [],
              tokenPool: [],
              mustDiscard: false,
              hasPlayedCard: false,
              lifePoints: 30,
              tokenCount: 0,
              tokenType: null,
              mulliganDone: false,
              playmat: playmats[1] || { id: '', name: '', image: '' },
              actionPoints: 1
            },
            game: {
              turn: 1,
              currentPhase: 'Main',
              isMyTurn: false,
              activePlayerId: null,
              gameOver: false,
              winner: null,
              updateTimestamp: Date.now(),
            },
            revealedCards: [],
            turnState: {
              unitsDeployed: [],
              discardedCardsCount: 0,
              temporaryKeywords: [],
              preventDestructionCards: [],
              battlePhaseDisabled: false,
            },
            lastCardPlayed: undefined,
            lastDestroyedUnit: undefined,
            targetType: undefined,
            detected: false,
            currentCard: undefined,
          },
          deckChoices: { '1': [], '2': [] },
          availableDecks,
          playmats,
          lifeToken: lifeTokenData,
          createdAt: new Date(),
          status: 'waiting',
          playersReady: new Set<number>(),
          usernames: [data.username || 'anonymous'],
        };

        await gameRepository.insertGame(newGame);
        gameCache.setGame(gameId, newGame);
        playerManager.addPlayer(socket.id, { gameId, playerId: 1 });
        socket.join(gameId);
        if (socket.rooms.has('lobby')) {
          socket.leave('lobby');
        }
        await scheduleActiveGamesUpdate(io, gameRepository);

        const ackResponse = {
          gameId,
          playerId: 1,
          chatHistory: newGame.chatHistory,
          availableDecks: newGame.availableDecks,
          playmats: newGame.playmats,
          lifeToken: newGame.lifeToken,
        };
        console.log('[DEBUG] createGame - Ack envoyé:', ackResponse);
        ack(ackResponse);
      } catch (error) {
        console.error('[WebSocket] Erreur lors de la création de la partie:', error);
        ack({ error: 'Erreur lors de la création de la partie' });
      }
    });

    socket.on('joinGame', async (data, ack) => {
      console.log('[WebSocket] Événement joinGame reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, username } = JoinGameSchema.parse(data);
        const game = await gameRepository.findGameById(gameId);
        if (!game) {
          console.log('[WebSocket] Partie non trouvée:', gameId);
          socket.emit('gameNotFound');
          ack({ error: 'Partie non trouvée' });
          return;
        }

        const playerInfo = playerManager.getPlayer(socket.id);
        if (playerInfo && playerInfo.gameId && playerInfo.gameId !== gameId) {
          console.log('[WebSocket] Erreur: Joueur déjà dans une autre partie:', playerInfo.gameId);
          socket.emit('error', 'Vous êtes déjà dans une autre partie');
          ack({ error: 'Vous êtes déjà dans une autre partie' });
          return;
        }

        if (game.players.includes(socket.id)) {
          console.log('[WebSocket] Joueur déjà dans cette partie:', gameId, 'socket.id:', socket.id);
          socket.join(gameId);
          const clientGameState = mapServerToClientGameState(game, socket.id);
          socket.emit('updateGameState', clientGameState);
          const joinResponse = {
            playerId: playerInfo?.playerId || game.players.indexOf(socket.id) + 1,
            gameId,
            chatHistory: game.chatHistory,
            availableDecks: game.availableDecks,
            playmats: game.playmats,
            lifeToken: game.lifeToken,
          };
          socket.emit('playerJoined', joinResponse);
          console.log('[WebSocket] Émission de playerJoined à:', socket.id, 'avec:', joinResponse);
          ack(joinResponse);
          return;
        }

        if (game.players.length >= 2) {
          console.log('[WebSocket] Erreur: La partie est pleine:', gameId, 'players:', game.players);
          socket.emit('error', 'La partie est pleine');
          ack({ error: 'La partie est pleine' });
          return;
        }

        game.players.push(socket.id);
        game.usernames.push(data.username || 'anonymous');
        socket.join(gameId);
        const newPlayerId = game.players.length;
        playerManager.addPlayer(socket.id, { gameId, playerId: newPlayerId });

        const joinResponse = {
          playerId: newPlayerId,
          gameId,
          chatHistory: game.chatHistory,
          availableDecks: game.availableDecks,
          playmats: game.playmats,
          lifeToken: game.lifeToken,
        };

        socket.emit('playerJoined', joinResponse);
        console.log('[WebSocket] Émission de playerJoined à:', socket.id, 'avec:', joinResponse);

        ack(joinResponse);

        if (game.players.length === 2) {
          // Randomize who is Player 1 (50% chance to swap)
          if (Math.random() > 0.5) {
            // Swap players and usernames to randomize initiative
            [game.players[0], game.players[1]] = [game.players[1], game.players[0]];
            [game.usernames[0], game.usernames[1]] = [game.usernames[1], game.usernames[0]];
            console.log('[WebSocket] Randomized: Swapped Player 1 and Player 2');
          } else {
            console.log('[WebSocket] Randomized: Kept original Player 1 and Player 2');
          }

          const player1SocketId = game.players[0];
          const player2SocketId = game.players[1];
          playerManager.addPlayer(player1SocketId, { gameId, playerId: 1 });
          playerManager.addPlayer(player2SocketId, { gameId, playerId: 2 });
          game.state.game.activePlayerId = player1SocketId;
          console.log('[WebSocket] activePlayer défini:', game.state.game.activePlayerId, 'pour gameId:', gameId, 'timestamp:', new Date().toISOString());
          console.log('[DEBUG] joinGame - Joueurs attribués:', {
            player1SocketId,
            player1Id: playerManager.getPlayer(player1SocketId)?.playerId,
            player2SocketId,
            player2Id: playerManager.getPlayer(player2SocketId)?.playerId,
          });

          await gameRepository.updateGame(gameId, {
            players: [player1SocketId, player2SocketId],
            usernames: game.usernames, // Updated if swapped
            state: {
              ...game.state,
              game: { ...game.state.game, activePlayerId: player1SocketId, updateTimestamp: Date.now() }
            },
            status: 'started',
          });
          gameCache.setGame(gameId, game);
          await scheduleActiveGamesUpdate(io, gameRepository);
          console.log(`[WebSocket] Partie ${gameId} mise à jour, statut: started, joueurs: ${game.players}, timestamp: ${new Date().toISOString()}`);

          game.players.forEach((playerSocketId: string) => {
            const clientGameState = mapServerToClientGameState(game, playerSocketId);
            io.to(playerSocketId).emit('updateGameState', clientGameState);
          });

          const gameStartDataPlayer1 = {
            playerId: playerManager.getPlayer(player1SocketId)?.playerId || 1,
            gameId,
            chatHistory: game.chatHistory,
            availableDecks: game.availableDecks,
            playmats: game.playmats,
            lifeToken: game.lifeToken,
          };
          const gameStartDataPlayer2 = {
            playerId: playerManager.getPlayer(player2SocketId)?.playerId || 2,
            gameId,
            chatHistory: game.chatHistory,
            availableDecks: game.availableDecks,
            playmats: game.playmats,
            lifeToken: game.lifeToken,
          };

          io.to(player1SocketId).emit('gameStart', gameStartDataPlayer1);
          io.to(player2SocketId).emit('gameStart', gameStartDataPlayer2);
          io.to(player2SocketId).emit('waitingForPlayer1Choice', { waiting: true });
          console.log(`[WebSocket] Émission de waitingForPlayer1Choice à player2 (${player2SocketId}):`, { waiting: true }, 'timestamp:', new Date().toISOString());
          io.to(gameId).emit('initialDeckList', game.availableDecks);
          io.to(gameId).emit('deckSelectionUpdate', game.deckChoices);
        } else {
          socket.emit('waiting', { gameId, message: 'En attente d\'un autre joueur...' });
          console.log(`[WebSocket] Socket ${socket.id} en attente d'un autre joueur pour ${gameId}, timestamp: ${new Date().toISOString()}`);
          await scheduleActiveGamesUpdate(io, gameRepository);
        }
      } catch (error) {
        console.error('[WebSocket] Erreur lors de la jointure de la partie:', error);
        socket.emit('error', 'Erreur lors de la jointure de la partie');
        ack({ error: 'Erreur lors de la jointure de la partie' });
      }
    });

    socket.on('checkPlayerGame', async (data, callback) => {
      console.log('[WebSocket] Événement checkPlayerGame reçu:', data, 'socket.id:', socket.id);
      try {
        const { username } = z.object({ username: z.string() }).parse(data);
        const games = await gameRepository.findActiveGames();
        const playerGame = games.find((game) => game.usernames.includes(username));
        if (playerGame) {
          const fullGame = await gameRepository.findGameById(playerGame.gameId);
          if (fullGame) {
            const playerIndex = fullGame.usernames.indexOf(username);
            const playerId = playerIndex + 1;
            callback({
              exists: true,
              gameId: fullGame.gameId,
              availableDecks: fullGame.availableDecks,
              status: fullGame.status,
              playerId
            });
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
          await scheduleActiveGamesUpdate(io, gameRepository);
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
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour playCard, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        const opponentKey = playerInfo.playerId === 1 ? 'player2' : 'player1';
        if (game.state.game.currentPhase !== 'Main') {
          console.log('[WebSocket] Erreur: Phase incorrecte pour jouer une carte', {
            currentPhase: game.state.game.currentPhase,
          });
          socket.emit('error', 'Impossible de jouer une carte en dehors de la phase Main');
          return;
        }

        const playerActionPoints = game.state[playerKey].actionPoints || 0;
        console.log('[WebSocket] Vérification des points d\'action:', {
          playerActionPoints,
          cardCost: card.cost,
          playerKey,
          gameId,
        });
        if (playerActionPoints < card.cost) {
          console.log('[WebSocket] Erreur: Pas assez de points d\'action', {
            playerActionPoints,
            cardCost: card.cost,
            playerKey,
            gameId,
          });
          socket.emit('error', 'Pas assez de points d\'action pour jouer cette carte');
          return;
        }

        // Place the card on the field
        game.state[playerKey].field[fieldIndex] = CardSchema.parse({
          ...card,
          exhausted: false,
          effects: card.effects || {},
        });
        game.state[playerKey].hand = game.state[playerKey].hand.filter((c: Card) => c.id !== card.id);
        game.state[playerKey].actionPoints = playerActionPoints - card.cost;
        game.state[playerKey].opponentHand = Array(game.state[opponentKey].hand.length).fill({
          id: 'hidden',
          name: 'Hidden Card',
          image: 'unknown',
          exhausted: false,
        });
        game.state[opponentKey].opponentHand = Array(game.state[playerKey].hand.length).fill({
          id: 'hidden',
          name: 'Hidden Card',
          image: 'unknown',
          exhausted: false,
        });
        game.state[playerKey].mulliganDone = true;

        console.log('[WebSocket] Carte jouée avec succès:', {
          cardId: card.id,
          fieldIndex,
          newActionPoints: game.state[playerKey].actionPoints,
          playerKey,
          gameId,
        });

        // Trigger 'on_play' effects using EffectManager
        const opponentSocketId = game.players.find(id => id !== socket.id);
        if (!opponentSocketId) {
          console.error('[WebSocket] Opponent socket ID not found');
          return;
        }

        // Map to client GameState for the current player (EffectManager expects GameState)
        const clientGameState = mapServerToClientGameState(game, socket.id);

        // Create GameContext
        const gameContext: GameContext = {
          gameState: clientGameState,
          io,
          socket,
          playerId: socket.id,
          opponentId: opponentSocketId,
        };

        // Set currentCard for effects that need it
        clientGameState.currentCard = card;

        // Execute effects
        const effectManager = new EffectManager(gameContext);
        await effectManager.executeEffects(card, 'on_play');

        // Map back modified state to server (copy relevant properties that effects might have changed)
        // Assuming effects can modify hand, field, graveyard, nexus, turnState, etc.
        game.state[playerKey].hand = clientGameState.player.hand;
        game.state[playerKey].field = clientGameState.player.field;
        game.state[playerKey].graveyard = clientGameState.player.graveyard;
        game.state[playerKey].nexus = clientGameState.player.nexus;
        game.state[playerKey].tokenPool = clientGameState.player.tokenPool;
        game.state[playerKey].tokenCount = clientGameState.player.tokenCount;

        // Pour l'opposant : copier seulement les propriétés potentiellement modifiées (ex: field, nexus, tokenPool), PAS la main (qui est cachée et non modifiée)
        game.state[opponentKey].field = clientGameState.opponent.field;
        game.state[opponentKey].graveyard = clientGameState.opponent.graveyard;
        game.state[opponentKey].nexus = clientGameState.opponent.nexus;
        game.state[opponentKey].tokenPool = clientGameState.opponent.tokenPool;
        game.state[opponentKey].tokenCount = clientGameState.opponent.tokenCount;

        game.state.turnState = clientGameState.turnState;
        game.state.revealedCards = clientGameState.revealedCards;
        game.state.lastCardPlayed = clientGameState.lastCardPlayed;
        game.state.lastDestroyedUnit = clientGameState.lastDestroyedUnit;
        game.state.targetType = clientGameState.targetType;
        game.state.detected = clientGameState.detected;
        game.state.currentCard = clientGameState.currentCard;

        // Update opponent views (hidden hands)
        game.state[playerKey].opponentHand = Array(game.state[opponentKey].hand.length).fill({
          id: 'hidden',
          name: 'Hidden Card',
          image: 'unknown',
          exhausted: false,
        });
        game.state[opponentKey].opponentHand = Array(game.state[playerKey].hand.length).fill({
          id: 'hidden',
          name: 'Hidden Card',
          image: 'unknown',
          exhausted: false,
        });

        // Save and emit
        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          console.log('[WebSocket] Envoi de updateGameState pour playerSocketId:', playerSocketId, 'avec isMyTurn:', game.state.game.activePlayerId === playerSocketId, 'timestamp:', new Date().toISOString());
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
          if (!game.availableDecks.some((deck: { id: string; name: string; image: string; infoImage: string }) => deck.id === data.deckId)) {
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
          if (!game.availableDecks.some((deck: { id: string; name: string; image: string; infoImage: string }) => deck.id === data.deckId)) {
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
                (deck: { id: string; name: string; image: string; infoImage: string }) => !game.deckChoices['1'].includes(deck.id) && !game.deckChoices['2'].includes(deck.id)
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
        io.to(data.gameId).emit('playerReady', { playerId: data.playerId });

        if (game.playersReady.size === 2 && game.deckChoices['1'].length >= 2 && game.deckChoices['2'].length >= 2) {
          console.log('[WebSocket] bothPlayersReady, envoi de l\'état initial pour gameId:', data.gameId, 'activePlayer:', game.state.game.activePlayerId, 'timestamp:', new Date().toISOString());
          io.to(data.gameId).emit('bothPlayersReady', { bothReady: true });
          game.state.game.currentPhase = 'Main';
          game.state.game.turn = 1;
          game.state.game.activePlayerId = game.players[0];

          for (const playerId of ['1', '2'] as const) {
            const playerSocketId = game.players.find((p: string) => playerManager.getPlayer(p)?.playerId === Number(playerId));
            if (!playerSocketId) {
              console.error(`[WebSocket] Erreur : Socket non trouvé pour playerId: ${playerId}`, 'timestamp:', new Date().toISOString());
              continue;
            }
            const selectedDeckIds = game.deckChoices[playerId];
            console.log('[DEBUG] selectedDeckIds:', selectedDeckIds);
            const deck: Card[] = [];
            for (const deckId of selectedDeckIds) {
              const deckList = await db.collection('decklists').findOne({ id: deckId });
              if (!deckList) {
                console.error(`[WebSocket] Erreur : Deck ${deckId} non trouvé`, 'timestamp:', new Date().toISOString());
                continue;
              }
              console.log('[DEBUG] deckList:', deckList);
              const cardIds = deckList.cardIds;
              console.log('[DEBUG] cardIds:', cardIds);
              const deckCards = await db.collection('card').find({ id: { $in: cardIds } }).toArray();
              console.log('[DEBUG] deckCards:', deckCards);
              const validatedCards = deckCards.map(card => {
                try {
                  return CardSchema.parse({
                    ...card,
                    exhausted: false,
                  });
                } catch (error) {
                  console.error(`[WebSocket] Erreur de validation pour la carte ${card.id}:`, error);
                  return null;
                }
              }).filter((card): card is Card => card !== null);
              console.log('[DEBUG] validatedCards:', validatedCards);
              deck.push(...validatedCards);
            }
            console.log('[DEBUG] deck:', deck);

            const shuffledDeck = deck.sort(() => Math.random() - 0.5);
            const initialDraw = shuffledDeck.slice(0, 5);
            const remainingDeck = shuffledDeck.slice(5);
            console.log('[DEBUG] initialDraw:', initialDraw, 'remainingDeck:', remainingDeck);

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
            game.state[playerKey].mulliganDone = false;
            game.state[playerKey].actionPoints = 1;
          }

          await gameRepository.updateGame(data.gameId, { state: game.state });
          gameCache.setGame(data.gameId, game);

          game.players.forEach((playerSocketId: string) => {
            const clientGameState = mapServerToClientGameState(game, playerSocketId);
            console.log('[WebSocket] Envoi de updateGameState après bothPlayersReady pour playerSocketId:', playerSocketId, 'isMyTurn:', clientGameState.game.isMyTurn, 'actionPoints:', clientGameState.player.actionPoints, 'timestamp:', new Date().toISOString());
            io.to(playerSocketId).emit('updateGameState', clientGameState);
          });

          io.to(data.gameId).emit('mulliganPhaseStart', { gameId: data.gameId });
          io.to(data.gameId).emit('phaseChangeMessage', {
            phase: 'Main',
            turn: 1,
            nextPlayerId: 1,
          });
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
            actionPoints: z.number().optional(),
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

        console.log('[WebSocket] État avant mise à jour:', {
          playerActionPoints: game.state[playerKey].actionPoints,
          clientActionPoints: clientState.actionPoints,
          playerKey,
          gameId,
        });

        if (clientState.deckSelection?.mulliganDone && !game.state[playerKey].mulliganDone) {
          game.state[playerKey].mulliganDone = clientState.deckSelection.mulliganDone;
        } else if (game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour updateGameState (pas le joueur actif), gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé - pas votre tour');
          return;
        }

        if (clientState.hand) {
          game.state[playerKey].hand = clientState.hand;
          game.state[opponentKey].opponentHand = Array(clientState.hand.length).fill({
            id: 'hidden',
            name: 'Hidden Card',
            image: 'unknown',
            exhausted: false,
          });
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
        if (clientState.actionPoints !== undefined) {
          console.warn('[WebSocket] Tentative de mise à jour de actionPoints via updateGameState ignorée:', {
            clientActionPoints: clientState.actionPoints,
            serverActionPoints: game.state[playerKey].actionPoints,
          });
        }

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        console.log('[WebSocket] État après mise à jour:', {
          playerActionPoints: game.state[playerKey].actionPoints,
          playerKey,
          gameId,
        });

        game.players.forEach((playerSocketId: string) => {
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
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour exhaustCard, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        if (game.state.game.currentPhase !== 'Main') {
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

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action exhaustCard:', error);
        socket.emit('error', 'Erreur lors de l\'épuisement de la carte');
      }
    });

    socket.on('attackCard', async (data) => {
      console.log('[WebSocket] Événement attackCard reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, cardId } = z.object({ gameId: z.string(), cardId: z.string() }).parse(data);
        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour attackCard, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        const opponentKey = playerInfo.playerId === 1 ? 'player2' : 'player1';
        if (game.state.game.currentPhase !== 'Battle') {
          socket.emit('error', 'Impossible d’attaquer en dehors de la phase Battle');
          return;
        }

        const cardIndex = game.state[playerKey].field.findIndex((c: Card) => c?.id === cardId);
        if (cardIndex === -1) {
          socket.emit('error', 'Carte non trouvée sur le terrain');
          return;
        }

        const attackingCard = game.state[playerKey].field[cardIndex];
        const dmg = attackingCard.types[0].value;  // Assumer value = atk power
        game.state[opponentKey].nexus.health -= dmg;
        game.state[opponentKey].lifePoints = game.state[opponentKey].nexus.health;  // Lier

        const effectManager = new EffectManager({
          gameState: mapServerToClientGameState(game, socket.id),
          io,
          socket,
          playerId: socket.id,
          opponentId: game.players.find(id => id !== socket.id)!,
        });
        await effectManager.executeEffects(attackingCard, 'on_hit_nexus');

        game.state[playerKey].field[cardIndex] = null;
        game.state[playerKey].graveyard.push(attackingCard);

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de attackCard:', error);
        socket.emit('error', 'Erreur lors de l’attaque');
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
        console.log('[DEBUG] updatePhase - Vérification autorisation:', {
          gameId,
          socketId: socket.id,
          playerInfo,
          activePlayer: game?.state.game.activePlayerId,
          gameExists: !!game,
          playerInfoExists: !!playerInfo,
          gameIdMatch: playerInfo?.gameId === gameId,
          isActivePlayer: game?.state.game.activePlayerId === socket.id,
          expectedTurn: game?.state.game.turn,
          receivedTurn: turn,
        });

        if (!game || !playerInfo || playerInfo.gameId !== gameId) {
          console.log('[WebSocket] Erreur: Non autorisé pour updatePhase, détails:', {
            gameExists: !!game,
            playerInfoExists: !!playerInfo,
            gameIdMatch: playerInfo?.gameId === gameId,
          });
          socket.emit('error', 'Non autorisé - Informations de jeu ou joueur manquantes');
          return;
        }

        if (game.state.game.activePlayerId !== socket.id) {
          console.warn('[WebSocket] Avertissement: Joueur non actif tente updatePhase:', {
            socketId: socket.id,
            activePlayer: game.state.game.activePlayerId,
            playerId: playerInfo.playerId,
          });
          socket.emit('error', 'Non autorisé - Pas votre tour');
          return;
        }

        if (game.state.game.turn !== turn) {
          console.warn('[WebSocket] Erreur: Tour non synchronisé:', {
            expectedTurn: game.state.game.turn,
            receivedTurn: turn,
          });
          socket.emit('error', 'Tour non synchronisé');
          return;
        }

        const validTransitions: { [key: string]: string[] } = {
          Standby: ['Main'],
          Main: ['Battle'],
          Battle: ['End'],
          End: ['Standby'],
        };
        if (!validTransitions[game.state.game.currentPhase]?.includes(phase)) {
          console.warn('[WebSocket] Erreur: Transition de phase invalide:', {
            currentPhase: game.state.game.currentPhase,
            requestedPhase: phase,
          });
          socket.emit('error', 'Transition de phase invalide');
          return;
        }

        game.state.game.currentPhase = phase;
        game.state.game.updateTimestamp = Date.now();
        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          console.log('[DEBUG] updatePhase - Envoi updateGameState à:', {
            playerSocketId,
            isMyTurn: clientGameState.game.isMyTurn,
            phase: clientGameState.game.currentPhase,
            turn: clientGameState.game.turn,
            updateTimestamp: game.state.game.updateTimestamp,
          });
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });

        io.to(gameId).emit('updatePhase', { gameId, phase, turn });
        io.to(gameId).emit('phaseChangeMessage', { phase, turn, nextPlayerId: playerInfo.playerId });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action updatePhase:', error);
        socket.emit('error', 'Erreur lors du changement de phase');
      }
    });

    socket.on('updateLifePoints', async (data) => {
      console.log('[WebSocket] Événement updateLifePoints reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, lifePoints } = z.object({ gameId: z.string(), lifePoints: z.number() }).parse(data);
        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour updateLifePoints, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        game.state[playerKey].lifePoints = lifePoints;
        game.state[playerKey].nexus.health = lifePoints;  // Lier les deux

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de updateLifePoints:', error);
        socket.emit('error', 'Erreur lors de la mise à jour des points de vie');
      }
    });

    socket.on('updateTokenCount', async (data) => {
      console.log('[WebSocket] Événement updateTokenCount reçu:', data, 'socket.id:', socket.id);
      try {
        const { gameId, tokenCount } = z.object({ gameId: z.string(), tokenCount: z.number() }).parse(data);
        const game = await gameRepository.findGameById(gameId);
        const playerInfo = playerManager.getPlayer(socket.id);
        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour updateTokenCount, gameId:', gameId, 'playerInfo:', playerInfo);
          socket.emit('error', 'Non autorisé');
          return;
        }

        const playerKey = playerInfo.playerId === 1 ? 'player1' : 'player2';
        game.state[playerKey].tokenCount = tokenCount;

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de updateTokenCount:', error);
        socket.emit('error', 'Erreur lors de la mise à jour du nombre de tokens');
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
        console.log('[DEBUG] endTurn - Vérification initiale:', {
          gameId,
          socketId: socket.id,
          playerInfo,
          activePlayer: game?.state.game.activePlayerId,
          gameExists: !!game,
          playerInfoExists: !!playerInfo,
          gameIdMatch: playerInfo?.gameId === gameId,
          isActivePlayer: game?.state.game.activePlayerId === socket.id,
        });

        if (!game || !playerInfo || playerInfo.gameId !== gameId || game.state.game.activePlayerId !== socket.id) {
          console.log('[WebSocket] Erreur: Non autorisé pour endTurn, détails:', {
            gameExists: !!game,
            playerInfoExists: !!playerInfo,
            gameIdMatch: playerInfo?.gameId === gameId,
            isActivePlayer: game?.state.game.activePlayerId === socket.id,
          });
          socket.emit('error', 'Non autorisé');
          return;
        }

        const currentPlayerId = playerInfo.playerId;
        const nextPlayerSocketId = playerManager.findPlayerByGameIdAndPlayerId(gameId, nextPlayerId);
        if (!nextPlayerSocketId) {
          console.log('[WebSocket] Erreur: nextPlayerSocketId non trouvé pour playerId:', nextPlayerId);
          socket.emit('error', 'Joueur suivant non trouvé');
          return;
        }

        console.log('[DEBUG] endTurn - Avant changement:', {
          gameId,
          currentPlayerId,
          currentSocketId: socket.id,
          nextPlayerId,
          nextPlayerSocketId,
          turn: game.state.game.turn,
          phase: game.state.game.currentPhase,
        });

        game.state.game.activePlayerId = nextPlayerSocketId;
        game.state.game.turn += 1;
        game.state.game.currentPhase = 'Standby';
        game.state.game.updateTimestamp = Date.now();
        const nextPlayerKey = nextPlayerId === 1 ? 'player1' : 'player2';
        const opponentKey = nextPlayerId === 1 ? 'player2' : 'player1';

        game.state.player1.hasPlayedCard = false;
        game.state.player2.hasPlayedCard = false;
        game.state.player1.mustDiscard = false;
        game.state.player2.mustDiscard = false;
        game.state.player1.actionPoints = 1;
        game.state.player2.actionPoints = 1;

        game.state.player1.field = game.state.player1.field.map((card: Card | null) => card ? { ...card, exhausted: false } : null);
        game.state.player2.field = game.state.player2.field.map((card: Card | null) => card ? { ...card, exhausted: false } : null);

        game.state.player1.opponentField = [...game.state.player2.field];
        game.state.player2.opponentField = [...game.state.player1.field];

        if (game.state.game.turn > 1 && game.state[nextPlayerKey].deck.length > 0 && game.state[nextPlayerKey].hand.length < 10) {
          const drawnCard = drawCardServer(game, nextPlayerKey);
          console.log('[DEBUG] Automatic draw in endTurn:', {
            nextPlayerKey,
            drawnCard,
            handLength: game.state[nextPlayerKey].hand.length,
            deckLength: game.state[nextPlayerKey].deck.length,
          });

          if (drawnCard && drawnCard.types.some(type => type.type === 'unit' && type.subTypes === 'token') && game.state[opponentKey].tokenType === 'assassin') {
            console.log('[DEBUG] Assassin Token drawn in endTurn, applying effects');
            game.state[nextPlayerKey].lifePoints = Math.max(0, game.state[nextPlayerKey].lifePoints! - 2);
            game.state[opponentKey].tokenCount = Math.min(game.state[opponentKey].tokenCount! + 1, 8);

            let newDrawnCard: Card | null = null;
            if (game.state[nextPlayerKey].deck.length > 0) {
              newDrawnCard = drawCardServer(game, nextPlayerKey);
              console.log('[DEBUG] Repioche after Assassin Token in endTurn:', { newDrawnCard });
            } else {
              console.log('[DEBUG] No cards left to repioche');
            }

            game.state[nextPlayerKey].opponentHand = Array(game.state[opponentKey].hand.length).fill({
              id: 'hidden',
              name: 'Hidden Card',
              image: 'unknown',
              exhausted: false,
            });
            game.state[opponentKey].opponentHand = Array(game.state[nextPlayerKey].hand.length).fill({
              id: 'hidden',
              name: 'Hidden Card',
              image: 'unknown',
              exhausted: false,
            });

            io.to(gameId).emit('handleAssassinTokenDraw', {
              playerLifePoints: game.state[nextPlayerKey].lifePoints,
              opponentTokenCount: game.state[opponentKey].tokenCount,
            });
          }
        }

        game.state.player1.opponentHand = Array(game.state.player2.hand.length).fill({
          id: 'hidden',
          name: 'Hidden Card',
          image: 'unknown',
          exhausted: false,
        });
        game.state.player2.opponentHand = Array(game.state.player1.hand.length).fill({
          id: 'hidden',
          name: 'Hidden Card',
          image: 'unknown',
          exhausted: false,
        });

        await gameRepository.updateGame(gameId, { state: game.state });
        gameCache.setGame(gameId, game);

        game.players.forEach((playerSocketId: string) => {
          const clientGameState = mapServerToClientGameState(game, playerSocketId);
          console.log('[DEBUG] endTurn - Envoi updateGameState à:', {
            playerSocketId,
            isMyTurn: clientGameState.game.isMyTurn,
            phase: clientGameState.game.currentPhase,
            turn: clientGameState.game.turn,
            updateTimestamp: game.state.game.updateTimestamp,
          });
          io.to(playerSocketId).emit('updateGameState', clientGameState);
        });

        io.to(gameId).emit('endTurn');
        console.log('[DEBUG] endTurn - Émission yourTurn à:', { nextPlayerSocketId });
        io.to(nextPlayerSocketId).emit('yourTurn');
        io.to(gameId).emit('updatePhase', { gameId, phase: 'Standby', turn: game.state.game.turn });
        io.to(gameId).emit('phaseChangeMessage', { phase: 'Standby', turn: game.state.game.turn, nextPlayerId });

        await checkWinCondition(gameId, game, gameRepository, gameCache, io);

        console.log('[DEBUG] endTurn - Après émission:', {
          gameId,
          activePlayer: game.state.game.activePlayerId,
          phase: game.state.game.currentPhase,
          turn: game.state.game.turn,
          updateTimestamp: game.state.game.updateTimestamp,
        });
      } catch (error) {
        console.error('[WebSocket] Erreur lors de l\'action endTurn:', error);
        socket.emit('error', 'Erreur lors du changement de tour');
      }
    });
  });
}