import { describe, expect, it } from 'vitest';
import { mulberry32, planBot } from '../src/engine/bots';
import { losClear, visibleSquares } from '../src/engine/fog';
import { Game } from '../src/engine/game';
import { isLegalOrder, legalOrders } from '../src/engine/orders';
import { resolveTurn } from '../src/engine/resolve';
import { homeSquares, initialNodeOwners, initialUnits, terrainIsDisjoint } from '../src/engine/setup';
import {
  COUNTERS,
  HOLD_TURNS,
  NODES,
  NODE_DECAY_GRACE,
  NODES_TO_WIN,
  NSQ,
  Order,
  Player,
  RIDGES,
  Stance,
  Unit,
  UnitType,
  idx,
} from '../src/engine/types';

const U = (id: number, type: UnitType, owner: Player, sq: number): Unit => ({
  id,
  type,
  owner,
  sq,
});

const adv = (id: number, path: number[]): Order => ({
  unitId: id,
  stance: Stance.Advance,
  path,
});
const brace = (id: number): Order => ({ unitId: id, stance: Stance.Brace, path: [] });
const strike = (id: number, target: number): Order => ({
  unitId: id,
  stance: Stance.Strike,
  path: [],
  target,
});

// Handy squares on the centre file.
const c2 = idx(4, 2);
const c3 = idx(4, 3);
const C = idx(4, 4); // e5, the centre node
const c5 = idx(4, 5);
const c6 = idx(4, 6);

describe('setup', () => {
  it('deals 7 units to each side in a 180°-symmetric position', () => {
    const units = initialUnits();
    expect(units.filter((u) => u.owner === 0)).toHaveLength(7);
    expect(units.filter((u) => u.owner === 1)).toHaveLength(7);

    for (const u of units.filter((x) => x.owner === 0)) {
      const mirror = idx(8 - (u.sq % 9), 8 - Math.floor(u.sq / 9));
      const twin = units.find((x) => x.owner === 1 && x.sq === mirror);
      expect(twin, `mirror of ${u.sq}`).toBeDefined();
      expect(twin!.type).toBe(u.type);
    }
  });

  it('fields one of each fighting type plus a Scout and Command', () => {
    const mine = initialUnits().filter((u) => u.owner === 0);
    const count = (t: UnitType) => mine.filter((u) => u.type === t).length;
    expect(count(UnitType.Command)).toBe(1);
    expect(count(UnitType.Vanguard)).toBe(2);
    expect(count(UnitType.Warden)).toBe(2);
    expect(count(UnitType.Lancer)).toBe(1);
    expect(count(UnitType.Scout)).toBe(1);
  });

  it('keeps ridges and nodes disjoint', () => {
    expect(terrainIsDisjoint()).toBe(true);
    expect(RIDGES).toHaveLength(8);
    expect(NODES).toHaveLength(5);
  });

  it('places ridges with 180° symmetry so neither side gets a vision edge', () => {
    for (const r of RIDGES) {
      const mirror = idx(8 - (r % 9), 8 - Math.floor(r / 9));
      expect(RIDGES).toContain(mirror);
    }
  });
});

