import { createHash, timingSafeEqual } from "crypto";

function parseDigests(value){
  return (value || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function sha256Hex(value){
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isHexSha256Digest(value){
  return /^[a-f0-9]{64}$/.test(value);
}

function digestMatches(providedDigest, expectedDigest){
  if(!isHexSha256Digest(expectedDigest)) return false;

  const provided = Buffer.from(providedDigest, "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function requireApiKey(req, res, next){
  const digests = parseDigests(process.env.API_KEY_DIGESTS);
  if(digests.length === 0){
    // safe default: if not configured, deny. Raw API_KEYS are intentionally ignored.
    return res.status(503).json({ error: "API_KEY_DIGESTS not configured" });
  }

  const provided = req.header("x-api-key") || "";
  if(!provided){
    return res.status(401).json({ error: "Unauthorized" });
  }

  const providedDigest = sha256Hex(provided);
  const authorized = digests.some(expectedDigest => digestMatches(providedDigest, expectedDigest));
  if(!authorized){
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
