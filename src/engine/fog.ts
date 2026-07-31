import { Player, RIDGE_SET, SIGHT, Unit, UnitType, cheb, idx, xOf, yOf, NSQ } from './types';

/**
 * Line of sight between two squares. Ridges strictly between the endpoints block it;
 * a ridge you are standing on, or looking directly at, does not.
 *
 * Sampling rather than a full supercover walk — deterministic, and at a 4-square
 * maximum sight radius the difference never materialises.
 */
export function losClear(from: number, to: number): boolean {
  const x0 = xOf(from);
  const y0 = yOf(from);
  const dx = xOf(to) - x0;
  const dy = yOf(to) - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return true;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const s = idx(Math.round(x0 + dx * t), Math.round(y0 + dy * t));
    if (s !== from && s !== to && RIDGE_SET.has(s)) return false;
  }
  return true;
}

/** Union of every friendly unit's sight, ridge-blocked. */
export function visibleSquares(units: Unit[], player: Player): Set<number> {
  const seen = new Set<number>();
  const mine = units.filter((u) => u.owner === player);
  for (let s = 0; s < NSQ; s++) {
    for (const u of mine) {
      if (cheb(u.sq, s) <= SIGHT[u.type] && losClear(u.sq, s)) {
        seen.add(s);
        break;
      }
    }
  }
  return seen;
}

export interface Ghost {
  unitId: number;
  type: UnitType;
  sq: number;
  /** Turn on which this sighting was taken. Stale ghosts are the core bluffing surface. */
  turn: number;
}

/**
 * A player's private memory of enemy positions.
 *
 * Enemy units inside current sight are recorded fresh. Enemies that have slipped out of
 * sight persist as stale markers — they are *not* deleted, because a remembered
 * position that has silently become wrong is precisely what makes fog a reasoning
 * problem rather than a blank. Confirmed deaths are removed, since combat results are
 * public.
 */
export function updateGhosts(
  ghosts: Map<number, Ghost>,
  units: Unit[],
  player: Player,
  visible: Set<number>,
  turn: number
): void {
  const alive = new Set(units.map((u) => u.id));
  for (const [id] of ghosts) if (!alive.has(id)) ghosts.delete(id);

  for (const u of units) {
    if (u.owner === player) continue;
    if (visible.has(u.sq)) {
      ghosts.set(u.id, { unitId: u.id, type: u.type, sq: u.sq, turn });
    }
  }
}

/** What one player is permitted to know at the start of their order-writing phase. */
export interface PlayerView {
  me: Player;
  turn: number;
  /** Full, exact information about your own units. */
  own: Unit[];
  /** Enemy units currently in sight. */
  visibleEnemies: Unit[];
  /** Last-known enemy positions, including stale ones. */
  ghosts: Ghost[];
  visible: Set<number>;
  nodeOwners: Array<Player | null>;
  /**
   * Turns since each node was last garrisoned (a friendly unit Braced on it). Public
   * information — bots and players alike need it to know which holdings are about to
   * rot. See NODE_DECAY_GRACE.
   */
  nodeAge: number[];
  supply: number;
  enemySupply: number;
  holdStreak: [number, number];
}
