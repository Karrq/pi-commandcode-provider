/**
 * Unit tests for the pure ZDR zone matcher (src/zdr-zones.ts).
 *
 * No pi runtime and no network. The home directory is real (from `node:os`)
 * and only derived paths are asserted, so nothing is mocked.
 */

import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  ZDR_ARMED_ENTRY,
  armedFromEntries,
  commandMentionsZone,
  formatZoneList,
  normalizeZone,
  pathInZones,
} from "../src/zdr-zones.ts"

const HOME = homedir()
const CWD = "/work/project"

describe("normalizeZone", () => {
  it("expands a leading tilde to the home directory", () => {
    assert.equal(normalizeZone("~/secret", CWD), join(HOME, "secret"))
    assert.equal(normalizeZone("~", CWD), HOME)
  })

  it("resolves a relative zone against the cwd and normalizes segments", () => {
    assert.equal(normalizeZone("zones/a", CWD), "/work/project/zones/a")
    assert.equal(normalizeZone("a/../b", CWD), "/work/project/b")
  })

  it("strips trailing separators", () => {
    assert.equal(normalizeZone("/a/b/", CWD), "/a/b")
    assert.equal(normalizeZone("/a/b///", CWD), "/a/b")
  })

  it("returns undefined for empty or whitespace-only zones", () => {
    assert.equal(normalizeZone("", CWD), undefined)
    assert.equal(normalizeZone("   ", CWD), undefined)
  })

  it("keeps the filesystem root intact", () => {
    assert.equal(normalizeZone("/", CWD), "/")
  })
})

describe("pathInZones", () => {
  it("matches the zone exactly", () => {
    assert.equal(pathInZones("/a/b", ["/a/b"], CWD), true)
  })

  it("matches a nested path", () => {
    assert.equal(pathInZones("/a/b/c/d.txt", ["/a/b"], CWD), true)
  })

  it("does not match a shared prefix boundary", () => {
    assert.equal(pathInZones("/a/bc", ["/a/b"], CWD), false)
    assert.equal(pathInZones("/a/bc/d", ["/a/b"], CWD), false)
  })

  it("resolves a relative target against the cwd", () => {
    assert.equal(pathInZones("private/x", ["/work/project/private"], CWD), true)
  })

  it("returns false for a target outside every zone", () => {
    assert.equal(pathInZones("/other/x", ["/a/b", "/c/d"], CWD), false)
  })

  it("returns false for an empty zones list", () => {
    assert.equal(pathInZones("/a/b", [], CWD), false)
  })

  it("returns false for an empty or invalid target", () => {
    assert.equal(pathInZones("", ["/a/b"], CWD), false)
    assert.equal(pathInZones("   ", ["/a/b"], CWD), false)
  })

  it("matches a glob zone at a directory boundary", () => {
    const zone = join(HOME, "Altius-*")
    assert.equal(pathInZones(join(HOME, "Altius-Chain"), [zone], CWD), true)
    assert.equal(pathInZones(join(HOME, "Altius-Chain", "src", "a.ts"), [zone], CWD), true)
  })

  it("does not match a glob zone without the literal stem", () => {
    const zone = join(HOME, "Altius-*")
    assert.equal(pathInZones(join(HOME, "Altius"), [zone], CWD), false)
    assert.equal(pathInZones(join(HOME, "AltiusStuff"), [zone], CWD), false)
  })

  it("keeps `*` inside one path segment and lets `**` cross separators", () => {
    assert.equal(pathInZones("/a/b/x/c/deep", ["/a/*/c"], CWD), false)
    assert.equal(pathInZones("/a/b/c/deep", ["/a/**"], CWD), true)
  })

  it("treats `?` as one character inside a segment", () => {
    assert.equal(pathInZones("/zones/ab", ["/zones/a?"], CWD), true)
    assert.equal(pathInZones("/zones/abc", ["/zones/a?"], CWD), false)
  })
})

describe("commandMentionsZone", () => {
  it("matches the absolute form of a zone", () => {
    assert.equal(
      commandMentionsZone("cat /zones/private/f.txt", ["/zones/private"], CWD),
      "/zones/private",
    )
  })

  it("matches the tilde-shortened form of a zone under home", () => {
    const zone = join(HOME, "private")
    assert.equal(commandMentionsZone("cat ~/private/f.txt", [zone], CWD), zone)
  })

  it("matches the cwd-relative form of a zone", () => {
    const zone = "/work/project/private"
    assert.equal(commandMentionsZone("cat private/f.txt", [zone], CWD), zone)
  })

  it("returns undefined when no zone is mentioned", () => {
    assert.equal(commandMentionsZone("ls /tmp && echo hi", ["/zones/private"], CWD), undefined)
  })

  it("does not catch a fragmented reference (documented limitation)", () => {
    const zone = join(HOME, "private")
    assert.equal(commandMentionsZone("cat $HOME/private/f.txt", [zone], CWD), undefined)
    assert.equal(
      commandMentionsZone("cat /zones/pri'vate'/f.txt", ["/zones/private"], CWD),
      undefined,
    )
  })

  it("matches a glob zone by its literal stem", () => {
    const zone = join(HOME, "Altius-*")
    assert.equal(commandMentionsZone("cat ~/Altius-Chain/README.md", [zone], CWD), zone)
    assert.equal(commandMentionsZone(`cat ${join(HOME, "Altius-HPEC")}/a`, [zone], CWD), zone)
  })

  it("does not match a glob zone without the literal stem", () => {
    const zone = join(HOME, "Altius-*")
    assert.equal(commandMentionsZone("cat ~/AltiusStuff/a", [zone], CWD), undefined)
    assert.equal(commandMentionsZone("ls /tmp", [zone], CWD), undefined)
  })
})

describe("armedFromEntries", () => {
  const marker = (data: unknown) => ({
    type: "custom",
    customType: ZDR_ARMED_ENTRY,
    data,
  })

  it("returns undefined when there are no entries", () => {
    assert.equal(armedFromEntries([]), undefined)
  })

  it("ignores custom entries with a different customType", () => {
    assert.equal(
      armedFromEntries([{ type: "custom", customType: "other", data: { source: "x", at: 1 } }]),
      undefined,
    )
    assert.equal(armedFromEntries([{ type: "message", data: { source: "x", at: 1 } }]), undefined)
  })

  it("returns a valid marker", () => {
    assert.deepEqual(armedFromEntries([marker({ source: "read", at: 42 })]), {
      source: "read",
      at: 42,
    })
  })

  it("returns the last valid marker when several exist", () => {
    assert.deepEqual(
      armedFromEntries([
        marker({ source: "cwd", at: 1 }),
        marker({ source: "bash", at: 2, detail: "cat /zones/private" }),
      ]),
      { source: "bash", at: 2, detail: "cat /zones/private" },
    )
  })

  it("ignores malformed data without throwing", () => {
    assert.equal(armedFromEntries([marker(null), marker("nope"), marker({ at: 3 })]), undefined)
    assert.equal(armedFromEntries([marker({ source: "read", at: "soon" })]), undefined)
  })

  it("returns a marker without an `at` field, defaulting it to 0", () => {
    assert.deepEqual(armedFromEntries([marker({ source: "inherited" })]), {
      source: "inherited",
      at: 0,
    })
  })
})

describe("formatZoneList", () => {
  it("joins zones with commas and renders an empty list as (none)", () => {
    assert.equal(formatZoneList(["/a", "~/b"]), "/a, ~/b")
    assert.equal(formatZoneList([]), "(none)")
  })
})
