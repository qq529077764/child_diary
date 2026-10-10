const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "child-diary-fact-api-"));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function lastPayload(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(messages[index].content); } catch {}
  }
  return {};
}

function payloadWith(messages, key) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(messages[index].content);
      if (value && Object.prototype.hasOwnProperty.call(value, key)) return value;
    } catch {}
  }
  return {};
}

function fakeModelResponse(messages) {
  const joined = messages.map(message => message.content).join("\n");
  const payload = lastPayload(messages);
  if (joined.includes('"current_text"')) {
    if (payload.recent_text === "然后呢，然后呢。") {
      return {
        facts: [],
        decision: { action: "keep_listening", reason: "non_story_audio", question: "", target_key: "", question_status: "none" },
        speech_quality: "coherent",
        segment_role: "adult_guidance"
      };
    }
    if (payload.recent_text?.includes("我今天起床了，然后呢")) {
      return {
        facts: [
          { slot: "what", label: "起床", text: "我今天起床了", quote: "我今天起床了，然后呢", source_role: "child_story", story_relation: "main" },
          { slot: "what", label: "穿衣服", text: "我穿好了衣服", quote: "然后呢，我穿好了衣服", source_role: "child_story", story_relation: "main" },
          { slot: "what", label: "带书包", text: "我带好了书包", quote: "带好了书包，然后呢", source_role: "child_story", story_relation: "main" },
          { slot: "what", label: "沙池运动", text: "我去了沙池运动", quote: "然后呢就去了沙池运动", source_role: "child_story", story_relation: "main" },
          { slot: "what", label: "看书", text: "我去了看书", quote: "我去了看书，然后呢", source_role: "child_story", story_relation: "main" }
        ],
        decision: { action: "ask_followup", reason: "missing_feeling", question: "去沙池运动时，你是什么感觉呀？", target_key: "去沙池运动", question_status: "none" },
        speech_quality: "coherent",
        segment_role: "adult_guidance"
      };
    }
    return {
      facts: [{ slot: "what", label: "去公园", text: "我和妈妈去了公园", quote: "我和妈妈去了公园", source_role: "child_story", story_relation: "main" }],
      decision: { action: "ask_followup", reason: "missing_result", question: "到了那里以后，你做了什么呀？", target_key: "我和妈妈去了公园", question_status: "none" },
      speech_quality: "coherent",
      segment_role: "child_story"
    };
  }
  if (joined.includes("整理成可直接用于成文")) {
    return {
      finalFacts: (payloadWith(messages, "knownFacts").knownFacts || []).map(fact => ({
        sourceFactIds: [fact.id], slot: fact.slot, label: "已确认事实", text: fact.text
      }))
    };
  }
  if (joined.includes("原子化的事实变更计划")) {
    return {
      changes: [{
        mode: "replace",
        targetFactIds: ["f2"],
        facts: [{ eventKey: "喂鸟", slot: "what", label: "喂小鸟", text: "我喂了好多好多小小的鸟" }]
      }]
    };
  }
  if (joined.includes("把candidateChanges复核成最终可执行的changes")) {
    return {
      changes: [{
        mode: "replace",
        targetFactIds: ["f2"],
        facts: [{ eventKey: "喂鸟", slot: "what", label: "喂小鸟", text: "我喂了好多好多小小的鸟" }]
      }]
    };
  }
  if (joined.includes("分别为每个operation写局部替换句")) {
    return {
      operations: [{
        key: "operation_1",
        sentences: [{ text: "我和妈妈去了公园，那里有好多好多小小的鸟，我还喂了它们。", factKeys: ["kept_1_1", "new_1_1"] }]
      }]
    };
  }
  if (joined.includes("把finalFacts组织")) {
    const ids = (payloadWith(messages, "finalFacts").finalFacts || []).map(fact => fact.id);
    return {
      title: "公园日记",
      sentences: [{ text: "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。", factIds: ids }]
    };
  }
  if (joined.includes("修复draft中的指定问题")) return payload.draft;
  return {};
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
  throw new Error("fact API did not start");
}

