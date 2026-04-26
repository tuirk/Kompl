/**
 * Single source of truth for the user-visible list of supported file formats.
 *
 * The file-upload connector and the onboarding card have to render this list
 * in three different visual styles (short card subtitle, dotted headline,
 * full hint-box list). Importing from here keeps them in sync.
 */

export const SUPPORTED_FORMATS_SHORT  = 'PDF, Word, audio, more';
export const SUPPORTED_FORMATS_FULL   = 'PDF, DOCX, PPTX, XLSX, TXT, MD, HTML, CSV, images, audio';
export const SUPPORTED_FORMATS_DOTTED = 'PDF · Word · Excel · Audio';
