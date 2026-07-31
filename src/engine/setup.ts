import { NODES, NODE_SET, NSQ, Player, RIDGE_SET, Unit, UnitType, idx } from './types';

let nextId = 0;

function mk(type: UnitType, owner: Player, sq: number): Unit {
  return { id: nextId++, type, owner, sq };
}

/**
 * Player 0's opening deployment; player 1 is the 180° rotation, so the position is
 * perfectly symmetric. Setup is public and fixed on purpose: hidden or randomised
 * setup adds variance rather than depth, and rewards memorised distributions —
 * exactly the axis this design is trying to avoid leaning on.
 */
const HOME_LAYOUT: Array<{ x: number; y: number; type: UnitType }> = [
  { x: 4, y: 0, type: UnitType.Command }, // e1
  { x: 3, y: 0, type: UnitType.Warden }, // d1
  { x: 5, y: 0, type: UnitType.Warden }, // f1
  { x: 1, y: 0, type: UnitType.Scout }, // b1
  { x: 2, y: 1, type: UnitType.Vanguard }, // c2
  { x: 4, y: 1, type: UnitType.Lancer }, // e2
  { x: 6, y: 1, type: UnitType.Vanguard }, // g2
];

export function initialUnits(): Unit[] {
  nextId = 0;
  const units: Unit[] = [];
  for (const s of HOME_LAYOUT) units.push(mk(s.type, 0, idx(s.x, s.y)));
  for (const s of HOME_LAYOUT) units.push(mk(s.type, 1, idx(8 - s.x, 8 - s.y)));
  return units;
}

/** Fresh id for a reinforcement, distinct from every unit dealt so far. */
export function mintUnit(type: UnitType, owner: Player, sq: number): Unit {
  return mk(type, owner, sq);
}

/**
 * Home rank squares, in the order a reinforcement will try to occupy them.
 *
 * Centre-out, so a new unit appears beside its Command rather than in a corner — and,
 * critically, player 1's list is the exact 180° **rotation** of player 0's.
 *
 * An earlier version returned `x = 0..8` at `y = 8` for player 1, which is the
 * *reflection* of player 0's list, not the rotation: `a1` mirrors to `i9`, not `a9`. The
 * whole board is built on 180° symmetry, so that one mismatch put every reinforcement on
 * the wrong side of a mirror-asymmetric ridge layout. In self-play with identical bots it
 * was worth a 2:1 win rate to player 1 — in a game that has no first player at all.
 */
export function homeSquares(player: Player): number[] {
  const base = [4, 3, 5, 2, 6, 1, 7, 0, 8].map((x) => idx(x, 0));
  return player === 0 ? base : base.map((s) => NSQ - 1 - s);
}

/**
 * Starting node control: each side already owns the two nodes on its own half, and the
 * centre is unowned.
 *
 * Node control is sticky (a vacated node keeps its holder), so starting territory is
 * consistent with the rest of the rules rather than a special case. It also makes the
 * opening economy solvent and puts the real question on the board immediately: you own
 * two, you need four, so you must take the centre *and* something of your opponent's.
 */
export function initialNodeOwners(): Array<Player | null> {
  return NODES.map((sq) => {
    const y = Math.floor(sq / 9);
    if (y === 4) return null; // the contested centre
    return y < 4 ? 0 : 1;
  });
}

/** Sanity invariant used by the tests: terrain never overlaps. */
export function terrainIsDisjoint(): boolean {
  for (const r of RIDGE_SET) if (NODE_SET.has(r)) return false;
  return true;
}
