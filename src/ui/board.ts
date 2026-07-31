import { PlayerView } from '../engine/fog';
import {
  CombatEvent,
  COUNTERS,
  NODES,
  NODE_DECAY_GRACE,
  Order,
  Player,
  RIDGE_SET,
  SIZE,
  Stance,
  Unit,
  UnitType,
  cheb,
  idx,
  xOf,
  yOf,
} from '../engine/types';

const CELL = 58;
const PAD = 26;
export const CANVAS_SIZE = SIZE * CELL + PAD * 2;

const COLOURS = {
  bg: '#0b1020',
  cellLight: '#161d34',
  cellDark: '#131a2e',
  ridge: '#2c3454',
  grid: '#0b1020',
  fog: 'rgba(6, 9, 20, 0.72)',
  label: '#5b678c',
  candidate: '#38f8b0',
  strike: '#fb7185',
  selection: '#fbbf24',
} as const;

/** Player 0 reads cyan, player 1 amber — consistent with the other prototype. */
const SIDE = ['#38bdf8', '#fbbf24'] as const;

const GLYPH: Record<UnitType, string> = {
  [UnitType.Command]: 'C',
  [UnitType.Vanguard]: 'V',
  [UnitType.Warden]: 'W',
  [UnitType.Lancer]: 'L',
  [UnitType.Scout]: 'S',
};

export interface RenderModel {
  view: PlayerView;
  /** Set while the screen is being handed to the other player. */
  concealed: boolean;
  selected: Unit | null;
  /** Which stance the selected unit is currently choosing a square for. */
  pendingStance: Stance | null;
  /** Squares the player may legally click right now. */
  candidates: Set<number>;
  orders: Map<number, Order>;
  /** Own unit positions at the start of last turn, for movement arrows. */
  lastPositions: Map<number, number>;
  lastEvents: CombatEvent[];
  /** Squares the guided demo is drawing attention to. */
  focus?: Set<number>;
  /** Overlay the counter relationships onto the pieces. */
  showCounters?: boolean;
  /**
   * In-flight movement. `t` runs 0→1 and `from` holds each unit's square before the
   * turn resolved, so pieces slide between squares instead of teleporting.
   */
  anim?: { t: number; from: Map<number, number> };
}