describe('order generation', () => {
  it('produces the documented order counts per unit type', () => {
    // Counts from a central square, where nothing is clipped by the board edge.
    expect(legalOrders(U(1, UnitType.Command, 0, C))).toHaveLength(9); // 8 advances + brace
    expect(legalOrders(U(1, UnitType.Vanguard, 0, C))).toHaveLength(21); // 12 + 8 + 1
    expect(legalOrders(U(1, UnitType.Warden, 0, C))).toHaveLength(25); // 16 + 8 + 1
    expect(legalOrders(U(1, UnitType.Scout, 0, C))).toHaveLength(25); // 16 + 8 + 1
  });

  it('never lets Command Strike', () => {
    const cmd = U(1, UnitType.Command, 0, C);
    expect(legalOrders(cmd).some((o) => o.stance === Stance.Strike)).toBe(false);
    expect(isLegalOrder(cmd, strike(1, c5))).toBe(false);
  });

  it('restricts Vanguards to straight orthogonal lines', () => {
    const v = U(1, UnitType.Vanguard, 0, C);
    expect(isLegalOrder(v, adv(1, [idx(5, 5)]))).toBe(false); // diagonal
    expect(isLegalOrder(v, adv(1, [c5, c6, idx(4, 7)]))).toBe(true); // 3 north
    expect(isLegalOrder(v, adv(1, [c5, c6, idx(4, 7), idx(4, 8)]))).toBe(false); // too far
  });

  it('rejects malformed orders', () => {
    const v = U(1, UnitType.Vanguard, 0, C);
    expect(isLegalOrder(v, { unitId: 2, stance: Stance.Brace, path: [] })).toBe(false);
    expect(isLegalOrder(v, { unitId: 1, stance: Stance.Brace, path: [c5] })).toBe(false);
    expect(isLegalOrder(v, { unitId: 1, stance: Stance.Strike, path: [] })).toBe(false);
    expect(isLegalOrder(v, strike(1, idx(4, 6)))).toBe(false); // not adjacent
  });

  it('every generated order validates', () => {
    for (const type of [UnitType.Command, UnitType.Vanguard, UnitType.Warden, UnitType.Scout]) {
      const u = U(1, type, 0, idx(1, 1)); // near a corner, to exercise clipping
      for (const o of legalOrders(u)) expect(isLegalOrder(u, o)).toBe(true);
    }
  });
});

