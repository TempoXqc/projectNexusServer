// server/src/cache/gameCache.ts
export class GameCache {
    cache;
    constructor() {
        this.cache = new Map();
    }
    getGame(gameId) {
        return this.cache.get(gameId);
    }
    setGame(gameId, game) {
        this.cache.set(gameId, game);
    }
    deleteGame(gameId) {
        this.cache.delete(gameId);
    }
}
