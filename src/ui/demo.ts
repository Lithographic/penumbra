import { legalOrders } from '../engine/orders';
import { Game } from '../engine/game';
import { FILES, Order, Player, Stance, Unit, UnitType, idx, xOf, yOf } from '../engine/types';

/**
 * A guided playthrough that runs on the real engine.
 *
 * Every beat below is executed by `Game.submit`, so the narration cannot drift away from
 * the rules — if a rule changes and the scripted exchange stops happening,
 * `npm run verify:demo` fails. The alternative (a hand-drawn slideshow) would look the
 * same and quietly rot.
 */

export type StanceCode = 'A' | 'B' | 'S';

/** [square the unit is standing on, stance, target square for A/S]. */
export type OrderSpec = [string, StanceCode, string?];

export interface DemoBeat {
  title: string;
  /** Why the move is being made — the point of the whole mode. */
  text: string;
  /** Orders for both sides. Omitted for a pause-and-explain beat. */
  play?: { p0: OrderSpec[]; p1: OrderSpec[] };
  /** Which type each side buys, if a reinforcement lands this turn. */
  reinforce?: [UnitType?, UnitType?];
  /** Squares to ring on the board while this beat is showing. */
  focus?: string[];
}

export function sq(name: string): number {
  return idx(FILES.indexOf(name[0]), Number(name.slice(1)) - 1);
}
export function name(square: number): string {
  return `${FILES[xOf(square)]}${yOf(square) + 1}`;
}

const STANCES: Record<StanceCode, Stance> = {
  A: Stance.Advance,
  B: Stance.Brace,
  S: Stance.Strike,
};

/**
 * Turn a spec into a real order, resolved against whatever is actually on the board.
 * Throws loudly rather than silently degrading to Brace — a demo that quietly stops
 * demonstrating the thing it claims to demonstrate is worse than one that fails.
 */
export function toOrder(game: Game, player: Player, spec: OrderSpec): Order {
  const [from, code, target] = spec;
  const unit: Unit | undefined = game.units.find(
    (u) => u.sq === sq(from) && u.owner === player
  );
  if (!unit) throw new Error(`demo: no player-${player} unit on ${from}`);

  const stance = STANCES[code];
  if (stance === Stance.Brace) return { unitId: unit.id, stance, path: [] };

  if (!target) throw new Error(`demo: ${code} from ${from} needs a target`);
  const wanted = sq(target);
  const found = legalOrders(unit).find((o) =>
    stance === Stance.Advance
      ? o.stance === Stance.Advance && o.path[o.path.length - 1] === wanted
      : o.stance === Stance.Strike && o.target === wanted
  );
  if (!found) throw new Error(`demo: ${from} cannot ${code} to ${target}`);
  return found;
}

/** Everything not named in a beat holds its ground. */
export function ordersFor(game: Game, player: Player, specs: OrderSpec[]): Order[] {
  const explicit = specs.map((s) => toOrder(game, player, s));
  const named = new Set(explicit.map((o) => o.unitId));
  const rest = game
    .unitsOf(player)
    .filter((u) => !named.has(u.id))
    .map((u) => ({ unitId: u.id, stance: Stance.Brace, path: [] }));
  return [...explicit, ...rest];
}

