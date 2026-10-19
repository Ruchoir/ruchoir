/**
 * The few lucide glyphs the Android widgets draw (widget mockup "Widgets Android"), as SVG strings
 * for `SvgWidget`: react-native-android-widget draws no React component, only its own widgets.
 * Their paths are lucide's own (lucide-react-native's icon data), stroke 2, 24 by 24.
 */
const NODES = {
  "square-pen": [
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>',
    '<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  ],
  "calendar-plus": [
    '<path d="M16 18h6"/>',
    '<path d="M16 2v3"/>',
    '<path d="M19 15v6"/>',
    '<path d="M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3"/>',
    '<path d="M3 9h18"/>',
    '<path d="M8 2v3"/>',
  ],
  upload: ['<path d="M12 3v12"/>', '<path d="m17 8-5-5-5 5"/>', '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'],
  search: ['<path d="m21 21-4.34-4.34"/>', '<circle cx="11" cy="11" r="8"/>'],
  calendar: ['<path d="M8 2v3"/>', '<path d="M16 2v3"/>', '<rect x="3" y="3" width="18" height="18" rx="2"/>', '<path d="M3 9h18"/>'],
} as const;

export type Glyph = keyof typeof NODES;

/** The glyph in `color`, as an SVG document. */
export function glyph(name: Glyph, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NODES[name].join("")}</svg>`;
}
