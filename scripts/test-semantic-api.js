const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "child-diary-semantic-api-"));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function fakeModelResponse(messages) {
  const joined = messages.map(message => message.content).join("\n");
  const story = {
    title: "公园日记",
    events: [
      { id: "e1", subject: "我和妈妈", action: "去", object: "公园", sourceSpanIds: ["span_1"] },
      { id: "e2", subject: "我", action: "喂", object: "鸽子", expressions: ["好多好多"], sourceSpanIds: ["span_1"] }
    ],
    sentences: [{ text: "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。", eventIds: ["e1", "e2"] }],
    corrections: []
  };
  if (joined.includes("独立的儿童日记修改补丁审计员")) return { hardErrors: [], verdict: "pass" };
  if (joined.includes("revisionSpan")) {
    const revisionSpanId = JSON.parse(messages.at(-1).content).revisionSpan.id;
    return { intent: "correct", operations: [{ type: "update_event", eventId: "event_2", changes: { object: "小鸟", childExpressions: { add: [{ text: "小小的", bindTo: "object", policy: "preserve" }], removeTexts: [] } }, sourceSpanIds: [revisionSpanId] }] };
  }
  if (joined.includes('"current_text"')) {
    return {
      facts: [{ slot: "what", label: "去公园", text: "我和妈妈去了公园", quote: "我和妈妈去了公园", source_role: "child_story", story_relation: "main" }],
      decision: { action: "ask_followup", reason: "missing_result", question: "到了公园以后，你做了什么呀？", target_key: "我和妈妈去了公园", question_status: "none" },
      speech_quality: "coherent",
      segment_role: "child_story"
    };
  }
  if (joined.includes("独立的儿童口述来源审计员")) return { hardErrors: [], verdict: "pass" };
  if (joined.includes("sourceSpans")) return story;
  if (joined.includes("独立的儿童日记语义审计员")) return { hardErrors: [], softIssues: [], verdict: "pass" };
  const revised = joined.includes("小小的");
  return {
    title: "公园日记",
    scenes: [{
      sceneId: "scene_main",
      sentences: [{
        text: revised
          ? "我和妈妈去了公园，那里有好多好多小小的鸟，我还喂了它们。"
          : "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。",
        eventIds: ["event_1", "event_2"]
      }]
    }]
  };
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API process exited early: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("semantic API did not start");
}

async function run() {
  let malformedExtractionInjected = false;
  const fakeModel = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      const joined = (request.messages || []).map(message => message.content).join("\n");
      const shouldInjectMalformed = !malformedExtractionInjected
        && joined.includes("sourceSpans")
        && !joined.includes("compact_json_retry");
      if (shouldInjectMalformed) malformedExtractionInjected = true;
      const content = shouldInjectMalformed
        ? '{"titleHint":"截断测试","spans":['
        : JSON.stringify(fakeModelResponse(request.messages || []));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  const modelPort = await listen(fakeModel);
  const portProbe = http.createServer();
  const apiPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const api = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      ALLOW_DEVICE_AUTH: "true",
      QWEN_API_KEY: "test-key",
      QWEN_MODEL: "test-model",
      QWEN_BASE_URL: `http://127.0.0.1:${modelPort}`,
      TENCENT_SECRET_ID: "",
      TENCENT_SECRET_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let processOutput = "";
  api.stdout.on("data", chunk => { processOutput += chunk; });
  api.stderr.on("data", chunk => { processOutput += chunk; });
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const request = async (pathName, method = "GET", data, token) => {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: { ...(data ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    const body = await response.json();
    return { response, body };
  };
  try {
    await waitForServer(baseUrl, api);
    const health = await request("/health");
    assert.equal(health.body.semanticStorySchema, 2);
    assert.equal(health.body.legacyCompose, false);
    const session = await request("/api/auth/session", "POST", { installationId: "semantic-api-test-user" });
    const token = session.body.token;
    assert.ok(token);
    await request("/api/guardian-consent", "POST", { policyVersion: "test-2026-10-09" }, token);
    const transcript = "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。";
    const realtime = await request("/api/analyze", "POST", { text: transcript, recentText: transcript, existingFacts: [], previousQuestions: [], previousQuestionKeys: [] }, token);
    assert.equal(realtime.response.status, 200, JSON.stringify(realtime.body));
    assert.equal(realtime.body.facts[0].text, "我和妈妈去了公园");
    const draft = await request("/api/finalize", "POST", { transcript, facts: [] }, token);
    assert.equal(draft.response.status, 200, JSON.stringify(draft.body));
    assert.match(processOutput, /Qwen stage retry/, "模型首次返回截断JSON时必须用紧凑模式自动重试");
    assert.equal(draft.body.story.schemaVersion, 2);
    assert.equal(draft.body.story.spans[0].text, transcript, "模型只回传片段分类，服务端必须恢复原始来源文本");
    assert.deepEqual(draft.body.sentences[0].eventIds, ["event_1", "event_2"]);
    const saved = await request("/api/diaries", "POST", {
      id: "semantic_api_test", title: draft.body.title, sentences: draft.body.sentences,
      story: draft.body.story, transcript, facts: [], savedAt: Date.now()
    }, token);
    assert.equal(saved.body.diary.story.schemaVersion, 2);
    const revised = await request("/api/revise", "POST", {
      instruction: "不是鸽子，是小小的鸟",
      title: draft.body.title,
      sentences: draft.body.sentences,
      story: draft.body.story
    }, token);
    assert.equal(revised.body.changed, true);
    assert.match(revised.body.sentences[0].text, /小小的/);
    const legacy = await request("/api/compose", "POST", {}, token);
    assert.equal(legacy.response.status, 410);
    await request("/api/diaries/semantic_api_test", "DELETE", undefined, token);
    console.log("semantic API integration: ok");
  } catch (error) {
    error.message += `\nAPI output:\n${processOutput}`;
    throw error;
  } finally {
    api.kill("SIGTERM");
    await new Promise(resolve => fakeModel.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
