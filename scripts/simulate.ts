/**
 * Penumbra design harness.
 *
 * DESIGN.md §5 makes five falsifiable predictions. This script tests four of them
 * mechanically (the fifth, human legibility, needs humans). Each section prints a
 * verdict so a failure is impossible to read as a pass.
 *
 * Run: npx vite-node scripts/simulate.ts [games]
 */
import {
  Bot,
  adaptiveCompositionBot,
  bestResponseBot,
  blindBot,
  compositionBot,
  conditionalExploiterBot,
  planBot,
  randomBot,
  stanceBiasBot,
  tellBot,
} from '../src/engine/bots';
import { UnitType } from '../src/engine/types';
import { GameOutcome, duel } from '../src/engine/match';

const GAMES = Number(process.argv[2] ?? 200);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);

function heading(n: number | string, title: string, claim: string) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`PREDICTION ${n} — ${title}`);
  console.log(`  claim: ${claim}`);
  console.log('═'.repeat(78));
}

function verdict(pass: boolean, detail: string) {
  console.log(`\n  ${pass ? '✅ HOLDS' : '❌ FAILS'} — ${detail}`);
  return pass;
}

/**
 * Probe families for the intransitivity test, in the order they were tried.
 *
 * v0.1 used stance-frequency archetypes and v0.2 used plan-based bots; both produced
 * clean pecking orders. v0.3 moves the intended cycle into army *composition*, so the
 * primary probe is now composition bots. The plan bots are kept as a control — if the
 * cycle is real it should show up among compositions and not among plans.
 */
const COMPOSITIONS: Bot[] = [
  compositionBot('vanguard', UnitType.Vanguard),
  compositionBot('warden', UnitType.Warden),
  compositionBot('lancer', UnitType.Lancer),
];

const ARCHETYPES: Bot[] = [
  planBot('centre', 'centre'),
  planBot('flank', 'flank'),
  planBot('counter', 'counter', [0.30, 0.45, 0.25]),
  planBot('spread', 'spread'),
];

const allOutcomes: GameOutcome[] = [];

// ── 1. Intransitivity ────────────────────────────────────────────────────────
heading(
  1,
  'INTRANSITIVITY',
  'the stance triad makes the strategy space cycle, so plain self-play cannot converge'
);

function roundRobin(family: Bot[], label: string, seedBase: number) {
  const k = family.length;
  const score: number[][] = Array.from({ length: k }, () => new Array(k).fill(0.5));

  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const d = duel(family[i], family[j], GAMES, seedBase + i * 31 + j);
      score[i][j] = d.scoreA;
      score[j][i] = 1 - d.scoreA;
      allOutcomes.push(...d.outcomes);
    }
  }

  console.log(`\n  ${label} — win rate of row versus column (${GAMES} games per pair):\n`);
  console.log(`  ${pad('', 12)}${family.map((b) => pad(b.name, 12)).join('')}`);
  for (let i = 0; i < k; i++) {
    const row = family.map((_, j) => pad(i === j ? '—' : pct(score[i][j]), 12)).join('');
    console.log(`  ${pad(family[i].name, 12)}${row}`);
  }

  const beats = (i: number, j: number) => score[i][j] > 0.5;
  const cycles: string[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      for (let l = 0; l < k; l++) {
        if (i === j || j === l || i === l) continue;
        if (i > l) continue; // one representative per cycle
        if (beats(i, j) && beats(j, l) && beats(l, i)) {
          cycles.push(
            `${family[i].name} → ${family[j].name} → ${family[l].name} → ${family[i].name}`
          );
        }
      }
    }
  }

  if (cycles.length) {
    console.log(`\n  3-cycles found in ${label.toLowerCase()}:`);
    for (const c of cycles) console.log(`    ${c}`);
  } else {
    console.log(`\n  No 3-cycles in ${label.toLowerCase()} — this family is transitive.`);
  }
  return cycles;
}

const compCycles = roundRobin(COMPOSITIONS, 'Army composition', 1000);
roundRobin(ARCHETYPES, 'Plans (control)', 3000);

const p1 = verdict(
  compCycles.length > 0,
  compCycles.length > 0
    ? `the counter triangle cycles — ${compCycles.length} cycle(s) among compositions, so a self-play ladder has no monotone gradient to climb`
    : 'compositions are transitive too; the counter triangle is not strong enough to cycle'
);

