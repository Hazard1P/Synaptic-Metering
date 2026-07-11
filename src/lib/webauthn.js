import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "crypto";
import { nanoid } from "nanoid";

const CHALLENGE_TTL_MINUTES = Number(process.env.WEBAUTHN_CHALLENGE_TTL_MINUTES || 5);
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Synaptic Systems Metering";

function base64url(buffer){ return Buffer.from(buffer).toString("base64url"); }
function fromBase64url(value){ return Buffer.from(String(value || ""), "base64url"); }
function sha256(buffer){ return createHash("sha256").update(buffer).digest(); }

function publicBase(req){ return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, ""); }
function expectedOrigin(req){ return process.env.WEBAUTHN_ORIGIN || publicBase(req); }
function rpId(req){ return process.env.WEBAUTHN_RP_ID || new URL(expectedOrigin(req)).hostname; }
function nowPlusMinutes(minutes){ return new Date(Date.now() + minutes * 60_000).toISOString(); }

function storeChallenge(db, { accountId = null, challenge, purpose }){
  db.prepare(`
    INSERT INTO webauthn_challenges (id, account_id, challenge, purpose, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("webauthnchal_" + nanoid(18), accountId, challenge, purpose, nowPlusMinutes(CHALLENGE_TTL_MINUTES));
}

function consumeChallenge(db, { challenge, purpose, accountId = undefined }){
  const row = db.prepare(`
    SELECT * FROM webauthn_challenges
    WHERE challenge=? AND purpose=? AND used_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).get(challenge, purpose);
  if(!row) throw Object.assign(new Error("webauthn_challenge_invalid"), { status: 400 });
  if(accountId !== undefined && row.account_id !== accountId) throw Object.assign(new Error("webauthn_challenge_account_mismatch"), { status: 400 });
  db.prepare("UPDATE webauthn_challenges SET used_at=datetime('now') WHERE id=?").run(row.id);
  return row;
}

function decodeClientData(clientDataJSON, expectedChallenge, req){
  const clientData = JSON.parse(fromBase64url(clientDataJSON).toString("utf8"));
  if(clientData.challenge !== expectedChallenge) throw Object.assign(new Error("webauthn_challenge_mismatch"), { status: 400 });
  if(clientData.origin !== expectedOrigin(req)) throw Object.assign(new Error("webauthn_origin_mismatch"), { status: 400 });
  if(clientData.type !== "webauthn.create" && clientData.type !== "webauthn.get") throw Object.assign(new Error("webauthn_type_invalid"), { status: 400 });
  return clientData;
}

function parseAuthenticatorData(authData){
  if(authData.length < 37) throw Object.assign(new Error("webauthn_authenticator_data_invalid"), { status: 400 });
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const counter = authData.readUInt32BE(33);
  return { rpIdHash, flags, counter, attestedCredentialData: authData.subarray(37) };
}

function ensureUserPresent(flags){ if((flags & 0x01) !== 0x01) throw Object.assign(new Error("webauthn_user_presence_required"), { status: 400 }); }
function ensureRpIdHash(parsed, req){
  if(!parsed.rpIdHash.equals(sha256(Buffer.from(rpId(req), "utf8")))) throw Object.assign(new Error("webauthn_rp_id_mismatch"), { status: 400 });
}

function readCborItem(buf, offset = 0){
  const first = buf[offset++];
  const major = first >> 5;
  let ai = first & 0x1f;
  let len = ai;
  if(ai === 24) len = buf[offset++];
  else if(ai === 25){ len = buf.readUInt16BE(offset); offset += 2; }
  else if(ai === 26){ len = buf.readUInt32BE(offset); offset += 4; }
  else if(ai >= 27) throw new Error("unsupported_cbor_length");
  if(major === 0) return { value: len, offset };
  if(major === 1) return { value: -1 - len, offset };
  if(major === 2){ const value = buf.subarray(offset, offset + len); return { value, offset: offset + len }; }
  if(major === 3){ const value = buf.subarray(offset, offset + len).toString("utf8"); return { value, offset: offset + len }; }
  if(major === 4){ const arr = []; for(let i=0;i<len;i++){ const r=readCborItem(buf, offset); arr.push(r.value); offset=r.offset; } return { value: arr, offset }; }
  if(major === 5){ const map = new Map(); for(let i=0;i<len;i++){ const k=readCborItem(buf, offset); const v=readCborItem(buf, k.offset); map.set(k.value, v.value); offset=v.offset; } return { value: map, offset }; }
  throw new Error("unsupported_cbor_type");
}

