# PENUMBRA — Design Document

*A two-player abstract strategy game engineered so that the residual skill lives in the
dimensions where humans still outperform machines.*

*v0.3 — rules honed against the simulation harness (`scripts/simulate.ts`). v0.2 had two
of four design levers falsified; v0.3 attempted a fix for each. **One worked, one failed
with a clear mechanism.** Three of the four levers now stand. See §6 for the evidence and
§7 for what it costs the thesis.*

---

## 0. The honest claim

There is **no game only humans can win**. Any game with known rules and a cheap simulator
falls to a dedicated training program eventually — chess, Go, Stratego (DeepNash),
heads-up and 6-max poker (Libratus, Pluribus), Diplomacy (Cicero), StarCraft II
(AlphaStar). Designing for "impossible" is designing for a claim that will be falsified.

So Penumbra targets the achievable version:

> **Maximise the cost asymmetry.** Make strong play cheap for a human to learn and
> expensive for a machine to reach, and put the winning margin in human-favouring
> cognitive dimensions rather than in search depth.

**Threat model** (in order of realism):

| Adversary | Realistic today? | What beats it |
|---|---|---|
| A general LLM agent handed the rules | Very | Large simultaneous order space, belief-state reasoning, mixed strategies |
| Off-the-shelf search (minimax / MCTS) bolted on | Very | Imperfect information + simultaneity — there is no minimax tree to search |
| CFR-style equilibrium solver | Plausible | Position-dependent payoffs defeat cheap abstraction |
| A funded, purpose-built RL program (DeepNash-scale) | Yes, if someone aims it | **Nothing.** It wins. Design for cost, not immunity |

---

## 1. What humans are actually still better at

Ranked by how real the gap is in 2026, and by whether you can build a game on it.

1. **Sample-efficient opponent modelling (n ≈ 1).** A human forms a usable model of *this
   specific opponent* — who over-commits when behind, who never bluffs twice — from a
   handful of observations, and shifts strategy inside a single match. Machines are
   sample-hungry: they learn a *distribution* of opponents in training and then play a
   fixed policy against the individual in front of them.
2. **Navigating intransitive metagames without a population.** Where strategy space cycles
   (A beats B beats C beats A), plain self-play chases its own tail. AlphaStar needed an
   explicit Nash-league of exploiters to handle StarCraft's cycles.
3. **Deciding what to find out.** Treating information-gathering as a *plan* is a form of
   directed exploration, still an RL weak point.
4. **Recursive theory of mind at 2–3 levels**, applied to a particular person rather than
   to a population average.
5. **Concept transfer that survives a rule change.**

Notably **absent**: search depth, tactical calculation, positional evaluation, endgame
precision, memorised openings, word association. A design leaning on any of those loses.

---

## 2. The four levers

Each is a *structural* property, not a gimmick. **Graded against simulation:**

| Lever | Mechanism | Status |
|---|---|---|
| **A** | Simultaneous commitment | ✅ Holds by construction, fairness verified |
| **B** | Combinatorial order space | ✅ Holds by construction, measured |
| **C** | Composition counter triangle → intransitivity | ❌ **Not supported**, twice (§6.1) |
| **D** | Non-monotonic material, via node decay | ✅ **Holds** after the v0.3 fix (§6.2) |

### Lever A — Simultaneous commitment ✅
Both players write orders for all units, then reveal and resolve together.

- Kills minimax outright: there is no alternating tree. An MCTS bolt-on plays into
  best-response exploitation.
- Forces genuinely **mixed** strategies. Every turn is a matrix game.
- Makes deception emergent rather than a special rule — nobody "lies", you commit blind.
- **There is no first player.** This is a real structural bonus, and it is enforced by a
  test: hand player 1 the exact 180° rotation of player 0's orders and the position must
  stay mirror-symmetric forever (`tests/engine.test.ts`, "seat symmetry"). That test
  exists because two separate asymmetry bugs shipped past casual inspection — see §6.4.

