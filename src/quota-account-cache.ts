/**
 * Disk-backed account cache for the quota layer.
 *
 * The resolved `whoami` identity is written beside the agent's other Command
 * Code files, not inside the host's auth file, which the host owns and may
 * rewrite. Entries are keyed by a SHA-256 of the API key, so the key itself is
 * never written here and a rotated or refreshed credential misses by
 * construction. There is no time-based expiry: the entry lives as long as the
 * credential that produced it, and the quota layer deletes it after a failed
 * request so the next fetch re-resolves `whoami`.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { CommandCodeQuota, QuotaAccountCache } from "./quota-types.ts"

const CACHE_VERSION = 1

interface CacheFile {
  version: number
  accounts: Record<string, CommandCodeQuota["account"]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAccount(value: unknown): value is CommandCodeQuota["account"] {
  if (!isRecord(value)) return false
  if (typeof value.login !== "string") return false
  if (value.orgId !== null && typeof value.orgId !== "string") return false
  if (value.keyName !== undefined && typeof value.keyName !== "string") return false
  return true
}

function accountKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex")
}

function readCache(path: string): CacheFile {
  try {
    if (!existsSync(path)) return { version: CACHE_VERSION, accounts: {} }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.accounts)) {
      return { version: CACHE_VERSION, accounts: {} }
    }
    const accounts: Record<string, CommandCodeQuota["account"]> = {}
    for (const [key, value] of Object.entries(parsed.accounts)) {
      if (isAccount(value)) accounts[key] = value
    }
    return { version: CACHE_VERSION, accounts }
  } catch {
    // A missing, unreadable, or corrupt file is just an empty cache.
    return { version: CACHE_VERSION, accounts: {} }
  }
}

function writeCache(path: string, cache: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true })
  // Write through a pid-scoped temp file so a concurrent reader never sees a
  // half-written JSON document.
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
  renameSync(temp, path)
}

export function createDiskQuotaAccountCache(path: string): QuotaAccountCache {
  return {
    get: (apiKey) => readCache(path).accounts[accountKey(apiKey)],
    set: (apiKey, account) => {
      const cache = readCache(path)
      cache.accounts[accountKey(apiKey)] = account
      writeCache(path, cache)
    },
    delete: (apiKey) => {
      const cache = readCache(path)
      const key = accountKey(apiKey)
      if (!(key in cache.accounts)) return
      delete cache.accounts[key]
      writeCache(path, cache)
    },
  }
}
