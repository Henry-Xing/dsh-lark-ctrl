/**
 * Resolve the "workspace line" shown on session cards.
 *
 * A session's `header.cwd` is not always the directory the work happens in:
 * sessions created from a **remote workspace** carry the LOCAL mirror path
 * (`<dshHome>/remote-workspaces/<id>`), so printing it raw tells the phone
 * nothing about which server the run touched.
 *
 * Operators can translate those ids with a small JSON map:
 *
 *   { "workspaces": { "<mirrorId>": { "host": "10.0.0.7", "remotePath": "/src/proj" } } }
 *
 * Location: the `workspaceMapPath` config, else `<DSH_HOME>/workspace-map.json`
 * (`DSH_HOME` or `~/.dsh`). Inline `workspaceMap` entries win over the file.
 *
 * Everything degrades to the raw cwd: an unknown mirror id still renders, just
 * without a host, so a missing map can never hide where a run happened.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `<dshHome>/remote-workspaces/<id>[/sub/path]` */
const MIRROR_RE = /(?:^|[\\/])\.dsh[\\/]remote-workspaces[\\/]([^\\/]+)((?:[\\/].*)?)$/

/** mtime-keyed cache per map path, so a long-running host re-reads on change. */
const fileCache = new Map()

/** @returns {string} */
function defaultMapPath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'workspace-map.json')
}

/**
 * @param {string} path
 * @returns {Record<string, { host?: string, remotePath?: string }>}
 */
function readMapFile(path) {
  try {
    const stat = statSync(path)
    const cached = fileCache.get(path)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.workspaces
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const workspaces = parsed !== null && typeof parsed.workspaces === 'object' && parsed.workspaces !== null
      ? parsed.workspaces
      : {}
    fileCache.set(path, { mtimeMs: stat.mtimeMs, workspaces })
    return workspaces
  } catch {
    return {}
  }
}

/**
 * @param {string | undefined} remotePath
 * @returns {string}
 */
function trimSlash(remotePath) {
  return typeof remotePath === 'string' ? remotePath.replace(/[\\/]+$/, '') : ''
}

/**
 * Build the line rendered above a card's summary, e.g.
 * `🖥 10.40.0.7 /develop03/user/proj` or `🖥 /home/me/proj`.
 *
 * @param {string | undefined} cwd - `session.header.cwd`
 * @param {{ workspaceMapPath?: string, workspaceMap?: Record<string, { host?: string, remotePath?: string }> }} [config]
 * @returns {string} empty string when there is nothing to show
 */
export function workspaceLine(cwd, config = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const normalized = cwd.replace(/\\/g, '/')
  const mirror = MIRROR_RE.exec(normalized)
  if (mirror !== null) {
    const id = mirror[1]
    const sub = (mirror[2] ?? '').replace(/\\/g, '/')
    const inline = config.workspaceMap ?? {}
    const entry = inline[id] ?? readMapFile(config.workspaceMapPath || defaultMapPath())[id]
    const base = trimSlash(entry?.remotePath)
    if (typeof entry?.host === 'string' && entry.host !== '') {
      return `🖥 ${entry.host} ${base}${sub}`
    }
    return `🖥 ${id}${sub}`
  }
  return `🖥 ${cwd}`
}
