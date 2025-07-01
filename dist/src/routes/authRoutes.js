import { Router } from 'express';
import { ObjectId } from 'mongodb';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
const router = Router();
const RegisterSchema = z.object({
    username: z.string().min(3).max(20),
    password: z.string().min(6),
});
const LoginSchema = z.object({
    username: z.string().min(3).max(20),
    password: z.string().min(6),
});
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        res.status(401).json({ error: 'Token requis' });
        return;
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const db = req.db;
        if (!db) {
            res.status(500).json({ error: 'Base de données non disponible' });
            return;
        }
        const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
        if (!user) {
            res.status(401).json({ error: 'Utilisateur non trouvé' });
            return;
        }
        if (!user.username || !user.password || !user.createdAt) {
            res.status(500).json({ error: 'Données utilisateur invalides' });
            return;
        }
        req.user = user;
        next();
    }
    catch (error) {
        console.error('Erreur de vérification du token:', error);
        res.status(403).json({ error: 'Token invalide' });
    }
};
export const setupAuthRoutes = (db) => {
    router.post('/register', async (req, res) => {
        try {
            const { username, password } = RegisterSchema.parse(req.body);
            const usersCollection = db.collection('users');
            const existingUser = await usersCollection.findOne({ username });
            if (existingUser) {
                res.status(400).json({ error: 'Nom d\'utilisateur déjà pris' });
                return;
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            const userInsert = {
                username,
                password: hashedPassword,
                createdAt: new Date(),
            };
            const result = await usersCollection.insertOne(userInsert);
            const token = jwt.sign({ userId: result.insertedId.toString() }, process.env.JWT_SECRET, {
                expiresIn: '30d',
            });
            res.status(201).json({ token, username });
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({ errors: error.errors });
            }
            else {
                res.status(500).json({ error: 'Erreur serveur' });
            }
        }
    });
    router.post('/login', async (req, res) => {
        try {
            const { username, password } = LoginSchema.parse(req.body);
            const usersCollection = db.collection('users');
            const user = await usersCollection.findOne({ username });
            if (!user) {
                res.status(401).json({ error: 'Nom d\'utilisateur ou mot de passe incorrect' });
                return;
            }
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                res.status(401).json({ error: 'Nom d\'utilisateur ou mot de passe incorrect' });
                return;
            }
            const token = jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET, {
                expiresIn: '30d',
            });
            console.log(`[POST /api/login] Utilisateur connecté: ${username} timestamp: ${new Date().toISOString()}`);
            res.json({ token, username });
        }
        catch (error) {
            console.error('Erreur lors de la connexion:', error);
            if (error instanceof z.ZodError) {
                res.status(400).json({ errors: error.errors });
                return;
            }
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });
    router.get('/verify', authenticateToken, async (req, res) => {
        console.log(`[GET /api/verify] Token vérifié pour utilisateur: ${req.user.username} timestamp: ${new Date().toISOString()}`);
        res.json({ username: req.user.username });
    });
    return router;
};
