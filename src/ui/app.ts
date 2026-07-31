import { Bot, adaptiveCompositionBot, mulberry32, planBot, RNG } from '../engine/bots';
import { PlayerView } from '../engine/fog';
import { Game } from '../engine/game';
import { legalOrders } from '../engine/orders';
import {
  COUNTERS,
  CombatEvent,
  DIRS8,
  FREE_UNITS,
  HOLD_TURNS,
  MAX_UNITS,
  MOVE_RANGE,
  NODES_TO_WIN,
  NODE_DECAY_GRACE,
  Order,
  Player,
  REINFORCEABLE,
  REINFORCE_COST,
  SIGHT,
  Stance,
  TURN_LIMIT,
  UNIT_NAMES,
  Unit,
  UnitType,
  idx,
  inBounds,
  sqName,
  xOf,
  yOf,
} from '../engine/types';
import { BoardView, RenderModel } from './board';
import { DEMO_SCRIPT, ordersFor, sq as demoSq } from './demo';

type Mode = { kind: 'hotseat' } | { kind: 'solo'; bot: Bot; rng: RNG };

type Phase =
  | { kind: 'menu' }
  /** Simultaneous orders under fog means the screen must be hidden between players. */
  | { kind: 'handoff'; player: Player }
  | { kind: 'orders'; player: Player }
  /** Guided playthrough: real engine, scripted orders, narration per beat. */
  | { kind: 'demo' }
  | { kind: 'over' };

