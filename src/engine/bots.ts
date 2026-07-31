import { PlayerView } from './fog';
import { legalOrders } from './orders';
import {
  COUNTERS,
  NODES,
  NODE_DECAY_GRACE,
  NODE_SET,
  NSQ,
  Order,
  Player,
  Stance,
  TurnRecord,
  Unit,
  UnitType,
  cheb,
} from './types';

// ── Deterministic RNG ────────────────────────────────────────────────────────
// Seeded so every reported simulation number is reproducible.

export type RNG = () => number;

export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Bot {
  name: string;
  reset(): void;
  orders(view: PlayerView, rng: RNG): Order[];
  /** Which unit type to bring in if a reinforcement is affordable. */
  reinforce?(view: PlayerView): UnitType;
  /**
   * Called after each turn with the pre-turn view and the public record. A bot may
   * only legitimately use enemy orders it could actually observe — units that were
   * in sight when orders were written, or that showed up in a combat result.
   */
  observe(view: PlayerView, record: TurnRecord, me: Player): void;
}

/**
 * The abstract stance payoff matrix, from the acting player's perspective.
 *
 * Note this is exactly the kind of *approximation* the design is meant to punish: the
 * real payoff of winning an exchange depends on where on the board it happens (next to
 * a node it can decide the game; in open ground it is nearly free). Any bot reasoning
 * from a fixed matrix like this is carrying an abstraction error. That is deliberate —
 * it is the machine-side handicap the design predicts. See DESIGN.md §Lever C.
 */
const PAYOFF: number[][] = [
  //         vs Advance, vs Brace, vs Strike
  /* Advance */ [0, 1, -2],
  /* Brace   */ [-1, 0, 2],
  /* Strike  */ [2, -2, -1],
];

function pickWeighted(weights: number[], rng: RNG): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * A bot's *plan* — which nodes it wants and how far from home it will range.
 *
 * This exists because stance-frequency archetypes turned out to be a bad probe for
 * intransitivity. A bot that Braces 70% of the time everywhere is not a different
 * strategy, it is a worse version of the same strategy, so a tournament between such
 * bots measures competence and always comes out transitive. Genuinely different *plans*
 * are what could plausibly cycle.
 */
export type Plan = 'centre' | 'flank' | 'counter' | 'spread';

/** What a bot may condition its stance choice on. */
export interface StanceContext {
  unit: Unit;
  /** True when the unit is adjacent to a currently visible enemy. */
  inContact: boolean;
  /** Square of that adjacent enemy, or null. */
  contactSq: number | null;
}

interface Tactics {
  /**
   * Stance mixture [advance, brace, strike], queried per unit.
   *
   * The context is passed in because a read is only worth applying where an exchange can
   * actually happen: an earlier version tilted *every* unit's stance toward the best
   * response, which dragged units off their territorial objectives and made the
   * modelling bot strictly worse. A human uses a read in contact and plays the position
   * elsewhere.
   */
  weights: (ctx: StanceContext) => number[];
  /** Whether the Scout is pushed forward for vision or parked at home. */
  useScout: boolean;
  plan: Plan;
}

/** Plan-specific preference over nodes, in squares of notional detour. */
function planBias(plan: Plan, nodeSq: number, unit: Unit, view: PlayerView): number {
  const isCentre = nodeSq === NODES[0];
  const homeY = view.me === 0 ? 0 : 8;
  const nodeY = Math.floor(nodeSq / 9);
  const ownHalf = Math.abs(nodeY - homeY) <= 4;

  switch (plan) {
    case 'centre':
      return isCentre ? 0 : 5;
    case 'flank':
      return isCentre ? 7 : 0;
    case 'counter':
      // Stay near home; only reach for nodes on your own side of the board.
      return (ownHalf ? 0 : 8) + Math.floor(cheb(unit.sq, nodeSq) / 2);
    case 'spread':
      return 0;
  }
}

function knownEnemies(
  view: PlayerView
): Array<{ sq: number; fresh: boolean; type: UnitType }> {
  const out = view.visibleEnemies.map((e) => ({ sq: e.sq, fresh: true, type: e.type }));
  const seen = new Set(view.visibleEnemies.map((e) => e.id));
  for (const g of view.ghosts) {
    if (!seen.has(g.unitId)) out.push({ sq: g.sq, fresh: false, type: g.type });
  }
  return out;
}

/**
 * Seat-neutral square ordering, used only to break ties deterministically.
 *
 * This exists because of a real bug: an earlier version broke ties on the raw square
 * index, which means "prefer lower y", which means "prefer south". That handed player 1
 * a free tempo every turn and produced a 6:1 seat skew in a game that has no first
 * player at all. Mirroring the index for player 1 makes both seats behave identically.
 */
function seatIndex(sq: number, me: Player): number {
  return me === 0 ? sq : NSQ - 1 - sq;
}