// ── 1b. The counter triangle in isolation ───────────────────────────────────
heading(
  '1b',
  'COUNTER TRIANGLE, PURE ARMIES',
  'with composition differences undiluted, does the triangle cycle?'
);

const FIGHTERS: Array<[string, UnitType]> = [
  ['vanguard', UnitType.Vanguard],
  ['warden', UnitType.Warden],
  ['lancer', UnitType.Lancer],
];
const neutral = planBot('neutral', 'spread');
const pureScore: number[][] = Array.from({ length: 3 }, () => new Array(3).fill(0.5));

for (let i = 0; i < 3; i++) {
  for (let j = i + 1; j < 3; j++) {
    const d = duel(neutral, neutral, GAMES, 9000 + i * 13 + j, [
      FIGHTERS[i][1],
      FIGHTERS[j][1],
    ]);
    pureScore[i][j] = d.scoreA;
    pureScore[j][i] = 1 - d.scoreA;
  }
}

console.log(`\n  Identical bots, armies forced to one type each (${GAMES} games per pair):\n`);
console.log(`  ${pad('', 12)}${FIGHTERS.map(([n]) => pad(n, 12)).join('')}`);
for (let i = 0; i < 3; i++) {
  const row = FIGHTERS.map((_, j) => pad(i === j ? '—' : pct(pureScore[i][j]), 12)).join('');
  console.log(`  ${pad(FIGHTERS[i][0], 12)}${row}`);
}

const pureOutcomes: GameOutcome[] = [];
for (let i = 0; i < 3; i++) {
  for (let j = i + 1; j < 3; j++) {
    pureOutcomes.push(
      ...duel(neutral, neutral, 40, 9500 + i * 7 + j, [FIGHTERS[i][1], FIGHTERS[j][1]]).outcomes
    );
  }
}
const meanStrikes = pureOutcomes.reduce((a, o) => a + o.strikes, 0) / pureOutcomes.length;
const meanCounter = pureOutcomes.reduce((a, o) => a + o.counterKills, 0) / pureOutcomes.length;
console.log(
  `\n  how much combat actually happens, per game:` +
    `\n    strikes resolved:        ${meanStrikes.toFixed(1)}` +
    `\n    decided by the counter:  ${meanCounter.toFixed(1)}`
);

const pureCycle =
  (pureScore[0][1] > 0.5 && pureScore[1][2] > 0.5 && pureScore[2][0] > 0.5) ||
  (pureScore[1][0] > 0.5 && pureScore[2][1] > 0.5 && pureScore[0][2] > 0.5);

console.log(
  `\n  expected by the rules: vanguard breaks warden, warden breaks lancer, lancer breaks vanguard`
);

const p1b = verdict(
  pureCycle,
  pureCycle
    ? 'pure compositions cycle — the counter mechanism works, and the transitive result above is dilution, not a broken triangle'
    : 'even pure compositions are transitive — one type is simply stronger on raw stats, so the counter cannot carry a cycle'
);

// ── 2. Non-monotonic material ────────────────────────────────────────────────
heading(
  2,
  'NON-MONOTONIC MATERIAL',
  'a unit-count lead is only worth something if territory can supply it'
);

const led = allOutcomes.filter((o) => o.midLeader !== null && o.winner !== null);
const split = (deficit: boolean) => {
  const set = led.filter((o) => o.midLeaderNodeDeficit === deficit);
  const wins = set.filter((o) => o.winner === o.midLeader).length;
  return { games: set.length, rate: set.length ? wins / set.length : NaN };
};
const solvent = split(false);
const broke = split(true);

console.log(`\n  Games with a mid-game unit-count lead: ${led.length} of ${allOutcomes.length}`);
console.log(`\n  ${pad('leader status', 24)}${pad('games', 10)}win rate`);
console.log(`  ${pad('also leads on nodes', 24)}${pad(String(solvent.games), 10)}${pct(solvent.rate)}`);
console.log(`  ${pad('trails on nodes', 24)}${pad(String(broke.games), 10)}${pct(broke.rate)}`);

const everBroke = allOutcomes.filter((o) => o.everInsolvent).length;
console.log(
  `  games where either side was ever insolvent: ${everBroke} (${pct(
    everBroke / allOutcomes.length
  )})`
);