function coseToJwk(cose){
  const key = readCborItem(cose).value;
  const kty = key.get(1), alg = key.get(3);
  if(kty === 2 && alg === -7){ return { kty:"EC", crv:"P-256", x:base64url(key.get(-2)), y:base64url(key.get(-3)), ext:true }; }
  if(kty === 3 && alg === -257){ return { kty:"RSA", n:base64url(key.get(-1)), e:base64url(key.get(-2)), ext:true }; }
  throw Object.assign(new Error("webauthn_public_key_unsupported"), { status: 400 });
}

function parseAttestedCredentialData(authData){
  let offset = 37 + 16;
  const credentialIdLength = authData.readUInt16BE(offset); offset += 2;
  const credentialId = authData.subarray(offset, offset + credentialIdLength); offset += credentialIdLength;
  const cose = authData.subarray(offset);
  return { credentialId: base64url(credentialId), jwk: coseToJwk(cose) };
}

export function generateRegistrationOptions(db, req){
  const account = req.authAccount;
  const challenge = base64url(randomBytes(32));
  const credentials = db.prepare("SELECT credential_id, transports FROM webauthn_credentials WHERE account_id=?").all(account.id);
  storeChallenge(db, { accountId: account.id, challenge, purpose: "registration" });
  return {
    rp: { name: RP_NAME, id: rpId(req) },
    user: { id: base64url(Buffer.from(account.id, "utf8")), name: account.display_name || account.id, displayName: account.display_name || account.id },
    challenge,
    pubKeyCredParams: [{ type:"public-key", alg:-7 }, { type:"public-key", alg:-257 }],
    authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
    timeout: CHALLENGE_TTL_MINUTES * 60_000,
    attestation: "none",
    excludeCredentials: credentials.map(c => ({ type:"public-key", id:c.credential_id, transports: JSON.parse(c.transports || "[]") }))
  };
}

export function verifyRegistrationResponse(db, req, body){
  const response = body?.response || {};
  const client = decodeClientData(response.clientDataJSON, body?.challenge, req);
  if(client.type !== "webauthn.create") throw Object.assign(new Error("webauthn_type_invalid"), { status: 400 });
  consumeChallenge(db, { challenge: body.challenge, purpose: "registration", accountId: req.authAccount.id });
  const authData = response.attestationObject
    ? readCborItem(fromBase64url(response.attestationObject)).value.get("authData")
    : fromBase64url(response.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  ensureRpIdHash(parsed, req); ensureUserPresent(parsed.flags);
  if((parsed.flags & 0x40) !== 0x40) throw Object.assign(new Error("webauthn_attestation_missing"), { status: 400 });
  const attested = parseAttestedCredentialData(authData);
  db.prepare(`INSERT INTO webauthn_credentials (id, account_id, credential_id, public_key, counter, transports, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(credential_id) DO UPDATE SET transports=excluded.transports, updated_at=datetime('now')`)
    .run("webauthncred_" + nanoid(18), req.authAccount.id, attested.credentialId, JSON.stringify(attested.jwk), parsed.counter, JSON.stringify(body.transports || response.transports || []));
  return { ok: true, credential_id: attested.credentialId };
}

export function generateAuthenticationOptions(db, req){
  const challenge = base64url(randomBytes(32));
  storeChallenge(db, { challenge, purpose: "authentication" });
  return { challenge, rpId: rpId(req), timeout: CHALLENGE_TTL_MINUTES * 60_000, userVerification: "preferred" };
}

export function verifyAuthenticationAssertion(db, req, body){
  const credentialId = body?.id || body?.rawId;
  const cred = db.prepare("SELECT * FROM webauthn_credentials WHERE credential_id=?").get(credentialId);
  if(!cred) throw Object.assign(new Error("webauthn_credential_not_found"), { status: 401 });
  const response = body.response || {};
  const client = decodeClientData(response.clientDataJSON, body.challenge, req);
  if(client.type !== "webauthn.get") throw Object.assign(new Error("webauthn_type_invalid"), { status: 400 });
  consumeChallenge(db, { challenge: body.challenge, purpose: "authentication" });
  const authData = fromBase64url(response.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  ensureRpIdHash(parsed, req); ensureUserPresent(parsed.flags);
  const signed = Buffer.concat([authData, sha256(fromBase64url(response.clientDataJSON))]);
  const key = createPublicKey({ key: JSON.parse(cred.public_key), format: "jwk" });
  const ok = verifySignature(key.asymmetricKeyType === "rsa" ? "RSA-SHA256" : "SHA256", signed, key, fromBase64url(response.signature));
  if(!ok) throw Object.assign(new Error("webauthn_signature_invalid"), { status: 401 });
  if(parsed.counter && Number(cred.counter || 0) && parsed.counter <= Number(cred.counter)) throw Object.assign(new Error("webauthn_counter_replay"), { status: 401 });
  db.prepare("UPDATE webauthn_credentials SET counter=?, last_used_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(parsed.counter, cred.id);
  return { ok: true, account_id: cred.account_id };
}
