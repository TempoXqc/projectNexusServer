import { Server, Socket } from 'socket.io';
import {
    GameState,
    PlayerState,
    OpponentState,
    Card,
    Effect,
    Condition,
    Target,
    MoveCard,
    HiddenCard,
} from "@tempoxqc/project-nexus-types";

interface GameContext {
    gameState: GameState;
    io: Server;
    socket: Socket;
    playerId: string;
    opponentId: string;
}

class EffectManager {
    private gameContext: GameContext;

    constructor(gameContext: GameContext) {
        this.gameContext = gameContext;
    }

    private getPlayerState(playerId: string): PlayerState | OpponentState {
        const { gameState } = this.gameContext;
        return playerId === gameState.player.id ? gameState.player : gameState.opponent;
    }

    async executeEffects(card: Card, trigger: keyof Card['effects']): Promise<void> {
        const effects = card.effects[trigger] || [];
        effects.sort((a: Effect, b: Effect) => (a.priority || 0) - (b.priority || 0));

        for (const effect of effects) {
            if (await this.checkCondition(effect.condition)) {
                if (effect.action === 'choice') {
                    await this.handleChoiceEffect(effect, card);
                } else if (typeof effect.action === 'string') {
                    await this.executeAction(effect, card);
                }
            }
        }
    }

    private async checkCondition(condition: Condition | undefined): Promise<boolean> {
        if (!condition) return true;

        const { gameState } = this.gameContext;
        switch (condition.type) {
            case 'count':
                return this.checkCountCondition(condition);
            case 'health_compare':
                return this.checkHealthCompareCondition(condition);
            case 'all_assassins_stealthed':
                return this.checkAllAssassinsStealthed();
            case 'cards_in_deck':
                return this.checkCardsInDeck(condition);
            case 'target_type':
                return this.checkTargetType(condition);
            case 'cards_in_hand':
                return this.checkCardsInHand(condition);
            case 'destroyed_unit':
                return this.checkDestroyedUnit(condition);
            case 'card_id_matches':
                return this.checkCardIdMatches(condition);
            case 'units_deployed_this_turn':
                return this.checkUnitsDeployedThisTurn(condition);
            case 'graveyard_has_unit':
                return this.checkGraveyardHasUnit(condition);
            case 'cards_in_token_pool':
                return this.checkCardsInTokenPool(condition);
            case 'dragon_in_play':
                return this.checkDragonInPlay(condition);
            case 'hidden_assassins':
                return this.checkHiddenAssassins();
            default:
                console.warn(`Condition non gérée : ${condition.type}`);
                return false;
        }
    }

    private checkCountCondition(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        let count = 0;

        if (condition.property === 'stealthed' && condition.filter?.faction) {
            count = this.getPlayerState(this.gameContext.playerId).field.filter(
                (card: Card) => card.faction === condition.filter!.faction && card.stealthed
            ).length;
        } else if (condition.property === 'units_in_play' && condition.filter?.faction) {
            count = this.getPlayerState(this.gameContext.playerId).field.filter(
                (card: Card) =>
                    card.faction === condition.filter!.faction &&
                    (!condition.filter!.exclude_self || card.id !== gameState.currentCard?.id)
            ).length;
        }

        switch (condition.operator) {
            case '>=':
                return count >= (condition.value as number);
            case '<':
                return count < (condition.value as number);
            case '===':
                return count === (condition.value as number);
            case '!==':
                return count !== (condition.value as number);
            default:
                return false;
        }
    }

    private checkHealthCompareCondition(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        const selfHealth = this.getPlayerState(this.gameContext.playerId).nexus.health;
        const opponentHealth = this.getPlayerState(this.gameContext.opponentId).nexus.health;

        switch (condition.operator) {
            case '<':
                return selfHealth < opponentHealth;
            case '>=':
                return selfHealth >= (condition.value as number);
            case '<=':
                return selfHealth <= (condition.value as number);
            default:
                return false;
        }
    }

    private checkAllAssassinsStealthed(): boolean {
        const { gameState } = this.gameContext;
        return this.getPlayerState(this.gameContext.playerId).field
            .filter((card: Card) => card.faction === 'assassin')
            .every((card: Card) => card.stealthed);
    }

