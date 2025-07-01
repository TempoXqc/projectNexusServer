export class GameRepository {
    db;
    get collection() {
        return this.db.collection('games');
    }
    constructor(db) {
        this.db = db;
    }
    async findGameById(gameId) {
        const game = await this.collection.findOne({ gameId });
        if (!game)
            return null;
        return {
            ...game,
            playersReady: new Set(game.playersReady),
        };
    }
    async insertGame(game) {
        const persistedGame = {
            ...game,
            playersReady: Array.from(game.playersReady),
        };
        await this.collection.insertOne(persistedGame);
        return game;
    }
    async updateGame(gameId, update) {
        const persistedUpdate = {
            ...update,
            ...(update.playersReady && { playersReady: Array.from(update.playersReady) }),
        };
        const result = await this.collection.updateOne({ gameId }, { $set: persistedUpdate });
        if (result.matchedCount === 0) {
            throw new Error('Partie non trouvée');
        }
        return this.findGameById(gameId);
    }
    async deleteGame(gameId) {
        await this.collection.deleteOne({ gameId });
    }
    async findActiveGames() {
        const games = await this.collection
            .find({ status: { $in: ['waiting', 'started'] } })
            .project({ gameId: 1, status: 1, createdAt: 1, players: 1, playersReady: 1, _id: 0 })
            .toArray();
        return games;
    }
    async cleanupInactiveGames() {
        await this.collection.deleteMany({
            createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) },
        });
    }
}
