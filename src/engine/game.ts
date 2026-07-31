import { Ghost, PlayerView, updateGhosts, visibleSquares } from './fog';
import { isLegalOrder } from './orders';
import { resolveTurn } from './resolve';
import { homeSquares, initialNodeOwners, initialUnits, mintUnit } from './setup';
import {
  FREE_UNITS,
  HOLD_TURNS,
  MAX_UNITS,
  NODES,
  NODES_TO_WIN,
  NODE_DECAY_GRACE,
  REINFORCEABLE,
  Order,
  Player,
  REINFORCE_COST,
  STARVE_ORDER,
  Stance,
  Status,
  TURN_LIMIT,
  TurnRecord,
  Unit,
  UnitType,
} from './types';

export class Game {
  units: Unit[] = initialUnits();
  turn = 0;
  /** Node control persists: a contested or vacated node stays with its last holder. */
  nodeOwners: Array<Player | null> = initialNodeOwners();
  /** Turn on which each node was last garrisoned. Nodes rot without one. */
  nodeGarrison: number[] = NODES.map(() => 0);
  supply: [number, number] = [0, 0];
  holdStreak: [number, number] = [0, 0];
  status: Status = { state: 'playing' };
  ghosts: [Map<number, Ghost>, Map<number, Ghost>] = [new Map(), new Map()];
  history: TurnRecord[] = [];

  unitsOf(player: Player): Unit[] {
    return this.units.filter((u) => u.owner === player);
  }

  commandOf(player: Player): Unit | undefined {
    return this.units.find((u) => u.owner === player && u.type === UnitType.Command);
  }

  nodesHeld(player: Player): number {
    return this.nodeOwners.filter((o) => o === player).length;
  }

  income(player: Player): number {
    return 1 + this.nodesHeld(player);
  }

  upkeep(player: Player): number {
    return Math.max(0, this.unitsOf(player).length - FREE_UNITS);
  }

  /** True when this player's army is larger than their territory can sustain. */
  insolvent(player: Player): boolean {
    return this.upkeep(player) > this.income(player);
  }

  viewFor(player: Player): PlayerView {
    const visible = visibleSquares(this.units, player);
    const other = (1 - player) as Player;
    return {
      me: player,
      turn: this.turn,
      own: this.unitsOf(player).map((u) => ({ ...u })),
      visibleEnemies: this.units
        .filter((u) => u.owner !== player && visible.has(u.sq))
        .map((u) => ({ ...u })),
      ghosts: [...this.ghosts[player].values()],
      visible,
      nodeOwners: [...this.nodeOwners],
      nodeAge: this.nodeGarrison.map((g) => this.turn - g),
      supply: this.supply[player],
      enemySupply: this.supply[other],
      holdStreak: [...this.holdStreak] as [number, number],
    };
  }

