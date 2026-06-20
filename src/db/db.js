import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const APPROVED_AT_REST_APPROACH = "managed-encrypted-storage";

export const DB_AT_REST_SECURITY = {
  requiredForCurrentSchema: true,
  approach: "Require managed encrypted storage for the SQLite database, WAL/SHM sidecars, snapshots, and backups. This build does not provide SQLCipher file encryption; production must document the managed storage control before startup.",
  approvedApproach: APPROVED_AT_REST_APPROACH,
  requiredProductionEnv: [
    "DB_AT_REST_ENCRYPTION=managed-encrypted-storage",
    "STORAGE_ENCRYPTION_AT_REST=true",
    "STORAGE_ENCRYPTION_PROVIDER",
    "STORAGE_ENCRYPTION_EVIDENCE"
  ]
};

function envValue(env, name){
  return typeof env[name] === "string" ? env[name].trim() : "";
}

function isProduction(env = process.env){
  return env.NODE_ENV === "production";
}

export function validateAtRestEncryptionSettings(env = process.env){
  const issues = [];

  if(!isProduction(env)){
    return { ok: true, issues };
  }

  const approach = envValue(env, "DB_AT_REST_ENCRYPTION");
  if(approach !== APPROVED_AT_REST_APPROACH){
    issues.push({
      variable: "DB_AT_REST_ENCRYPTION",
      feature: "SQLite data-at-rest protection",
      message: `DB_AT_REST_ENCRYPTION must be set to ${APPROVED_AT_REST_APPROACH} in production. SQLCipher/field-level envelope encryption is not enabled in this build.`
    });
  }

  if(envValue(env, "STORAGE_ENCRYPTION_AT_REST").toLowerCase() !== "true"){
    issues.push({
      variable: "STORAGE_ENCRYPTION_AT_REST",
      feature: "managed encrypted storage attestation",
      message: "STORAGE_ENCRYPTION_AT_REST=true is required to attest that the database volume, SQLite sidecar files, snapshots, and backups are encrypted at rest."
    });
  }

  if(!envValue(env, "STORAGE_ENCRYPTION_PROVIDER")){
    issues.push({
      variable: "STORAGE_ENCRYPTION_PROVIDER",
      feature: "managed encrypted storage attestation",
      message: "Name the managed storage provider/control that encrypts the DATABASE_PATH volume and backups, for example an encrypted cloud block volume with encrypted snapshots."
    });
  }

  if(!envValue(env, "STORAGE_ENCRYPTION_EVIDENCE")){
    issues.push({
      variable: "STORAGE_ENCRYPTION_EVIDENCE",
      feature: "managed encrypted storage attestation",
      message: "Document the compliance evidence for the encrypted storage guarantee, such as a policy URL, control ID, ticket, or runbook section reviewed for this deployment."
    });
  }

  return { ok: issues.length === 0, issues };
}

function assertAtRestEncryptionConfiguration(env = process.env){
  const result = validateAtRestEncryptionSettings(env);
  if(!result.ok){
    const details = result.issues.map(issue => `${issue.variable}: ${issue.message}`).join("; ");
    throw new Error(`SQLite at-rest encryption validation failed: ${details}`);
  }
}

function isServerless(){
  return process.env.SERVERLESS === "true";
}

function assertWritableDirectory(dir, envName){
  if(!fs.existsSync(dir)){
    if(isServerless()){
      throw new Error(`${envName} parent directory does not exist: ${dir}. In serverless mode, mount a writable volume first and point DATABASE_PATH at a file inside it.`);
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  const stats = fs.statSync(dir);
  if(!stats.isDirectory()){
    throw new Error(`${envName} parent path is not a directory: ${dir}`);
  }

  try{
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
  }catch(e){
    throw new Error(`${envName} parent directory is not readable/writable: ${dir}. In serverless mode, DATABASE_PATH must point to a file inside a writable mounted volume.`);
  }
}

function resolveDatabasePath(){
  const configuredPath = (process.env.DATABASE_PATH || "").trim();

  // Serverless platforms frequently expose the deployed source tree as
  // read-only and may discard writes between invocations. Require an
  // explicit DATABASE_PATH so operators must point SQLite at a mounted,
  // writable, persistent volume such as /mnt/data/app.db.
  if(isServerless() && !configuredPath){
    throw new Error("SERVERLESS=true requires DATABASE_PATH to point to a SQLite file on a writable mounted volume, for example /mnt/data/app.db.");
  }

  if(isServerless() && !path.isAbsolute(configuredPath)){
    throw new Error("SERVERLESS=true requires DATABASE_PATH to be an absolute path inside a writable mounted volume, for example /mnt/data/app.db.");
  }

  return configuredPath || "./data/app.db";
}

function journalMode(){
  const configuredMode = (process.env.SQLITE_JOURNAL_MODE || "").trim();

  // WAL creates -wal and -shm sidecar files, which many serverless volume
  // implementations either do not support or do not persist reliably. Default
  // serverless deployments to DELETE unless explicitly overridden.
  return configuredMode || (isServerless() ? "DELETE" : "WAL");
}

export function openDb(){
  assertAtRestEncryptionConfiguration();
  const dbPath = resolveDatabasePath();
  const dir = path.dirname(dbPath);
  assertWritableDirectory(dir, "DATABASE_PATH");

  const db = new Database(dbPath);
  db.pragma(`journal_mode = ${journalMode()}`);
  db.pragma("foreign_keys = ON");
  return db;
}
