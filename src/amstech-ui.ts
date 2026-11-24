/** Small helpers for the AMSTech look (see src/shared.css and src/amstech-ui/). */

/** The element with this id (the pages only look up ids they define). */
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Fills the blue part of a slider track up to its value: the track gradient reads --v. */
export function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--v', `${Math.max(0, Math.min(100, percent))}%`);
}

/** Repaints every slider (call after the code sets a value, which fires no input event). */
export function paintRanges(root: ParentNode = document): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="range"]')) paintRange(input);
}

/** Keeps sliders painted while they are dragged, and paints them once now. */
export function watchRanges(): void {
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'range') paintRange(target);
  });
  paintRanges();
}

/** Closes a modal <dialog> on a click on its backdrop (outside its box), like a sheet. */
export function closeOnBackdropClick(dialog: HTMLDialogElement): void {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || event.detail === 0) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}

/**
 * The chapter bar of the brand manual: a line with a small notch per step and Thor's ears on the current
 * one (the only place, with the logo, where the ears appear). Labels are fixed strings from the code.
 */
export function stepsBar(labels: string[], current: number, width = 380): string {
  const y = 30;
  const step = width / labels.length;
  let line = 'M1 30';
  let ears = '';
  labels.forEach((_, index) => {
    const cx = step * index + step / 2;
    if (index === current) {
      line += `H${cx - 18}M${cx + 18} ${y}`;
      ears = `<path class="steps-ears" d="M${cx - 18} ${y}L${cx - 14} ${y - 24}L${cx - 3} ${y - 13}H${cx + 3}L${cx + 14} ${y - 24}L${cx + 18} ${y}"/>`
        + `<circle class="steps-dot" cx="${cx + 14}" cy="${y - 24}" r="3.6"/>`;
    } else {
      line += `H${cx - 6}L${cx} ${y - 9}L${cx + 6} ${y}`;
    }
  });
  line += `H${width - 1}`;
  const items = labels.map((label, index) => `<li${index === current ? ' class="current" aria-current="step"' : ''}>${label}</li>`).join('');
  return `<svg viewBox="0 0 ${width} 34" aria-hidden="true"><path class="steps-line" d="${line}"/>${ears}</svg><ol>${items}</ol>`;
}