export class BoardView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_SIZE * dpr;
    canvas.height = CANVAS_SIZE * dpr;
    canvas.style.width = `${CANVAS_SIZE}px`;
    canvas.style.height = `${CANVAS_SIZE}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
  }

  /** Square under a pointer event, or null outside the grid. */
  hitTest(ev: MouseEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left - PAD;
    const py = ev.clientY - rect.top - PAD;
    const gx = Math.floor(px / CELL);
    const gy = SIZE - 1 - Math.floor(py / CELL);
    if (gx < 0 || gx >= SIZE || gy < 0 || gy >= SIZE) return null;
    return idx(gx, gy);
  }

  /** Screen centre of a square. Rank 1 is drawn at the bottom. */
  private centre(sq: number): [number, number] {
    return [
      PAD + xOf(sq) * CELL + CELL / 2,
      PAD + (SIZE - 1 - yOf(sq)) * CELL + CELL / 2,
    ];
  }

  /** Where a unit should be drawn right now, mid-slide if a move is animating. */
  private unitPos(m: RenderModel, id: number, sq: number): [number, number] {
    const a = m.anim;
    if (!a || a.t >= 1) return this.centre(sq);
    const from = a.from.get(id);
    if (from === undefined || from === sq) return this.centre(sq);
    const [fx, fy] = this.centre(from);
    const [tx, ty] = this.centre(sq);
    // Ease-in-out, so a piece accelerates away and settles rather than sliding linearly.
    const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
    return [fx + (tx - fx) * e, fy + (ty - fy) * e];
  }

  render(m: RenderModel): void {
    const { ctx } = this;
    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    this.drawCells();
    // Fog goes down before the nodes, not after: node ownership and the decay countdown
    // are public information, so they must stay crisp even on squares nobody can see.
    // Drawing them first left the number that the whole economy turns on greyed out.
    this.drawFog(m);
    this.drawNodes(m);
    if (!m.concealed) {
      this.drawCandidates(m);
      this.drawTrails(m);
      this.drawEventMarks(m);
      this.drawGhosts(m);
      this.drawUnits(m);
      this.drawOrders(m);
      this.drawSelection(m);
      this.drawFocus(m);
    }
    this.drawLabels();
  }

  private drawCells(): void {
    const { ctx } = this;
    for (let sq = 0; sq < SIZE * SIZE; sq++) {
      const x = PAD + xOf(sq) * CELL;
      const y = PAD + (SIZE - 1 - yOf(sq)) * CELL;
      const checker = (xOf(sq) + yOf(sq)) % 2 === 0;
      ctx.fillStyle = RIDGE_SET.has(sq)
        ? COLOURS.ridge
        : checker
          ? COLOURS.cellLight
          : COLOURS.cellDark;
      ctx.fillRect(x, y, CELL, CELL);

      if (RIDGE_SET.has(sq)) {
        // Hatching, so a ridge reads as "blocks sight" rather than "impassable".
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, CELL, CELL);
        ctx.clip();
        ctx.strokeStyle = 'rgba(148, 163, 214, 0.35)';
        ctx.lineWidth = 1.5;
        for (let o = -CELL; o < CELL * 2; o += 8) {
          ctx.beginPath();
          ctx.moveTo(x + o, y);
          ctx.lineTo(x + o + CELL, y + CELL);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = COLOURS.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
    }
  }

  private drawNodes(m: RenderModel): void {
    const { ctx } = this;
    NODES.forEach((sq, i) => {
      const [cx, cy] = this.centre(sq);
      const owner = m.view.nodeOwners[i];
      const colour = owner === null ? '#64748b' : SIDE[owner];

      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      const r = CELL * 0.38;
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k - Math.PI / 2;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = colour;
      ctx.lineWidth = owner === null ? 1.5 : 2.5;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.restore();

      // Turns of ownership left before the garrison lapses. This is the number the whole
      // economy turns on, so it lives on the board rather than in a panel — and in the
      // cell corner rather than under the hexagon, where a unit standing on the node used
      // to cover it up. Shown for both sides: node age is public information, and knowing
      // when the enemy's territory rots is half the plan.
      if (owner !== null) {
        const left = NODE_DECAY_GRACE - m.view.nodeAge[i];
        const bx = PAD + xOf(sq) * CELL + CELL - 12;
        const by = PAD + (SIZE - 1 - yOf(sq)) * CELL + 11;
        const urgent = left <= 1;

        ctx.beginPath();
        ctx.arc(bx, by, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = '#070a14';
        ctx.fill();
        ctx.strokeStyle = urgent ? COLOURS.strike : colour;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = urgent ? COLOURS.strike : colour;
        ctx.font = '700 11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(left <= 0 ? '!' : String(left), bx, by + 0.5);
      }
    });
  }

  private drawFog(m: RenderModel): void {
    const { ctx } = this;
    ctx.fillStyle = COLOURS.fog;
    for (let sq = 0; sq < SIZE * SIZE; sq++) {
      if (m.view.visible.has(sq)) continue;
      const x = PAD + xOf(sq) * CELL;
      const y = PAD + (SIZE - 1 - yOf(sq)) * CELL;
      ctx.fillRect(x, y, CELL, CELL);
    }
  }

  private drawCandidates(m: RenderModel): void {
    if (!m.selected || m.pendingStance === null) return;
    const { ctx } = this;
    const strike = m.pendingStance === Stance.Strike;
    for (const sq of m.candidates) {
      const [cx, cy] = this.centre(sq);
      ctx.beginPath();
      if (strike) {
        ctx.arc(cx, cy, CELL * 0.34, 0, Math.PI * 2);
        ctx.strokeStyle = COLOURS.strike;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = COLOURS.candidate;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /** Faint arrows showing where your own units came from last turn. */
  private drawTrails(m: RenderModel): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(148, 163, 214, 0.45)';
    ctx.lineWidth = 2;
    for (const u of m.view.own) {
      const from = m.lastPositions.get(u.id);
      if (from === undefined || from === u.sq) continue;
      const [fx, fy] = this.centre(from);
      const [tx, ty] = this.centre(u.sq);
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(fx, fy, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(148, 163, 214, 0.55)';
      ctx.fill();
    }
  }

  /** Public combat results from last turn — an X where something died. */
  private drawEventMarks(m: RenderModel): void {
    const { ctx } = this;
    for (const e of m.lastEvents) {
      if (e.died.length === 0) continue;
      const [cx, cy] = this.centre(e.at);
      ctx.strokeStyle = 'rgba(251, 113, 133, 0.75)';
      ctx.lineWidth = 2.5;
      const r = CELL * 0.22;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
    }
  }

  private drawGhosts(m: RenderModel): void {
    const { ctx } = this;
    const foe = (1 - m.view.me) as Player;
    const visibleIds = new Set(m.view.visibleEnemies.map((e) => e.id));
    for (const g of m.view.ghosts) {
      if (visibleIds.has(g.unitId)) continue;
      const [cx, cy] = this.centre(g.sq);
      ctx.save();
      ctx.globalAlpha = 0.4;
      this.drawGlyph(cx, cy, g.type, foe, true);
      ctx.restore();
      ctx.fillStyle = COLOURS.label;
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`t${g.turn}`, cx, cy + CELL * 0.42);
    }
  }

  private drawUnits(m: RenderModel): void {
    for (const u of m.view.own) {
      const [cx, cy] = this.unitPos(m, u.id, u.sq);
      this.drawGlyph(cx, cy, u.type, m.view.me, false);
    }
    for (const e of m.view.visibleEnemies) {
      const [cx, cy] = this.unitPos(m, e.id, e.sq);
      this.drawGlyph(cx, cy, e.type, e.owner, false);
    }
    if (m.showCounters) this.drawCounterMarks(m);
  }

  /**
   * The counter triangle, drawn onto the pieces.
   *
   * Two layers, because the rule has two halves that matter at different moments. A
   * permanent corner badge says what a piece breaks in the abstract — useful while you
   * are still learning that Vanguard→Warden→Lancer→Vanguard. A chevron appears only when
   * a piece is *actually* adjacent to something it beats (green, above) or something that
   * beats it (red, below), which is the part you need at the moment you choose a stance.
   */
  private drawCounterMarks(m: RenderModel): void {
    const { ctx } = this;
    const foes = m.view.visibleEnemies;
    const mine = m.view.own;

    const mark = (u: { sq: number; type: UnitType }, enemies: Array<{ sq: number; type: UnitType }>) => {
      const breaks = COUNTERS[u.type];
      if (breaks === null) return; // Command and Scout sit outside the triangle
      const [cx, cy] = this.centre(u.sq);

      // Static badge: the initial of whatever this type breaks.
      const bx = PAD + xOf(u.sq) * CELL + 11;
      const by = PAD + (SIZE - 1 - yOf(u.sq)) * CELL + 11;
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(7,10,20,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56,248,176,0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#38f8b0';
      ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(GLYPH[breaks], bx, by + 0.5);

      const beatsSomeone = enemies.some((e) => cheb(e.sq, u.sq) === 1 && COUNTERS[u.type] === e.type);
      const beatenBy = enemies.some((e) => cheb(e.sq, u.sq) === 1 && COUNTERS[e.type] === u.type);

      const chevron = (up: boolean, colour: string) => {
        const y = cy + (up ? -CELL * 0.42 : CELL * 0.42);
        const d = up ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(cx - 7, y - 3 * d);
        ctx.lineTo(cx, y + 3 * d);
        ctx.lineTo(cx + 7, y - 3 * d);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
      };
      if (beatsSomeone) chevron(true, '#38f8b0');
      if (beatenBy) chevron(false, '#fb7185');
    };

    for (const u of mine) mark(u, foes);
    for (const e of foes) mark(e, mine);
  }

  private drawGlyph(
    cx: number,
    cy: number,
    type: UnitType,
    owner: Player,
    stale: boolean
  ): void {
    const { ctx } = this;
    const colour = SIDE[owner];
    const r = CELL * 0.3;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    switch (type) {
      case UnitType.Command:
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        break;
      case UnitType.Vanguard: // arrowhead — reach
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.92, r * 0.72);
        ctx.lineTo(-r * 0.92, r * 0.72);
        ctx.closePath();
        break;
      case UnitType.Warden: // block — anchor
        ctx.rect(-r * 0.82, -r * 0.82, r * 1.64, r * 1.64);
        break;
      case UnitType.Lancer: // diamond
        ctx.moveTo(0, -r);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r, 0);
        ctx.closePath();
        break;
      case UnitType.Scout: // small ring — eye
        ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2);
        break;
    }
    ctx.fillStyle = stale ? 'transparent' : 'rgba(11, 16, 32, 0.85)';
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = type === UnitType.Command ? 3 : 2;
    if (stale) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = colour;
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPH[type], 0, 1);
    ctx.restore();
  }

  /** Pending orders: a chevron for Advance, a bar for Brace, a burst for Strike. */
  private drawOrders(m: RenderModel): void {
    const { ctx } = this;
    for (const u of m.view.own) {
      const o = m.orders.get(u.id);
      if (!o) continue;
      const [sx, sy] = this.centre(u.sq);

      if (o.stance === Stance.Brace) {
        ctx.strokeStyle = COLOURS.candidate;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sx - CELL * 0.26, sy + CELL * 0.34);
        ctx.lineTo(sx + CELL * 0.26, sy + CELL * 0.34);
        ctx.stroke();
        continue;
      }

      if (o.stance === Stance.Advance && o.path.length) {
        const [tx, ty] = this.centre(o.path[o.path.length - 1]);
        ctx.strokeStyle = COLOURS.candidate;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        const a = Math.atan2(ty - sy, tx - sx);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - 9 * Math.cos(a - 0.4), ty - 9 * Math.sin(a - 0.4));
        ctx.lineTo(tx - 9 * Math.cos(a + 0.4), ty - 9 * Math.sin(a + 0.4));
        ctx.closePath();
        ctx.fillStyle = COLOURS.candidate;
        ctx.fill();
        continue;
      }

      if (o.stance === Stance.Strike && o.target !== undefined) {
        const [tx, ty] = this.centre(o.target);
        ctx.strokeStyle = COLOURS.strike;
        ctx.lineWidth = 3;
        const r = CELL * 0.2;
        ctx.beginPath();
        ctx.moveTo(tx - r, ty - r);
        ctx.lineTo(tx + r, ty + r);
        ctx.moveTo(tx + r, ty - r);
        ctx.lineTo(tx - r, ty + r);
        ctx.stroke();
      }
    }
  }

  /** Demo-mode emphasis: a soft ring around the squares the narration is talking about. */
  private drawFocus(m: RenderModel): void {
    if (!m.focus || m.focus.size === 0) return;
    const { ctx } = this;
    for (const s of m.focus) {
      const [cx, cy] = this.centre(s);
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.46, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(56, 248, 176, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawSelection(m: RenderModel): void {
    if (!m.selected) return;
    const { ctx } = this;
    const [cx, cy] = this.centre(m.selected.sq);
    ctx.strokeStyle = COLOURS.selection;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(cx - CELL / 2 + 3, cy - CELL / 2 + 3, CELL - 6, CELL - 6);
    ctx.setLineDash([]);
  }

  private drawLabels(): void {
    const { ctx } = this;
    ctx.fillStyle = COLOURS.label;
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 0; x < SIZE; x++) {
      const cx = PAD + x * CELL + CELL / 2;
      const label = 'abcdefghi'[x];
      ctx.fillText(label, cx, PAD / 2);
      ctx.fillText(label, cx, CANVAS_SIZE - PAD / 2);
    }
    for (let y = 0; y < SIZE; y++) {
      const cy = PAD + (SIZE - 1 - y) * CELL + CELL / 2;
      ctx.fillText(String(y + 1), PAD / 2, cy);
      ctx.fillText(String(y + 1), CANVAS_SIZE - PAD / 2, cy);
    }
  }
}
