/** Test-only DOM probe. Unresolved gradients and browser-native checkboxes are not passes. */
export function collectNonText(context: string) {
  const root = document.querySelector(context);
  if (!root) throw Error('Missing contrast context');
  const samples: {
    kind: string;
    target: string;
    foreground: string;
    background: string;
    width?: string;
  }[] = [];
  const incomplete: string[] = [];
  const visible = (el: Element) => {
    if (!el.getBoundingClientRect().width || el.closest(':disabled')) return false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 1) return false;
    }
    return true;
  };
  const background = (el: Element | null): string | null => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') return null;
      if (s.backgroundColor.startsWith('color(')) return null;
      if (s.backgroundColor.startsWith('rgba(') && s.backgroundColor !== 'rgba(0, 0, 0, 0)')
        return null;
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') return s.backgroundColor;
    }
    return null;
  };
  const label = (el: Element) =>
    el.getAttribute('aria-label') || el.id || el.className || el.tagName;
  for (const element of root.querySelectorAll(
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
  )) {
    if (!visible(element)) continue;
    const frame = element.closest('.search-field, .composer-field, .timer-search') ?? element;
    const css = getComputedStyle(frame),
      target = String(label(element));
    const outside = background(frame.parentElement);
    const inside = background(frame);
    if (!inside || !outside) incomplete.push(`boundary:${target}:complex-background`);
    for (const [side, bg] of [
      ['inside', inside],
      ['outside', outside],
    ] as const) {
      if (!bg) continue;
      samples.push({
        kind: `boundary-${side}`,
        target,
        foreground: css.borderTopColor,
        background: bg,
        width: css.borderTopWidth,
      });
    }
  }
  for (const svg of root.querySelectorAll('button svg')) {
    if (!visible(svg)) continue;
    const button = svg.closest('button');
    if (!button) continue;
    const bg = background(svg);
    if (!bg) {
      incomplete.push(`icon:${String(label(button))}:complex-background`);
      continue;
    }
    const paints = new Set<string>();
    for (const part of svg.querySelectorAll(
      'path, rect, circle, polygon, polyline, line, ellipse',
    )) {
      const css = getComputedStyle(part);
      if (Number(css.opacity) !== 1) continue;
      if (
        css.stroke !== 'none' &&
        Number(css.strokeOpacity) === 1 &&
        parseFloat(css.strokeWidth) > 0
      )
        paints.add(css.stroke);
      if (css.fill !== 'none' && Number(css.fillOpacity) === 1) paints.add(css.fill);
    }
    if (!paints.size) incomplete.push(`icon:${String(label(button))}:no-opaque-paint`);
    for (const foreground of paints)
      samples.push({ kind: 'icon', target: String(label(button)), foreground, background: bg });
  }
  return { samples, incomplete };
}
