const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "child-diary-privacy-"));
const dbPath = path.join(dataDir, "test.sqlite");
const port = 5300 + (process.pid % 400);
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    DB_PATH: dbPath,
    ALLOW_DEVICE_AUTH: "true",
    WECHAT_APP_ID: "",
    WECHAT_APP_SECRET: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk.toString(); });

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`test server did not start: ${stderr}`);
}

async function run() {
  await waitForServer();
  const auth = await request("/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ installationId: "privacy-regression-device" })
  });
  assert.equal(auth.status, 200);
  assert.ok(auth.body.token);
  const headers = { authorization: `Bearer ${auth.body.token}` };

  const beforeConsent = await request("/api/diaries", { headers });
  assert.equal(beforeConsent.status, 403);
  assert.equal(beforeConsent.body.error, "guardian_consent_required");

  const consent = await request("/api/guardian-consent", {
    method: "POST",
    headers,
    body: JSON.stringify({ policyVersion: "2026-10-09-v1" })
  });
  assert.equal(consent.status, 200);
  assert.equal(consent.body.consented, true);

  const diary = {
    id: "diary_privacy_test",
    title: "测试日记",
    sentences: [{ id: "s1", text: "今天我去了公园。", factIds: ["f1"], factTexts: ["去了公园"] }],
    transcript: "今天我去了公园",
    facts: [{ id: "f1", text: "去了公园", active: true }],
    savedAt: Date.now()
  };
  const created = await request("/api/diaries", {
    method: "POST",
    headers,
    body: JSON.stringify(diary)
  });
  assert.equal(created.status, 201);

  const removed = await request(`/api/diaries/${diary.id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM diaries WHERE id = ?").get(diary.id).count, 0);
  database.close();

  const recreated = await request("/api/diaries", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...diary, id: "diary_account_delete" })
  });
  assert.equal(recreated.status, 201);
  const accountDeleted = await request("/api/account", { method: "DELETE", headers });
  assert.equal(accountDeleted.status, 200);

  const afterAccountDelete = await request("/api/diaries", { headers });
  assert.equal(afterAccountDelete.status, 401);
  const finalDatabase = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(finalDatabase.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(finalDatabase.prepare("SELECT COUNT(*) AS count FROM diaries").get().count, 0);
  assert.equal(finalDatabase.prepare("SELECT COUNT(*) AS count FROM guardian_consents").get().count, 0);
  finalDatabase.close();

  console.log("privacy and storage regression: ok");
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill("SIGTERM");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
