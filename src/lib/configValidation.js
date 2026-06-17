const PRODUCTION_REQUIRED_CONFIG = [
  {
    name: "GOOGLE_CLIENT_ID",
    feature: "Google OAuth account login"
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    feature: "Google OAuth token exchange"
  },
  {
    name: "API_KEY_DIGESTS",
    feature: "API-key authentication for protected API/admin routes"
  },
  {
    name: "CORS_ORIGINS",
    feature: "browser CORS allowlist for deployed web clients"
  }
];

function envValue(env, name){
  return typeof env[name] === "string" ? env[name].trim() : "";
}

function hasEnv(env, name){
  return envValue(env, name).length > 0;
}

function startupConfigError(issues){
  const details = issues
    .map(issue => `- ${issue.variable}: ${issue.message} Affected feature: ${issue.feature}.`)
    .join("\n");
  const error = new Error(`Startup configuration validation failed:\n${details}`);
  error.name = "StartupConfigError";
  error.issues = issues;
  return error;
}

export function validateStartupConfig(env = process.env){
  if(env.NODE_ENV !== "production") return { ok: true, issues: [] };

  const issues = [];

  for(const required of PRODUCTION_REQUIRED_CONFIG){
    if(!hasEnv(env, required.name)){
      issues.push({
        variable: required.name,
        feature: required.feature,
        message: `${required.name} is required in production.`
      });
    }
  }

  if(!hasEnv(env, "PUBLIC_BASE_URL") && !hasEnv(env, "GOOGLE_REDIRECT_URI")){
    issues.push({
      variable: "PUBLIC_BASE_URL or GOOGLE_REDIRECT_URI",
      feature: "Google OAuth redirect URI generation",
      message: "Set PUBLIC_BASE_URL so the app can derive /auth/google/callback, or set GOOGLE_REDIRECT_URI explicitly."
    });
  }

  const publicBaseUrl = envValue(env, "PUBLIC_BASE_URL");
  if(publicBaseUrl){
    let parsed;
    try{
      parsed = new URL(publicBaseUrl);
    }catch{
      issues.push({
        variable: "PUBLIC_BASE_URL",
        feature: "public app URL and Google OAuth redirect URI generation",
        message: "PUBLIC_BASE_URL must be a valid absolute URL in production."
      });
    }

    if(parsed && parsed.protocol !== "https:"){
      issues.push({
        variable: "PUBLIC_BASE_URL",
        feature: "public app URL and Google OAuth redirect URI generation",
        message: "PUBLIC_BASE_URL must use https:// in production."
      });
    }
  }

  if(issues.length > 0) throw startupConfigError(issues);

  return { ok: true, issues: [] };
}
