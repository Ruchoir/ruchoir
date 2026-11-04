/**
 * The Réordonner mode of the roles list, as data: which rows may move, which arrows are on, and the
 * order a move gives. Pure. A person may only move the roles they manage (those below their own
 * highest role), within that band; the others keep their place (`orderAllowed`, the web's rule, the
 * API being the judge). `order` is every ranked role's id, strongest first, base roles left out.
 */
import { orderAllowed, type RoleLike } from "@ruchoir/client/permissionsLogic";

type Direction = "up" | "down";

/** The positions of `order` the viewer may fill: those of the roles they manage. */
function slots(roles: RoleLike[], order: string[]): number[] {
  const manageable = new Set(roles.filter((r) => r.manageable).map((r) => r.id));
  return order.flatMap((id, index) => (manageable.has(id) ? [index] : []));
}

function neighbour(roles: RoleLike[], order: string[], id: string, direction: Direction, mayManage: boolean): number | null {
  if (!mayManage) return null;
  const band = slots(roles, order);
  const at = band.findIndex((index) => order[index] === id);
  if (at < 0) return null;
  const other = band[direction === "up" ? at - 1 : at + 1];
  return other === undefined ? null : other;
}

/** Whether the arrow of `id` in that direction does something. */
export function canMove(roles: RoleLike[], order: string[], id: string, direction: Direction, mayManage = true): boolean {
  return neighbour(roles, order, id, direction, mayManage) !== null;
}

/** The order after moving `id` one step; the same order when it cannot move there. */
export function moveRole(roles: RoleLike[], order: string[], id: string, direction: Direction, mayManage = true): string[] {
  const to = neighbour(roles, order, id, direction, mayManage);
  if (to === null) return order;
  const next = [...order];
  const from = next.indexOf(id);
  [next[from], next[to]] = [next[to], next[from]];
  return orderAllowed(roles, next) ? next : order;
}

/** Whether saving would send anything. */
export function orderChanged(initial: string[], order: string[]): boolean {
  return initial.length !== order.length || initial.some((id, index) => order[index] !== id);
}

/** Every ranked role in the shown order, with its movability and the state of its two arrows. */
export function rowsOf<R extends RoleLike>(roles: R[], order: string[], mayManage: boolean): { role: R; id: string; movable: boolean; up: boolean; down: boolean }[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  return order.flatMap((id) => {
    const role = byId.get(id);
    if (!role) return [];
    return [
      {
        role,
        id,
        movable: mayManage && role.manageable,
        up: canMove(roles, order, id, "up", mayManage),
        down: canMove(roles, order, id, "down", mayManage),
      },
    ];
  });
}