  /**
   * Consume both players' order sets and advance one full turn.
   *
   * Illegal or missing orders silently fall back to Brace rather than throwing — under
   * simultaneity there is no opportunity to ask for a correction, and a unit given no
   * usable instruction holding its ground is the sane default.
   */
  submit(
    orders0: Order[],
    orders1: Order[],
    /** Which unit type each player would like to reinforce, if they can afford one. */
    reinforcePrefs: [UnitType?, UnitType?] = []
  ): TurnRecord {
    if (this.status.state !== 'playing') {
      throw new Error('game is over');
    }
    this.turn++;

    const byId = new Map(this.units.map((u) => [u.id, u]));
    const vetted: Order[] = [];
    for (const [player, set] of [
      [0, orders0],
      [1, orders1],
    ] as Array<[Player, Order[]]>) {
      const used = new Set<number>();
      for (const o of set) {
        const u = byId.get(o.unitId);
        if (!u || u.owner !== player || used.has(o.unitId)) continue;
        if (!isLegalOrder(u, o)) continue;
        used.add(o.unitId);
        vetted.push(o);
      }
    }

    const { finalSq, deaths, events } = resolveTurn(this.units, vetted);

    this.units = this.units.filter((u) => !deaths.has(u.id));
    for (const u of this.units) {
      const dest = finalSq.get(u.id);
      if (dest !== undefined) u.sq = dest;
    }

    // ── Node control ────────────────────────────────────────────────────────
    // A node is claimed only by a unit that **Braced** on it. Walking onto a node does
    // not take it; you must dig in, which costs a turn and exposes you to being walked
    // straight past.
    //
    // This rule exists because of a measured failure. When merely occupying a node
    // claimed it, the archetype tournament came out cleanly transitive with Strike-heavy
    // play on top: Advance was compulsory (you had to move to score), so its counter was
    // over-rewarded, while Brace — the counter to Strike — forfeited territory and could
    // never cash in. The victory condition was quietly breaking the very cycle the
    // stance triad is built on. Making Brace the act that *converts* ground closes the
    // loop: Advance takes ground, Brace banks it, Strike punishes Advance.
    const stanceOf = new Map<number, Stance>();
    for (const o of vetted) stanceOf.set(o.unitId, o.stance);

    NODES.forEach((nodeSq, i) => {
      const on = this.units.filter((u) => u.sq === nodeSq);
      if (on.length !== 1) return; // vacant or contested: the previous holder keeps it
      const stance = stanceOf.get(on[0].id) ?? Stance.Brace;
      if (stance !== Stance.Brace) return;
      this.nodeOwners[i] = on[0].owner;
      this.nodeGarrison[i] = this.turn;
    });

    // Nodes rot without a garrison. Territory costs attention, not just capture: holding
    // four nodes pins four of your six fighting units, so massing for an attack means
    // letting your income decay — and an army you can no longer feed starves.
    NODES.forEach((_, i) => {
      if (this.nodeOwners[i] === null) return;
      if (this.turn - this.nodeGarrison[i] > NODE_DECAY_GRACE) this.nodeOwners[i] = null;
    });

    // ── Supply ──────────────────────────────────────────────────────────────
    const starved: number[] = [];
    const reinforced: number[] = [];
    for (const player of [0, 1] as Player[]) {
      if (this.insolvent(player)) {
        const victim = this.pickStarvation(player);
        if (victim) {
          starved.push(victim.id);
          this.units = this.units.filter((u) => u.id !== victim.id);
        }
      }
      this.supply[player] += this.income(player) - this.upkeep(player);
      if (this.supply[player] < 0) this.supply[player] = 0;

      if (
        this.supply[player] >= REINFORCE_COST &&
        this.unitsOf(player).length < MAX_UNITS &&
        !this.insolventIfGrown(player)
      ) {
        const spot = homeSquares(player).find((s) => !this.units.some((u) => u.sq === s));
        if (spot !== undefined) {
          const wanted = reinforcePrefs[player];
          const type =
            wanted !== undefined && REINFORCEABLE.includes(wanted) ? wanted : UnitType.Vanguard;
          const fresh = mintUnit(type, player, spot);
          this.units.push(fresh);
          this.supply[player] -= REINFORCE_COST;
          reinforced.push(fresh.id);
        }
      }
    }

    // ── Fog ─────────────────────────────────────────────────────────────────
    for (const player of [0, 1] as Player[]) {
      const visible = visibleSquares(this.units, player);
      updateGhosts(this.ghosts[player], this.units, player, visible, this.turn);
    }

    // ── Victory ─────────────────────────────────────────────────────────────
    for (const player of [0, 1] as Player[]) {
      this.holdStreak[player] =
        this.nodesHeld(player) >= NODES_TO_WIN ? this.holdStreak[player] + 1 : 0;
    }
    this.checkVictory();

    const record: TurnRecord = {
      turn: this.turn,
      orders: [orders0, orders1],
      events,
      finalSquares: this.units.map((u) => [u.id, u.sq] as [number, number]),
      deaths: [...deaths],
      starved,
      reinforced,
      nodeOwners: [...this.nodeOwners],
      supply: [...this.supply] as [number, number],
    };
    this.history.push(record);
    return record;
  }

  /** Cheapest expendable unit; Command is never starved. */
  private pickStarvation(player: Player): Unit | undefined {
    for (const type of STARVE_ORDER) {
      const found = this.unitsOf(player).find((u) => u.type === type);
      if (found) return found;
    }
    return undefined;
  }

  /** Would one more unit tip this player into insolvency? Prevents suicide reinforcing. */
  private insolventIfGrown(player: Player): boolean {
    return Math.max(0, this.unitsOf(player).length + 1 - FREE_UNITS) > this.income(player);
  }

  private checkVictory(): void {
    const c0 = this.commandOf(0);
    const c1 = this.commandOf(1);
    if (!c0 && !c1) {
      this.status = { state: 'draw', reason: 'both Commands destroyed' };
      return;
    }
    if (!c1) {
      this.status = { state: 'won', winner: 0, reason: 'Command destroyed' };
      return;
    }
    if (!c0) {
      this.status = { state: 'won', winner: 1, reason: 'Command destroyed' };
      return;
    }

    for (const player of [0, 1] as Player[]) {
      if (this.holdStreak[player] >= HOLD_TURNS) {
        this.status = {
          state: 'won',
          winner: player,
          reason: `held ${NODES_TO_WIN}+ nodes for ${HOLD_TURNS} turns`,
        };
        return;
      }
    }

    if (this.turn >= TURN_LIMIT) {
      const n0 = this.nodesHeld(0);
      const n1 = this.nodesHeld(1);
      if (n0 === n1) this.status = { state: 'draw', reason: 'turn limit, equal nodes' };
      else
        this.status = {
          state: 'won',
          winner: n0 > n1 ? 0 : 1,
          reason: 'turn limit, node count',
        };
    }
  }
}