describe('the stance triad', () => {
  it('Strike kills Advance', () => {
    const units = [U(1, UnitType.Vanguard, 0, c3), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [adv(1, [C]), strike(2, C)]);
    expect([...r.deaths]).toEqual([1]);
    expect(r.events.some((e) => e.kind === 'strike-kills-advance')).toBe(true);
  });

  it('Brace kills Strike when the attacker does not counter it', () => {
    // Vanguard does not counter Vanguard, so the Bracer wins the exchange.
    const units = [U(1, UnitType.Vanguard, 0, C), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [brace(1), strike(2, C)]);
    expect([...r.deaths]).toEqual([2]);
    expect(r.events.some((e) => e.kind === 'brace-kills-strike')).toBe(true);
  });

  it('is broken by the countering type: Vanguard beats a Bracing Warden', () => {
    const units = [U(1, UnitType.Warden, 0, C), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [brace(1), strike(2, C)]);
    expect([...r.deaths]).toEqual([1]); // the Bracer dies instead
    expect(r.events.some((e) => e.kind === 'counter-breaks-brace')).toBe(true);
  });

  it('closes the counter triangle in all three directions', () => {
    const triangle: Array<[UnitType, UnitType]> = [
      [UnitType.Vanguard, UnitType.Warden],
      [UnitType.Warden, UnitType.Lancer],
      [UnitType.Lancer, UnitType.Vanguard],
    ];
    for (const [breaker, broken] of triangle) {
      expect(COUNTERS[breaker]).toBe(broken);

      // The breaker wins...
      const a = resolveTurn([U(1, broken, 0, C), U(2, breaker, 1, c5)], [
        brace(1),
        strike(2, C),
      ]);
      expect([...a.deaths], `${UnitType[breaker]} breaks ${UnitType[broken]}`).toEqual([1]);

      // ...and the reverse matchup does not.
      const b = resolveTurn([U(1, breaker, 0, C), U(2, broken, 1, c5)], [
        brace(1),
        strike(2, C),
      ]);
      expect([...b.deaths], `${UnitType[broken]} cannot break ${UnitType[breaker]}`).toEqual([2]);
    }
  });

  it('leaves the counter irrelevant against an Advance', () => {
    // An advancer dies to any Strike, countering type or not.
    const r = resolveTurn([U(1, UnitType.Warden, 0, c3), U(2, UnitType.Vanguard, 1, c5)], [
      adv(1, [C]),
      strike(2, C),
    ]);
    expect([...r.deaths]).toEqual([1]);
    expect(r.events.some((e) => e.kind === 'strike-kills-advance')).toBe(true);
  });

  it('lets the countering type win a Strike-versus-Strike outright', () => {
    // Vanguard counters Warden, so the trade is one-sided.
    const one = resolveTurn([U(1, UnitType.Warden, 0, C), U(2, UnitType.Vanguard, 1, c5)], [
      strike(1, c5),
      strike(2, C),
    ]);
    expect([...one.deaths]).toEqual([1]);

    // Neutral matchup still trades both ways.
    const both = resolveTurn([U(1, UnitType.Warden, 0, C), U(2, UnitType.Warden, 1, c5)], [
      strike(1, c5),
      strike(2, C),
    ]);
    expect(both.deaths.size).toBe(2);
  });

  it('Strike versus Strike is a mutual kill', () => {
    const units = [U(1, UnitType.Vanguard, 0, C), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [strike(1, c5), strike(2, C)]);
    expect(r.deaths.has(1)).toBe(true);
    expect(r.deaths.has(2)).toBe(true);
    expect(r.events.some((e) => e.kind === 'strike-trade')).toBe(true);
  });

  it('Advance walks past a Bracing Vanguard and cedes it no ground', () => {
    const units = [U(1, UnitType.Vanguard, 0, c2), U(2, UnitType.Vanguard, 1, C)];
    const r = resolveTurn(units, [adv(1, [c3, C, c5]), brace(2)]);
    expect(r.deaths.size).toBe(0);
    expect(r.finalSq.get(1)).toBe(c5); // slipped all the way past
    expect(r.finalSq.get(2)).toBe(C); // the Bracer keeps its square
    expect(r.events.some((e) => e.kind === 'ground-ceded')).toBe(true);
  });

  it('a Bracing Warden is the exception — it holds its ground', () => {
    const units = [U(1, UnitType.Vanguard, 0, c2), U(2, UnitType.Warden, 1, C)];
    const r = resolveTurn(units, [adv(1, [c3, C, c5]), brace(2)]);
    expect(r.deaths.size).toBe(0);
    expect(r.finalSq.get(1)).toBe(c3); // stopped short
  });

  it('an Advance cannot come to rest on a Bracer it passed', () => {
    const units = [U(1, UnitType.Vanguard, 0, c3), U(2, UnitType.Vanguard, 1, C)];
    const r = resolveTurn(units, [adv(1, [C]), brace(2)]);
    expect(r.finalSq.get(1)).toBe(c3);
    expect(r.deaths.size).toBe(0);
  });

  it('Scouts lose every exchange, even when Bracing', () => {
    const units = [U(1, UnitType.Scout, 0, C), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [brace(1), strike(2, C)]);
    expect([...r.deaths]).toEqual([1]);
  });

  it('a Scout that Strikes simply dies', () => {
    const units = [U(1, UnitType.Scout, 0, C), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [strike(1, c5), adv(2, [c6])]);
    expect([...r.deaths]).toEqual([1]);
  });

  it('a Strike into empty space whiffs', () => {
    const units = [U(1, UnitType.Vanguard, 0, C)];
    const r = resolveTurn(units, [strike(1, c5)]);
    expect(r.deaths.size).toBe(0);
    expect(r.events.some((e) => e.kind === 'strike-whiff')).toBe(true);
  });
});