    private checkCardsInDeck(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        const owner = condition.filter?.owner?.[0] || this.gameContext.playerId;
        const count = this.getPlayerState(owner).deck.filter(
            (card: Card) => condition.filter?.type && card.types.some((t: Card['types'][number]) => t.type === condition.filter!.type![0])
        ).length;
        return condition.operator === '>=' ? count >= (condition.value as number) : false;
    }

    private checkTargetType(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        return gameState.targetType === condition.value;
    }

    private checkCardsInHand(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        const count = this.getPlayerState(this.gameContext.playerId).hand.length;
        return condition.operator === '<=' ? count <= (condition.value as number) : false;
    }

    private checkDestroyedUnit(condition: Condition): boolean {
        return !!this.gameContext.gameState.lastDestroyedUnit;
    }

    private checkCardIdMatches(condition: Condition): boolean {
        return condition.value === this.gameContext.gameState.lastCardPlayed?.id;
    }

    private checkUnitsDeployedThisTurn(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        const count = gameState.turnState.unitsDeployed.filter(
            (card: Card) => condition.filter?.label && card.label.includes('dragon')
        ).length;
        return condition.operator === '>=' ? count >= (condition.value as number) : false;
    }

    private checkGraveyardHasUnit(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        return this.getPlayerState(this.gameContext.playerId).graveyard.some(
            (card: Card) => condition.filter?.faction && card.faction === condition.filter.faction && card.types.some((t: Card['types'][number]) => t.type === 'unit')
        );
    }

    private checkCardsInTokenPool(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        const count = this.getPlayerState(this.gameContext.playerId).tokenPool.filter(
            (token: PlayerState['tokenPool'][number]) => condition.filter?.type && token.type.includes(condition.filter.type[0])
        ).length;
        return condition.operator === '>=' ? count >= (condition.value as number) : false;
    }

    private checkDragonInPlay(condition: Condition): boolean {
        const { gameState } = this.gameContext;
        const count = this.getPlayerState(this.gameContext.playerId).field.filter(
            (card: Card) =>
                condition.filter?.label &&
                card.label.includes('dragon') &&
                (!condition.filter.exclude_self || card.id !== gameState.currentCard?.id)
        ).length;
        return condition.operator === '>='
            ? count >= (condition.value as number)
            : count < (condition.value as number);
    }

    private checkHiddenAssassins(): boolean {
        console.warn('Condition hidden_assassins non implémentée');
        return false;
    }

    private async handleChoiceEffect(effect: Effect, card: Card): Promise<void> {
        const { io, socket, playerId } = this.gameContext;
        if (!effect.options) return;

        const options = effect.options.map((opt) => ({
            title: opt.title.en,
            actions: opt.actions,
        }));

        const selectedOption = await new Promise<string>((resolve) => {
            io.to(playerId).emit('requestChoice', { cardId: card.id, options }, (response: string) => {
                resolve(response);
            });
        });

        const chosenOption = effect.options.find((opt) => opt.title.en === selectedOption);
        if (chosenOption) {
            for (const action of chosenOption.actions) {
                await this.executeAction(action, card);
            }
        }
    }

