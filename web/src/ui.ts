/**
 * Shared Tailwind utility-class snippets.
 *
 * These exist because the previous design system had a handful of recurring
 * component classes (btn, role-badge, chip, …). They are plain Tailwind
 * utility strings, composed with `cn()` at call sites.
 */

/** Base button (matches the old `.btn`). */
export const btn =
  'inline-flex items-center gap-1 rounded-lg border border-border bg-panel px-3 py-1.5 text-sm whitespace-nowrap cursor-pointer hover:border-[#b9c4cf] disabled:opacity-55 disabled:cursor-not-allowed';

/** Primary button variant (old `.btn-primary`). */
export const btnPrimary = 'border-accent bg-accent text-white hover:border-accent-dark hover:bg-accent-dark';

/** Small button size (old `.btn-small`). */
export const btnSmall = 'rounded-md px-2 py-0.5 text-xs';

/** Danger button variant (old `.btn.danger`). */
export const btnDanger = 'border-danger-line bg-danger-bg text-danger';

/** Ghost icon button (old `.icon-btn`). */
export const iconBtn =
  'cursor-pointer border-0 bg-transparent px-0.5 text-[13px] leading-none opacity-55 hover:opacity-100';

/** Danger tint for icon buttons (old `.icon-btn.danger:hover`). */
export const iconBtnDanger = 'hover:text-danger';

/** Role pill badge (old `.role-badge`). */
export const roleBadge =
  'inline-block rounded-full border border-info-line bg-info-bg px-[7px] py-px text-[11px] text-accent-dark';

/** Admin variant of the role badge (old `.role-badge.admin`). */
export const roleBadgeAdmin = 'border-warn-line bg-warn-bg text-warn-strong';

/** Clickable chip (old `.chip`). */
export const chip =
  'cursor-pointer rounded-full border border-border bg-panel px-2 py-px text-xs hover:border-accent hover:text-accent';

/** Text input / select (old `.field input`, `.grant-user`, …). */
export const input =
  'rounded-lg border border-border bg-white px-2.5 py-[7px] focus:border-accent focus:outline-2 focus:outline-focus-ring';
