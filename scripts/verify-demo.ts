/**
 * Runs the guided demo through the real engine and prints what actually happened each
 * turn. The demo's narration claims specific exchanges occur; this is what stops those
 * claims from silently going stale when a rule changes.
 *
 * Run: npx vite-node scripts/verify-demo.ts
 */
import { Game } from '../src/engine/game';
import { DEMO_SCRIPT, ordersFor } from '../src/ui/demo';
import { NODES, Player, UNIT_NAMES, sqName } from '../src/engine/types';

const game = new Game();
let turn = 0;
let failures = 0;

for (const [i, beat] of DEMO_SCRIPT.entries()) {
  if (!beat.play) {
    console.log(`\n[beat ${i}] ${beat.title} — (no move)`);
    continue;
  }
  turn++;
  const before = new Map(game.units.map((u) => [u.id, `${UNIT_NAMES[u.type]}@${sqName(u.sq)}`]));
  let rec;
  try {
    rec = game.submit(
      ordersFor(game, 0 as Player, beat.play.p0),
      ordersFor(game, 1 as Player, beat.play.p1),
      beat.reinforce ?? []
    );
  } catch (e) {
    console.log(`\n[beat ${i}] ${beat.title}\n  ❌ ${(e as Error).message}`);
    failures++;
    break;
  }

  const events = rec.events
    .filter((e) => e.kind !== 'strike-whiff')
    .map((e) => `${e.kind}@${sqName(e.at)}${e.died.length ? ` kills:${e.died.map((d) => before.get(d) ?? d).join(',')}` : ''}`);

  console.log(`\n[beat ${i}] ${beat.title}  (turn ${turn})`);
  console.log(`  nodes  p0=${game.nodesHeld(0)} p1=${game.nodesHeld(1)}  ` +
              `owners=${game.nodeOwners.map((o, k) => `${sqName(NODES[k])}:${o ?? '-'}`).join(' ')}`);
  console.log(`  clock  p0=${game.holdStreak[0]} p1=${game.holdStreak[1]}   ` +
              `units p0=${game.unitsOf(0).length} p1=${game.unitsOf(1).length}`);
  if (events.length) console.log(`  events ${events.join(' | ')}`);
  if (rec.starved.length) console.log(`  starved ${rec.starved.length}`);
  if (rec.reinforced.length)
    console.log(`  reinforced ${rec.reinforced
      .map((id) => { const u = game.units.find((x) => x.id === id); return u ? `${UNIT_NAMES[u.type]}@${sqName(u.sq)}` : String(id); })
      .join(',')}`);
  console.log(`  p0: ${game.unitsOf(0).map((u) => `${UNIT_NAMES[u.type][0]}${sqName(u.sq)}`).join(' ')}`);
  if (game.status.state !== 'playing') console.log(`  STATUS ${JSON.stringify(game.status)}`);
}

console.log('\n─── final ───');
console.log(JSON.stringify(game.status));
const won = game.status.state === 'won' && game.status.winner === 0;
console.log(won ? '✅ demo ends in a player-0 victory as narrated' : '❌ demo did not end as narrated');
if (!won || failures) throw new Error('demo script does not match the engine');
