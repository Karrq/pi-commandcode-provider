/**
 * Unit tests for the pure ZDR header decision (src/zdr-policy.ts).
 *
 * The provider is the ZDR mode: the ZDR provider sends the header, the plain
 * provider only with the upstream environment force. Exclusions and per-model
 * releases veto either.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { zdrHeaderFor, type ZdrHeaderState } from "../src/zdr-policy.ts"

const PLAIN = "commandcode"
const ZDR = "commandcode-zdr"

function state(overrides: Partial<ZdrHeaderState> = {}): ZdrHeaderState {
  return {
    exclusions: [],
    sessionAllow: new Set(),
    rejected: new Set(),
    onceAllow: new Set(),
    env: {},
    ...overrides,
  }
}

describe("zdrHeaderFor", () => {
  it("sends the header on the ZDR provider and not on the plain provider", () => {
    assert.equal(zdrHeaderFor("m", ZDR, state()), true)
    assert.equal(zdrHeaderFor("m", PLAIN, state()), false)
    assert.equal(zdrHeaderFor("m", undefined, state()), false)
  })

  it("lets the environment force the header on the plain provider", () => {
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env: { CMD_ZDR: "1" } })), true)
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env: { COMMANDCODE_ZDR: "1" } })), true)
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env: { CMD_ZDR: "true" } })), false)
  })

  it("lets exclusions, session releases, and rejections veto the ZDR provider", () => {
    assert.equal(zdrHeaderFor("m", ZDR, state({ exclusions: ["m"] })), false)
    assert.equal(zdrHeaderFor("m", ZDR, state({ sessionAllow: new Set(["m"]) })), false)
    assert.equal(zdrHeaderFor("m", ZDR, state({ rejected: new Set(["m"]) })), false)
  })

  it("consumes a one-shot release once, then falls back to the provider", () => {
    const shared = state({ onceAllow: new Set(["m"]) })
    assert.equal(zdrHeaderFor("m", ZDR, shared), false)
    assert.equal(zdrHeaderFor("m", ZDR, shared), true)
  })

  it("lets a veto win over the environment force", () => {
    const env = { CMD_ZDR: "1" }
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env, exclusions: ["m"] })), false)
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env, sessionAllow: new Set(["m"]) })), false)
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env, rejected: new Set(["m"]) })), false)
    assert.equal(zdrHeaderFor("m", PLAIN, state({ env, onceAllow: new Set(["m"]) })), false)
  })
})
