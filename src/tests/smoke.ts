import assert from "node:assert/strict"
import { isRetryablePayuStatus } from "../providers/payu/config"

assert.equal(isRetryablePayuStatus(429), true)
assert.equal(isRetryablePayuStatus(500), true)
assert.equal(isRetryablePayuStatus(400), false)

console.log("mp smoke test passed")