export const DEMO_SCRIPT: DemoBeat[] = [
  {
    title: 'The position',
    text:
      'Cyan at the bottom, amber at the top, mirrored exactly. The five hexagons are nodes: each side already owns the two on its own half, and the centre is unclaimed. Hold three nodes at the end of four consecutive turns and you win.',
    focus: ['c4', 'g4', 'e5', 'c6', 'g6'],
  },
  {
    title: 'Turn 1 — everyone runs',
    text:
      'Both sides send a Vanguard to each of their own nodes and a Lancer at the middle. Cyan also starts a Warden up the f-file and a Scout up the b-file. A Warden only moves two squares, so if you want it in the fight later you have to start walking now.',
    focus: ['c4', 'g4', 'e5'],
    play: {
      p0: [['c2','A','c4'],['g2','A','g4'],['e2','A','e4'],['f1','A','f3'],['b1','A','b3']],
      p1: [['c8','A','c6'],['g8','A','g6'],['e8','A','e6'],['d9','A','d7'],['h9','A','h7']],
    },
  },
  {
    title: 'Turn 2 — bracing is what claims',
    text:
      'Standing on a node does nothing at all. The Vanguards brace, which claims both flanks and resets their decay clocks. Meanwhile both Lancers reach for the centre on the same turn — and because orders are simultaneous, two advances into one square simply halt. Neither side gets it.',
    focus: ['e5','c4','g4'],
    play: {
      p0: [['c4','B'],['g4','B'],['e4','A','e5'],['f3','A','f5'],['b3','A','b5']],
      p1: [['c6','B'],['g6','B'],['e6','A','e5'],['d7','A','d5'],['h7','A','h5']],
    },
  },
  {
    title: 'Turn 3 — do not race, ambush',
    text:
      'They will probably push for the centre again, so cyan does not race them to it. The Lancer stands still and strikes the square they are walking into. Strike beats Advance: their Lancer dies on arrival. Reading the opponent is worth more than a tempo.',
    focus: ['e5'],
    play: { p0: [['e4','S','e5']], p1: [['e6','A','e5']] },
  },
  {
    title: 'Turn 4 — take the free ground',
    text:
      'With their Lancer gone the centre is undefended, so cyan walks on. Amber pushes a Warden to d5, right beside the square cyan wants to hold. Watch that Warden — the counter triangle is about to decide the next exchange.',
    focus: ['e5','d5'],
    play: { p0: [['e4','A','e5']], p1: [['d5','B']] },
  },
  {
    title: 'Turn 5 — the counter denies a claim',
    text:
      'Cyan braces to claim the centre; amber strikes it with the Warden. Warden breaks Lancer, so the countering type wins whatever the defender chose. The Lancer dies — and because nothing survived on the square, the node is never claimed. Bracing to claim is exactly when you are most exposed.',
    focus: ['e5','d5'],
    play: { p0: [['e5','B']], p1: [['d5','S','e5']] },
  },
  {
    title: 'Turn 6 — bring the right answer',
    text:
      'A Warden holds the middle, so cyan needs a Vanguard, because Vanguard breaks Warden. One peels off the g4 garrison to do it. That is a real cost: nobody is bracing on g4 now, and its decay clock has started running down.',
    focus: ['g4','e4'],
    play: { p0: [['g4','A','e4']], p1: [['d5','B']] },
  },
  {
    title: 'Turn 7 — line up the counter',
    text:
      'The Vanguard steps to d4, directly beneath their Warden. Amber braces, which is normally the correct answer to an incoming strike — but not against the one type that breaks it.',
    focus: ['d4','d5'],
    play: { p0: [['e4','A','d4']], p1: [['d5','B']] },
  },
  {
    title: 'Turn 8 — the triangle pays',
    text:
      'The Vanguard strikes the braced Warden and breaks it. Meanwhile amber sends a Vanguard toward the middle, abandoning its own c6 garrison to do it. Both sides are now spending territory security to buy tempo.',
    focus: ['d5','c6'],
    play: { p0: [['d4','S','d5']], p1: [['c6','A','e6']] },
  },
  {
    title: 'Turn 9 — hurry home',
    text:
      'The g4 clock is nearly out, so the Vanguard sprints the three squares back. At the same time the Warden that left home on turn one finally arrives and steps onto the empty centre. Slow units are only ever useful if you committed them early.',
    focus: ['g4','e5'],
    reinforce: [UnitType.Lancer, undefined],
    play: { p0: [['d4','A','g4'],['f5','A','e5']], p1: [['e6','B']] },
  },
  {
    title: 'Turn 10 — three nodes, clock starts',
    text:
      'Both brace. g4 is refreshed with nothing to spare and the centre is claimed. Three of five nodes, so cyan\u2019s victory clock starts: four consecutive turns and the game ends.',
    focus: ['g4','e5','c4'],
    reinforce: [UnitType.Lancer, undefined],
    play: { p0: [['g4','B'],['e5','B']], p1: [['e6','B']] },
  },
  {
    title: 'Turn 11 — buy the counter',
    text:
      'Amber strikes the centre and Vanguard breaks Warden, so cyan loses the garrison. Cyan also has supply banked, and spends it deliberately: amber is fielding Vanguards, and Lancer breaks Vanguard. Reinforcement type is a decision every single time, not a default.',
    focus: ['e5'],
    reinforce: [UnitType.Lancer, undefined],
    play: { p0: [], p1: [['e6','S','e5']] },
  },
  {
    title: 'Turn 12 — losing a node hurts twice',
    text:
      'The new Lancer sets off up the c-file. Amber steps onto the centre — and notice their c6 has now rotted away from neglect, costing them income as well as ground. Their army is already larger than their territory can feed.',
    focus: ['c6','e5'],
    play: { p0: [['c1','A','c3']], p1: [['e6','A','e5']] },
  },
  {
    title: 'Turn 13 — the clock resets',
    text:
      'Amber braces and claims the centre, so cyan drops to two nodes and the victory clock goes straight back to zero. Ownership only changes when somebody braces, which is why killing a garrison is not the same as taking the node.',
    focus: ['e5'],
    play: { p0: [['c3','A','d4']], p1: [['e5','B']] },
  },
  {
    title: 'Turn 14 — walk into range',
    text:
      'The Lancer steps to d5, right beside the braced Vanguard holding the middle. Note it had to route around cyan\u2019s own c4 garrison — friendly units block each other, so your own territory can get in your way.',
    focus: ['d5','e5'],
    play: { p0: [['d4','A','d5']], p1: [] },
  },
  {
    title: 'Turn 15 — the counter you paid for',
    text:
      'The Lancer strikes the braced Vanguard. Lancer breaks Vanguard, so bracing does not save it. This is why the reinforcement choice mattered four turns ago — cyan bought the exact answer to what amber was fielding.',
    focus: ['e5','d5'],
    play: { p0: [['d5','S','e5']], p1: [] },
  },
  {
    title: 'Turn 16 — step in',
    text:
      'The centre is empty and the Lancer walks on. Amber still owns it on paper, but has nothing left nearby to contest it with.',
    focus: ['e5'],
    play: { p0: [['d5','A','e5']], p1: [] },
  },
  {
    title: 'Turn 17 — retake and restart the clock',
    text:
      'The Lancer braces. The centre flips back to cyan, that is three nodes again, and the clock restarts at one. Four quiet turns now ends the game.',
    focus: ['e5','c4','g4'],
    play: { p0: [['e5','B']], p1: [] },
  },
  {
    title: 'Turn 18 — holding is the move',
    text:
      'Everything braces. Bracing refreshes each node it stands on, so all three decay clocks stay full while the victory clock counts up. Holding is not passive — it is the only thing that scores.',
    focus: ['c4','g4','e5'],
    play: { p0: [], p1: [] },
  },
  {
    title: 'Turn 19 — what you would actually see',
    text:
      'This demonstration shows both armies, because you cannot explain a plan through fog. In a real game each side sees only what its own units see: ridges block line of sight, and an enemy you have lost track of stays on the board as a dashed ghost stamped with the turn you last saw it. Ghosts are memories, and they are often wrong.',
    focus: ['b5','h5'],
    play: { p0: [], p1: [] },
  },
  {
    title: 'Turn 20 — and why the screen hides',
    text:
      'That is also why two players on one screen get a handoff card between turns. Orders are simultaneous and secret, so letting you see the other side\u2019s view would break the game rather than spoil it. Meanwhile the fourth consecutive turn holding three nodes lands — cyan wins.',
    focus: ['c4','g4','e5'],
    play: { p0: [], p1: [] },
  },
  {
    title: 'What decided it',
    text:
      'Cyan struck squares instead of racing for them, committed a slow unit long before it was needed, bought the reinforcement that countered what amber actually fielded, and never let a node rot. Amber lost by taking ground it could not hold.',
    focus: ['c4','g4','e5'],
  },
];
