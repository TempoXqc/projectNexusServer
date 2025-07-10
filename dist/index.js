// server/src/index.ts
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { setupAuthRoutes } from './routes/authRoutes.js';
import * as path from 'node:path';
import { fileURLToPath } from 'url';
import { serverConfig } from './config/serverConfig.js';
import { registerSocketHandlers } from './sockets/socketHandlers.js';
import { z } from 'zod';
import initializeRoutes from "./routes/apiRoutes.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    process.exit(1);
}
const app = express();
const server = createServer(app);
app.use((req, _res, next) => {
    next();
});
app.use(cors({
    origin: (origin, callback) => {
        const allowedOrigins = serverConfig.corsOrigins.map(o => o.replace(/^https?:\/\//, '')); // Supprimer le protocole
        const normalizedOrigin = origin ? origin.replace(/^https?:\/\//, '') : '';
        if (!origin || allowedOrigins.includes(normalizedOrigin)) {
            callback(null, origin || '*');
        }
        else {
            callback(new Error('Origine non autorisée'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));
const io = new Server(server, {
    cors: {
        origin: serverConfig.corsOrigins,
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['websocket', 'polling'],
});
const client = new MongoClient(MONGODB_URI);
const BackcardSchema = z.object({
    id: z.string(),
    name: z.string(),
    image: z.string(),
});
async function connectToMongoDB() {
    try {
        await client.connect();
        const db = client.db('projectNexus');
        await db.collection('games').createIndex({ gameId: 1 });
        await db.collection('users').createIndex({ username: 1 }, { unique: true });
        return db;
    }
    catch (error) {
        process.exit(1);
    }
}
async function startServer() {
    const db = await connectToMongoDB();
    app.use((req, _res, next) => {
        req.db = db;
        next();
    });
    app.use(express.json());
    app.use('/api', setupAuthRoutes(db));
    app.use('/api', initializeRoutes(db));
    app.get('/api/games', async (_req, res) => {
        try {
            const gamesCollection = db.collection('games');
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
            res.json(activeGames);
        }
        catch (error) {
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });
    app.get('/api/backcard', async (_req, res) => {
        try {
            const backcardCollection = db.collection('backcard');
            const backcard = await backcardCollection.findOne({ id: 'backcard_officiel' });
            const validatedBackcard = BackcardSchema.parse(backcard);
            res.json(validatedBackcard);
        }
        catch (error) {
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });
    await registerSocketHandlers(io, db);
    const PORT = serverConfig.port;
    server.listen(PORT, () => {
        console.log(`Serveur démarré sur le port ${PORT}`);
    });
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
(async () => {
    try {
        await startServer();
    }
    catch (error) {
        console.error('Erreur lors du démarrage du serveur:', error);
        process.exit(1);
    }
})();