### Lever B — Combinatorial order space ✅
Measured order counts from an unclipped central square: Command 9, Vanguard 21, Warden 25,
Lancer 25, Scout 25. A full seven-unit order set is therefore

```
9 × 21² × 25² × 25 × 25 ≈ 1.6 × 10⁹ joint orders per turn
```

That is Diplomacy-scale, and it is what defeats naive CFR: you cannot enumerate the
matrix, and any abstraction that makes it enumerable throws away the positional detail the
payoffs depend on.

### Lever C — Intransitivity ❌ (two attempts, both falsified)
*The intended load-bearing lever, and the one that will not come good.*

**v0.2 attempt — stance payoffs.** The stance triad is rock-paper-scissors, so the strategy
space was supposed to cycle. It did not: three probe families all came out transitive,
because the territorial layer imposes an ordering the stances cannot overturn.

**v0.3 attempt — composition counters.** The cycle was moved into *army composition*, which
is how StarCraft gets durable intransitivity: a third fighting type (Lancer) plus a counter
triangle, Vanguard → Warden → Lancer → Vanguard, and choosable reinforcements so players
actually pick a composition. The triangle is correct in the rules and all three edges are
covered by tests. It still does not cycle at the strategy level, for a reason the harness
pinned down precisely — see §6.1.

### Lever D — Non-monotonic material ✅ (fixed in v0.3)
Units cost upkeep paid from territory, and — the v0.3 addition — **a node rots back to
unowned unless a friendly unit Braces on it every few turns.**

Decay is what made the lever real. Upkeep alone never bit, because income was a pure
function of a sticky node count, so a large army was never actually unsupportable. Decay
makes territory cost *attention*: garrisoning three nodes pins three of your six fighting
units, so massing for an attack means letting your income rot, and an army you can no longer
feed starves.

Measured: a mid-game unit-count lead converts at **80.5%** when its holder also leads on
nodes, and **50.0%** when it does not. Piece-counting is now genuinely a trap.

---

## 3. The game

### Board
9×9 grid, files `a–i`, ranks `1–9`.

- **Ridges** (8 squares, 180°-symmetric): passable, but **block line of sight**. Ridges are
  what make fog *inferable* rather than blank — predictable blind corridors both players
  can reason about, unlike randomised terrain.
- **Nodes** (5 squares): `e5` centre, plus `c4`, `g4`, `c6`, `g6`. Each side starts owning
  the two on its own half; the centre starts unowned.

### Units — 6 + Command per side

| Unit | Count | Move | Sight | Notes |
|---|---|---|---|---|
| **Command** | 1 | 1, any direction | 2 | Lose it and you lose. Cannot Strike. |
| **Vanguard** | 2 | up to 3, straight orthogonal | 1 | Reach. Fast, blind, dies easily. |
| **Warden** | 2 | up to 2, any direction | 2 | The anchor. Holds ground when Bracing. |
| **Lancer** | 1 | up to 2, any direction | 1 | Flexible, short-sighted. |
| **Scout** | 1 | up to 2, any direction | **4** | Loses every exchange it enters. Pure vision. |

Fast-and-blind versus slow-and-seeing makes vision a resource you spend structure to
obtain. The Warden moves 2, not 1 — under node decay, mobility *is* economy, and a move-1
unit cannot garrison what it cannot reach (§6.1).

### The counter triangle

```
Vanguard breaks Warden   ·   Warden breaks Lancer   ·   Lancer breaks Vanguard
```

If the attacker's type counters the defender's, the attacker wins the exchange whatever the
defender chose — reversing both Brace-beats-Strike and the Strike-versus-Strike trade. It is
the only place unit type touches combat. Against an Advance the counter is irrelevant: an
advancer dies to any Strike.

### The turn

1. Both players secretly write one order per unit: a **path** and a **stance**.
2. Reveal simultaneously.
3. Resolve movement, then combat; remove casualties.
4. Update node control → income; pay upkeep → possible starvation; reinforce.
5. Recompute fog; update ghost markers.
6. Check victory.

### Stances — the intransitive core

