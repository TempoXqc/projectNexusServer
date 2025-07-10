export class PlayerManager {
    players = {};
    addPlayer(socketId, info) {
        this.players[socketId] = { ...info, lastCreateTime: this.players[socketId]?.lastCreateTime };
        console.log('[PlayerManager] Joueur ajouté:', { socketId, info });
        this.debugPlayers();
    }
    getPlayer(socketId) {
        const player = this.players[socketId];
        console.log('[PlayerManager] Récupération joueur:', { socketId, player });
        return player;
    }
    removePlayer(socketId) {
        const player = this.players[socketId];
        delete this.players[socketId];
        console.log('[PlayerManager] Joueur supprimé:', { socketId, player });
        this.debugPlayers();
    }
    setLastCreateTime(socketId, time) {
        const player = this.players[socketId] || { gameId: '', playerId: null };
        this.players[socketId] = { ...player, lastCreateTime: time };
        console.log('[PlayerManager] Mise à jour lastCreateTime:', { socketId, time });
        this.debugPlayers();
    }
    getLastCreateTime(socketId) {
        return this.players[socketId]?.lastCreateTime;
    }
    updatePlayerSocketId(oldSocketId, newSocketId) {
        const player = this.players[oldSocketId];
        if (player) {
            this.players[newSocketId] = { ...player };
            delete this.players[oldSocketId];
            console.log('[PlayerManager] Mise à jour socketId:', { oldSocketId, newSocketId, player });
            this.debugPlayers();
        }
        else {
            console.warn('[PlayerManager] Aucun joueur trouvé pour oldSocketId:', oldSocketId);
        }
    }
    findPlayerByGameIdAndPlayerId(gameId, playerId) {
        for (const [socketId, info] of Object.entries(this.players)) {
            if (info.gameId === gameId && info.playerId === playerId) {
                return socketId;
            }
        }
        return null;
    }
    debugPlayers() {
        console.log('[PlayerManager] État actuel:', Object.entries(this.players));
    }
}
