# Penumbra

A two-player simultaneous-move strategy game on a 9×9 fog-of-war board, designed as an
experiment: **can you build a versus game where the winning margin sits in the cognitive
dimensions humans still beat machines at, without resorting to gimmicks?**

No twitch reflexes, no physical components, no cultural trivia, no LLM referee. Just a
board, seven units a side, and simultaneous orders.

See [DESIGN.md](DESIGN.md) for the full design and — more usefully — for the measured
verdict on it. Short version: of the four mechanisms intended to make this hard for AI,
**three survived simulation and one was falsified twice.**

## Rules in brief

Each turn both players secretly write one order per unit — a **path** and a **stance** —
then reveal and resolve simultaneously.

**Advance** takes ground · **Brace** banks it · **Strike** punishes movement

```
Strike beats Advance   ·   Advance beats Brace   ·   Brace beats Strike
```

Three fighting types counter each other, which reverses the exchange when it applies:

```
Vanguard breaks Warden   ·   Warden breaks Lancer   ·   Lancer breaks Vanguard
```

Hold **3 of the 5 nodes** for 4 consecutive turns, or destroy the enemy **Command**. Nodes
are claimed only by **Bracing** on them — walking over a node does not take it — and they
**rot back to unowned** if you stop garrisoning them.

Your army is fed by territory: every unit past the fourth costs upkeep, paid from node
income. Since holding three nodes pins three of your six fighting units, massing for an
attack means letting your income decay — and an army you cannot feed starves. Reinforcements
are your choice of type, so composition is a repeated decision.

Ridges block line of sight but not movement. Units out of sight persist as stale **ghost**
markers — combat results, however, are always public, so fog is a reasoning problem rather
than a dice roll.

## Running it

```sh
npm install
npm run dev       # play it — http://localhost:5173
npm test          # 55 engine tests
npm run sim       # the design harness — prints a verdict per prediction
npm run sim 500   # more games, tighter numbers
npm run build     # typecheck + production bundle
```

`npm run dev` gives you two players on one screen, or a game against one of two AIs.
Because orders are simultaneous and the board is fogged, hotseat **hides the board between
turns** — neither side may see the other's view, so the handoff screen is a rule, not a
nicety.

Reading the board: hexagons are nodes, and the numbered chip on an owned one is **how many
turns of ownership it has left** before the garrison lapses — red means it rots next turn.
Yours and your opponent's are both shown, because node age is public. Hatched squares are
ridges: they block sight, not movement. Dashed units are **ghosts** — where you last saw
something, stamped with the turn, which may well be wrong by now.

`npm run sim` is the interesting one. It does not report "balance"; it reports whether each
of the design's falsifiable claims survives, and says `❌ FAILS` in your face when one
doesn't. Use at least `500` — smaller samples have produced positive results on the
exploitation metric that larger runs then contradicted.

## Layout

```
src/engine/
  types.ts     rules constants, terrain, order/stance definitions
  setup.ts     opening deployment and starting territory
  orders.ts    legal order generation and validation
  resolve.ts   simultaneous movement (time-stepped) and combat adjudication
  fog.ts       line of sight, visibility, ghost memory
  game.ts      turn sequence, economy, victory conditions
  bots.ts      probe opponents, composition bots, opponent-modelling bots
  match.ts     game/duel drivers and outcome metrics
src/ui/
  board.ts     canvas renderer — terrain, fog, ghosts, order preview
  app.ts       phase machine, order entry, hotseat handoff
  style.css
tests/         engine tests, including the seat-symmetry mirror invariant
scripts/       simulate.ts — the design harness
```

The renderer only ever reads `game.viewFor(player)`, never `game.units`, so the UI cannot
leak information the rules say a player should not have.

## A note on the test suite

The mirror-invariant test in `tests/engine.test.ts` is the one worth knowing about. Because
the game is simultaneous-move, there is no first player, so *any* seat advantage is a bug.
Two shipped past casual review — a tie-break that preferred "south", and reinforcement
squares generated as a reflection instead of a 180° rotation (`a1` mirrors to `i9`, not
`a9`). The second was worth a 2:1 win rate to player 1 and was invisible in normal play.
The test hands player 1 the exact rotation of player 0's orders and asserts the position
stays symmetric forever.