    private async executeAction(action: Effect, card: Card): Promise<void> {
        const { gameState, io, playerId, opponentId } = this.gameContext;

        switch (action.action) {
            case 'draw':
                await this.handleDraw(action, playerId);
                break;
            // case 'damage':
            //     await this.handleDamage(action);
            //     break;
            // case 'move_card':
            //     await this.handleMoveCard(action);
            //     break;
            case 'restore_health':
                await this.handleRestoreHealth(action);
                break;
            case 'purify':
                await this.handlePurify(action);
                break;
            case 'set_cost_to_zero':
                await this.handleSetCostToZero(action);
                break;
            case 'reveal':
                await this.handleReveal(action);
                break;
            // case 'select_from_revealed':
            //     await this.handleSelectFromRevealed(action, card);
            //     break;
            case 'reorder_revealed_cards':
                await this.handleReorderRevealedCards(action);
                break;
            // case 'take_control_of_unit':
            //     await this.handleTakeControlOfUnit(action);
            //     break;
            case 'exhaust_unit':
                await this.handleExhaustUnit(action);
                break;
            case 'split_damage':
                await this.handleSplitDamage(action);
                break;
            case 'gain_token':
                await this.handleGainToken(action);
                break;
            case 'add_keyword':
                await this.handleAddKeyword(action);
                break;
            case 'deploy':
                await this.handleDeploy(action);
                break;
            case 'gain_extra_play':
                await this.handleGainExtraPlay(action);
                break;
            case 'prevent_destruction':
                await this.handlePreventDestruction(action);
                break;
            // case 'discard':
            //     await this.handleDiscard(action);
            //     break;
            case 'move_remaining_to_bottom':
                await this.handleMoveRemainingToBottom(action);
                break;
            case 'activate_ability':
                await this.handleActivateAbility(action);
                break;
            case 'activate_onPlay_ability':
                await this.handleActivateOnPlayAbility(action);
                break;
            case 'disable_battle_phase':
                await this.handleDisableBattlePhase(action);
                break;
            case 'ignore_defence':
                await this.handleIgnoreDefence(action);
                break;
            case 'pay_health':
                await this.handlePayHealth(action);
                break;
            default:
                console.warn(`Action non gérée : ${action.action}`);
        }

        io.to(playerId).emit('updateGameState', gameState);
        io.to(opponentId).emit('updateGameState', gameState);
    }

    private async handleDraw(action: Effect, playerId: string): Promise<void> {
        const { gameState } = this.gameContext;
        const player = this.getPlayerState(playerId);
        const amount = typeof action.amount === 'number' ? action.amount : 1;
        for (let i = 0; i < amount && player.deck.length > 0; i++) {
            const card = player.deck.shift();
            if (card) {
                if ('hand' in player && Array.isArray(player.hand) && player.hand.every((item): item is Card => 'faction' in item)) {
                    player.hand.push({ ...card, exhausted: false }); // S'assurer que exhausted est défini
                    await this.executeEffects(card, 'on_draw');
                }
            }
        }
    }

    // private async handleDamage(action: Effect): Promise<void> {
    //     const { gameState, playerId, opponentId } = this.gameContext;
    //     if (!action.target) return;
    //
    //     const targetPlayerId = Array.isArray(action.target)
    //         ? action.target[0]?.owner?.includes('self')
    //             ? playerId
    //             : opponentId
    //         : action.target.owner?.includes('self')
    //             ? playerId
    //             : opponentId;
    //     const targetPlayer = this.getPlayerState(targetPlayerId);
    //
    //     const amount =
    //         action.amount === 'max_graveyard_unit_value'
    //             ? Math.max(
    //                 ...targetPlayer.graveyard
    //                     .filter((card: Card) => card.types.some((t: Card['types'][number]) => t.type === 'unit'))
    //                     .map((card: Card) => card.types[0]?.value || 0),
    //                 0
    //             )
    //             : typeof action.amount === 'number'
    //                 ? action.amount
    //                 : 1;
    //
    //     if (Array.isArray(action.target)) {
    //         const hasNexus = action.target.some((t: Target) => t.type?.includes('nexus'));
    //         const hasUnit = action.target.some((t: Target) => t.type?.includes('unit'));
    //         if (hasNexus) {
    //             targetPlayer.nexus.health -= amount;
    //         } else if (hasUnit) {
    //             const units = targetPlayer.field.filter(
    //                 (card: Card) =>
    //                     action.target.some((t: Target) => t.type?.includes('unit')) &&
    //                     (action.target[0]?.filter?.max_value !== undefined
    //                         ? card.types[0].value <= action.target[0].filter.max_value
    //                         : true)
    //             );
    //             if (units.length > 0) {
    //                 const unit = units[0];
    //                 unit.types[0].value -= amount;
    //                 if (unit.types[0].value <= 0) {
    //                     targetPlayer.field = targetPlayer.field.filter((c: Card) => c.id !== unit.id);
    //                     targetPlayer.graveyard.push(unit);
    //                     gameState.lastDestroyedUnit = unit;
    //                     await this.executeEffects(unit, 'on_destroyed');
    //                 }
    //             }
    //         }
    //     } else {
    //         const target = action.target;
    //         if (target.type?.includes('nexus')) {
    //             targetPlayer.nexus.health -= amount;
    //         } else if (target.type?.includes('unit')) {
    //             const units = targetPlayer.field.filter(
    //                 (card: Card) =>
    //                     (Array.isArray(target.type)
    //                         ? target.type.includes('unit')
    //                         : target.type === 'unit') &&
    //                     (target.filter?.max_value !== undefined
    //                         ? card.types[0].value <= target.filter.max_value
    //                         : true)
    //             );
    //             if (units.length > 0) {
    //                 const unit = units[0];
    //                 unit.types[0].value -= amount;
    //                 if (unit.types[0].value <= 0) {
    //                     targetPlayer.field = targetPlayer.field.filter((c: Card) => c.id !== unit.id);
    //                     targetPlayer.graveyard.push(unit);
    //                     gameState.lastDestroyedUnit = unit;
    //                     await this.executeEffects(unit, 'on_destroyed');
    //                 }
    //             }
    //         }
    //     }
    // }