describe('simultaneous movement', () => {
  it('halts a head-on collision symmetrically — no side moves first', () => {
    const units = [U(1, UnitType.Vanguard, 0, c2), U(2, UnitType.Vanguard, 1, c6)];
    const r = resolveTurn(units, [adv(1, [c3, C, c5]), adv(2, [c5, C, c3])]);
    expect(r.deaths.size).toBe(0);
    // Each advanced exactly one square and stopped short of the contested centre.
    expect(r.finalSq.get(1)).toBe(c3);
    expect(r.finalSq.get(2)).toBe(c5);
    expect(r.events.some((e) => e.kind === 'advance-halted')).toBe(true);
  });

  it('is symmetric under mirroring the whole position', () => {
    const units = [U(1, UnitType.Vanguard, 0, c2), U(2, UnitType.Vanguard, 1, c6)];
    const r = resolveTurn(units, [adv(1, [c3]), adv(2, [c5])]);
    expect(r.finalSq.get(1)).toBe(c3);
    expect(r.finalSq.get(2)).toBe(c5);
  });

  it('refuses to let two units trade places', () => {
    const units = [U(1, UnitType.Vanguard, 0, C), U(2, UnitType.Vanguard, 1, c5)];
    const r = resolveTurn(units, [adv(1, [c5]), adv(2, [C])]);
    expect(r.finalSq.get(1)).toBe(C);
    expect(r.finalSq.get(2)).toBe(c5);
  });

  it('never stacks friendly units', () => {
    const units = [U(1, UnitType.Vanguard, 0, c2), U(2, UnitType.Warden, 0, c3)];
    const r = resolveTurn(units, [adv(1, [c3]), brace(2)]);
    expect(r.finalSq.get(1)).toBe(c2);
  });

  it('lets two friendly units converge on one square without either arriving', () => {
    const units = [U(1, UnitType.Vanguard, 0, c3), U(2, UnitType.Vanguard, 0, c5)];
    const r = resolveTurn(units, [adv(1, [C]), adv(2, [C])]);
    expect(r.finalSq.get(1)).toBe(c3);
    expect(r.finalSq.get(2)).toBe(c5);
  });
});

describe('fog of war', () => {
  it('lets ridges block line of sight', () => {
    const ridge = RIDGES[1]; // (3,2)
    const from = idx(2, 2);
    const to = idx(4, 2);
    expect(losClear(from, ridge)).toBe(true); // you can see the ridge itself
    expect(losClear(from, to)).toBe(false); // but not through it
  });

  it('gives Scouts materially more vision than line units', () => {
    const far = idx(0, 4);
    const scout = visibleSquares([U(1, UnitType.Scout, 0, C)], 0);
    const vanguard = visibleSquares([U(1, UnitType.Vanguard, 0, C)], 0);
    expect(scout.has(far)).toBe(true);
    expect(vanguard.has(far)).toBe(false);
    expect(scout.size).toBeGreaterThan(vanguard.size * 3);
  });

  it('keeps stale ghosts after the enemy slips out of sight', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Command, 1, idx(4, 8)),
      U(3, UnitType.Scout, 0, C),
      U(4, UnitType.Vanguard, 1, c6),
    ];
    g.submit([], []);
    expect(g.ghosts[0].get(4)?.sq).toBe(c6);

    // Blind the observer entirely; the remembered position must persist.
    g.units = g.units.filter((u) => u.id !== 3);
    g.submit([], []);
    const ghost = g.ghosts[0].get(4);
    expect(ghost).toBeDefined();
    expect(ghost!.sq).toBe(c6);
    expect(ghost!.turn).toBe(1); // stamped when it was actually seen
  });

  it('forgets ghosts for units confirmed dead — combat results are public', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Command, 1, idx(4, 8)),
      U(3, UnitType.Vanguard, 0, C),
      U(4, UnitType.Vanguard, 1, c5),
    ];
    // Vanguard does not counter Vanguard, so the Bracer kills the attacker.
    g.submit([brace(3)], [strike(4, C)]);
    expect(g.units.some((u) => u.id === 4)).toBe(false);
    expect(g.ghosts[0].has(4)).toBe(false);
  });
});

