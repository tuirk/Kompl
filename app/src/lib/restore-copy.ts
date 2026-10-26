/**
 * What every screen says about restoring a .kompl.zip backup, so the import
 * card, the repair card and onboarding never disagree. Import refuses a wiki
 * that has pages (POST /api/import, lib/wiki-empty.ts), and Kompl has no
 * button to empty a wiki, so a restore means a new, empty Kompl.
 */

export const RESTORE_NEEDS_EMPTY =
  'A backup can only be restored into a new, empty Kompl with nothing compiled yet. ' +
  "It can't be added to a wiki that already has pages, and Kompl has no button to empty a wiki.";

export const RESTORE_HOW =
  'To restore, set up a new Kompl, skip onboarding, then import the .kompl.zip file under ' +
  'Settings → Backup & restore → Import wiki.';

/** After a repair: the saved copy is a way back, but not a one-click undo. */
export const REPAIR_COPY_RESTORE =
  "This isn't a one-click undo: the copy can only be restored into a new, empty Kompl, " +
  'not into this wiki while it has pages. ' +
  RESTORE_HOW;
