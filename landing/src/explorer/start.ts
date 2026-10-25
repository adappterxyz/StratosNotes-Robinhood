/**
 * Where the explorer opens: a carousel card can open it on its own note and side. Kept apart from
 * Explorer.tsx so the landing can name a start without loading the explorer itself.
 */
import type { Preset, Role, Sym, Terms } from './model';

export interface ExplorerStart {
  role: Role;
  goal: string;
  type: Terms['type'];
  syms: Sym[];
  preset: Preset;
  physical?: boolean;
}

export const DEFAULT_START: ExplorerStart = {
  role: 'investor',
  goal: 'yield',
  type: 'phoenix',
  syms: ['ETH'],
  preset: 'Dip & recover',
};
