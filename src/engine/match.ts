import { Bot, RNG, mulberry32 } from './bots';
import { Game } from './game';
import { Player, TURN_LIMIT, UnitType } from './types';

export interface GameOutcome {
  winner: Player | null;
  reason: string;
  turns: number;
  deaths: number;
  nodeCounts: [number, number];
  /** Kills scored by each player, split at the halfway point of the turn limit. */
  killsFirstHalf: [number, number];
  killsSecondHalf: [number, number];
  /**
   * Mid-game snapshot for the non-monotonic-material test: who held a unit-count lead,
   * how large it was, and whether that leader could actually supply it.
   */
  midLeader: Player | null;
  midLead: number;
  midLeaderInsolvent: boolean;
  /**
   * Whether the mid-game unit-count leader also held *fewer* nodes — the actual
   * overextended state.
   *
   * This replaced `midLeaderInsolvent` as the discriminator because that flag could not
   * fire by construction: insolvency causes starvation, starvation removes a unit, and so
   * an insolvent player stops being the unit-count leader almost immediately. The bucket
   * read 0 games across three separate configurations before the metric itself turned out
   * to be the problem. "More units, less ground" is the state the lever is about.
   */
  midLeaderNodeDeficit: boolean;
  /**
   * Whether either side was insolvent at any point. The mid-game snapshot alone was too
   * narrow to tell whether the upkeep mechanic ever fires at all.
   */
  everInsolvent: boolean;
  /** Strikes ordered, and how many were decided by the composition counter. */
  strikes: number;
  counterKills: number;
}

/** Play one game to completion and report the metrics the design predictions need. */
export function playGame(
  bots: [Bot, Bot],
  seed: number,
  turnLimit = TURN_LIMIT,
  /**
   * Optional forced army composition per player: every fighting unit becomes this type.
   * Used to test the counter triangle in isolation — with the standard mixed deployment,
   * composition differences are diluted by a shared starting army and slow reinforcement
   * drift, so a null result cannot distinguish "the counter is too weak" from "the
   * compositions were never actually different".
   */
  armies?: [UnitType, UnitType]
): GameOutcome {
  const game = new Game();
  if (armies) {
    for (const u of game.units) {
      if (u.type === UnitType.Command || u.type === UnitType.Scout) continue;
      u.type = armies[u.owner];
    }
  }
  const rngs: [RNG, RNG] = [mulberry32(seed * 2 + 1), mulberry32(seed * 2 + 2)];
  bots[0].reset();
  bots[1].reset();

  let deaths = 0;
  const killsFirstHalf: [number, number] = [0, 0];
  const killsSecondHalf: [number, number] = [0, 0];

  /**
   * Snapshot every turn rather than at a fixed turn number. An earlier version sampled
   * at turn 15 and recorded data in 1 game out of 720, because games were ending long
   * before that — the metric silently measured nothing. Sampling every turn and picking
   * the midpoint retrospectively works whatever length the game turns out to be.
   */
  const snapshots: Array<{
    leader: Player;
    lead: number;
    insolvent: boolean;
    nodeDeficit: boolean;
  }> = [];
  let everInsolvent = false;
  let strikes = 0;
  let counterKills = 0;

  while (game.status.state === 'playing' && game.turn < turnLimit) {
    const views = [game.viewFor(0), game.viewFor(1)] as const;
    const owners = new Map(game.units.map((u) => [u.id, u.owner]));

    const orders0 = bots[0].orders(views[0], rngs[0]);
    const orders1 = bots[1].orders(views[1], rngs[1]);
    const record = game.submit(orders0, orders1, [
      bots[0].reinforce?.(views[0]),
      bots[1].reinforce?.(views[1]),
    ]);

    deaths += record.deaths.length;
    for (const e of record.events) {
      if (e.kind === 'counter-breaks-brace') counterKills++;
      if (
        e.kind === 'strike-whiff' ||
        e.kind === 'strike-trade' ||
        e.kind === 'brace-kills-strike' ||
        e.kind === 'counter-breaks-brace' ||
        e.kind === 'strike-kills-advance'
      ) {
        strikes++;
      }
    }
    const half = game.turn * 2 <= turnLimit ? killsFirstHalf : killsSecondHalf;
    for (const id of record.deaths) {
      const owner = owners.get(id);
      if (owner !== undefined) half[(1 - owner) as Player]++;
    }

    bots[0].observe(views[0], record, 0);
    bots[1].observe(views[1], record, 1);

    if (game.insolvent(0) || game.insolvent(1)) everInsolvent = true;

    const n0 = game.unitsOf(0).length;
    const n1 = game.unitsOf(1).length;
    if (n0 !== n1) {
      const leader: Player = n0 > n1 ? 0 : 1;
      const foe = (1 - leader) as Player;
      snapshots.push({
        leader,
        lead: Math.abs(n0 - n1),
        insolvent: game.insolvent(leader),
        nodeDeficit: game.nodesHeld(leader) < game.nodesHeld(foe),
      });
    } else {
      snapshots.push({ leader: 0, lead: 0, insolvent: false, nodeDeficit: false });
    }
  }

  const mid = snapshots[Math.floor(snapshots.length / 2)];
  const midLeader: Player | null = mid && mid.lead > 0 ? mid.leader : null;
  const midLead = mid?.lead ?? 0;
  const midLeaderInsolvent = mid?.insolvent ?? false;
  const midLeaderNodeDeficit = mid?.nodeDeficit ?? false;

  const status = game.status;
  return {
    winner: status.state === 'won' ? status.winner : null,
    reason: status.state === 'playing' ? 'unfinished' : status.reason,
    turns: game.turn,
    deaths,
    nodeCounts: [game.nodesHeld(0), game.nodesHeld(1)],
    killsFirstHalf,
    killsSecondHalf,
    midLeader,
    midLead,
    midLeaderInsolvent,
    midLeaderNodeDeficit,
    everInsolvent,
    strikes,
    counterKills,
  };
}

export interface Duel {
  /** Win rate for bot A, counting draws as half, averaged over both seatings. */
  scoreA: number;
  winsA: number;
  winsB: number;
  draws: number;
  games: number;
  outcomes: GameOutcome[];
}

/**
 * Play a balanced duel: half the games with A as player 0, half with A as player 1.
 * Simultaneous movement means there is no first-mover advantage by construction, but
 * seat-swapping still controls for the asymmetric deployment geometry.
 */
export function duel(
  a: Bot,
  b: Bot,
  games: number,
  seed = 1,
  /** Forced compositions, given in A-then-B order and swapped along with the seats. */
  armies?: [UnitType, UnitType]
): Duel {
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  const outcomes: GameOutcome[] = [];

  for (let g = 0; g < games; g++) {
    const aIsZero = g % 2 === 0;
    const pair: [Bot, Bot] = aIsZero ? [a, b] : [b, a];
    const forced: [UnitType, UnitType] | undefined = armies
      ? aIsZero
        ? armies
        : [armies[1], armies[0]]
      : undefined;
    const o = playGame(pair, seed + g * 7919, TURN_LIMIT, forced);
    outcomes.push(o);

    if (o.winner === null) draws++;
    else {
      const aWon = aIsZero ? o.winner === 0 : o.winner === 1;
      if (aWon) winsA++;
      else winsB++;
    }
  }

  return {
    scoreA: (winsA + draws / 2) / games,
    winsA,
    winsB,
    draws,
    games,
    outcomes,
  };
}
