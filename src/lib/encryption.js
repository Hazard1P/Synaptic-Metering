import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = "v1";

function parseKeySpec(raw){
  const value = String(raw || "").trim();
  if(!value) return null;
  const separator = value.includes(":") ? ":" : value.includes("=") ? "=" : null;
  if(separator){
    const [keyId, ...rest] = value.split(separator);
    return { keyId: keyId.trim(), material: rest.join(separator).trim() };
  }
  return { keyId: "primary", material: value };
}

function decodeKeyMaterial(material){
  if(/^[a-f0-9]{64}$/i.test(material)) return Buffer.from(material, "hex");
  const decoded = Buffer.from(material, "base64");
  if(decoded.length === KEY_BYTES) return decoded;
  const utf8 = Buffer.from(material, "utf8");
  if(utf8.length === KEY_BYTES) return utf8;
  throw new Error("FIELD_ENCRYPTION_KEY material must resolve to 32 bytes");
}

export function parseFieldEncryptionKeys(env = process.env){
  const keys = new Map();
  const add = spec => {
    if(!spec) return;
    const parsed = parseKeySpec(spec);
    if(!parsed?.keyId) throw new Error("field encryption key id is required");
    keys.set(parsed.keyId, decodeKeyMaterial(parsed.material));
  };

  if(env.FIELD_ENCRYPTION_KEYS){
    let parsed;
    try{ parsed = JSON.parse(env.FIELD_ENCRYPTION_KEYS); }catch{ parsed = null; }
    if(parsed && typeof parsed === "object" && !Array.isArray(parsed)){
      for(const [keyId, material] of Object.entries(parsed)) add(`${keyId}:${material}`);
    }else{
      String(env.FIELD_ENCRYPTION_KEYS).split(",").map(s => s.trim()).filter(Boolean).forEach(add);
    }
  }
  add(env.FIELD_ENCRYPTION_KEY);

  const activeKeyId = env.FIELD_ENCRYPTION_KEY_ID || [...keys.keys()][0];
  if(keys.size && !keys.has(activeKeyId)) throw new Error(`active field encryption key '${activeKeyId}' is not configured`);
  return { activeKeyId, keys };
}

function keyring(options = {}){
  const configured = options.keys ? { activeKeyId: options.activeKeyId, keys: options.keys } : parseFieldEncryptionKeys(options.env || process.env);
  if(!configured.keys?.size) throw new Error("FIELD_ENCRYPTION_KEY or FIELD_ENCRYPTION_KEYS is required for field encryption");
  return configured;
}

function encode(buffer){ return Buffer.from(buffer).toString("base64url"); }
function decode(value, field){
  if(!/^[A-Za-z0-9_-]+$/.test(value || "")) throw new Error(`invalid encrypted field ${field}`);
  return Buffer.from(value, "base64url");
}

export function isEncryptedEnvelope(value){
  return typeof value === "string" && value.startsWith(`${ENVELOPE_VERSION}:`);
}

export function encryptField(plaintext, options = {}){
  if(plaintext === null || plaintext === undefined) return plaintext;
  const { activeKeyId, keys } = keyring(options);
  const key = keys.get(activeKeyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${activeKeyId}:${encode(iv)}:${encode(tag)}:${encode(ciphertext)}`;
}

export function decryptField(envelope, options = {}){
  if(envelope === null || envelope === undefined) return envelope;
  if(typeof envelope !== "string") throw new Error("encrypted field must be a string envelope");
  const parts = envelope.split(":");
  if(parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) throw new Error("malformed encrypted field envelope");
  const [, keyId, ivText, tagText, ciphertextText] = parts;
  const { keys } = keyring(options);
  const key = keys.get(keyId);
  if(!key) throw new Error(`field encryption key '${keyId}' is not configured`);
  const iv = decode(ivText, "iv");
  const tag = decode(tagText, "tag");
  const ciphertext = decode(ciphertextText, "ciphertext");
  if(iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length < 1) throw new Error("malformed encrypted field envelope");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptJsonField(value, options = {}){
  return encryptField(JSON.stringify(value ?? null), options);
}

export function decryptJsonField(envelope, fallback = null, options = {}){
  const plaintext = isEncryptedEnvelope(envelope) ? decryptField(envelope, options) : String(envelope ?? "null");
  try{ return JSON.parse(plaintext); }catch{ return fallback; }
}
