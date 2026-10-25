import type { Compiled, ProductParams, TemplateSource, TemplateSummary, WorkflowIR } from '@sn/core';

export interface DocInfo {
  name: string;
  /** product: opened from a term sheet; custom: a BPMN workflow (edited, imported, from AI or blank). */
  origin: 'product' | 'custom';
  basis: ProductParams | null;
  edited: boolean;
  template?: TemplateSummary;
  /** From the AI's reading of a term sheet: the issuance size and schedule it stated. */
  hint?: { size?: number; every?: number; unit?: 'months' | 'days' | 'minutes' };
}

/** What a stage needs from the open workflow, compiled as it would be published. */
export interface Built {
  ir: WorkflowIR;
  c: Compiled;
  source: TemplateSource;
}

/** What the guided issue flow (pages/IssueWizard.tsx) has already asked; with `compact` those sections are hidden. */
export interface IssuePreset {
  chainKey?: string;
  size?: number;
  strikeIn?: number;
  every?: { n: number; unit: 'minutes' | 'days' | 'months' };
  ratioPct?: number;
  haircuts?: Record<string, number>;
  timing?: { lag: number; grace: number } | null;
}

export type Stage = 'design' | 'validate' | 'payoff' | 'template' | 'issue';