describe('supply', () => {
  it('starves an army larger than its territory can sustain', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Warden, 0, idx(3, 0)),
      U(3, UnitType.Warden, 0, idx(5, 0)),
      U(4, UnitType.Vanguard, 0, idx(0, 1)),
      U(5, UnitType.Vanguard, 0, idx(1, 1)),
      U(6, UnitType.Vanguard, 0, idx(2, 1)),
      U(7, UnitType.Scout, 0, idx(6, 1)),
      U(8, UnitType.Command, 1, idx(4, 8)),
    ];
    g.nodeOwners = [null, null, null, null, null]; // strip starting territory
    expect(g.insolvent(0)).toBe(true); // upkeep 3 against income 1

    const rec = g.submit([], []);
    expect(rec.starved).toHaveLength(1);
    expect(g.units.some((u) => u.id === 7)).toBe(false); // the Scout goes first
  });

  it('never starves the Command', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Warden, 0, idx(3, 0)),
      U(3, UnitType.Warden, 0, idx(5, 0)),
      U(4, UnitType.Warden, 0, idx(2, 0)),
      U(5, UnitType.Warden, 0, idx(6, 0)),
      U(6, UnitType.Warden, 0, idx(1, 0)),
      U(7, UnitType.Warden, 0, idx(7, 0)),
      U(8, UnitType.Command, 1, idx(4, 8)),
    ];
    g.nodeOwners = [null, null, null, null, null];
    expect(g.insolvent(0)).toBe(true);

    for (let i = 0; i < 8; i++) if (g.status.state === 'playing') g.submit([], []);
    // It starves down to something it can feed, but never eats its own Command.
    expect(g.units.some((u) => u.id === 1)).toBe(true);
    expect(g.insolvent(0)).toBe(false);
  });

  it('reinforces from banked supply, and never into insolvency', () => {
    const g = new Game();
    g.units = [U(1, UnitType.Command, 0, idx(4, 0)), U(2, UnitType.Command, 1, idx(4, 8))];
    g.nodeOwners = [null, null, null, null, null];
    g.supply[0] = 3;
    const rec = g.submit([], []);
    expect(rec.reinforced).toHaveLength(1);
    expect(g.unitsOf(0)).toHaveLength(2);
    expect(g.insolvent(0)).toBe(false);
  });

  it('opens exactly solvent — no side starves on turn 1', () => {
    const g = new Game();
    expect(g.nodesHeld(0)).toBe(2);
    expect(g.nodesHeld(1)).toBe(2);
    expect(g.income(0)).toBe(3);
    expect(g.upkeep(0)).toBe(3); // 7 units, 4 free
    expect(g.insolvent(0)).toBe(false);

    const rec = g.submit([], []);
    expect(rec.starved).toHaveLength(0);
    expect(g.unitsOf(0)).toHaveLength(7);
    expect(g.unitsOf(1)).toHaveLength(7);
  });

  it('makes losing a node cost a unit', () => {
    const g = new Game();
    g.nodeOwners = [null, null, 0, 1, 1]; // player 0 down to one node
    expect(g.insolvent(0)).toBe(true); // upkeep 3 against income 2
    const rec = g.submit([], []);
    expect(rec.starved).toHaveLength(1);
  });

  it('gives each side its own half at the start, centre unowned', () => {
    const owners = initialNodeOwners();
    expect(owners[0]).toBeNull(); // the centre is contested from move one
    expect(owners.filter((o) => o === 0)).toHaveLength(2);
    expect(owners.filter((o) => o === 1)).toHaveLength(2);
  });

  it('scales the sustainable army size with nodes held', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Vanguard, 0, NODES[0]),
      U(3, UnitType.Vanguard, 0, NODES[1]),
      U(4, UnitType.Vanguard, 0, NODES[2]),
      U(5, UnitType.Command, 1, idx(4, 8)),
    ];
    g.submit([], []);
    expect(g.nodesHeld(0)).toBe(3);
    expect(g.income(0)).toBe(4); // 1 + 3 nodes
    expect(g.insolvent(0)).toBe(false); // 4 units on 3 nodes is sustainable
  });
});

describe('node decay', () => {
  it('lets an ungarrisoned node rot back to unowned', () => {
    const g = new Game();
    g.units = [U(1, UnitType.Command, 0, idx(4, 0)), U(2, UnitType.Command, 1, idx(4, 8))];
    expect(g.nodesHeld(0)).toBe(2); // starting territory

    for (let i = 0; i <= NODE_DECAY_GRACE; i++) g.submit([], []);
    // Nobody ever Braced on anything, so every holding lapses.
    expect(g.nodesHeld(0)).toBe(0);
    expect(g.nodesHeld(1)).toBe(0);
  });

  it('keeps a node indefinitely while a unit keeps Bracing on it', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Vanguard, 0, NODES[1]),
      U(3, UnitType.Command, 1, idx(4, 8)),
    ];
    for (let i = 0; i < NODE_DECAY_GRACE * 3; i++) g.submit([], []);
    expect(g.nodeOwners[1]).toBe(0);
  });

  it('starves a player whose territory rots out from under them', () => {
    const g = new Game();
    // A full army and no garrison anywhere: income collapses, upkeep does not.
    for (let i = 0; i <= NODE_DECAY_GRACE; i++) g.submit([], []);
    expect(g.nodesHeld(0)).toBe(0);
    expect(g.insolvent(0)).toBe(true);
    const rec = g.submit([], []);
    expect(rec.starved.length).toBeGreaterThan(0);
  });
});

