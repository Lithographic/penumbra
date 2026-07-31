// Core types for the Penumbra rules engine. Pure data — no DOM, no renderer.
//
// Penumbra is simultaneous-move, so unlike an alternating-move engine there is no
// "side to move". A turn consumes *both* players' full order sets at once.

export type Player = 0 | 1;

export const SIZE = 9;
export const NSQ = SIZE * SIZE;

export const idx = (x: number, y: number): number => y * SIZE + x;
export const xOf = (sq: number): number => sq % SIZE;
export const yOf = (sq: number): number => Math.floor(sq / SIZE);
export const inBounds = (x: number, y: number): boolean =>
  x >= 0 && x < SIZE && y >= 0 && y < SIZE;

export const FILES = 'abcdefghi';
export const sqName = (sq: number): string => `${FILES[xOf(sq)]}${yOf(sq) + 1}`;

/** Chebyshev (king-move) distance — the metric for both sight and most movement. */
export function cheb(a: number, b: number): number {
  return Math.max(Math.abs(xOf(a) - xOf(b)), Math.abs(yOf(a) - yOf(b)));
}

export enum UnitType {
  Command = 0,
  Vanguard = 1,
  Warden = 2,
  Scout = 3,
  Lancer = 4,
}

/**
 * The intransitive core: Strike > Advance > Brace > Strike.
 * See resolve.ts for the exact adjudication and DESIGN.md for why.
 */
export enum Stance {
  Advance = 0,
  Brace = 1,
  Strike = 2,
}

export interface Unit {
  id: number;
  type: UnitType;
  owner: Player;
  sq: number;
}

export const UNIT_NAMES: Record<UnitType, string> = {
  [UnitType.Command]: 'Command',
  [UnitType.Vanguard]: 'Vanguard',
  [UnitType.Warden]: 'Warden',
  [UnitType.Scout]: 'Scout',
  [UnitType.Lancer]: 'Lancer',
};

/**
 * The composition counter triangle: Vanguard → Warden → Lancer → Vanguard.
 *
 * `COUNTERS[a] === b` means a Striking `a` **breaks a Bracing `b`**, reversing the one
 * matchup the defender normally wins. It is the only place unit type affects combat.
 *
 * This exists because v0.2's intransitivity claim was falsified. The stance triad is a
 * cycle in the abstract, but three separate probe families produced cleanly transitive
 * tournaments, because the territorial layer imposed an ordering the stances could not
 * overturn. Stances were never going to cycle on their own: with only two fighting types
 * and reinforcement hard-coded to Vanguard, there was no composition space at all. Putting
 * the cycle in *what army you field* is how StarCraft gets durable intransitivity, and it
 * attaches the cycle to a decision players actually make repeatedly.
 *
 * Brace still wins two matchups in three, so digging in remains the default good idea —
 * it is only the *right counter-type* that breaks it.
 */
export const COUNTERS: Record<UnitType, UnitType | null> = {
  [UnitType.Vanguard]: UnitType.Warden,
  [UnitType.Warden]: UnitType.Lancer,
  [UnitType.Lancer]: UnitType.Vanguard,
  [UnitType.Command]: null,
  [UnitType.Scout]: null,
};

/** Types that can be brought in as reinforcements. */
export const REINFORCEABLE: readonly UnitType[] = [
  UnitType.Vanguard,
  UnitType.Warden,
  UnitType.Lancer,
  UnitType.Scout,
];

/**
 * Maximum squares travelled by an Advance.
 *
 * The Warden moves 2, not 1. It was 1 — the "slow anchor" — and that broke the counter
 * triangle on exactly one edge: with pure armies, Lancers beat Wardens 77% despite Wardens
 * countering them, because a move-1 unit simply loses the territorial game no matter how
 * many exchanges it wins. Under node decay, mobility *is* economy: you cannot garrison
 * what you cannot reach. Wardens keep their identity through sight 2 and the Brace
 * ground-holding exception instead of through slowness.
 */
export const MOVE_RANGE: Record<UnitType, number> = {
  [UnitType.Command]: 1,
  [UnitType.Vanguard]: 3,
  [UnitType.Warden]: 2,
  [UnitType.Scout]: 2,
  [UnitType.Lancer]: 2,
};

/** Sight radius in Chebyshev distance, subject to ridge line-of-sight blocking. */
export const SIGHT: Record<UnitType, number> = {
  [UnitType.Command]: 2,
  [UnitType.Vanguard]: 1,
  [UnitType.Warden]: 2,
  [UnitType.Scout]: 4,
  [UnitType.Lancer]: 1,
};

export const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

export const DIRS4: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

/** Vanguards move in straight orthogonal lines only; everything else uses all 8. */
export function dirsFor(type: UnitType): ReadonlyArray<readonly [number, number]> {
  return type === UnitType.Vanguard ? DIRS4 : DIRS8;
}

/** Scouts lose every exchange they enter — their job is vision, not violence. */
export const LOSES_ALL_EXCHANGES = (type: UnitType): boolean => type === UnitType.Scout;

/** Wardens Bracing hold their square against an Advance instead of ceding ground. */
export const HOLDS_GROUND_ON_BRACE = (type: UnitType): boolean => type === UnitType.Warden;

// ── Terrain ──────────────────────────────────────────────────────────────────

/**
 * The five nodes: centre plus four quadrants. Holding them is the economy.
 *
 * Deliberately set two ranks off each home row rather than one. At one rank a Vanguard
 * reached its own pair of nodes on turn 1 and — with the centre also in range — could
 * open the victory clock immediately; simulation had games ending on turn 4. Two ranks
 * out means each side still claims its own pair early, but the third node needed for a
 * victory must be taken from contested ground.
 */
