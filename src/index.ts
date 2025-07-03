import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';
import { registerSocketHandlers } from './sockets/socketHandlers.js';
import { setupAuthRoutes } from './routes/authRoutes.js';
import * as path from 'node:path';
import { fileURLToPath } from 'url';
import { serverConfig } from './config/serverConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger le fichier .env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Valider les variables d'environnement
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Erreur : La variable d\'environnement MONGODB_URI est manquante');
  process.exit(1);
}

console.log('[DEBUG] Mongo URI utilisée :', MONGODB_URI.replace(/:([^@]+)@/, ':****@'));
console.log('[DEBUG] Origines CORS autorisées :', serverConfig.corsOrigins);

const app = express();
const server = createServer(app);

// Configurer CORS pour HTTP
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[CORS] Requête reçue: ${req.method} ${req.url} Origine: ${req.headers.origin}`);
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = serverConfig.corsOrigins.map(o => o.replace(/^https?:\/\//, '')); // Supprimer le protocole
    const normalizedOrigin = origin ? origin.replace(/^https?:\/\//, '') : '';
    console.log(`[CORS] Vérification de l'origine: ${origin} (normalisée: ${normalizedOrigin}), Allowed: ${allowedOrigins}`);
    if (!origin || allowedOrigins.includes(normalizedOrigin)) {
      callback(null, origin || '*');
    } else {
      console.error(`[CORS] Origine non autorisée: ${origin}`);
      callback(new Error('Origine non autorisée'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Configurer CORS pour WebSocket
const io = new Server(server, {
  cors: {
    origin: serverConfig.corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/addons', express.static('addons'));

const client = new MongoClient(MONGODB_URI);

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('Connecté à MongoDB');
    const db = client.db('projectNexus');
    await db.collection('games').createIndex({ gameId: 1 });
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    return db;
  } catch (error) {
    console.error('Erreur de connexion à MongoDB:', error);
    process.exit(1);
  }
}

async function startServer() {
  const db = await connectToMongoDB();

  // Middleware pour passer db aux routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.db = db;
    next();
  });

  // Configurer les routes d'authentification
  app.use('/api', setupAuthRoutes(db));

  // Endpoint pour les parties actives
  app.get('/api/games', async (req: Request, res: Response) => {
    try {
      const gamesCollection = db.collection('games');
      console.log('[API] Requête /api/games reçue', new Date().toISOString());
      const activeGames = await gamesCollection
          .find({
            status: { $in: ['waiting', 'started'] },
          })
          .project({
            gameId: 1,
            status: 1,
            createdAt: 1,
            players: 1,
            _id: 0,
          })
          .toArray();
      console.log('[API] Parties trouvées:', activeGames, new Date().toISOString());
      res.json(activeGames);
    } catch (error) {
      console.error('[API] Erreur lors de la récupération des parties:', error, new Date().toISOString());
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // Gestion des connexions WebSocket
  io.on('connection', (socket) => {
    console.log('[WebSocket] Nouvelle connexion:', socket.id, 'depuis:', socket.handshake.headers.origin);
    socket.on('connect_error', (error) => {
      console.error('[WebSocket] Erreur de connexion pour socket:', socket.id, 'Erreur:', error);
    });
    socket.on('disconnect', (reason) => {
      console.log('[WebSocket] Déconnexion:', socket.id, 'Raison:', reason);
    });
  });

  const PORT = serverConfig.port;
  server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
  });

  // Nettoyage des parties inactives (toutes les heures)
  setInterval(async () => {
    const gamesCollection = db.collection('games');
    await gamesCollection.deleteMany({
      createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    console.log('Parties inactives supprimées');
    const activeGames = await gamesCollection
        .find({
          status: { $in: ['waiting', 'started'] },
        })
        .project({
          gameId: 1,
          status: 1,
          createdAt: 1,
          players: 1,
          _id: 0,
        })
        .toArray();
    io.emit('activeGamesUpdate', activeGames);
  }, 60 * 60 * 1000);
}

startServer();