describe('reinforcement composition', () => {
  it('brings in the requested type', () => {
    const g = new Game();
    g.units = [U(1, UnitType.Command, 0, idx(4, 0)), U(2, UnitType.Command, 1, idx(4, 8))];
    g.nodeOwners = [null, null, null, null, null];
    g.supply[0] = 3;
    const rec = g.submit([], [], [UnitType.Lancer, undefined]);
    expect(rec.reinforced).toHaveLength(1);
    expect(g.units.find((u) => u.id === rec.reinforced[0])!.type).toBe(UnitType.Lancer);
  });

  it('refuses to mint a second Command and falls back to Vanguard', () => {
    const g = new Game();
    g.units = [U(1, UnitType.Command, 0, idx(4, 0)), U(2, UnitType.Command, 1, idx(4, 8))];
    g.nodeOwners = [null, null, null, null, null];
    g.supply[0] = 3;
    const rec = g.submit([], [], [UnitType.Command, undefined]);
    expect(g.units.find((u) => u.id === rec.reinforced[0])!.type).toBe(UnitType.Vanguard);
    expect(g.unitsOf(0).filter((u) => u.type === UnitType.Command)).toHaveLength(1);
  });
});

describe('victory', () => {
  it('ends when a Command dies', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, C),
      U(2, UnitType.Command, 1, idx(0, 8)),
      U(3, UnitType.Vanguard, 1, c6),
    ];
    g.submit([adv(1, [c5])], [strike(3, c5)]);
    expect(g.status).toMatchObject({ state: 'won', winner: 1, reason: 'Command destroyed' });
  });

  it('awards the node victory only after the hold clock runs out', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      ...NODES.slice(0, NODES_TO_WIN).map((sq, i) =>
        U(10 + i, UnitType.Vanguard, 0, sq)
      ),
      U(5, UnitType.Command, 1, idx(4, 8)),
    ];
    for (let i = 0; i < HOLD_TURNS - 1; i++) {
      g.submit([], []);
      expect(g.status.state, `turn ${i + 1}`).toBe('playing');
      expect(g.holdStreak[0]).toBe(i + 1);
    }
    g.submit([], []);
    expect(g.status).toMatchObject({ state: 'won', winner: 0 });
  });

  it('resets the hold clock when control slips', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      ...NODES.slice(0, NODES_TO_WIN).map((sq, i) =>
        U(10 + i, UnitType.Vanguard, 0, sq)
      ),
      U(5, UnitType.Command, 1, idx(4, 8)),
      U(6, UnitType.Vanguard, 1, idx(2, 4)),
    ];
    g.submit([], []);
    expect(g.holdStreak[0]).toBe(1);

    // Walking onto a node does not take it — only Bracing on it does.
    g.units.find((u) => u.sq === NODES[1])!.sq = idx(1, 1);
    g.submit([], [adv(6, [NODES[1]])]);
    expect(g.nodeOwners[1]).toBe(0); // player 1 arrived but did not dig in
    expect(g.holdStreak[0]).toBe(2);

    // Now it digs in, and the node changes hands.
    g.submit([], []);
    expect(g.nodeOwners[1]).toBe(1);
    expect(g.holdStreak[0]).toBe(0);
  });

  it('decides a stalemate on node count at the turn limit', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      // Two garrisons hold against decay; the centre stays unowned, so neither side ever
      // reaches the victory threshold and the game runs the full distance.
      U(2, UnitType.Vanguard, 0, NODES[1]),
      U(3, UnitType.Vanguard, 0, NODES[2]),
      U(4, UnitType.Command, 1, idx(4, 8)),
      U(5, UnitType.Vanguard, 1, NODES[3]),
    ];
    while (g.status.state === 'playing') g.submit([], []);
    expect(g.nodesHeld(0)).toBe(2);
    expect(g.nodesHeld(1)).toBe(1);
    expect(g.turn).toBe(60);
    expect(g.status).toMatchObject({
      state: 'won',
      winner: 0,
      reason: 'turn limit, node count',
    });
  });

  it('refuses further orders once the game is over', () => {
    const g = new Game();
    g.units = [U(1, UnitType.Command, 0, C)];
    g.submit([], []);
    expect(g.status.state).toBe('won');
    expect(() => g.submit([], [])).toThrow();
  });
});