- **ADVANCE** — move your full distance.
- **BRACE** — do not move; dig in. **This is also the only way to claim or hold a node.**
- **STRIKE** — stationary; attack one adjacent square.

| | vs ADVANCE | vs BRACE | vs STRIKE |
|---|---|---|---|
| **ADVANCE** | both halt, no deaths | **walks past** (Bracer keeps its square) | advancer **dies** |
| **BRACE** | ground conceded | nothing | striker **dies** |
| **STRIKE** | kills the advancer | striker dies | **both die** |

**Strike beats Advance, Advance beats Brace, Brace beats Strike.** Two exceptions:

- A Bracing **Warden** holds its square against an Advance instead of ceding it — the one
  asymmetry in the triad, and the reason Wardens anchor positions.
- A **Scout** loses every exchange it enters, in both directions. Ordering a Scout to
  Strike simply kills it.

**Combat is Strike-only.** Units do not fight merely by ending up adjacent. This keeps the
triad sharp: Strike is the only thing that kills, Brace is what punishes it, Advance is
what walks past it.

**Brace-to-claim** is the load-bearing economic rule. Walking onto a node does not take it;
you must dig in, which costs a turn and exposes you to being walked straight past.

**Nodes decay.** A node you own reverts to unowned if no friendly unit has Braced on it
within the last 4 turns. Territory has to be garrisoned, not just captured — this is what
puts army size and territorial reach in genuine competition.

### Supply

- **Income** = 1 + nodes held.
- **Upkeep** = 1 per unit beyond **four**. A full seven-unit army costs 3.
- Insolvent at step 4 → **starve** one unit (Scout first, then Lancer, Vanguard, Warden;
  never the Command).
- Bank supply; spend **3** to **reinforce** — and you choose the type (cap 7 units), which
  is what makes composition a repeated decision rather than a fixed hand.

The opening is *exactly* solvent: 7 units cost 3, two home nodes pay 3. Sitting on that
knife edge is the intent — lose a node and you cannot feed your army.

### Fog

- You see a square if a friendly unit has it within sight, unblocked by ridges.
- Enemies in sight are fully visible; out of sight they persist as **ghost** markers
  stamped with the turn last seen. Ghosts are private, and a remembered position that has
  silently gone stale is the core bluffing surface.
- **Combat results are public.** This is what makes hidden state a reasoning problem rather
  than a dice roll: casualties are the deduction footholds. Penumbra should reward
  inference, never luck.

### Victory

- Destroy the enemy **Command**, or
- hold **3 of 5 nodes** at the end of **4 consecutive** turns, or
- opponent has no units left.
- Turn 60: most nodes wins; exact tie is a draw.

Since you start with two, a node victory means taking and *holding* a third against decay —
which costs you three garrisoned units out of six.

---

## 4. Why this pile of rules resists machines

Restricted to what survives §6:

- **No search tree.** Simultaneity plus fog means an engine must reason over information
  sets and mixed strategies. The cheapest recipe — minimax with a decent eval — has no
  purchase at all.
- **No enumerable matrix.** ~6 × 10⁸ joint orders per turn. Abstraction is mandatory, and
  any abstraction coarse enough to solve is too coarse to see the node adjacency that sets
  the payoffs.
- **Greedy evaluation is not obviously right**, though §6.2 shows it is not actively
  punished either.

What is **no longer** claimed: that self-play cycles rather than converging, and that
piece-counting is a trap. Both were measured and neither held.

### The strongest counterargument

**Stratego.** Enormous hidden state, deep bluffing, "obviously" AI-hostile — and DeepNash
reached expert human level with model-free RL and no search at all.

Penumbra differs in ways DeepNash's recipe does not cover: Stratego is alternating-move
(no per-turn mixed-strategy pressure), has a small per-turn action space, has payoffs fixed
by a piece chart rather than by position, and has monotonic material. Penumbra breaks the
first three. With Lever D inert it no longer clearly breaks the fourth.

Being honest about the residue: **Levers A and B alone put Penumbra in roughly the same
family as Diplomacy — and Diplomacy fell to Cicero.** That is the current strength of the
claim.