/** Nearest node this player does not already hold, weighted by the bot's plan. */
function objectiveFor(unit: Unit, view: PlayerView, plan: Plan): number {
  let best = NODES[0];
  let bestScore = Infinity;
  NODES.forEach((nodeSq, i) => {
    const mine = view.nodeOwners[i] === view.me;
    // A node you hold whose garrison is about to lapse is as urgent as one you do not
    // hold at all — otherwise a bot walks away from its own territory and starves.
    const rotting = mine && view.nodeAge[i] >= NODE_DECAY_GRACE - 1;
    const settled = mine && !rotting ? 6 : 0;
    const score =
      (cheb(unit.sq, nodeSq) + settled + planBias(plan, nodeSq, unit, view)) * NSQ +
      seatIndex(nodeSq, view.me);
    if (score < bestScore) {
      bestScore = score;
      best = nodeSq;
    }
  });
  return best;
}

/** A Scout's objective is vision: head for whichever node its own side is not covering. */
function scoutObjective(unit: Unit, view: PlayerView): number {
  let best = NODES[0];
  let bestScore = Infinity;
  for (const nodeSq of NODES) {
    const crowd = view.own.filter((o) => o.id !== unit.id && cheb(o.sq, nodeSq) <= 2).length;
    const score = (cheb(unit.sq, nodeSq) + crowd * 3) * NSQ + seatIndex(nodeSq, view.me);
    if (score < bestScore) {
      bestScore = score;
      best = nodeSq;
    }
  }
  return best;
}

