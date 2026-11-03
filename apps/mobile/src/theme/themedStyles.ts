/**
 * Styles built from a style's shape (corners, lines), once per shape: a file declares
 * `const makeStyles = styleCache((shape) => StyleSheet.create({...}))` and a component reads
 * `useThemedStyles(makeStyles)`. Each style's `Shape` is one object (`SHAPES`), so switching style
 * builds the other set and switching back finds the first.
 *
 * Kept free of React Native so Node tests it; the hook lives in `useTheme.ts`.
 */
import type { Shape } from "./tokens.ts";

export function styleCache<T>(make: (shape: Shape) => T): (shape: Shape) => T {
  const built = new WeakMap<Shape, T>();
  return (shape) => {
    let styles = built.get(shape);
    if (styles === undefined) {
      styles = make(shape);
      built.set(shape, styles);
    }
    return styles;
  };
}