---

## 5. Falsifiable predictions

Run `npm run sim [games]`. Each prediction prints an explicit verdict.

1. **Intransitivity is real.** A round-robin of distinct strategies should contain 3-cycles.
2. **Material is genuinely non-monotonic.** A unit-count lead should convert *worse* when
   its holder is supply-insolvent.
3. **Exploitation beats a fixed mixture.** A bot that models the opponent within the match
   should beat a non-modelling control, and the gap should widen with match length.
4. **Vision has a price.** Scout-led play should be worth having but not dominant.
5. **Game health.** Decisive, varied win conditions, no seat skew.
6. **Sanity floor.** Heuristic play clears random play.

---

## 6. What simulation found

Numbers below from `npm run sim 200` (1,400 games for the pooled metrics).

### 6.1 Intransitivity — ❌ not supported, after two different attempts

**v0.2: stances.** Three probe families all produced cleanly transitive tournaments —
stance-frequency archetypes, the same after Brace-to-claim was added, and plan-based bots
(centre / flank / counter / spread). No 3-cycles anywhere.

**v0.3: composition.** The cycle was moved where StarCraft keeps its: army composition. A
third fighting type plus the counter triangle, with reinforcement type chosen freely. Result:

```
              vanguard    warden      lancer
  vanguard    —           59.0%       43.8%
  warden      41.0%       —           47.9%
  lancer      56.2%       52.1%       —
```

Transitive again: `lancer > vanguard > warden`. So was the triangle too weak, or was one
type simply better? A dedicated isolation experiment settles it — identical bots, armies
forced to a single fighting type each, so composition differences cannot be diluted by the
shared starting army or by slow reinforcement drift:

```
              vanguard    warden      lancer
  vanguard    —           85.3%       39.8%
  warden      14.7%       —           48.3%
  lancer      60.2%       51.7%       —

  how much combat actually happens, per game:
    strikes resolved:        4.4
    decided by the counter:  2.1
```

Two of three counter edges close (Vanguard→Warden emphatically, Lancer→Vanguard). The
Warden→Lancer edge refuses to close — **even though the Warden out-stats the Lancer and
counters it.** That inconsistency is the clue, and the last two lines explain it:

> **Combat is too peripheral to carry a cycle.** About 4 strikes happen per 15-turn game and
> the counter decides roughly 2 of them, while the outcome is determined by holding nodes for
> four consecutive turns. Vanguard's 85% over Warden is not the counter — it is *mobility*
> (move 3 versus 2, and under decay mobility is how you garrison). The counter triangle is
> correct in the rules, provably so in the tests, and nearly irrelevant to who wins.

Two fixes were tried along the way and both were kept, because both are improvements on
their own terms even though neither produced a cycle: the counter was strengthened to decide
Strike-versus-Strike as well as Brace, and the Warden was given move 2 (its move-1 "slow
anchor" identity was simply unplayable once territory had to be garrisoned — the
Warden→Lancer edge went from 23.0% to 48.3% on that change alone).

*Conclusion.* Intransitivity cannot be bolted onto a game whose victory condition is
territorial by making *combat* cyclic. To earn Lever C, exchanges would have to become the
currency of territory itself — for instance, node capture requiring you to defeat the
garrison rather than merely outlast it. That is a different game, not a tweak, and I am not
going to keep patching around it and call the result evidence.

### 6.2 Non-monotonic material — ✅ holds, after node decay

| Mid-game unit-count leader | Games | Win rate |
|---|---|---|
| also leads on nodes | 2670 | **80.5%** |
| trails on nodes | 36 | **50.0%** |

A material lead is worth a great deal when it is supplied and worth *nothing* when it is
not — a 30-point swing. Greedy piece-counting is now a genuine trap, which is what the lever
was for. Insolvency fires in **23.2%** of games, up from 0.3% before decay.

Two honest caveats:

- The overextended state is **rare** — 36 of 2,706 games with a lead, about 1.3%. The effect
  is large and consistent in direction across sample sizes, but it is an uncommon situation
  rather than a routine pressure.
