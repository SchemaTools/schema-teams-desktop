/** Lucide React 1.54.0 X/Send paths, ISC + Feather MIT; full license in renderer/licenses.
 * Fixed trusted markup only: packaged main has no runtime dependency on lucide-react.
 */
const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const closeGlyph = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
export const sendGlyph = svg(
  '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
);
