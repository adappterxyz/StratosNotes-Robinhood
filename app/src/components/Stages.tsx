/**
 * The workspace's stages, in order (Flow's right panel): Overview, Validate,
 * Payoff, Ready-made note (save), Issue. Each works on the workflow open on the canvas.
 */
export { OverviewPanel } from './stages/OverviewPanel';
export { ValidatePanel } from './stages/ValidatePanel';
export { PayoffPanel } from './stages/PayoffPanel';
export { TemplatePanel } from './stages/TemplatePanel';
export { IssuePanel } from './stages/IssuePanel';
export type { Built, DocInfo, IssuePreset, Stage } from './stages/types';