- Getting here required fixing the *metric*, not just the rules. The original discriminator
  asked whether the unit-count leader was insolvent, which **cannot fire by construction**:
  insolvency causes starvation, starvation removes a unit, so an insolvent player stops
  being the unit-count leader almost immediately. That bucket read 0 games across three
  configurations before the instrument itself turned out to be the problem. "More units,
  less ground" is the state the lever is actually about.

### 6.3 Exploitation — ❌ not demonstrated

Marginal stance modelling costs **−2.9pp** against a non-modelling control, averaged over
the four plan bots. Reading a conditional habit costs **−4.9pp** even against an opponent
built to have one. Reading *composition* is the only variant that comes out ahead, and only
by **+2.3pp** (49.5% versus 47.2%) — inside noise.

**The most important finding in this section is about sampling.** At 200 games per pair,
marginal modelling measured **+1.8pp** and the harness printed `✅ HOLDS`. At 500 games per
pair the same comparison measured **−2.9pp**. An earlier configuration produced **+3.7pp**
for conditional modelling, which also evaporated. Every apparent positive on this prediction
so far has been sample noise, and each one was reported as a pass by a threshold test before
a larger run contradicted it. Anything under ~500 games per pair on this metric should be
treated as unmeasured.

The instrument is also weak in a way worth stating plainly: these bots are one-ply and
plan-free, and the "opponent model" is a three-bin histogram. The claim under test — that
sample-efficient modelling of a *specific* opponent pays — is not really testable with
players this crude. A negative here is weak evidence about the game and strong evidence
about the harness. The honest next step is a human trial, not a better histogram.

### 6.4 Fairness — ✅ holds, after two bugs

Simultaneous movement means there is no first player, so **any** seat skew is a bug. Two
shipped past casual inspection and were caught only by measurement:

1. **A heuristic bug.** The bots broke ties on raw square index, which means "prefer lower
   y", which means "prefer south" — a free tempo for player 1 every turn. Seat skew: 71%.
2. **An engine bug.** Home-rank reinforcement squares for player 1 were generated as the
   *reflection* of player 0's list rather than the 180° **rotation** (`a1` mirrors to `i9`,
   not `a9`). On a mirror-asymmetric ridge layout that was worth a **2:1** win rate to
   player 1 in self-play with identical bots.

Both are now covered by the mirror-invariant test. Final seat skew: **2.3%**.

A related engine fix: movement is resolved by **time-stepped** simulation rather than
"truncate at the first shared square". The naive rule resolved a head-on collision
asymmetrically — whichever unit the engine examined first kept its ground.

### 6.5 Vision — ✅ holds

Scout-led play scores **53.3%** against parking the Scout at home. Worth having, not
decisive — a genuine trade-off. This only became measurable once Scouts stopped
auto-starving on turn 1.

### 6.6 Game health — ✅ holds

- **96.2%** decisive; median length **21** turns; 4.3 casualties per game.
- Win reasons are genuinely varied: node hold 880, turn-limit node count 350, Command
  destroyed 117, draw 53.
- Heuristic play beats random play 100%.

### Balance history