async function run() {
  let malformedCompositionInjected = false;
  const fakeModel = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      const joined = (request.messages || []).map(message => message.content).join("\n");
      const shouldInjectMalformed = !malformedCompositionInjected
        && joined.includes("把finalFacts组织")
        && !joined.includes("compact_json_retry");
      if (shouldInjectMalformed) malformedCompositionInjected = true;
      const content = shouldInjectMalformed ? '{"title":"截断测试","sentences":[' : JSON.stringify(fakeModelResponse(request.messages || []));
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
  const request = async (pathname, method = "GET", data, token) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(data ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    return { response, body: await response.json() };
  };
  try {
    await waitForServer(baseUrl, api);
    const health = await request("/health");
    assert.equal(health.body.factDiarySchema, 1);
    const session = await request("/api/auth/session", "POST", { installationId: "fact-api-test-user" });
    const token = session.body.token;
    await request("/api/guardian-consent", "POST", { policyVersion: "test-2026-10-10" }, token);
    const transcript = "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。";
    const facts = [
      { id: "f1", slot: "what", label: "去公园", text: "我和妈妈去了公园", quote: "我和妈妈去了公园", active: true },
      { id: "f2", slot: "what", label: "喂鸽子", text: "我喂了好多好多鸽子", quote: "好多好多鸽子，我还喂了它们", active: true }
    ];
    const realtime = await request("/api/analyze", "POST", { text: transcript, recentText: transcript, existingFacts: [], previousQuestions: [], previousQuestionKeys: [] }, token);
    assert.equal(realtime.response.status, 200, JSON.stringify(realtime.body));
    const repeatedThen = "我今天起床了，然后呢，我穿好了衣服，带好了书包，然后呢就去了沙池运动，我去了看书，然后呢。";
    const repeatedThenResult = await request("/api/analyze", "POST", {
      text: repeatedThen, recentText: repeatedThen, existingFacts: [], previousQuestions: [], previousQuestionKeys: []
    }, token);
    assert.equal(repeatedThenResult.response.status, 200, JSON.stringify(repeatedThenResult.body));
    assert.deepEqual(repeatedThenResult.body.facts.map(fact => fact.text), ["我今天起床了", "我穿好了衣服", "我带好了书包", "我去了沙池运动", "我去了看书"]);
    const guidanceOnly = await request("/api/analyze", "POST", {
      text: "然后呢，然后呢。", recentText: "然后呢，然后呢。", existingFacts: [], previousQuestions: [], previousQuestionKeys: []
    }, token);
    assert.equal(guidanceOnly.response.status, 200, JSON.stringify(guidanceOnly.body));
    assert.deepEqual(guidanceOnly.body.facts, []);
    const draft = await request("/api/finalize", "POST", { transcript, facts }, token);
    assert.equal(draft.response.status, 200, JSON.stringify(draft.body));
    assert.match(processOutput, /Qwen stage retry/, "模型首次返回截断JSON时必须自动重试");
    assert.deepEqual(draft.body.sentences[0].factIds, ["f1", "f2"]);
    assert.equal(draft.body.sentences[0].sourceText.includes("我和妈妈去了公园"), true);
    assert.equal(Array.isArray(draft.body.facts), true);
    assert.equal("story" in draft.body, false);
    const saved = await request("/api/diaries", "POST", {
      id: "fact_api_test", title: draft.body.title, sentences: draft.body.sentences,
      transcript, facts: draft.body.facts, savedAt: Date.now()
    }, token);
    assert.equal(saved.response.status, 201);
    assert.equal("story" in saved.body.diary, false);
    const revised = await request("/api/revise", "POST", {
      instruction: "不是鸽子，是小小的鸟",
      title: draft.body.title,
      sentences: draft.body.sentences.map((sentence, index) => ({ ...sentence, id: index ? sentence.id : "s1" })),
      facts: draft.body.facts
    }, token);
    assert.equal(revised.body.changed, true, JSON.stringify(revised.body));
    assert.match(revised.body.sentences[0].text, /小小的/);
    assert.equal(revised.body.facts.find(fact => fact.id === "f2").text, "我喂了好多好多小小的鸟");
    const legacy = await request("/api/compose", "POST", {}, token);
    assert.equal(legacy.response.status, 410);
    console.log("fact API integration: ok");
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
