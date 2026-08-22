// Fixed ref-type color palette (mirrors TortoiseGit's revision graph) plus a
// WCAG relative-luminance based contrast text color, so labels stay legible
// against any of the palette colors in both light and dark VSCode themes.

import type { RefType } from '../../shared/types';

export const REF_COLORS: Record<RefType, string> = {
  head: '#ff0000',
  'current-branch': '#ff0000',
  'local-branch': '#3794ff',
  'remote-branch': '#4ec9b0',
  tag: '#d7ba7d',
  stash: '#c586c0',
  other: '#9cdcfe',
};

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.substring(0, 2), 16),
    parseInt(value.substring(2, 4), 16),
    parseInt(value.substring(4, 6), 16),
  ];
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbChannelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Picks black or white text for the best contrast against `bgHex`, per WCAG. */
export function contrastTextColor(bgHex: string): string {
  return relativeLuminance(bgHex) > 0.5 ? '#000000' : '#ffffff';
}
