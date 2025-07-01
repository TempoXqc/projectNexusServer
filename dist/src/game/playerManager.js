export class PlayerManager {
    players = {};
    addPlayer(socketId, info) {
        this.players[socketId] = { ...info, lastCreateTime: this.players[socketId]?.lastCreateTime };
    }
    getPlayer(socketId) {
        return this.players[socketId];
    }
    removePlayer(socketId) {
        delete this.players[socketId];
    }
    setLastCreateTime(socketId, time) {
        const player = this.players[socketId] || { gameId: '', playerId: null };
        this.players[socketId] = { ...player, lastCreateTime: time };
    }
    getLastCreateTime(socketId) {
        return this.players[socketId]?.lastCreateTime;
    }
}
