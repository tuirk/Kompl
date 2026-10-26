/**
 * How much a .kompl backup may unpack to on restore (POST /api/import). The
 * restore holds the whole backup in memory while it writes it in one
 * transaction, so a zip bomb (a small file that unpacks to gigabytes, or
 * holds a vast number of entries) would crash the app instead of being
 * refused. A large real wiki (thousands of sources and pages) unpacks to a
 * few hundred MB in tens of thousands of files.
 */

/** Bytes all entries unpack to together, counted as they unpack. */
export const MAX_IMPORT_UNPACKED_BYTES = 1024 ** 3;

/** Entries in the zip, folders included. */
export const MAX_IMPORT_ENTRIES = 200_000;
