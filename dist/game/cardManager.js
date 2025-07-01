export class CardManager {
    deckLists;
    allCards;
    db;
    constructor(db) {
        this.db = db;
        this.deckLists = {};
        this.allCards = [];
    }
    // async initialize() {
    //   await this.loadData();
    // }
    async initialize() {
        await this.loadData();
    }
    async loadData() {
        try {
            const deckListsCollection = this.db.collection('decklists');
            const deckListsDocs = await deckListsCollection.find({}).toArray();
            if (deckListsDocs.length === 0) {
                console.error('Aucun deck trouvé dans la collection decklists', 'timestamp:', new Date().toISOString());
            }
            this.deckLists = deckListsDocs.reduce((acc, doc) => {
                acc[doc.id.toString()] = doc.cardIds;
                return acc;
            }, {});
        }
        catch (error) {
            console.error('Erreur lors du chargement de decklists depuis MongoDB Atlas:', error, 'timestamp:', new Date().toISOString());
            throw new Error(`Erreur lors du chargement de decklists: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
        }
        try {
            const cardsCollection = this.db.collection('card');
            this.allCards = (await cardsCollection.find({}).toArray()).map((card) => ({
                id: card.id,
                name: card.name,
                image: card.image,
                exhausted: false,
            }));
        }
        catch (error) {
            console.error('Erreur lors du chargement de cards depuis MongoDB Atlas:', error, 'timestamp:', new Date().toISOString());
            throw new Error(`Erreur lors du chargement de cards: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
        }
    }
    getDeckLists() {
        return this.deckLists;
    }
    getAllCards() {
        return this.allCards;
    }
    async getRandomDecks(count = 4) {
        try {
            const deckListsCollection = this.db.collection('decklists');
            const deckListsDocs = await deckListsCollection.find({}).toArray();
            console.log('[DEBUG] Documents bruts de decklists:', JSON.stringify(deckListsDocs, null, 2));
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
                console.log('[DEBUG] Deck mappé:', JSON.stringify(mappedDeck, null, 2));
                return mappedDeck;
            });
            const shuffled = deckData.sort(() => Math.random() - 0.5);
            return shuffled.slice(0, count);
        }
        catch (error) {
            console.error('Erreur lors du chargement de decklists pour getRandomDecks:', error, 'timestamp:', new Date().toISOString());
            return [];
        }
    }
}