const p2 = verdict(
  broke.games > 0 && solvent.games > 0 && broke.rate < solvent.rate,
  broke.games === 0 || solvent.games === 0
    ? 'not enough games in one bucket to judge — raise the game count'
    : broke.rate < solvent.rate
      ? `material only pays when supplied (${pct(solvent.rate)} vs ${pct(broke.rate)}), so greedy piece-counting is a trap`
      : `an unsupplied lead wins just as often (${pct(broke.rate)}); upkeep is too soft to punish over-extension`
);

// ── 3. Exploitation beats a fixed mixture ────────────────────────────────────
heading(
  3,
  'EXPLOITATION',
  'within-match opponent modelling beats a fixed mixture — the human-advantage axis'
);

const exploiter = bestResponseBot('exploiter');
const control = stanceBiasBot('non-adaptive', [0.34, 0.33, 0.33]);

console.log(`\n  ${pad('opponent', 14)}${pad('exploiter', 14)}${pad('non-adaptive', 14)}delta`);
let exploiterEdge = 0;
let comparisons = 0;
const exploiterGames: GameOutcome[] = [];

for (const foe of ARCHETYPES) {
  const withModel = duel(exploiter, foe, GAMES, 2000 + foe.name.length);
  const without = duel(control, foe, GAMES, 2000 + foe.name.length);
  exploiterGames.push(...withModel.outcomes);
  const delta = withModel.scoreA - without.scoreA;
  exploiterEdge += delta;
  comparisons++;
  console.log(
    `  ${pad(foe.name, 14)}${pad(pct(withModel.scoreA), 14)}${pad(pct(without.scoreA), 14)}${
      delta >= 0 ? '+' : ''
    }${(delta * 100).toFixed(1)}pp`
  );
}
const meanEdge = exploiterEdge / comparisons;

// Does the edge grow as the model sharpens? Compare kill differential by game half.
let firstHalf = 0;
let secondHalf = 0;
for (const o of exploiterGames) {
  firstHalf += o.killsFirstHalf[0] - o.killsFirstHalf[1];
  secondHalf += o.killsSecondHalf[0] - o.killsSecondHalf[1];
}
console.log(
  `\n  Kill differential across all exploiter games (player 0 seat):` +
    `\n    first half:  ${firstHalf >= 0 ? '+' : ''}${firstHalf}` +
    `\n    second half: ${secondHalf >= 0 ? '+' : ''}${secondHalf}`
);

const p3 = verdict(
  meanEdge > 0,
  meanEdge > 0
    ? `modelling is worth ${(meanEdge * 100).toFixed(1)}pp on average — reads pay, which is the premise the whole design rests on`
    : `modelling is worth ${(meanEdge * 100).toFixed(1)}pp — the game does not reward reads and the central premise is dead`
);

// ── 3b. Exploiting a conditional habit ──────────────────────────────────────
heading(
  '3b',
  'EXPLOITATION, GIVEN SOMETHING TO EXPLOIT',
  'against an opponent with a real conditional habit, does modelling pay?'
);

const compReader = adaptiveCompositionBot('composition-read');
const compFixed = compositionBot('fixed-warden', UnitType.Warden);
const vsReader = duel(compReader, compFixed, GAMES, 7001);
const vsBlindComp = duel(compositionBot('fixed-vanguard', UnitType.Vanguard), compFixed, GAMES, 7001);
console.log(`\n  composition read versus a fixed-composition opponent:`);
console.log(`    adaptive composition   ${pct(vsReader.scoreA)}`);
console.log(`    fixed composition      ${pct(vsBlindComp.scoreA)}`);

const tell = tellBot('has-a-tell');
const condExploiter = conditionalExploiterBot('conditional-model');
const marginalExploiter = bestResponseBot('marginal-model');

const vsCond = duel(condExploiter, tell, GAMES, 6001);
const vsMarginal = duel(marginalExploiter, tell, GAMES, 6001);
const vsFlat = duel(control, tell, GAMES, 6001);

console.log(`\n  versus an opponent that Braces on nodes and Strikes off them:\n`);
console.log(`  ${pad('conditional model', 24)}${pct(vsCond.scoreA)}`);
console.log(`  ${pad('marginal model', 24)}${pct(vsMarginal.scoreA)}`);
console.log(`  ${pad('no model (control)', 24)}${pct(vsFlat.scoreA)}`);