    private async handlePayHealth(action: Effect): Promise<void> {
        const { gameState, playerId, opponentId } = this.gameContext;
        if (!action.target) return;

        const targetPlayerId = Array.isArray(action.target)
            ? action.target[0]?.owner?.includes('self')
                ? playerId
                : opponentId
            : action.target.owner?.includes('self')
                ? playerId
                : opponentId;
        const targetPlayer = this.getPlayerState(targetPlayerId);
        const amount = typeof action.amount === 'number' ? action.amount : 1;
        targetPlayer.nexus.health -= amount;
        if (action.effect) {
            await this.executeAction(action.effect, gameState.currentCard || { id: '', name: { fr: '', en: '', es: '' }, image: { fr: '', en: '', es: '' }, faction: 'assassin', label: [], cost: 0, effects: {}, types: [] });
        }
    }

    // private async handleMoveCard(action: Effect): Promise<void> {
    //     const { gameState, playerId, opponentId } = this.gameContext;
    //     if (!action.from || !action.to) return;
    //
    //     const sourcePlayerId = typeof action.from !== 'string' && action.from.deck?.owner?.includes('self') ? playerId : opponentId;
    //     const targetPlayerId = typeof action.to !== 'string' && action.to.deck?.owner?.includes('self') ? playerId : opponentId;
    //     const sourcePlayer = this.getPlayerState(sourcePlayerId);
    //     const targetPlayer = this.getPlayerState(targetPlayerId);
    //
    //     let sourceZone: Card[] = typeof action.from !== 'string' ? sourcePlayer[(action.from.zone as keyof PlayerState) || 'deck'] as Card[] : sourcePlayer.deck;
    //     let targetZone: Card[] = typeof action.to !== 'string' ? targetPlayer[(action.to.zone as keyof PlayerState) || 'deck'] as Card[] : targetPlayer.deck;
    //
    //     const card = sourceZone.find(
    //         (c: Card) =>
    //             (typeof action.from !== 'string' && action.from[action.from.zone as keyof MoveCard]?.id?.[0] ? c.id === action.from[action.from.zone as keyof MoveCard].id![0] : false) ||
    //             (typeof action.from !== 'string' && action.from[action.from.zone as keyof MoveCard]?.filter?.id?.[0] ? c.id === action.from[action.from.zone as keyof MoveCard].filter.id[0] : false)
    //     );
    //     if (card) {
    //         sourceZone = sourceZone.filter((c: Card) => c.id !== card.id);
    //         if (typeof action.to !== 'string' && action.to[action.to.zone as keyof MoveCard]?.where?.to_position === 'shuffle') {
    //             targetZone.push(card);
    //             targetZone.sort(() => Math.random() - 0.5);
    //         } else {
    //             targetZone.unshift(card);
    //         }
    //     }
    // }

