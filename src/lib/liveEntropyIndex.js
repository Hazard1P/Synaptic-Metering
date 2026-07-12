import { createHash } from "node:crypto";
import { intelligenceTickContext, mapDatabaseStatus } from "./anchoredIntelligence.js";

const DEFAULT_ANCHOR_ID = "live-entropy-index";
const MAX_STRING_COUNT = 64;

function sha256Hex(value){
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clampUnit(value){
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeString(value){
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 1000);
}

function shannonEntropy(value){
  if(!value) return 0;
  const counts = new Map();
  for(const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for(const count of counts.values()){
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function normalizeStrings(input){
  return (Array.isArray(input) ? input : [input])
    .map(normalizeString)
    .filter(Boolean)
    .slice(0, MAX_STRING_COUNT);
}

export function buildEntropyAnchor({ context, strings = [], now = new Date() } = {}){
  const anchorId = context?.anchored_asset?.id || DEFAULT_ANCHOR_ID;
  const normalizedStrings = normalizeStrings(strings);
  const stringsDigest = sha256Hex(JSON.stringify(normalizedStrings));
  return {
    id: sha256Hex(JSON.stringify({
      operation: "Live_Entropy_Index_Build_Anchor",
      anchor_id: anchorId,
      tick_id: context?.deterministic_tick_id || null,
      strings_digest: stringsDigest
    })),
    operation: "Live_Entropy_Index_Build_Anchor",
    anchor_id: anchorId,
    tick_id: context?.deterministic_tick_id || null,
    strings_digest: stringsDigest,
    component_count: normalizedStrings.length,
    created_at: now.toISOString(),
    policy: "non_extractive_entropy_anchor_hashes_normalized_strings_only"
  };
}

export function buildLiveEntropyIndex({ db = null, strings = [], anchorId = DEFAULT_ANCHOR_ID, now = new Date() } = {}){
  const normalizedStrings = normalizeStrings(strings);
  const combined = normalizedStrings.join("\n");
  const entropy = shannonEntropy(combined);
  const uniqueSymbols = new Set(combined).size;
  const maxEntropy = combined.length > 1 ? Math.log2(uniqueSymbols || 1) : 0;
  const entropyRatio = maxEntropy ? clampUnit(entropy / maxEntropy) : 0;
  const context = intelligenceTickContext({ db, anchorId, now });
  const buildAnchor = buildEntropyAnchor({ context, strings: normalizedStrings, now });
  const liveEntropyScore = Number((entropyRatio * 100).toFixed(3));

  return {
    schema: "synaptics.intelligence.live-entropy-index.v1",
    operation: "Live_Entropy_Index",
    anchor_id: context.anchored_asset.id,
    build_anchor: buildAnchor,
    live_entropy_index: liveEntropyScore,
    entropy_ratio: Number(entropyRatio.toFixed(6)),
    shannon_entropy_bits_per_symbol: Number(entropy.toFixed(6)),
    unique_symbols: uniqueSymbols,
    string_count: normalizedStrings.length,
    character_count: combined.length,
    strings_of_intelligence: normalizedStrings,
    string_of_intelligence: combined,
    string_digest: buildAnchor.strings_digest,
    context,
    components: {
      normalization: "NFKC_trim_collapse_whitespace",
      entropy_model: "shannon_bits_per_symbol",
      live_tick: "anchored_seconds_of_intelligence_context",
      build_anchor: "sha256_tick_and_string_digest_anchor",
      map_database: mapDatabaseStatus({ db, anchorId: context.anchored_asset.id, now })
    },
    privacy: {
      raw_anchor_asset_extraction: "not_performed",
      persistence: "caller_controlled",
      digest_algorithm: "sha256"
    }
  };
}
