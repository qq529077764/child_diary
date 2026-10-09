const assert = require("node:assert/strict");

let pageDefinition;
const storage = new Map();
const modals = [];
let loginCalls = 0;
let privacyHandler;

global.Page = definition => { pageDefinition = definition; };
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  showModal: options => { modals.push(options); },
  login: () => { loginCalls += 1; },
  onNeedPrivacyAuthorization: handler => { privacyHandler = handler; },
  offNeedPrivacyAuthorization: () => { privacyHandler = undefined; },
  getRecorderManager: () => ({ onStart() {}, onStop() {}, onError() {}, stop() {} })
};

require("../wechat-miniapp/pages/index/index.js");

function createPage(overrides = {}) {
  const page = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    setData(update) { Object.assign(this.data, update); },
    recorder: { stop() {} },
    ...overrides
  };
  page.resetRuntime();
  return page;
}

function storyModel() {
  return {
    schemaVersion: 2,
    titleHint: "公园日记",
    spans: [{ id: "span_1", text: "我去了公园，我很开心", role: "child_story", accepted: true, reason: "" }],
    scenes: [{ id: "scene_park", label: "公园", order: 0, sourceSpanIds: ["span_1"] }],
    events: [
      { id: "event_park", sceneId: "scene_park", subject: "我", action: "去", object: "公园", time: "", location: "", manner: "", result: "", feeling: "", polarity: "positive", certainty: "certain", details: [], childExpressions: [], sourceSpanIds: ["span_1"], status: "active", confidence: 0.98 },
      { id: "event_feeling", sceneId: "scene_park", subject: "我", action: "感到", object: "", time: "", location: "", manner: "", result: "", feeling: "开心", polarity: "positive", certainty: "certain", details: [], childExpressions: [], sourceSpanIds: ["span_1"], status: "active", confidence: 0.97 }
    ],
    relations: []
  };
}

async function run() {
  const privacyPage = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    setData(update) { Object.assign(this.data, update); }
  };
  privacyPage.onLoad();
  assert.equal(loginCalls, 0, "没有监护人同意时，启动小程序不能调用微信登录");
  await privacyPage.startStory();
  assert.equal(privacyPage.data.showGuardianConsent, true, "首次开始录音前必须显示监护人确认");
  assert.equal(typeof privacyHandler, "function", "小程序应接入微信隐私授权回调");
  privacyPage.onUnload();

  const story = storyModel();
  const sentence = {
    id: "sentence_1",
    sceneId: "scene_park",
    text: "我去了公园，心里很开心。",
    eventIds: ["event_park", "event_feeling"],
    sourceSpanIds: ["span_1"]
  };
  const page = createPage();
  const restored = page.presentDiary({
    id: "diary_new",
    title: "公园日记",
    savedAt: 100,
    story,
    facts: [],
    sentences: [sentence]
  });
  assert.equal(restored.story.schemaVersion, 2, "历史日记必须恢复语义事件账本");
  assert.deepEqual(restored.sentences[0].eventIds, ["event_park", "event_feeling"], "历史句子必须恢复事件来源");

  page.data.selectedDiary = restored;
  page.restoreDiaryForRevision();
  assert.equal(page.editingDiaryId, "diary_new", "恢复历史日记后应保留原编号");
  assert.equal(page.storyModel.schemaVersion, 2, "恢复日记时应载入事件账本");

  let savedRecord;
  page.readDiaryHistory = () => [restored];
  page.loadDiaryHistory = () => [];
  page.ensureCloudSession = async () => "token";
  page.rawRequest = async (path, method, record) => { if (path === "/api/diaries" && method === "POST") savedRecord = record; return {}; };
  page.refreshCloudHistory = async () => [];
  page.data.diaryTitle = restored.title;
  page.data.diarySentences = restored.sentences;
  page.transcript = "我去了公园，我很开心";
  await page.saveDiary();
  assert.equal(savedRecord.id, "diary_new", "修改历史日记后应更新原记录，不能新增一篇");
  assert.equal(savedRecord.story.schemaVersion, 2, "保存日记时必须连同事件账本一起保存");

  const revisionPage = createPage();
  revisionPage.data.phase = "revise";
  revisionPage.data.diaryTitle = "公园日记";
  revisionPage.data.diarySentences = [sentence];
  revisionPage.storyModel = structuredClone(story);
  revisionPage.revisionTranscript = "不是开心，是特别开心";
  revisionPage.revisionBaseSnapshot = {
    title: "公园日记",
    sentences: structuredClone([sentence]),
    facts: [],
    story: structuredClone(story)
  };
  let revisionRequest;
  revisionPage.request = async (path, data) => {
    assert.equal(path, "/api/revise");
    revisionRequest = data;
    const revisedStory = structuredClone(story);
    revisedStory.events.find(event => event.id === "event_feeling").feeling = "特别开心";
    return {
      changed: true,
      title: "公园日记",
      story: revisedStory,
      sentences: [{ ...sentence, text: "我去了公园，心里特别开心。" }]
    };
  };
  await revisionPage.finishRevision();
  assert.equal(revisionRequest.story.schemaVersion, 2, "修改请求必须提交当前事件账本");
  assert.deepEqual(revisionRequest.sentences[0].eventIds, ["event_park", "event_feeling"], "修改请求使用事件编号而不是事实原句");
  assert.equal(revisionPage.data.diarySentences[0].text, "我去了公园，心里特别开心。", "服务器事务成功后客户端才应用新正文");
  assert.equal(revisionPage.storyModel.events.find(event => event.id === "event_feeling").feeling, "特别开心", "客户端必须整体接收新事件版本");

  const unchangedPage = createPage();
  unchangedPage.data.phase = "revise";
  unchangedPage.data.diaryTitle = "公园日记";
  unchangedPage.data.diarySentences = [sentence];
  unchangedPage.storyModel = structuredClone(story);
  unchangedPage.revisionTranscript = "嗯我想一下";
  unchangedPage.request = async () => ({ changed: false, message: "还没有听到明确修改" });
  modals.length = 0;
  await unchangedPage.finishRevision();
  assert.equal(modals.at(-1).title, "还没有修改", "没有语义补丁时必须保留原文");
  assert.equal(unchangedPage.data.diarySentences[0].text, sentence.text, "无修改不能改变当前正文");

  const legacyPage = createPage();
  legacyPage.data.phase = "revise";
  legacyPage.data.diarySentences = [{ id: "old_sentence", text: "旧日记。" }];
  legacyPage.revisionTranscript = "把旧日记改一下";
  let legacyRequestCount = 0;
  legacyPage.request = async () => { legacyRequestCount += 1; };
  modals.length = 0;
  await legacyPage.finishRevision();
  assert.equal(legacyRequestCount, 0, "没有事件账本的旧日记不得偷偷调用旧修改流程");
  assert.equal(modals.at(-1).title, "旧日记暂不修改", "旧日记必须明确保留而不是降级到旧逻辑");

  console.log("miniapp semantic revision regression: ok");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