function buildOrders(view: PlayerView, rng: RNG, tactics: Tactics): Order[] {
  const enemies = knownEnemies(view);
  const out: Order[] = [];

  for (const unit of view.own) {
    const legal = legalOrders(unit);
    const adjacentEnemy = enemies.find((e) => cheb(unit.sq, e.sq) === 1 && e.fresh);
    let stance = pickWeighted(
      tactics.weights({
        unit,
        inContact: adjacentEnemy !== undefined,
        contactSq: adjacentEnemy?.sq ?? null,
      }),
      rng
    ) as Stance;

    // Structural overrides — these are not strategy, they are "do not throw the unit
    // away for nothing" guards that any sane player applies.
    if (unit.type === UnitType.Command) {
      stance = stance === Stance.Strike ? Stance.Brace : stance;
    }
    if (unit.type === UnitType.Scout) {
      // Scouts lose every exchange, so striking is pure self-harm.
      stance = stance === Stance.Strike ? Stance.Advance : stance;
    }
    if (stance === Stance.Strike && !adjacentEnemy) {
      stance = Stance.Advance;
    }

    // Composition play: strike when your type breaks theirs, and do not sit Bracing next
    // to the one type that breaks yours.
    //
    // Explicitly *not* applied to a unit standing on a node. Bracing is the only way to
    // claim or refresh a node, so overriding it here made garrisons wander off their
    // objectives the moment an enemy came adjacent — under decay that quietly handed the
    // territory back. It showed up as Warden armies losing to Lancers they counter.
    const onNode = NODE_SET.has(unit.sq);
    if (
      adjacentEnemy &&
      !onNode &&
      unit.type !== UnitType.Scout &&
      unit.type !== UnitType.Command
    ) {
      const iBreakThem = COUNTERS[unit.type] === adjacentEnemy.type;
      const theyBreakMe = COUNTERS[adjacentEnemy.type] === unit.type;
      if ((iBreakThem || theyBreakMe) && stance === Stance.Brace) stance = Stance.Strike;
    }

    if (stance === Stance.Strike && adjacentEnemy) {
      const strike = legal.find(
        (o) => o.stance === Stance.Strike && o.target === adjacentEnemy.sq
      );
      if (strike) {
        out.push(strike);
        continue;
      }
    }

    if (stance === Stance.Brace) {
      out.push({ unitId: unit.id, stance: Stance.Brace, path: [] });
      continue;
    }

    // Advance toward the objective, minimising distance; deterministic tie-break.
    const parkScout = unit.type === UnitType.Scout && !tactics.useScout;
    if (parkScout) {
      out.push({ unitId: unit.id, stance: Stance.Brace, path: [] });
      continue;
    }
    const goal =
      unit.type === UnitType.Scout
        ? scoutObjective(unit, view)
        : objectiveFor(unit, view, tactics.plan);

    // Already standing on the objective: dig in rather than wander off it. Under
    // Brace-to-claim this is also the act that converts the ground into territory.
    if (goal === unit.sq) {
      out.push({ unitId: unit.id, stance: Stance.Brace, path: [] });
      continue;
    }

    const advances = legal.filter((o) => o.stance === Stance.Advance);
    let best: Order | null = null;
    let bestScore = Infinity;
    for (const o of advances) {
      const dest = o.path[o.path.length - 1];
      // Steer around squares next to a *currently visible* enemy, since Strike beats
      // Advance. This is the channel through which vision pays for itself: only fresh
      // sightings are dodged, so a side that scouts walks into fewer interceptions.
      const danger = enemies.filter((e) => e.fresh && cheb(dest, e.sq) === 1).length;
      const score = (cheb(dest, goal) + danger * 2) * NSQ + seatIndex(dest, view.me);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    out.push(best ?? { unitId: unit.id, stance: Stance.Brace, path: [] });
  }

  return out;
}

/**
 * Plays a fixed stance mixture forever. Stands in for "approximate equilibrium play":
 * unexploitable in the abstract matrix sense, and completely non-adaptive.
 */
export function stanceBiasBot(
  name: string,
  weights: [number, number, number],
  plan: Plan = 'spread'
): Bot {
  return {
    name,
    reset() {},
    orders(view, rng) {
      return buildOrders(view, rng, { weights: () => weights, useScout: true, plan });
    },
    observe() {},
  };
}

/**
 * A bot defined by its *plan* rather than by stance noise. These are the honest probe
 * for intransitivity: four coherent ways to try to win, rather than four levels of
 * twitchiness applied to one way.
 */
export function planBot(
  name: string,
  plan: Plan,
  weights: [number, number, number] = [0.45, 0.35, 0.20]
): Bot {
  return {
    name,
    reset() {},
    orders(view, rng) {
      return buildOrders(view, rng, { weights: () => weights, useScout: true, plan });
    },
    observe() {},
  };
}

/** Same as stanceBiasBot but leaves the Scout at home — the control for "vision has a price". */
export function blindBot(name: string, weights: [number, number, number]): Bot {
  return {
    name,
    reset() {},
    orders(view, rng) {
      return buildOrders(view, rng, { weights: () => weights, useScout: false, plan: 'spread' });
    },
    observe() {},
  };
}

/**
 * Counts the opponent's observed stance frequencies within the current match and
 * best-responds to the empirical mixture.
 *
 * This is the human-side proxy: sample-efficient, within-match opponent modelling. If
 * the design works, this should beat a fixed mixture and the gap should widen with
 * match length. If it does not, the central premise is dead. See DESIGN.md §5.3.
 */
export function bestResponseBot(name: string, tilt = 0.45): Bot {
  let counts = [1, 1, 1]; // Laplace prior
  return {
    name,
    reset() {
      counts = [1, 1, 1];
    },
    orders(view, rng) {
      const total = counts.reduce((a, b) => a + b, 0);
      const p = counts.map((c) => c / total);
      const ev = PAYOFF.map((row) => row.reduce((acc, v, j) => acc + v * p[j], 0));

      let bestIdx = 0;
      for (let i = 1; i < ev.length; i++) if (ev[i] > ev[bestIdx]) bestIdx = i;

      // A *tilt* on a balanced baseline, not a near-pure best response.
      //
      // The first version committed ~85% to the argmax and lost badly — because the
      // abstract matrix above knows nothing about nodes, so "Brace is the best reply"
      // becomes "sit still and lose on territory". That is a genuine illustration of
      // the abstraction error the design predicts, but it makes a useless proxy for a
      // human read: a human exploits a tendency *while still playing the position*.
      // Tilting keeps it positionally competent and isolates the value of the read.
      const base = (1 - tilt) / 3;
      const tilted = [base, base, base];
      tilted[bestIdx] += tilt;
      const baseline = [0.45, 0.35, 0.2];

      return buildOrders(view, rng, {
        weights: (ctx) => (ctx.inContact ? tilted : baseline),
        useScout: true,
        plan: 'spread',
      });
    },
    observe(view, record, me) {
      const enemyOrders = record.orders[(1 - me) as Player];
      const visibleIds = new Set(view.visibleEnemies.map((e) => e.id));
      for (const o of enemyOrders) {
        const inCombat = record.events.some(
          (e) => e.attacker === o.unitId || e.defender === o.unitId
        );
        if (visibleIds.has(o.unitId) || inCombat) counts[o.stance]++;
      }
    },
  };
}

/** Uniform over legal orders — the floor that everything else must clear. */
export function randomBot(name = 'random'): Bot {
  return {
    name,
    reset() {},
    orders(view, rng) {
      return view.own.map((u) => {
        const legal = legalOrders(u);
        return legal[Math.floor(rng() * legal.length)];
      });
    },
    observe() {},
  };
}

/**
 * An opponent with a genuine, readable habit: when in contact it defends ground it is
 * standing on and lashes out everywhere else.
 *
 * This exists to make the exploitation prediction testable at all. The original probe
 * opponents were stationary near-uniform stance mixtures, which have essentially nothing
 * to read — best-responding to their marginal frequencies is worth almost zero by
 * construction, so a null result there measured the instrument rather than the game.
 * A conditional tell is what human opponent-reading is actually about.
 */
export function tellBot(name: string, plan: Plan = 'spread'): Bot {
  return {
    name,
    reset() {},
    orders(view, rng) {
      return buildOrders(view, rng, {
        weights: (ctx) => {
          if (!ctx.inContact) return [0.55, 0.3, 0.15];
          // The tell: Brace on a node, Strike off one.
          return NODE_SET.has(ctx.unit.sq) ? [0.05, 0.9, 0.05] : [0.05, 0.05, 0.9];
        },
        useScout: true,
        plan,
      });
    },
    observe() {},
  };
}

/**
 * Models the opponent's stance *conditional on an observable feature* — whether the unit
 * in question is standing on a node — rather than as a single marginal frequency.
 *
 * This is the closer proxy for a human read: people do not track "he Braces 40% of the
 * time", they track "he always digs in when he is holding something". Two buckets is a
 * crude version of that, but it is the difference between a model that can represent a
 * conditional habit and one that structurally cannot.
 */
export function conditionalExploiterBot(name: string, tilt = 0.5): Bot {
  const fresh = () => [
    [1, 1, 1],
    [1, 1, 1],
  ];
  let counts = fresh();
  const bucketOf = (sq: number) => (NODE_SET.has(sq) ? 0 : 1);

  const tiltedFor = (bucket: number): number[] => {
    const total = counts[bucket].reduce((a, b) => a + b, 0);
    const p = counts[bucket].map((c) => c / total);
    const ev = PAYOFF.map((row) => row.reduce((acc, v, j) => acc + v * p[j], 0));
    let bestIdx = 0;
    for (let i = 1; i < ev.length; i++) if (ev[i] > ev[bestIdx]) bestIdx = i;
    const base = (1 - tilt) / 3;
    const w = [base, base, base];
    w[bestIdx] += tilt;
    return w;
  };

  return {
    name,
    reset() {
      counts = fresh();
    },
    orders(view, rng) {
      return buildOrders(view, rng, {
        weights: (ctx) =>
          ctx.inContact && ctx.contactSq !== null
            ? tiltedFor(bucketOf(ctx.contactSq))
            : [0.45, 0.35, 0.2],
        useScout: true,
        plan: 'spread',
      });
    },
    observe(view, record, me) {
      const enemyOrders = record.orders[(1 - me) as Player];
      const seen = new Map(view.visibleEnemies.map((e) => [e.id, e.sq]));
      for (const o of enemyOrders) {
        const sq = seen.get(o.unitId);
        if (sq === undefined) continue; // only what was actually observed
        counts[bucketOf(sq)][o.stance]++;
      }
    },
  };
}

/**
 * Reinforces a single unit type all game. These are the honest probe for intransitivity
 * in v0.3: if the counter triangle works, their tournament should contain a 3-cycle
 * (Vanguard → Warden → Lancer → Vanguard) rather than a pecking order.
 */
export function compositionBot(name: string, type: UnitType, plan: Plan = 'spread'): Bot {
  return {
    name,
    reset() {},
    orders(view, rng) {
      return buildOrders(view, rng, {
        weights: () => [0.45, 0.35, 0.2],
        useScout: true,
        plan,
      });
    },
    reinforce() {
      return type;
    },
    observe() {},
  };
}

/**
 * Fields whatever type counters what the opponent is actually fielding — a composition
 * read rather than a stance read, and a much better proxy for how a human exploits an
 * opponent's habits than counting stance frequencies was.
 */
export function adaptiveCompositionBot(name: string): Bot {
  const counterOf = (t: UnitType): UnitType => {
    for (const k of [UnitType.Vanguard, UnitType.Warden, UnitType.Lancer]) {
      if (COUNTERS[k] === t) return k;
    }
    return UnitType.Vanguard;
  };
  let tally = new Map<UnitType, number>();

  return {
    name,
    reset() {
      tally = new Map();
    },
    orders(view, rng) {
      return buildOrders(view, rng, {
        weights: () => [0.45, 0.35, 0.2],
        useScout: true,
        plan: 'spread',
      });
    },
    reinforce() {
      let commonest = UnitType.Warden;
      let best = -1;
      for (const [type, n] of tally) {
        if (n > best) {
          best = n;
          commonest = type;
        }
      }
      return counterOf(commonest);
    },
    observe(view) {
      // Only what was actually seen. Composition is far easier to observe than stance —
      // you just look at what is on the board — which is part of why it is a more
      // plausible read for a human to be making.
      for (const e of view.visibleEnemies) {
        if (e.type === UnitType.Command || e.type === UnitType.Scout) continue;
        tally.set(e.type, (tally.get(e.type) ?? 0) + 1);
      }
    },
  };
}
