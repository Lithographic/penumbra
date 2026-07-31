import {
  DIRS8,
  MOVE_RANGE,
  Order,
  Stance,
  Unit,
  UnitType,
  dirsFor,
  idx,
  inBounds,
  xOf,
  yOf,
} from './types';

/**
 * Every geometrically legal order for one unit.
 *
 * Deliberately independent of enemy positions (see the note on Order in types.ts).
 * Ridges do not block movement, so this is pure board geometry.
 *
 * Order counts per unit: Command 9, Vanguard 21, Warden 17, Scout 25 — which puts a
 * full 7-unit joint order set in the 10⁸ range. That size is the point: it is what
 * makes the per-turn matrix non-enumerable. See DESIGN.md §Lever B.
 */
export function legalOrders(unit: Unit): Order[] {
  const out: Order[] = [];

  // Brace is always available.
  out.push({ unitId: unit.id, stance: Stance.Brace, path: [] });

  // Advance: straight line in an allowed direction, 1..range squares.
  const range = MOVE_RANGE[unit.type];
  for (const [dx, dy] of dirsFor(unit.type)) {
    const path: number[] = [];
    for (let step = 1; step <= range; step++) {
      const x = xOf(unit.sq) + dx * step;
      const y = yOf(unit.sq) + dy * step;
      if (!inBounds(x, y)) break;
      path.push(idx(x, y));
      out.push({ unitId: unit.id, stance: Stance.Advance, path: [...path] });
    }
  }

  // Strike: stationary, attacks one adjacent square. Command cannot Strike — it is a
  // liability to protect and supply, not a fighter.
  if (unit.type !== UnitType.Command) {
    for (const [dx, dy] of DIRS8) {
      const x = xOf(unit.sq) + dx;
      const y = yOf(unit.sq) + dy;
      if (!inBounds(x, y)) continue;
      out.push({ unitId: unit.id, stance: Stance.Strike, path: [], target: idx(x, y) });
    }
  }

  return out;
}

/** Validates an order's shape against the unit it claims to command. */
export function isLegalOrder(unit: Unit, order: Order): boolean {
  if (order.unitId !== unit.id) return false;

  if (order.stance === Stance.Brace) {
    return order.path.length === 0 && order.target === undefined;
  }

  if (order.stance === Stance.Strike) {
    if (unit.type === UnitType.Command) return false;
    if (order.path.length !== 0 || order.target === undefined) return false;
    const dx = Math.abs(xOf(order.target) - xOf(unit.sq));
    const dy = Math.abs(yOf(order.target) - yOf(unit.sq));
    return Math.max(dx, dy) === 1;
  }

  // Advance: non-empty straight path of allowed length in an allowed direction.
  if (order.target !== undefined) return false;
  const len = order.path.length;
  if (len < 1 || len > MOVE_RANGE[unit.type]) return false;

  const dx = Math.sign(xOf(order.path[0]) - xOf(unit.sq));
  const dy = Math.sign(yOf(order.path[0]) - yOf(unit.sq));
  const allowed = dirsFor(unit.type).some(([ax, ay]) => ax === dx && ay === dy);
  if (!allowed) return false;

  for (let i = 0; i < len; i++) {
    const x = xOf(unit.sq) + dx * (i + 1);
    const y = yOf(unit.sq) + dy * (i + 1);
    if (!inBounds(x, y) || order.path[i] !== idx(x, y)) return false;
  }
  return true;
}

/** A Brace order, used as the fallback for any unit given no valid instruction. */
export function braceOrder(unit: Unit): Order {
  return { unitId: unit.id, stance: Stance.Brace, path: [] };
}