export const NODES: readonly number[] = [
  idx(4, 4), // e5 centre
  idx(2, 3), // c4
  idx(6, 3), // g4
  idx(2, 5), // c6
  idx(6, 5), // g6
];

/**
 * Ridges block line of sight but not movement, and are placed with 180° rotational
 * symmetry so neither side gets a vision edge. They exist to make fog *inferable*:
 * predictable blind corridors are something both players can reason about, unlike
 * randomised terrain.
 */
export const RIDGES: readonly number[] = [
  idx(1, 3),
  idx(3, 2),
  idx(5, 2),
  idx(7, 3),
  idx(7, 5),
  idx(5, 6),
  idx(3, 6),
  idx(1, 5),
];

export const RIDGE_SET: ReadonlySet<number> = new Set(RIDGES);
export const NODE_SET: ReadonlySet<number> = new Set(NODES);

// ── Orders ───────────────────────────────────────────────────────────────────

/**
 * One order per unit per turn.
 *
 * `path` is the sequence of squares *entered*, excluding the starting square, in
 * travel order. It is empty for Brace and Strike (a Strike is stationary in v0.1).
 * `target` is the attacked square, required for Strike and unused otherwise.
 *
 * Order legality is purely geometric — it never depends on where enemy units are.
 * That matters under fog: you cannot be forced into an illegal order by information
 * you do not have. Collisions with unseen units are handled at resolution time by
 * halting, not by rejecting the order.
 */
export interface Order {
  unitId: number;
  stance: Stance;
  path: number[];
  target?: number;
}

// ── Economy ──────────────────────────────────────────────────────────────────

/**
 * Units up to this count are free; each one beyond costs 1 supply per turn.
 *
 * Set to 4 so that the opening position is exactly solvent: 7 units cost 3 upkeep, and
 * the two home-side nodes each side starts with pay income 3. At 3 free units the
 * starting army was unsupportable by construction — every game opened insolvent and both
 * sides immediately starved their Scout, which silently deleted the entire vision layer
 * before turn 2. Sitting on the knife edge is the point: lose a node and you can no
 * longer feed your army.
 */
export const FREE_UNITS = 4;
/** Hard cap on army size (reinforcement stops here). */
export const MAX_UNITS = 7;
/** Supply cost of one reinforcement. */
export const REINFORCE_COST = 3;
/**
 * Nodes needed, held simultaneously, to start the victory clock.
 *
 * Went 3 → 4 → 3. It was raised to 4 because at 3 the winning threshold and the
 * army-size gate were the same number, so the economy never had room to matter. Once node
 * *decay* was added, 4-of-5 became nearly unreachable — only 291 of 2,000 games ended by
 * node victory, median length hit the 60-turn limit, and the game turned into a grind. So
 * it is back to 3: decay now supplies the difficulty that the higher threshold was
 * standing in for, and holding three nodes against decay genuinely costs you three
 * garrisoned units.
 */
export const NODES_TO_WIN = 3;
/**
 * Consecutive turns of NODES_TO_WIN control required for a node victory.
 *
 * Raised from 3 after simulation: three turns was short enough that grabbing another
 * node was effectively an instant win, so nobody ever had to *defend* one. A longer
 * clock forces the holder to survive a counterattack, which is what couples the victory
 * condition to the supply economy the way DESIGN.md intends. Trimmed back to 4 once
 * NODES_TO_WIN rose to 4, since reaching the threshold at all is now much harder.
 */
export const HOLD_TURNS = 4;
export const TURN_LIMIT = 60;

/** Starvation removes the least valuable unit first. Command is never starved. */
export const STARVE_ORDER: readonly UnitType[] = [
  UnitType.Scout,
  UnitType.Lancer,
  UnitType.Vanguard,
  UnitType.Warden,
];

/**
 * Turns a node may go without a friendly unit **Bracing** on it before it reverts to
 * unowned.
 *
 * This is the fix for v0.2's dead non-monotonic-material lever. Upkeep alone never bit:
 * the over-extended bucket was empty across 1,200 games because income was a pure
 * function of a sticky node count, so a big army was never actually unsupportable. Decay
 * makes territory *cost attention*. Garrisoning four nodes pins four of your six fighting
 * units, so massing an army to attack means letting your income rot — and an army you can
 * no longer feed starves. That is the tension the lever was supposed to create.
 */
export const NODE_DECAY_GRACE = 4;

// ── Events / results ─────────────────────────────────────────────────────────

export type CombatEventKind =
  | 'strike-kills-advance'
  | 'brace-kills-strike'
  | 'counter-breaks-brace'
  | 'strike-trade'
  | 'strike-whiff'
  | 'advance-halted'
  | 'ground-ceded';

export interface CombatEvent {
  kind: CombatEventKind;
  at: number;
  /** Unit ids involved. Both players learn combat results — see DESIGN.md §Fog. */
  attacker?: number;
  defender?: number;
  died: number[];
}

export interface TurnRecord {
  turn: number;
  orders: [Order[], Order[]];
  events: CombatEvent[];
  /** unitId -> square, for every unit that survived the turn. */
  finalSquares: Array<[number, number]>;
  deaths: number[];
  starved: number[];
  reinforced: number[];
  nodeOwners: Array<Player | null>;
  supply: [number, number];
}

export type Status =
  | { state: 'playing' }
  | { state: 'won'; winner: Player; reason: string }
  | { state: 'draw'; reason: string };
