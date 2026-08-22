// Fixed ref-type color palette plus a WCAG relative-luminance based
// contrast text color, so labels stay legible against any of the palette
// colors in both light and dark VSCode themes.
//
// Values match TortoiseGit's own defaults (src/TortoiseProc/Colors.cpp:
// CurrentBranch/LocalBranch/RemoteBranch/Tag/Stash/OtherRef), not VSCode's
// theme colors, so a node looks the same regardless of which theme is
// active — matching the reference product exactly was an explicit ask.
import type { RefType } from '../../shared/types';

export const REF_COLORS: Record<RefType, string> = {
  head: '#c80000',
  'current-branch': '#c80000',
  'local-branch': '#00c300',
  'remote-branch': '#ffddaa',
  tag: '#ffff00',
  stash: '#808080',
  other: '#e0e0e0',
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
