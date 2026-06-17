import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const DB_AT_REST_SECURITY = {
  requiredForCurrentSchema: false,
  approach: "Use host/volume encryption for this SQLite file; do not add account secrets, OAuth tokens, or raw API keys unless SQLCipher or field-level envelope encryption is integrated first."
};

function assertAtRestEncryptionConfiguration(){
  if(process.env.DB_ENCRYPTION_REQUIRED === "true"){
    throw new Error("DB_ENCRYPTION_REQUIRED=true is not supported by this first-pass SQLite build; integrate SQLCipher or field-level envelope encryption before storing sensitive account/OAuth fields.");
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
