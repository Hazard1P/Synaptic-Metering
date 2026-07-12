import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { decryptField, encryptField, isEncryptedEnvelope, parseFieldEncryptionKeys } from "../src/lib/encryption.js";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const env = {
  FIELD_ENCRYPTION_KEYS: JSON.stringify({ a: keyA, b: keyB }),
  FIELD_ENCRYPTION_KEY_ID: "a"
};

describe("field envelope encryption", () => {
  it("encrypts and decrypts versioned AES-256-GCM envelopes with key ids", () => {
    const ciphertext = encryptField("secret-json", { env });
    assert.match(ciphertext, /^v1:a:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    assert.notEqual(ciphertext, "secret-json");
    assert.equal(decryptField(ciphertext, { env }), "secret-json");
  });

  it("rejects malformed ciphertext envelopes", () => {
    assert.throws(() => decryptField("v1:a:not-base64:tag", { env }), /invalid encrypted field iv|malformed encrypted field envelope/);
    assert.throws(() => decryptField("plaintext", { env }), /malformed encrypted field envelope/);
  });

  it("fails authentication when the wrong key material is configured", () => {
    const ciphertext = encryptField("secret", { env });
    const wrongEnv = { FIELD_ENCRYPTION_KEYS: JSON.stringify({ a: randomBytes(32).toString("base64") }), FIELD_ENCRYPTION_KEY_ID: "a" };
    assert.throws(() => decryptField(ciphertext, { env: wrongEnv }));
  });

  it("decrypts older key versions while encrypting new fields with the active key", () => {
    const oldCiphertext = encryptField("rotated", { env: { ...env, FIELD_ENCRYPTION_KEY_ID: "b" } });
    const newCiphertext = encryptField("current", { env });
    assert.match(oldCiphertext, /^v1:b:/);
    assert.match(newCiphertext, /^v1:a:/);
    assert.equal(decryptField(oldCiphertext, { env }), "rotated");
    assert.equal(decryptField(newCiphertext, { env }), "current");
  });

  it("parses key material from FIELD_ENCRYPTION_KEY for single-key deployments", () => {
    const parsed = parseFieldEncryptionKeys({ FIELD_ENCRYPTION_KEY: `primary:${keyA}` });
    assert.equal(parsed.activeKeyId, "primary");
    assert.equal(parsed.keys.get("primary").length, 32);
    assert.equal(isEncryptedEnvelope(encryptField("x", { env: { FIELD_ENCRYPTION_KEY: `primary:${keyA}` } })), true);
  });
});