    private async handleRestoreHealth(action: Effect): Promise<void> {
        const { gameState, playerId, opponentId } = this.gameContext;
        if (!action.target) return;

        const targetPlayerId = Array.isArray(action.target)
            ? action.target[0]?.owner?.includes('self')
                ? playerId
                : opponentId
            : action.target.owner?.includes('self')
                ? playerId
                : opponentId;
        const targetPlayer = this.getPlayerState(targetPlayerId);
        const amount =
            action.amount === 'discarded_cards_count'
                ? gameState.turnState.discardedCardsCount
                : typeof action.amount === 'number'
                    ? action.amount
                    : 1;
        targetPlayer.nexus.health += Math.min(amount, action.max || amount);
    }

    private async handlePurify(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        const units = player.field.filter((card: Card) => card.types.some((t: Card['types'][number]) => t.type === 'unit'));
        const amount = typeof action.amount === 'number' ? action.amount : 1;
        for (let i = 0; i < amount && units.length > i; i++) {
            await this.executeEffects(units[i], 'on_purified');
        }
    }

    private async handleSetCostToZero(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        if (!action.target || (Array.isArray(action.target) ? !action.target[0]?.id : !action.target.id)) return;

        if ('hand' in player && Array.isArray(player.hand) && player.hand.every((item): item is Card => 'faction' in item)) {
            const targetCards = player.hand.filter((card: Card) =>
                Array.isArray(action.target)
                    ? action.target.some((t: Target) => t.id && (Array.isArray(t.id) ? t.id.includes(card.id) : t.id === card.id))
                    : action.target.id && (Array.isArray(action.target.id) ? action.target.id.includes(card.id) : action.target.id === card.id)
            );
            targetCards.forEach((card: Card) => (card.cost = 0));
        }
    }

    private async handleReveal(action: Effect): Promise<void> {
        const { gameState, io, playerId, opponentId } = this.gameContext;
        const targetPlayerId = action.from && typeof action.from !== 'string' && action.from.deck?.owner?.includes('self') ? playerId : opponentId;
        const player = this.getPlayerState(targetPlayerId);
        const amount = typeof action.amount === 'number' ? action.amount : 1;
        const revealedCards = player.deck.slice(0, amount);
        gameState.revealedCards = revealedCards;
        io.to(playerId).emit('revealCards', revealedCards);
        io.to(opponentId).emit('revealCards', revealedCards);
    }

    // private async handleSelectFromRevealed(action: Effect, card: Card): Promise<void> {
    //     const { gameState, io, playerId } = this.gameContext;
    //     const revealedCards = gameState.revealedCards;
    //     const prompt = action.prompt?.en || '';
    //
    //     const selectedCardId = await new Promise<string>((resolve) => {
    //         io.to(playerId).emit('selectFromRevealed', { prompt, cards: revealedCards }, (response: string) => {
    //             resolve(response);
    //         });
    //     });
    //
    //     const selectedCard = revealedCards.find((c: Card) => c.id === selectedCardId);
    //     if (selectedCard && action.from && typeof action.from !== 'string' && action.to && typeof action.to !== 'string') {
    //         await this.handleMoveCard({
    //             ...action,
    //             from: { deck: { owner: action.from.deck?.owner || ['self'], id: [selectedCardId] } },
    //             to: action.to,
    //         });
    //     }
    // }

    private async handleReorderRevealedCards(action: Effect): Promise<void> {
        const { gameState, io, playerId, opponentId } = this.gameContext;
        const targetPlayerId = action.target && (Array.isArray(action.target) ? action.target[0]?.owner?.includes('self') : action.target.owner?.includes('self')) ? playerId : opponentId;
        const player = this.getPlayerState(targetPlayerId);
        const revealedCards = gameState.revealedCards;

        const reorderedCardIds = await new Promise<string[]>((resolve) => {
            io.to(playerId).emit('reorderRevealedCards', { cards: revealedCards }, (response: string[]) => {
                resolve(response);
            });
        });

        player.deck = reorderedCardIds
            .map((id) => revealedCards.find((c: Card) => c.id === id))
            .filter((c): c is Card => !!c)
            .concat(player.deck.filter((c: Card) => !revealedCards.some((rc: Card) => rc.id === c.id)));
    }