| Change | Why | Effect |
|---|---|---|
| Nodes moved from ranks 3/7 to ranks 4/6 | A Vanguard reached three nodes on turn 1 | Median length 4 → 10 turns |
| `HOLD_TURNS` 3 → 6 → 4 | A third node was an instant win; nobody had to defend | Holding became a real phase |
| Seat-neutral tie-breaks in the bots | 71% seat skew | Skew → 5% |
| **Brace-to-claim nodes** | Advance was compulsory, so Strike was over-rewarded | Closed the triad's territorial hole |
| `NODES_TO_WIN` 3 → 4 | Winning threshold and army-size gate were the same number | Gave the economy room |
| `homeSquares` rotation, not reflection | 2:1 seat skew in self-play | Skew → 2.3% |
| `FREE_UNITS` 3 → 4, plus starting territory | Opening was insolvent; every Scout starved on turn 1 | Vision layer became real |
| Exploiter tilts only *in contact* | Reads dragged units off their objectives | Modelling cost 15pp → 4pp |
| **Node decay without a garrison** | Upkeep never bit; material was effectively monotonic | Insolvency 0.3% → 23%; Lever D earned |
| `NODES_TO_WIN` 4 → 3, decay grace 3 → 4 | Decay made 4-of-5 unreachable; median length hit the 60-turn cap | Median 60 → 15 turns, decisive 75% → 88% |
| **Lancer + counter triangle** | Two fighting types is no composition space at all | Triangle works in the rules; no strategic cycle |
| Counter also decides Strike-vs-Strike | Confined to Brace, composition barely mattered | Still no cycle |
| Warden move 1 → 2 | A move-1 unit cannot garrison under decay | Warden→Lancer edge 23% → 48% |
| Bots stop overriding Brace *on a node* | Counter-aware play abandoned garrisons | Correctness fix |
| Overextension metric: insolvency → node deficit | Old bucket could not fire by construction | 0 games → 36 games, effect visible |

---

## 7. Where this leaves the thesis

**Levers A, B and D hold; C does not.** The surviving argument:

- Simultaneity plus fog denies an engine a search tree (A).
- A ~10⁹ per-turn order space denies it a cheap abstraction (B).
- Territory-fed supply makes greedy material evaluation actively misleading — 80.5% versus
  50.0% (D).

That is a real cost asymmetry against the two most realistic adversaries, an LLM handed the
rules and a search bot bolted on, and D in particular poisons the standard
"learn a value net, search on top" shortcut. It is more than v0.2 could claim.

What is still missing is the part that would have made Penumbra *structurally* expensive
rather than merely awkward: a cycling strategy space, which is what forces a training program
into population play instead of plain self-play. Two serious attempts failed, and the second
failed for a reason that looks fundamental to the shape of the game — combat is a side-channel
in a territorial contest, so making combat cyclic cannot cycle the strategy space (§6.1).

And the design's *central premise* — that within-match opponent modelling pays — remains
undemonstrated, with the added embarrassment that every positive result on it so far has been
sample noise (§6.3). That question needs humans, not better bots.

So: a decent game with two verified AI-hostile properties and one verified evaluation trap,
which is roughly the Diplomacy profile, and Cicero cleared that bar. The honest summary is
that this design does not achieve what it set out to, and the harness is the part worth
keeping.

## 8. Deliberate rule decisions

- **No explicit bluff/lie mechanic.** Deception must emerge from fog plus simultaneity.
- **No randomness anywhere.** All uncertainty is about the opponent's mind, never dice.
  Randomness would *help* a machine — it converts reads into variance.
- **No hidden setup.** Symmetric and public. Hidden setup adds variance, not depth, and
  rewards memorised distributions.
- **Public combat results**, to preserve deducibility.
- **Command cannot Strike.** It is a liability to protect and supply, not a fighter.
- **Fixed symmetric ridges**, so the game is fair without a first-player compensation rule.
- **Illegal or missing orders default to Brace** rather than throwing: under simultaneity
  there is no chance to ask for a correction.

## 9. Open questions for v0.4

- **Lever C, properly:** make exchanges the currency of territory — node capture requires
  defeating the garrison, not outlasting it — so that a combat cycle can actually propagate
  into strategy. This is a redesign of the victory condition, not a parameter change.
- **Prediction 3 needs humans.** Two people, one session. Everything else on that axis has
  been noise.
- 620 of 5,000 games still end in a turn-limit draw with equal nodes. The tiebreak is
  probably too coarse.
- Should the Scout be able to Brace defensively? It currently loses every exchange.
- Verify the Warden's Brace exception does not collapse the stance cycle into
  "Brace is just good".
- **The renderer exists now** (`npm run dev`), so the remaining question is the only one
  bots cannot answer: put two people in front of it and find out whether the economy and
  the counter triangle are legible in play. Everything in §6.3 is waiting on that.
