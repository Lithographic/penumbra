import { braceOrder } from './orders';
import {
  CombatEvent,
  CombatEventKind,
  COUNTERS,
  HOLDS_GROUND_ON_BRACE,
  LOSES_ALL_EXCHANGES,
  Order,
  Stance,
  Unit,
} from './types';

export interface ResolveResult {
  /** unitId -> square, for every unit alive at the end of resolution. */
  finalSq: Map<number, number>;
  /** unitIds removed this turn. */
  deaths: Set<number>;
  events: CombatEvent[];
}

/**
 * Adjudicate one simultaneous turn.
 *
 * Movement is a **time-stepped** simulation: every unit advances one square per tick,
 * and conflicts are detected tick by tick. This matters for fairness. A naive
 * "truncate at the first shared square" rule resolves a head-on collision
 * asymmetrically — whichever unit the engine happens to examine first keeps its ground
 * — which would be a serious bug in a game whose entire premise is that neither side
 * moves first. Time-stepping makes two units marching at each other stop symmetrically,
 * one square apart, with no reference to list order.
 *
 * Path lengths only ever shrink, so every fixed point terminates.
 *
 * Combat is Strike-only. Units do not fight merely by ending up adjacent, which keeps
 * the triad sharp: Strike is the only thing that kills, Brace is what punishes it, and
 * Advance is what walks past it.
 */
