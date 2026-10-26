import fs from 'fs'
import path from 'path'

/**
 * How long a backup download may take. A backup carries the whole wiki (the
 * raw sources, every page with its previous versions, every table), and the
 * app builds all of it before it answers, so a large wiki takes minutes.
 */
export const BACKUP_TIMEOUT_MS = 10 * 60_000

/** A .kompl backup is a zip: it starts with a local file header (PK\x03\x04). */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

/**
 * Save a backup over the last one without ever leaving a broken file: write
 * it beside its name, flush it to disk, then rename it over the old one. A
 * failed write (a full disk, a crash) leaves the last backup as it was.
 */
export function saveBackupFile(filePath: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const partial = `${filePath}.partial`
  try {
    fs.writeFileSync(partial, buf, { flush: true })
    fs.renameSync(partial, filePath)
  } catch (err) {
    fs.rmSync(partial, { force: true })
    throw err
  }
}