    // private async handleTakeControlOfUnit(action: Effect): Promise<void> {
    //     const { gameState, playerId, opponentId } = this.gameContext;
    //     const opponent = this.getPlayerState(opponentId);
    //     const player = this.getPlayerState(playerId);
    //     if (!action.from || typeof action.from === 'string') return;
    //
    //     const unit = action.from.field?.max_value !== undefined
    //         ? opponent.field.find((card: Card) => card.types[0].value <= action.from.field.max_value)
    //         : undefined;
    //     if (unit) {
    //         opponent.field = opponent.field.filter((c: Card) => c.id !== unit.id);
    //         player.field.push(unit);
    //     }
    // }

    private async handleExhaustUnit(action: Effect): Promise<void> {
        const { gameState, playerId, opponentId } = this.gameContext;
        const targetPlayerId = Array.isArray(action.target)
            ? action.target[0]?.owner?.includes('self')
                ? playerId
                : opponentId
            : action.target?.owner?.includes('self')
                ? playerId
                : opponentId;
        const player = this.getPlayerState(targetPlayerId);
        const unit = player.field.find((card: Card) => card.types.some((t: Card['types'][number]) => t.type === 'unit'));
        if (unit) {
            unit.exhausted = true;
            await this.executeEffects(unit, 'on_exhaust');
        }
    }

    private async handleSplitDamage(action: Effect): Promise<void> {
        const { gameState, io, playerId, opponentId } = this.gameContext;
        const targetPlayerId = Array.isArray(action.target)
            ? action.target[0]?.owner?.includes('self')
                ? playerId
                : opponentId
            : action.target?.owner?.includes('self')
                ? playerId
                : opponentId;
        const player = this.getPlayerState(targetPlayerId);
        const targets = [
            ...player.field.filter((card: Card) => card.types.some((t: Card['types'][number]) => t.type === 'unit')),
            player.nexus,
        ];

        const selectedTargets = await new Promise<any[]>((resolve) => {
            io.to(playerId).emit('selectSplitDamageTargets', { amount: action.amount || 1, targets }, (response: any[]) => {
                resolve(response);
            });
        });

        for (const target of selectedTargets) {
            if (target.type === 'nexus') {
                player.nexus.health -= 1;
            } else {
                const unit = player.field.find((c: Card) => c.id === target.id);
                if (unit) {
                    unit.types[0].value -= 1;
                    if (unit.types[0].value <= 0) {
                        player.field = player.field.filter((c: Card) => c.id !== unit.id);
                        player.graveyard.push(unit);
                        gameState.lastDestroyedUnit = unit;
                        await this.executeEffects(unit, 'on_destroyed');
                    }
                }
            }
        }
    }

    private async handleGainToken(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        if (action.token) {
            player.tokenPool.push({ id: action.token, type: [action.token] });
        }
    }

    private async handleAddKeyword(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        if (!action.target || (Array.isArray(action.target) ? !action.target[0]?.id : !action.target.id)) return;

        const targetCards = player.field.filter((card: Card) =>
            Array.isArray(action.target)
                ? action.target.some((t: Target) => t.id && (Array.isArray(t.id) ? t.id.includes(card.id) : t.id === card.id))
                : action.target.id && (Array.isArray(action.target.id) ? action.target.id.includes(card.id) : action.target.id === card.id)
        );
        targetCards.forEach((card: Card) => {
            card.keywords = card.keywords || [];
            card.keywords.push(action.keyword!);
        });
    }

    private async handleDeploy(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        if (!action.target || Array.isArray(action.target)) return;

        const cardId = action.target.id
            ? Array.isArray(action.target.id)
                ? action.target.id[0]
                : action.target.id
            : undefined;
        if (!cardId) return;

        const card = player.deck.find((c: Card) => c.id === cardId);
        if (card) {
            player.deck = player.deck.filter((c: Card) => c.id !== card.id);
            player.field.push({ ...card, exhausted: action.exhaust ?? false });
            gameState.turnState.unitsDeployed.push(card);
            await this.executeEffects(card, 'on_play');
        }
    }

    private async handleGainExtraPlay(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        player.extraPlays = (player.extraPlays || 0) + (typeof action.amount === 'number' ? action.amount : 1);
    }