describe('robustness', () => {
  it('treats missing, foreign and illegal orders as Brace', () => {
    const g = new Game();
    g.units = [
      U(1, UnitType.Command, 0, idx(4, 0)),
      U(2, UnitType.Vanguard, 0, c2),
      U(3, UnitType.Command, 1, idx(4, 8)),
    ];
    // Order 2 is illegal (4 squares), order 3 belongs to the opponent.
    g.submit([adv(2, [c3, C, c5, c6]), brace(3)], []);
    expect(g.units.find((u) => u.id === 2)!.sq).toBe(c2);
    expect(g.status.state).toBe('playing');
  });

  it('ignores duplicate orders for the same unit', () => {
    const units = [U(1, UnitType.Vanguard, 0, c2)];
    const r = resolveTurn(units, [adv(1, [c3]), adv(1, [c3, C, c5])]);
    expect(r.finalSq.get(1)).toBe(c3); // the first order stands
  });
});

describe('seat symmetry', () => {
  /**
   * Penumbra is simultaneous-move, so there is no first player and neither seat may
   * enjoy any advantage whatsoever. This is a regression test for a real bug: home-rank
   * reinforcement squares were generated as the *reflection* of player 0's list rather
   * than the 180° *rotation* (a1 mirrors to i9, not a9), which was worth a 2:1 win rate
   * to player 1 in self-play with identical bots — and was completely invisible in
   * ordinary play.
   *
   * The invariant: hand player 1 the exact rotation of player 0's orders and the
   * position must stay mirror-symmetric indefinitely.
   */
  const m = (sq: number) => NSQ - 1 - sq;

  for (const plan of ['centre', 'flank', 'counter', 'spread'] as const) {
    it(`stays mirror-symmetric under mirrored play (${plan})`, () => {
      const bot = planBot('probe', plan);
      const g = new Game();
      const rng = mulberry32(4242);

      for (let turn = 1; turn <= 25 && g.status.state === 'playing'; turn++) {
        const orders0 = bot.orders(g.viewFor(0), rng);

        const twin = new Map<number, number>();
        for (const a of g.unitsOf(0)) {
          const b = g.unitsOf(1).find((u) => u.sq === m(a.sq) && u.type === a.type);
          if (b) twin.set(a.id, b.id);
        }
        const orders1 = orders0
          .filter((o) => twin.has(o.unitId))
          .map((o) => ({
            unitId: twin.get(o.unitId)!,
            stance: o.stance,
            path: o.path.map(m),
            target: o.target === undefined ? undefined : m(o.target),
          }));

        g.submit(orders0, orders1);

        expect(g.unitsOf(0).length, `unit count, turn ${turn}`).toBe(g.unitsOf(1).length);
        expect(g.nodesHeld(0), `nodes held, turn ${turn}`).toBe(g.nodesHeld(1));
        expect(g.supply[0], `supply, turn ${turn}`).toBe(g.supply[1]);
        for (const a of g.unitsOf(0)) {
          const hasTwin = g.unitsOf(1).some((u) => u.sq === m(a.sq) && u.type === a.type);
          expect(hasTwin, `mirror of p0 unit at ${a.sq} on turn ${turn}`).toBe(true);
        }
      }
    });
  }

  it('places reinforcements as a 180° rotation, not a reflection', () => {
    const zero = homeSquares(0);
    const one = homeSquares(1);
    expect(one).toEqual(zero.map((s) => NSQ - 1 - s));
  });
});
