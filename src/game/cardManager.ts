// server/src/game/cardManager.ts
import { Db } from 'mongodb';
import { Card, CardSchema } from '@tempoxqc/project-nexus-types';

interface DeckDocument {
  id: string;
  name: string;
  cardIds: string[];
  image?: string;
  infoImage?: string;
}

export class CardManager {
  private deckLists: { [key: string]: string[] };
  private allCards: Card[];
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.deckLists = {};
    this.allCards = [];
  }

  async initialize() {
    await this.loadData();
  }

  private async loadData() {
    try {
      const deckListsCollection = this.db.collection('decklists');
      const deckListsDocs = await deckListsCollection.find<DeckDocument>({}).toArray();
      if (deckListsDocs.length === 0) {
        console.warn('[CardManager] Aucune donnée trouvée dans la collection decklists, initialisation avec deckLists vide', 'timestamp:', new Date().toISOString());
        this.deckLists = {};
      } else {
        this.deckLists = deckListsDocs.reduce((acc, doc) => {
          acc[doc.id.toString()] = doc.cardIds;
          return acc;
        }, {} as { [key: string]: string[] });
      }
    } catch (error) {
      console.error('Erreur lors du chargement de decklists depuis MongoDB Atlas:', error, 'timestamp:', new Date().toISOString());
      this.deckLists = {};
    }

    try {
      const cardsCollection = this.db.collection('card');
      const rawCards = await cardsCollection.find({}).toArray();
      this.allCards = rawCards.map((card: any) => {
        try {
          return CardSchema.parse({
            ...card,
            exhausted: false,
          });
        } catch (error) {
          console.error(`[CardManager] Erreur de validation pour la carte ${card.id}:`, error, 'timestamp:', new Date().toISOString());
          return null;
        }
      }).filter((card): card is Card => card !== null);
      if (this.allCards.length === 0) {
        console.warn('[CardManager] Aucune carte valide trouvée dans la collection card, initialisation avec allCards vide', 'timestamp:', new Date().toISOString());
      }
    } catch (error) {
      console.error('Erreur lors du chargement de cards depuis MongoDB Atlas:', error, 'timestamp:', new Date().toISOString());
      this.allCards = [];
    }
  }

  getDeckLists() {
    return this.deckLists;
  }

  getAllCards() {
    return this.allCards;
  }

  async getRandomDecks(count: number = 4): Promise<{ id: string; name: string; image: string; infoImage: string }[]> {
    try {
      const deckListsCollection = this.db.collection('decklists');
      const deckListsDocs = await deckListsCollection.find<DeckDocument>({}).toArray();
      if (deckListsDocs.length === 0) {
        console.error('Aucun deck trouvé dans la collection decklists', 'timestamp:', new Date().toISOString());
        return [];
      }
      const deckData = deckListsDocs.map((deck) => {
        const mappedDeck = {
          id: deck.id.toString(),
          name: deck.name,
          image: deck.image || `https://res.cloudinary.com/dsqxexeam/image/upload/v1750992816/${deck.name}_default.png`,
          infoImage: deck.infoImage || `https://res.cloudinary.com/dsqxexeam/image/upload/v1750992816/${deck.name}_default.png`,
        };
        return mappedDeck;
      });
      const shuffled = deckData.sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count);
    } catch (error) {
      console.error('Erreur lors du chargement de decklists pour getRandomDecks:', error, 'timestamp:', new Date().toISOString());
      return [];
    }
  }
}