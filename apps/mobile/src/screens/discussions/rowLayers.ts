/**
 * The layers of a message row's style, in the order they are laid (the later one wins): the row, the
 * tablet's own spacing, a style's card (Indigo), the mention's tint over it, and last the smaller top
 * of a message continuing the one above, which must beat the tablet's. Free of React Native so Node
 * tests it.
 */
export type RowLayer = "row" | "rowTablet" | "card" | "mention" | "continued";

export function rowLayers({ head, tablet, card, mention }: { head: boolean; tablet: boolean; card: boolean; mention: boolean }): RowLayer[] {
  const layers: RowLayer[] = ["row"];
  if (tablet) layers.push("rowTablet");
  if (card) layers.push("card");
  if (mention) layers.push("mention");
  if (!head) layers.push("continued");
  return layers;
}