const STANCE_NAMES: Record<Stance, string> = {
  [Stance.Advance]: 'Advance',
  [Stance.Brace]: 'Brace',
  [Stance.Strike]: 'Strike',
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

export class App {
  private game = new Game();
  private mode: Mode = { kind: 'hotseat' };
  private phase: Phase = { kind: 'menu' };

  private board: BoardView;
  private pending = new Map<number, Order>();
  private storedFirst: Order[] = [];
  private selected: Unit | null = null;
  private pendingStance: Stance | null = null;
  private candidates = new Set<number>();
  private lastPositions = new Map<number, number>();
  private lastEvents: CombatEvent[] = [];
  private logLines: string[] = [];
  private reinforcePref: [UnitType, UnitType] = [UnitType.Vanguard, UnitType.Vanguard];
  private demoIndex = 0;
  private demoPlaying = false;
  private demoTimer: number | null = null;
  /** Draw the counter relationships onto the pieces. Persisted across sessions. */
  private showCounters = localStorage.getItem('penumbra.counters') !== 'off';
  private muted = localStorage.getItem('penumbra.muted') === 'on';
  private demoSpeed = Number(localStorage.getItem('penumbra.speed') ?? '1') || 1;
  private animT = 1;
  private animRaf: number | null = null;

  constructor() {
    this.board = new BoardView(el<HTMLCanvasElement>('board'));
    this.board.canvas.addEventListener('click', (e) => this.onBoardClick(e));
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Escape closes the rules modal first, and only then cancels a selection.
      const help = el('help');
      if (help.classList.contains('open')) help.classList.remove('open');
      else this.clearSelection();
      this.render();
    });

    el('start-hotseat').addEventListener('click', () => this.start({ kind: 'hotseat' }));
    el('start-solo').addEventListener('click', () =>
      this.start({
        kind: 'solo',
        bot: adaptiveCompositionBot('opponent'),
        rng: mulberry32(Math.floor(Math.random() * 2 ** 31)),
      })
    );
    el('start-solo-simple').addEventListener('click', () =>
      this.start({
        kind: 'solo',
        bot: planBot('opponent', 'spread'),
        rng: mulberry32(Math.floor(Math.random() * 2 ** 31)),
      })
    );
    el('handoff-ready').addEventListener('click', () => this.onHandoffReady());
    el('submit').addEventListener('click', () => this.onSubmit());
    el('brace-rest').addEventListener('click', () => this.braceRemaining());
    el('again').addEventListener('click', () => window.location.reload());
    el('start-demo').addEventListener('click', () => this.startDemo());
    el('counters-toggle').addEventListener('click', () => {
      this.showCounters = !this.showCounters;
      localStorage.setItem('penumbra.counters', this.showCounters ? 'on' : 'off');
      this.render();
    });
    el('demo-prev').addEventListener('click', () => this.demoGo(this.demoIndex - 1));
    el('demo-next').addEventListener('click', () => this.demoGo(this.demoIndex + 1));
    el('demo-play').addEventListener('click', () => this.demoToggle());
    el('demo-exit').addEventListener('click', () => {
      this.stopSpeech();
      window.location.reload();
    });
    el('demo-speed').addEventListener('input', (e) => {
      this.demoSpeed = Number((e.target as HTMLInputElement).value);
      localStorage.setItem('penumbra.speed', String(this.demoSpeed));
      if (this.demoPlaying) this.demoSchedule();
      this.renderDemo();
    });
    el('demo-mute').addEventListener('click', () => {
      this.muted = !this.muted;
      localStorage.setItem('penumbra.muted', this.muted ? 'on' : 'off');
      if (this.muted) this.stopSpeech();
      else this.speak(DEMO_SCRIPT[this.demoIndex].text);
      this.render();
    });
    el('help-toggle').addEventListener('click', () => el('help').classList.add('open'));
    el('help-close').addEventListener('click', () => el('help').classList.remove('open'));
    el('help').addEventListener('click', (e) => {
      // Clicking the backdrop dismisses; clicking inside the sheet does not.
      if (e.target === el('help')) el('help').classList.remove('open');
    });

    this.render();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private start(mode: Mode): void {
    this.mode = mode;
    this.game = new Game();
    this.pending.clear();
    this.storedFirst = [];
    this.lastPositions.clear();
    this.lastEvents = [];
    this.logLines = [];
    this.reinforcePref = [UnitType.Vanguard, UnitType.Vanguard];
    this.phase =
      mode.kind === 'hotseat' ? { kind: 'handoff', player: 0 } : { kind: 'orders', player: 0 };
    this.render();
  }

  // ── demonstration ──────────────────────────────────────────────────────────

  private startDemo(): void {
    this.mode = { kind: 'hotseat' };
    this.phase = { kind: 'demo' };
    this.demoIndex = 0;
    this.demoPlaying = false;
    this.rebuildDemo();
    this.render();
    this.speak(DEMO_SCRIPT[0].text);
  }

  /**
   * Replays the script from the start up to the current beat.
   *
   * Rebuilding rather than stepping backwards keeps this honest: there is no undo path
   * that could drift from what `Game.submit` would actually have produced, and at nine
   * beats the cost is irrelevant.
   */
  private rebuildDemo(): void {
    this.game = new Game();
    this.lastPositions.clear();
    this.lastEvents = [];
    this.logLines = [];
    for (let i = 0; i <= this.demoIndex; i++) {
      const beat = DEMO_SCRIPT[i];
      if (!beat?.play) continue;
      if (this.game.status.state !== 'playing') break;
      this.lastPositions = new Map(this.game.units.map((u) => [u.id, u.sq]));
      const rec = this.game.submit(
        ordersFor(this.game, 0, beat.play.p0),
        ordersFor(this.game, 1, beat.play.p1),
        beat.reinforce ?? []
      );
      this.lastEvents = rec.events;
      this.logLines = this.describe(rec.turn, rec);
    }
  }

  private demoGo(i: number): void {
    if (i < 0 || i >= DEMO_SCRIPT.length) {
      this.demoStop();
      return;
    }
    const forward = i > this.demoIndex;
    this.demoIndex = i;
    this.rebuildDemo();
    if (forward && DEMO_SCRIPT[i].play) this.startAnim();
    else this.animT = 1;
    this.render();
    this.speak(DEMO_SCRIPT[i].text);
    if (this.demoPlaying) this.demoSchedule();
  }

  private demoToggle(): void {
    if (this.demoPlaying) this.demoStop();
    else {
      this.demoPlaying = true;
      if (this.demoIndex >= DEMO_SCRIPT.length - 1) this.demoGo(0);
      else this.demoSchedule();
      this.render();
    }
  }

  /**
   * Slide the pieces from where they were to where they ended up.
   *
   * Skipped entirely above 4x, where the tween would be shorter than a couple of frames
   * and would read as a flicker rather than a movement.
   */
  private startAnim(): void {
    if (this.animRaf !== null) cancelAnimationFrame(this.animRaf);
    const duration = 620 / this.demoSpeed;
    if (this.demoSpeed > 4 || duration < 120) {
      this.animT = 1;
      return;
    }
    const started = performance.now();
    this.animT = 0;
    const step = (now: number) => {
      this.animT = Math.min(1, (now - started) / duration);
      this.render();
      if (this.animT < 1) this.animRaf = requestAnimationFrame(step);
      else this.animRaf = null;
    };
    this.animRaf = requestAnimationFrame(step);
  }

  private demoStop(): void {
    this.demoPlaying = false;
    if (this.demoTimer !== null) window.clearTimeout(this.demoTimer);
    this.demoTimer = null;
    this.render();
  }

  /** Reading pace: a floor plus time proportional to how much text the beat carries. */
  private beatMs(i = this.demoIndex): number {
    const beat = DEMO_SCRIPT[i];
    return Math.max(700, Math.min(14000, 3200 + beat.text.length * 42) / this.demoSpeed);
  }

  /** Rough time speech synthesis needs, at a normal speaking rate. */
  private speechMs(text: string): number {
    return text.length * 58;
  }

  /**
   * At high playback speeds a beat is gone before it can be read out, and half-spoken
   * narration cut off mid-sentence is worse than none. So narration is skipped rather
   * than truncated once the beat is shorter than the sentence needs.
   */
  private narrationFits(i = this.demoIndex): boolean {
    if (!this.demoPlaying) return true; // stepping by hand: always speak
    return this.beatMs(i) >= this.speechMs(DEMO_SCRIPT[i].text) * 0.85;
  }

  private demoSchedule(): void {
    if (this.demoTimer !== null) window.clearTimeout(this.demoTimer);
    const ms = this.beatMs();
    this.demoTimer = window.setTimeout(() => {
      if (!this.demoPlaying) return;
      if (this.demoIndex >= DEMO_SCRIPT.length - 1) this.demoStop();
      else this.demoGo(this.demoIndex + 1);
    }, ms);
  }

  /** The demo shows both armies: you cannot explain a plan through fog. */
  private demoView(): PlayerView {
    const all = new Set<number>();
    for (let i = 0; i < 81; i++) all.add(i);
    return {
      me: 0,
      turn: this.game.turn,
      own: this.game.unitsOf(0).map((u) => ({ ...u })),
      visibleEnemies: this.game.unitsOf(1).map((u) => ({ ...u })),
      ghosts: [],
      visible: all,
      nodeOwners: [...this.game.nodeOwners],
      nodeAge: this.game.nodeGarrison.map((g) => this.game.turn - g),
      supply: this.game.supply[0],
      enemySupply: this.game.supply[1],
      holdStreak: [...this.game.holdStreak] as [number, number],
    };
  }

  /**
   * Read the beat aloud. Browser speech synthesis is best-effort — it is missing or
   * voiceless in some browsers — so nothing in the demo depends on it working, and the
   * text is always on screen regardless.
   */
  private speak(text: string): void {
    if (this.muted || typeof window.speechSynthesis === 'undefined') return;
    if (!this.narrationFits()) {
      this.stopSpeech();
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch {
      /* narration is a nicety, never a dependency */
    }
  }

  private stopSpeech(): void {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }

  private renderDemo(): void {
    const beat = DEMO_SCRIPT[this.demoIndex];
    el('demo-step').textContent = `${this.demoIndex + 1} / ${DEMO_SCRIPT.length}`;
    el('demo-title').textContent = beat.title;
    el('demo-text').textContent = beat.text;
    el('demo-play').textContent = this.demoPlaying ? 'Pause' : 'Play';
    el('demo-mute').textContent = this.muted ? 'Unmute' : 'Mute';
    el('demo-mute').classList.toggle('on', !this.muted);
    (el('demo-speed') as HTMLInputElement).value = String(this.demoSpeed);
    const tooFast = this.demoPlaying && !this.narrationFits();
    el('demo-speed-label').textContent =
      `${this.demoSpeed.toFixed(1)}×${tooFast ? ' — narration off' : ''}`;
    (el('demo-prev') as HTMLButtonElement).disabled = this.demoIndex === 0;
    (el('demo-next') as HTMLButtonElement).disabled =
      this.demoIndex >= DEMO_SCRIPT.length - 1;
  }

  private onHandoffReady(): void {
    if (this.phase.kind !== 'handoff') return;
    this.phase = { kind: 'orders', player: this.phase.player };
    this.clearSelection();
    this.render();
  }

  private onSubmit(): void {
    if (this.phase.kind !== 'orders') return;
    const player = this.phase.player;
    const orders = [...this.pending.values()];

    if (this.mode.kind === 'hotseat' && player === 0) {
      this.storedFirst = orders;
      this.pending.clear();
      this.clearSelection();
      this.phase = { kind: 'handoff', player: 1 };
      this.render();
      return;
    }

    const [o0, o1] =
      this.mode.kind === 'hotseat'
        ? [this.storedFirst, orders]
        : [orders, this.mode.bot.orders(this.game.viewFor(1), this.mode.rng)];

    this.resolve(o0, o1);
  }

  private resolve(o0: Order[], o1: Order[]): void {
    // Snapshot every unit's square so the next screen can draw movement trails. Only own
    // units are ever read back out of this, so it leaks nothing.
    this.lastPositions = new Map(this.game.units.map((u) => [u.id, u.sq]));

    const record = this.game.submit(o0, o1, this.reinforcePref);
    this.lastEvents = record.events;
    this.logLines = this.describe(record.turn, record);

    this.pending.clear();
    this.storedFirst = [];
    this.clearSelection();

    if (this.game.status.state !== 'playing') {
      this.phase = { kind: 'over' };
    } else if (this.mode.kind === 'hotseat') {
      this.phase = { kind: 'handoff', player: 0 };
    } else {
      this.phase = { kind: 'orders', player: 0 };
    }
    this.render();
  }

  /** Public information only — combat results, supply shocks, node changes. */
  private describe(turn: number, record: ReturnType<Game['submit']>): string[] {
    const out: string[] = [`— turn ${turn} —`];
    for (const e of record.events) {
      const at = sqName(e.at);
      switch (e.kind) {
        case 'strike-kills-advance':
          out.push(`A strike caught an advance at ${at}.`);
          break;
        case 'brace-kills-strike':
          out.push(`A braced defender killed its attacker at ${at}.`);
          break;
        case 'counter-breaks-brace':
          out.push(`A countering type broke a braced defender at ${at}.`);
          break;
        case 'strike-trade':
          out.push(`Mutual destruction at ${at}.`);
          break;
        case 'ground-ceded':
          out.push(`An advance slipped past a braced unit at ${at}.`);
          break;
        case 'advance-halted':
          out.push(`Two advances halted against each other at ${at}.`);
          break;
        case 'strike-whiff':
          break;
      }
    }
    if (record.starved.length) out.push(`Starvation: ${record.starved.length} unit(s) lost.`);
    if (record.reinforced.length) out.push(`Reinforcement arrived.`);
    if (out.length === 1) out.push('Quiet turn — no contact.');
    return out;
  }

  // ── order entry ────────────────────────────────────────────────────────────

  private get activePlayer(): Player | null {
    return this.phase.kind === 'orders' ? this.phase.player : null;
  }

  private clearSelection(): void {
    this.selected = null;
    this.pendingStance = null;
    this.candidates.clear();
  }

  private select(unit: Unit): void {
    this.selected = unit;
    this.pendingStance = null;
    this.candidates.clear();
    this.render();
  }

  private chooseStance(stance: Stance): void {
    const unit = this.selected;
    if (!unit) return;

    if (stance === Stance.Brace) {
      this.pending.set(unit.id, { unitId: unit.id, stance: Stance.Brace, path: [] });
      this.clearSelection();
      this.render();
      return;
    }

    this.pendingStance = stance;
    this.candidates.clear();
    if (stance === Stance.Advance) {
      for (const o of legalOrders(unit)) {
        if (o.stance === Stance.Advance) this.candidates.add(o.path[o.path.length - 1]);
      }
    } else {
      for (const [dx, dy] of DIRS8) {
        const x = xOf(unit.sq) + dx;
        const y = yOf(unit.sq) + dy;
        if (inBounds(x, y)) this.candidates.add(idx(x, y));
      }
    }
    this.render();
  }

  private onBoardClick(ev: MouseEvent): void {
    const player = this.activePlayer;
    if (player === null) return;
    const sq = this.board.hitTest(ev);
    if (sq === null) return;

    // Committing a square for the stance being aimed.
    if (this.selected && this.pendingStance !== null && this.candidates.has(sq)) {
      const unit = this.selected;
      const wanted =
        this.pendingStance === Stance.Advance
          ? legalOrders(unit).find(
              (o) => o.stance === Stance.Advance && o.path[o.path.length - 1] === sq
            )
          : legalOrders(unit).find((o) => o.stance === Stance.Strike && o.target === sq);
      if (wanted) {
        this.pending.set(unit.id, wanted);
        this.clearSelection();
        this.render();
        return;
      }
    }

    const own = this.game.viewFor(player).own.find((u) => u.sq === sq);
    if (own) this.select(own);
    else {
      this.clearSelection();
      this.render();
    }
  }

  private braceRemaining(): void {
    const player = this.activePlayer;
    if (player === null) return;
    for (const u of this.game.viewFor(player).own) {
      if (!this.pending.has(u.id)) {
        this.pending.set(u.id, { unitId: u.id, stance: Stance.Brace, path: [] });
      }
    }
    this.clearSelection();
    this.render();
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    const menu = this.phase.kind === 'menu';
    el('menu').classList.toggle('hidden', !menu);
    el('game').classList.toggle('hidden', menu);
    if (menu) return;

    const isDemo = this.phase.kind === 'demo';
    const concealed = this.phase.kind === 'handoff';
    const viewer: Player =
      this.phase.kind === 'handoff'
        ? this.phase.player
        : this.phase.kind === 'orders'
          ? this.phase.player
          : 0;
    const view = isDemo ? this.demoView() : this.game.viewFor(viewer);

    const model: RenderModel = {
      view,
      concealed,
      selected: this.selected,
      pendingStance: this.pendingStance,
      candidates: this.candidates,
      orders: this.pending,
      lastPositions: this.lastPositions,
      lastEvents: this.lastEvents,
      focus: isDemo
        ? new Set((DEMO_SCRIPT[this.demoIndex].focus ?? []).map(demoSq))
        : undefined,
      showCounters: this.showCounters,
      anim:
        isDemo && this.animT < 1 ? { t: this.animT, from: this.lastPositions } : undefined,
    };
    this.board.render(model);

    el('handoff').classList.toggle('hidden', !concealed);
    el('gameover').classList.toggle('hidden', this.phase.kind !== 'over' && !isDemo ? false : true);
    el('gameover').classList.toggle('hidden', this.phase.kind !== 'over');
    el('controls').classList.toggle('hidden', this.phase.kind !== 'orders');
    el('demopanel').classList.toggle('hidden', !isDemo);
    el('counters-toggle').textContent = this.showCounters ? 'Counters ✓' : 'Counters';
    el('counters-toggle').classList.toggle('on', this.showCounters);
    el('logcard').classList.toggle('hidden', isDemo);
    if (isDemo) this.renderDemo();

    if (concealed && this.phase.kind === 'handoff') {
      el('handoff-title').textContent = `Pass to Player ${this.phase.player + 1}`;
      el('handoff-sub').textContent =
        'Orders are simultaneous and the board is fogged — no peeking at the other side’s view.';
    }

    this.renderHeader(viewer, view.turn);
    this.renderStatus(viewer);
    if (!isDemo) {
      this.renderRoster(viewer);
      this.renderSelection();
      this.renderReinforcement(viewer);
      this.renderLog();
    }
    this.renderGameOver();
  }

  private renderHeader(viewer: Player, turn: number): void {
    if (this.phase.kind === 'demo') {
      el('turn').textContent = `Turn ${turn} / ${TURN_LIMIT}`;
      el('whose').textContent = 'Demonstration — cyan to win';
      el('whose').className = 'whose side-0';
      return;
    }
    const label =
      this.mode.kind === 'solo' ? 'You' : `Player ${viewer + 1}`;
    el('turn').textContent = `Turn ${turn + (this.phase.kind === 'over' ? 0 : 1)} / ${TURN_LIMIT}`;
    el('whose').textContent = this.phase.kind === 'orders' ? `${label} — write orders` : label;
    el('whose').className = `whose side-${viewer}`;
  }

  private renderStatus(viewer: Player): void {
    const g = this.game;
    const foe = (1 - viewer) as Player;
    const upkeep = g.upkeep(viewer);
    const income = g.income(viewer);

    const rows: Array<[string, string, boolean]> = [
      ['Nodes held', `${g.nodesHeld(viewer)} of 5 — need ${NODES_TO_WIN}`, false],
      [
        'Victory clock',
        g.holdStreak[viewer] > 0
          ? `${g.holdStreak[viewer]} / ${HOLD_TURNS} turns`
          : `not holding ${NODES_TO_WIN}`,
        g.holdStreak[viewer] >= HOLD_TURNS - 1,
      ],
      [
        'Supply',
        `income ${income} · upkeep ${upkeep} · banked ${g.supply[viewer]}`,
        g.insolvent(viewer),
      ],
      ['Army', `${g.unitsOf(viewer).length} of ${MAX_UNITS} (${FREE_UNITS} free)`, false],
      ['Opponent clock', `${g.holdStreak[foe]} / ${HOLD_TURNS}`, g.holdStreak[foe] >= HOLD_TURNS - 1],
    ];

    el('status').innerHTML = rows
      .map(
        ([k, v, warn]) =>
          `<div class="row${warn ? ' warn' : ''}"><span>${k}</span><b>${v}</b></div>`
      )
      .join('');

    const insolvent = this.game.insolvent(viewer);
    const alert = el('alert');
    alert.classList.toggle('hidden', !insolvent);
    if (insolvent) {
      alert.textContent =
        'Insolvent — your army is larger than your territory can feed. A unit starves at end of turn.';
    }
  }

  private renderRoster(viewer: Player): void {
    const view = this.game.viewFor(viewer);
    const list = el('roster');
    list.innerHTML = '';

    for (const u of view.own) {
      const order = this.pending.get(u.id);
      const item = document.createElement('button');
      item.className = `unit${this.selected?.id === u.id ? ' selected' : ''}${
        order ? ' assigned' : ''
      }`;
      const breaks = COUNTERS[u.type];
      item.innerHTML =
        `<span class="glyph side-${viewer}">${UNIT_NAMES[u.type][0]}</span>` +
        `<span class="name">${UNIT_NAMES[u.type]} <em>${sqName(u.sq)}</em></span>` +
        `<span class="order">${order ? STANCE_NAMES[order.stance] : '—'}</span>`;
      item.title = breaks
        ? `Breaks a braced ${UNIT_NAMES[breaks]}`
        : 'Does not counter anything';
      item.addEventListener('click', () => this.select(u));
      list.appendChild(item);
    }

    const unassigned = view.own.filter((u) => !this.pending.has(u.id)).length;
    el('unassigned').textContent =
      unassigned === 0 ? 'All units ordered.' : `${unassigned} unit(s) will default to Brace.`;
  }

  private renderSelection(): void {
    const box = el('stances');
    const unit = this.selected;
    if (!unit) {
      box.innerHTML = '<p class="hint">Select a unit on the board or in the roster.</p>';
      return;
    }

    const breaks = COUNTERS[unit.type];
    const brokenBy = (
      [UnitType.Vanguard, UnitType.Warden, UnitType.Lancer] as UnitType[]
    ).find((t) => COUNTERS[t] === unit.type);

    const buttons: Array<[Stance, string, boolean]> = [
      [Stance.Brace, 'Brace — dig in, claim a node', true],
      [Stance.Advance, `Advance — up to ${MOVE_RANGE[unit.type]}`, MOVE_RANGE[unit.type] > 0],
      [Stance.Strike, 'Strike — hit an adjacent square', unit.type !== UnitType.Command],
    ];

    box.innerHTML =
      `<div class="selhead"><b>${UNIT_NAMES[unit.type]}</b> at ${sqName(unit.sq)}` +
      ` <span class="dim">sight ${SIGHT[unit.type]}</span></div>` +
      (unit.type === UnitType.Scout
        ? '<p class="hint warnText">Scouts lose every exchange they enter. Keep it out of contact.</p>'
        : `<p class="hint">${
            breaks ? `Breaks braced <b>${UNIT_NAMES[breaks]}</b>` : 'Counters nothing'
          }${brokenBy ? ` · broken by <b>${UNIT_NAMES[brokenBy]}</b>` : ''}</p>`);

    for (const [stance, label, enabled] of buttons) {
      if (!enabled) continue;
      const b = document.createElement('button');
      b.className = `stance${this.pendingStance === stance ? ' active' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => this.chooseStance(stance));
      box.appendChild(b);
    }

    if (this.pendingStance !== null) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent =
        this.pendingStance === Stance.Advance
          ? 'Click a marked square to advance there.'
          : 'Click a ringed square to strike it.';
      box.appendChild(p);
    }
  }

  private renderReinforcement(viewer: Player): void {
    const g = this.game;
    const affordable = g.supply[viewer] >= REINFORCE_COST && g.unitsOf(viewer).length < MAX_UNITS;
    const box = el('reinforce');
    box.classList.toggle('hidden', !affordable);
    if (!affordable) return;

    box.innerHTML = '<div class="label">Next reinforcement</div>';
    for (const type of REINFORCEABLE) {
      const b = document.createElement('button');
      b.className = `pill${this.reinforcePref[viewer] === type ? ' active' : ''}`;
      b.textContent = UNIT_NAMES[type];
      b.addEventListener('click', () => {
        this.reinforcePref[viewer] = type;
        this.render();
      });
      box.appendChild(b);
    }
  }

  private renderLog(): void {
    el('log').innerHTML =
      this.logLines.length === 0
        ? '<p class="hint">No turns resolved yet.</p>'
        : this.logLines.map((l) => `<div class="line">${l}</div>`).join('');
  }

  private renderGameOver(): void {
    if (this.phase.kind !== 'over') return;
    const s = this.game.status;
    let text = '';
    if (s.state === 'won') {
      const who =
        this.mode.kind === 'solo'
          ? s.winner === 0
            ? 'You win'
            : 'The opponent wins'
          : `Player ${s.winner + 1} wins`;
      text = `${who} — ${s.reason}.`;
    } else if (s.state === 'draw') {
      text = `Draw — ${s.reason}.`;
    }
    el('result').textContent = text;
  }
}

/** Static reference text, kept in one place so the rules on screen match the engine. */
export const HELP_HTML = `
  <h3>How a turn works</h3>
  <p>Both sides write one order per unit, then everything resolves at once. There is no
  first player.</p>
  <h3>Stances</h3>
  <ul>
    <li><b>Advance</b> — take ground. Walks straight past a braced unit.</li>
    <li><b>Brace</b> — dig in. The only way to claim or hold a node, and it kills attackers.</li>
    <li><b>Strike</b> — hit one adjacent square. Kills anything that advanced into it.</li>
  </ul>
  <p class="cycle">Strike beats Advance · Advance beats Brace · Brace beats Strike</p>
  <h3>Counters</h3>
  <p class="cycle">Vanguard breaks Warden · Warden breaks Lancer · Lancer breaks Vanguard</p>
  <p>If the attacker's type counters the defender's, the attacker wins the exchange whatever
  the defender chose. A braced <b>Warden</b> holds its square against an advance; a
  <b>Scout</b> loses every exchange it enters.</p>
  <h3>Territory</h3>
  <p>Hold ${NODES_TO_WIN} of 5 nodes for ${HOLD_TURNS} consecutive turns, or destroy the enemy
  Command. Nodes are claimed only by <b>bracing</b> on them, and rot back to unowned after
  ${NODE_DECAY_GRACE} turns without a garrison — the number on a node you own is how long it
  has left.</p>
  <h3>Supply</h3>
  <p>Income is 1 + nodes held. Every unit past the ${FREE_UNITS}th costs 1 upkeep. Spend more
  than you earn and a unit starves each turn, so massing an army while your nodes rot will
  quietly kill it.</p>
  <h3>Fog</h3>
  <p>You see what your units see; ridges block sight but not movement. Enemies you have lost
  track of stay on the board as dashed <b>ghosts</b> stamped with the turn you last saw them —
  they are memories, not facts. Combat results are always public.</p>
`;
