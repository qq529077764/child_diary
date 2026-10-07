const fs = require("fs");
const path = require("path");
const { DatabaseSync, backup } = require("node:sqlite");

const dataDir = process.env.DATA_DIR || "/app/data";
const sourcePath = process.env.DB_PATH || path.join(dataDir, "child-diary.sqlite");
const backupDir = path.join(dataDir, "backups");
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);

fs.mkdirSync(backupDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetPath = path.join(backupDir, `child-diary-${timestamp}.sqlite`);
const database = new DatabaseSync(sourcePath, { readOnly: true });

backup(database, targetPath)
  .then(() => {
    database.close();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(backupDir)) {
      if (!/^child-diary-.*\.sqlite$/.test(name)) continue;
      const filePath = path.join(backupDir, name);
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
    console.log(targetPath);
  })
  .catch(error => {
    try { database.close(); } catch {}
    console.error(error);
    process.exitCode = 1;
  });
