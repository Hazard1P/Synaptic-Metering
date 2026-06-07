export function requireApiKey(req, res, next){
  const keys = (process.env.API_KEYS || "").split(",").map(s=>s.trim()).filter(Boolean);
  if(keys.length === 0){
    // safe default: if not configured, deny
    return res.status(503).json({ error: "API_KEYS not configured" });
  }
  const provided = req.header("x-api-key") || "";
  if(!provided || !keys.includes(provided)){
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