export function resolveTurn(units: Unit[], rawOrders: Order[]): ResolveResult {
  const byId = new Map<number, Unit>();
  for (const u of units) byId.set(u.id, u);

  const orders = new Map<number, Order>();
  for (const u of units) orders.set(u.id, braceOrder(u));
  // First order for a unit wins, matching Game.submit — a unit cannot be double-tasked.
  const tasked = new Set<number>();
  for (const o of rawOrders) {
    if (!byId.has(o.unitId) || tasked.has(o.unitId)) continue;
    tasked.add(o.unitId);
    orders.set(o.unitId, o);
  }

  /** Remaining path length. Shrinks as conflicts are discovered; never grows. */
  const len = new Map<number, number>();
  for (const u of units) {
    const o = orders.get(u.id)!;
    len.set(u.id, o.stance === Stance.Advance ? o.path.length : 0);
  }

  /** Where a unit sits at tick t, given its current (possibly truncated) path. */
  const posAt = (u: Unit, t: number): number => {
    const l = len.get(u.id)!;
    if (t <= 0 || l === 0) return u.sq;
    const path = orders.get(u.id)!.path;
    return t <= l ? path[t - 1] : path[l - 1];
  };
  const movingAt = (u: Unit, t: number): boolean => len.get(u.id)! >= t;
  const traversed = (u: Unit): number[] => orders.get(u.id)!.path.slice(0, len.get(u.id)!);

  const events: CombatEvent[] = [];
  const cededGround = new Set<string>();
  const haltPoints = new Map<string, number>();

  const maxLen = units.reduce((m, u) => Math.max(m, len.get(u.id)!), 0);

  for (let t = 1; t <= maxLen; t++) {
    let stable = false;
    let guard = 0;
    while (!stable && guard++ < 64) {
      stable = true;

      // (1) Two or more movers want the same square this tick — all of them halt.
      //     This is Advance vs Advance: both stop, nobody dies.
      const wanted = new Map<number, Unit[]>();
      for (const u of units) {
        if (!movingAt(u, t)) continue;
        const s = posAt(u, t);
        const list = wanted.get(s);
        if (list) list.push(u);
        else wanted.set(s, [u]);
      }
      for (const [sq, group] of wanted) {
        if (group.length < 2) continue;
        for (const u of group) len.set(u.id, t - 1);
        if (group.some((g) => g.owner !== group[0].owner)) {
          haltPoints.set(`${group[0].id}:${group[1].id}`, sq);
        }
        stable = false;
      }
      if (!stable) continue;

      // (2) Two movers trying to trade places — both halt.
      const movers = units.filter((u) => movingAt(u, t));
      for (let a = 0; a < movers.length && stable; a++) {
        for (let b = a + 1; b < movers.length; b++) {
          const ua = movers[a];
          const ub = movers[b];
          if (posAt(ua, t) === posAt(ub, t - 1) && posAt(ub, t) === posAt(ua, t - 1)) {
            len.set(ua.id, t - 1);
            len.set(ub.id, t - 1);
            if (ua.owner !== ub.owner) haltPoints.set(`${ua.id}:${ub.id}`, posAt(ua, t));
            stable = false;
            break;
          }
        }
      }
      if (!stable) continue;

      // (3) A mover entering a square already held by a unit that is not moving.
      for (const u of units) {
        if (!movingAt(u, t)) continue;
        const s = posAt(u, t);
        let halt = false;

        for (const v of units) {
          if (v.id === u.id || movingAt(v, t)) continue;
          if (posAt(v, t) !== s) continue;

          if (v.owner === u.owner) {
            halt = true; // never stack with your own
            break;
          }
          const vStance = orders.get(v.id)!.stance;
          const soft = vStance === Stance.Brace && !HOLDS_GROUND_ON_BRACE(v.type);
          if (!soft) {
            // An enemy Striker, or a Bracing Warden holding ground.
            halt = true;
            break;
          }
          // Advance beats Brace: slip past the dug-in position. You may pass through
          // it, but you may not come to rest on top of it.
          if (t === len.get(u.id)!) {
            halt = true;
            break;
          }
          cededGround.add(`${u.id}:${v.id}:${s}`);
        }

        if (halt) {
          len.set(u.id, t - 1);
          stable = false;
        }
      }
    }
  }

  for (const [pair, sq] of haltPoints) {
    const [a, b] = pair.split(':').map(Number);
    events.push({ kind: 'advance-halted', at: sq, attacker: a, defender: b, died: [] });
  }
  for (const key of cededGround) {
    const [mover, holder, sq] = key.split(':').map(Number);
    // Only report ground actually taken — the mover may have been halted since.
    if (traversed(byId.get(mover)!).includes(sq)) {
      events.push({ kind: 'ground-ceded', at: sq, attacker: mover, defender: holder, died: [] });
    }
  }

  // ── Combat ────────────────────────────────────────────────────────────────
  // Strikes are evaluated against the post-movement picture but applied all at once,
  // so deaths are genuinely simultaneous: a unit that dies this turn still lands the
  // blow it ordered. That is what makes Strike-vs-Strike a mutual kill rather than a
  // race.
  const deaths = new Set<number>();
  const finalOf = (u: Unit): number => posAt(u, maxLen);

  for (const s of units) {
    const so = orders.get(s.id)!;
    if (so.stance !== Stance.Strike || so.target === undefined) continue;
    const t = so.target;

    const defenders = units.filter((d) => {
      if (d.owner === s.owner) return false;
      return d.sq === t || finalOf(d) === t || traversed(d).includes(t);
    });

    if (defenders.length === 0) {
      events.push({ kind: 'strike-whiff', at: t, attacker: s.id, died: [] });
      continue;
    }

    for (const d of defenders) {
      const dStance = orders.get(d.id)!.stance;
      const died: number[] = [];
      let kind: CombatEventKind;

      // Scouts lose every exchange they enter. This overrides everything below in both
      // directions, which is what makes them pure vision units — a Scout ordered to
      // Strike simply dies.
      if (LOSES_ALL_EXCHANGES(d.type)) {
        died.push(d.id);
        kind = 'strike-kills-advance';
      } else if (LOSES_ALL_EXCHANGES(s.type)) {
        died.push(s.id);
        kind = 'brace-kills-strike';
      } else if (dStance === Stance.Strike) {
        // Mutual destruction, unless one side's type counters the other's — the counter
        // decides the exchange whatever the defender chose. Confining it to Brace made
        // composition too weak to matter: a wrong-typed army was punished only when it
        // attacked a dug-in position.
        if (COUNTERS[s.type] === d.type) {
          died.push(d.id);
          kind = 'counter-breaks-brace';
        } else if (COUNTERS[d.type] === s.type) {
          died.push(s.id);
          kind = 'counter-breaks-brace';
        } else {
          died.push(s.id, d.id);
          kind = 'strike-trade';
        }
      } else if (dStance === Stance.Brace) {
        // Bracing normally kills the attacker — unless the attacker's type counters the
        // defender's. This is the only point where unit type touches combat, and it is
        // what makes army composition a live decision rather than flavour.
        if (COUNTERS[s.type] === d.type) {
          died.push(d.id);
          kind = 'counter-breaks-brace';
        } else {
          died.push(s.id);
          kind = 'brace-kills-strike';
        }
      } else {
        died.push(d.id);
        kind = 'strike-kills-advance';
      }

      for (const id of died) deaths.add(id);
      events.push({ kind, at: t, attacker: s.id, defender: d.id, died });
    }
  }

  const finalSq = new Map<number, number>();
  for (const u of units) if (!deaths.has(u.id)) finalSq.set(u.id, finalOf(u));

  return { finalSq, deaths, events };
}