    private async handlePreventDestruction(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        if (!action.target || (Array.isArray(action.target) ? !action.target[0]?.id : !action.target.id)) return;

        const targetCards = player.field.filter((card: Card) =>
            Array.isArray(action.target)
                ? action.target.some((t: Target) => t.id && (Array.isArray(t.id) ? t.id.includes(card.id) : t.id === card.id))
                : action.target.id && (Array.isArray(action.target.id) ? action.target.id.includes(card.id) : action.target.id === card.id)
        );
        targetCards.forEach((card: Card) => {
            card.preventDestruction = true;
            if (action.duration === 'this_turn') {
                gameState.turnState.preventDestructionCards.push(card.id);
            }
        });
    }

    // private async handleDiscard(action: Effect): Promise<void> {
    //     const { gameState, io, playerId } = this.gameContext;
    //     const player = this.getPlayerState(playerId);
    //     if ('hand' in player && Array.isArray(player.hand) && player.hand.every((item): item is Card => 'faction' in item)) {
    //         const cardsToDiscard = player.hand.filter(
    //             (card: Card) =>
    //                 action.from &&
    //                 typeof action.from !== 'string' &&
    //                 action.from.hand?.filter &&
    //                 (action.from.hand.filter.faction ? card.faction === action.from.hand.filter.faction : true) &&
    //                 (action.from.hand.filter.type ? card.types.some((t: Card['types'][number]) => t.type === action.from.hand.filter.type) : true)
    //         );
    //
    //         const selectedCardIds = await new Promise<string[]>((resolve) => {
    //             io.to(playerId).emit('selectCardsToDiscard', { amount: action.amount || 1, cards: cardsToDiscard }, (response: string[]) => {
    //                 resolve(response);
    //             });
    //         });
    //
    //         for (const cardId of selectedCardIds) {
    //             const card = player.hand.find((c: Card) => c.id === cardId);
    //             if (card) {
    //                 player.hand = player.hand.filter((c: Card) => c.id !== cardId);
    //                 player.graveyard.push(card);
    //                 gameState.turnState.discardedCardsCount++;
    //                 await this.executeEffects(card, 'on_discard');
    //             }
    //         }
    //     }
    // }

    private async handleMoveRemainingToBottom(action: Effect): Promise<void> {
        const { gameState, playerId, opponentId } = this.gameContext;
        if (!action.target) return;

        const targetPlayerId = Array.isArray(action.target)
            ? action.target[0]?.owner?.includes('self')
                ? playerId
                : opponentId
            : action.target.owner?.includes('self')
                ? playerId
                : opponentId;
        const player = this.getPlayerState(targetPlayerId);
        const remainingCards = gameState.revealedCards.filter((c: Card) => !c.selected);
        player.deck.push(...remainingCards);
        gameState.revealedCards = [];
    }

    private async handleActivateAbility(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        const units = player.field.filter((card: Card) => card.types.some((t: Card['types'][number]) => t.type === 'unit'));
        for (const unit of units) {
            await this.executeEffects(unit, 'on_play');
        }
    }

    private async handleActivateOnPlayAbility(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        const units = player.field.filter((card: Card) => card.types.some((t: Card['types'][number]) => t.type === 'unit'));
        for (const unit of units) {
            await this.executeEffects(unit, 'on_play');
        }
    }

    private async handleDisableBattlePhase(action: Effect): Promise<void> {
        const { gameState } = this.gameContext;
        gameState.turnState.battlePhaseDisabled = true;
    }

    private async handleIgnoreDefence(action: Effect): Promise<void> {
        const { gameState, playerId } = this.gameContext;
        const player = this.getPlayerState(playerId);
        if (!action.target || (Array.isArray(action.target) ? !action.target[0]?.id : !action.target.id)) return;

        const targetCards = player.field.filter((c: Card) =>
            Array.isArray(action.target)
                ? action.target.some((t: Target) => t.id && (Array.isArray(t.id) ? t.id.includes(c.id) : t.id === c.id))
                : action.target.id && (Array.isArray(action.target.id) ? action.target.id.includes(c.id) : action.target.id === c.id)
        );
        targetCards.forEach((card: Card) => {
            card.keywords = card.keywords || [];
            card.keywords.push('ignore_defence');
        });
    }
}

export default EffectManager;