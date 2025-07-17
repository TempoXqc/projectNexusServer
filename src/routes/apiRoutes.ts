// server/src/routes/apiRoutes.ts
import { Router, Request, Response } from 'express';
import { GameRepository } from '../database/gameRepository.js';
import { z } from 'zod';
import { Db } from 'mongodb';

const ActiveGameSchema = z.object({
  gameId: z.string(),
  status: z.enum(['waiting', 'started']),
  createdAt: z.date(),
  players: z.array(z.string()),
});

// Schéma pour valider la backcard
const BackcardSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
});

export function initializeRoutes(db: Db) {
  const gameRepository = new GameRepository(db);
  const router = Router();

  // Route existante pour les parties
  router.get('/games', async (_req: Request, res: Response) => {
    try {
      const activeGames = await gameRepository.findActiveGames();
      const validatedGames = z.array(ActiveGameSchema).parse(activeGames);
      res.status(200).json(validatedGames);
    } catch (error: unknown) {
      console.error('Erreur lors de la récupération des parties:', error);
      res.status(500).json({ error: 'Erreur serveur lors de la récupération des parties' });
    }
  });

  // Nouvelle route pour récupérer la backcard
  router.get('/backcard', async (_req: Request, res: Response) => {
    try {
      const backcardCollection = db.collection('backcard');
      const backcard = await backcardCollection.findOne({ id: 'backcard_officiel' });
      if (!backcard) {
        return res.status(404).json({ error: 'Backcard non trouvée' });
      }
      const validatedBackcard = BackcardSchema.parse(backcard);
      res.status(200).json(validatedBackcard);
    } catch (error: unknown) {
      console.error('Erreur lors de la récupération de la backcard:', error);
      res.status(500).json({ error: 'Erreur serveur lors de la récupération de la backcard' });
    }
  });

  router.get('/playmats', async (_req: Request, res: Response) => {
    try {
      const playmats = await db
          .collection('playmats')
          .aggregate([{ $sample: { size: 2 } }])
          .toArray();
      res.json(playmats);
    } catch (error) {
      console.error('Erreur lors de la récupération des playmats:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  router.get('/card', async (req, res) => {
    const cards = await db.collection('card').find().toArray();
    res.json(cards);
  });


  return router;
}

export default initializeRoutes;