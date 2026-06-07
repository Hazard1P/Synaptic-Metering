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

export function openDb(){
  assertAtRestEncryptionConfiguration();
  const dbPath = process.env.DATABASE_PATH || "./data/app.db";
  const dir = path.dirname(dbPath);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
