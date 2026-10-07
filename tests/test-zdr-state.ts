/**
 * Unit tests for the shared ZDR decision point (src/zdr-state.ts).
 *
 * No host runtime and no network: the module is a globalThis-backed decider
 * with an environment fallback, so the environment is passed in explicitly.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  commandCodeZdrExcluded,
  commandCodeZdrFor,
  republishCommandCodeZdr,
  setCommandCodeZdrExcluded,
  setCommandCodeZdrDecider,
  setCommandCodeZdrRepublish,
} from "../src/zdr-state.ts"
import { COMMAND_CODE_ZDR_PROVIDER } from "../src/providers.ts"

describe("commandCodeZdrFor", () => {
  it("falls back to the environment and the ZDR provider when no decider is published", () => {
    setCommandCodeZdrDecider(undefined)
    assert.equal(commandCodeZdrFor("m", undefined, { CMD_ZDR: "1" }), true)
    assert.equal(commandCodeZdrFor("m", undefined, { COMMANDCODE_ZDR: "1" }), true)
    assert.equal(commandCodeZdrFor("m", undefined, {}), false)
    // The ZDR provider is the mode, even with no environment force.
    assert.equal(commandCodeZdrFor("m", COMMAND_CODE_ZDR_PROVIDER, {}), true)
    assert.equal(commandCodeZdrFor("m", "commandcode", {}), false)
    // Only the exact "1" value enables the header.
    assert.equal(commandCodeZdrFor("m", undefined, { CMD_ZDR: "true" }), false)
  })

  it("lets a published decider override the environment per model and provider", () => {
    setCommandCodeZdrDecider((modelId, provider) => modelId === "a" && provider === "zdr")
    assert.equal(commandCodeZdrFor("a", "zdr", { CMD_ZDR: "1" }), true)
    assert.equal(commandCodeZdrFor("b", "zdr", { CMD_ZDR: "1" }), false)
    assert.equal(commandCodeZdrFor("a", "plain", { CMD_ZDR: "1" }), false)
    setCommandCodeZdrDecider(undefined)
  })

  it("restores the environment fallback after the decider is cleared", () => {
    setCommandCodeZdrDecider(() => false)
    assert.equal(commandCodeZdrFor("a", undefined, { CMD_ZDR: "1" }), false)
    setCommandCodeZdrDecider(undefined)
    assert.equal(commandCodeZdrFor("a", undefined, { CMD_ZDR: "1" }), true)
  })
})

describe("commandCodeZdrExcluded", () => {
  it("hides only the published ids and clears with an empty list", () => {
    setCommandCodeZdrExcluded(["a", "b"])
    assert.equal(commandCodeZdrExcluded("a"), true)
    assert.equal(commandCodeZdrExcluded("b"), true)
    assert.equal(commandCodeZdrExcluded("c"), false)
    setCommandCodeZdrExcluded([])
    assert.equal(commandCodeZdrExcluded("a"), false)
    setCommandCodeZdrExcluded(undefined)
    assert.equal(commandCodeZdrExcluded("a"), false)
  })
})

describe("republishCommandCodeZdr", () => {
  it("calls the registered callback and stops after it is cleared", () => {
    let calls = 0
    setCommandCodeZdrRepublish(() => {
      calls++
    })
    republishCommandCodeZdr()
    assert.equal(calls, 1)
    setCommandCodeZdrRepublish(undefined)
    republishCommandCodeZdr()
    assert.equal(calls, 1)
  })
})