const condEdge = vsCond.scoreA - vsFlat.scoreA;
const p3b = verdict(
  condEdge > 0.03,
  condEdge > 0.03
    ? `reading a conditional habit is worth ${(condEdge * 100).toFixed(
        1
      )}pp over not modelling — the axis the design depends on is live`
    : `reading a conditional habit is worth only ${(condEdge * 100).toFixed(
        1
      )}pp — opponent modelling does not pay even when there is a clear tell`
);

// ── 4. Vision has a price ────────────────────────────────────────────────────
heading(4, 'VISION HAS A PRICE', 'scouting is neither free nor worthless');

const seeing = stanceBiasBot('scouting', [0.34, 0.33, 0.33]);
const blind = blindBot('scout-parked', [0.34, 0.33, 0.33]);
const visionDuel = duel(seeing, blind, GAMES, 4242);
allOutcomes.push(...visionDuel.outcomes);

console.log(`\n  scouting versus scout-parked: ${pct(visionDuel.scoreA)}`);
console.log(
  `  (${visionDuel.winsA} wins / ${visionDuel.winsB} losses / ${visionDuel.draws} draws)`
);

const p4 = verdict(
  visionDuel.scoreA > 0.5 && visionDuel.scoreA < 0.85,
  visionDuel.scoreA <= 0.5
    ? `pushing the Scout out is not worth it (${pct(visionDuel.scoreA)}) — information is underpriced`
    : visionDuel.scoreA >= 0.85
      ? `scouting is nearly free (${pct(visionDuel.scoreA)}) — it should cost something real`
      : `vision is worth having but not decisive (${pct(visionDuel.scoreA)}) — a genuine trade-off`
);

// ── 5. Game health ───────────────────────────────────────────────────────────
heading(5, 'GAME HEALTH', 'the game must actually resolve, and resolve for varied reasons');

const decisive = allOutcomes.filter((o) => o.winner !== null).length;
const lengths = allOutcomes.map((o) => o.turns).sort((a, b) => a - b);
const median = lengths[Math.floor(lengths.length / 2)];
const meanDeaths = allOutcomes.reduce((a, o) => a + o.deaths, 0) / allOutcomes.length;

const reasons = new Map<string, number>();
for (const o of allOutcomes) reasons.set(o.reason, (reasons.get(o.reason) ?? 0) + 1);

const seat0 = allOutcomes.filter((o) => o.winner === 0).length;
const seat1 = allOutcomes.filter((o) => o.winner === 1).length;

console.log(`\n  games:            ${allOutcomes.length}`);
console.log(`  decisive:         ${pct(decisive / allOutcomes.length)}`);
console.log(`  median length:    ${median} turns`);
console.log(`  mean casualties:  ${meanDeaths.toFixed(1)} per game`);
console.log(`  seat balance:     player 0 ${seat0} / player 1 ${seat1}`);
console.log('\n  outcome reasons:');
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${pad(reason, 42)}${count}`);
}

// Simultaneous movement means there is no first player; a large seat skew would mean
// the deployment geometry is quietly unfair.
const seatSkew = Math.abs(seat0 - seat1) / Math.max(1, seat0 + seat1);
const p5 = verdict(
  decisive / allOutcomes.length > 0.6 && seatSkew < 0.15,
  `decisive ${pct(decisive / allOutcomes.length)}, seat skew ${pct(seatSkew)}` +
    (seatSkew >= 0.15 ? ' — deployment geometry favours one seat' : '')
);

// ── Sanity floor ─────────────────────────────────────────────────────────────
const floor = duel(stanceBiasBot('heuristic', [0.34, 0.33, 0.33]), randomBot(), GAMES, 777);
console.log(`\n  sanity floor — heuristic versus random: ${pct(floor.scoreA)}`);
const p6 = verdict(floor.scoreA > 0.6, 'heuristic play clears random play');

console.log(`\n${'═'.repeat(78)}`);
const checks = [p1, p1b, p2, p3, p3b, p4, p5, p6];
const passed = checks.filter(Boolean).length;
console.log(`SUMMARY: ${passed}/${checks.length} checks hold`);
console.log('═'.repeat(78));
