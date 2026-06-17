export const OPTIONAL_ENVIRONMENT_CONFIG = [
  {
    name: "GOOGLE_ALLOWED_EMAILS",
    feature: "Google OAuth account email allowlist",
    format: "comma-separated verified email addresses"
  },
  {
    name: "ADMIN_GOOGLE_EMAILS",
    feature: "Google OAuth admin bootstrap",
    format: "comma-separated verified email addresses"
  },
  {
    name: "BUSINESS_GOOGLE_EMAILS",
    feature: "Google OAuth business-association bootstrap metadata",
    format: "comma-separated verified email addresses"
  }
];

const EMAIL_LIST_ENV_VARS = OPTIONAL_ENVIRONMENT_CONFIG.map(item => item.name);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function parseCsvEnv(value){
  return (value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function validateEmailListEnv(env, issues){
  for(const name of EMAIL_LIST_ENV_VARS){
    const entries = parseCsvEnv(envValue(env, name));
    for(const entry of entries){
      if(!EMAIL_PATTERN.test(entry)){
        issues.push({
          variable: name,
          feature: OPTIONAL_ENVIRONMENT_CONFIG.find(item => item.name === name)?.feature || "Google OAuth account policy",
          message: `${name} must contain only comma-separated email addresses; invalid entry: ${entry}.`
        });
      }
    }
  }
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
  const issues = [];
  validateEmailListEnv(env, issues);

  if(env.NODE_ENV !== "production"){
    if(issues.length > 0) throw startupConfigError(issues);
    return { ok: true, issues: [] };
  }

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
