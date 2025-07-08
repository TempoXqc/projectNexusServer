export class PlayerManager {
  private players: Record<string, { gameId: string; playerId: number | null; lastCreateTime?: number }> = {};

  addPlayer(socketId: string, info: { gameId: string; playerId: number | null }) {
    this.players[socketId] = { ...info, lastCreateTime: this.players[socketId]?.lastCreateTime };
    console.log('[PlayerManager] Joueur ajouté:', { socketId, info });
    this.debugPlayers();
  }

  getPlayer(socketId: string) {
    const player = this.players[socketId];
    console.log('[PlayerManager] Récupération joueur:', { socketId, player });
    return player;
  }

  removePlayer(socketId: string) {
    const player = this.players[socketId];
    delete this.players[socketId];
    console.log('[PlayerManager] Joueur supprimé:', { socketId, player });
    this.debugPlayers();
  }

  setLastCreateTime(socketId: string, time: number) {
    const player = this.players[socketId] || { gameId: '', playerId: null };
    this.players[socketId] = { ...player, lastCreateTime: time };
    console.log('[PlayerManager] Mise à jour lastCreateTime:', { socketId, time });
    this.debugPlayers();
  }

  getLastCreateTime(socketId: string): number | undefined {
    return this.players[socketId]?.lastCreateTime;
  }

  updatePlayerSocketId(oldSocketId: string, newSocketId: string) {
    const player = this.players[oldSocketId];
    if (player) {
      this.players[newSocketId] = { ...player };
      delete this.players[oldSocketId];
      console.log('[PlayerManager] Mise à jour socketId:', { oldSocketId, newSocketId, player });
      this.debugPlayers();
    } else {
      console.warn('[PlayerManager] Aucun joueur trouvé pour oldSocketId:', oldSocketId);
    }
  }

  findPlayerByGameIdAndPlayerId(gameId: string, playerId: number): string | null {
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