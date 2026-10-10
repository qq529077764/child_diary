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

const facts = [
  { id: "f1", slot: "what", label: "去公园", text: "我去了公园", quote: "我去了公园", active: true },
  { id: "f2", slot: "feeling", label: "心情", text: "我很开心", quote: "我很开心", active: true }
];
const sentence = {
  id: "sentence_1",
  text: "我去了公园，心里很开心。",
  factIds: ["f1", "f2"]
};

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

  const page = createPage();
  const restored = page.presentDiary({
    id: "diary_new",
    title: "公园日记",
    savedAt: 100,
    facts,
    sentences: [sentence]
  });
  assert.deepEqual(restored.sentences[0].factIds, ["f1", "f2"], "历史句子必须恢复事实来源");
  assert.equal(restored.sentences[0].sourceText, "我去了公园；我很开心", "孩子原话直接来自事实池");
  assert.equal(restored.sentences[0].factSummary, "我去了公园；我很开心", "对应事实不能由事件字段机械拼装");

  page.data.selectedDiary = restored;
  page.restoreDiaryForRevision();
  assert.equal(page.editingDiaryId, "diary_new", "恢复历史日记后应保留原编号");
  assert.deepEqual(page.facts.map(fact => fact.id), ["f1", "f2"], "恢复日记时应载入事实账本");

  let savedRecord;
  page.readDiaryHistory = () => [restored];
  page.loadDiaryHistory = () => [];
  page.ensureCloudSession = async () => "token";
  page.rawRequest = async (requestPath, method, record) => {
    if (requestPath === "/api/diaries" && method === "POST") savedRecord = record;
    return {};
  };
  page.refreshCloudHistory = async () => [];
  page.data.diaryTitle = restored.title;
  page.data.diarySentences = restored.sentences;
  page.transcript = "我去了公园，我很开心";
  await page.saveDiary();
  assert.equal(savedRecord.id, "diary_new", "修改历史日记后应更新原记录，不能新增一篇");
  assert.deepEqual(savedRecord.facts.map(fact => fact.id), ["f1", "f2"], "保存日记时必须连同事实账本一起保存");
  assert.equal("story" in savedRecord, false, "新版不再保存旧语义事件账本");

  const revisionPage = createPage();
  revisionPage.data.phase = "revise";
  revisionPage.data.diaryTitle = "公园日记";
  revisionPage.data.diarySentences = [sentence];
  revisionPage.facts = structuredClone(facts);
  revisionPage.revisionTranscript = "不是开心，是特别开心";
  revisionPage.revisionBaseSnapshot = {
    title: "公园日记",
    sentences: structuredClone([sentence]),
    facts: structuredClone(facts)
  };
  let revisionRequest;
  revisionPage.request = async (requestPath, data) => {
    assert.equal(requestPath, "/api/revise");
    revisionRequest = data;
    const revisedFacts = structuredClone(facts);
    revisedFacts.find(fact => fact.id === "f2").text = "我特别开心";
    revisedFacts.find(fact => fact.id === "f2").quote = "不是开心，是特别开心";
    return {
      changed: true,
      title: "公园日记",
      facts: revisedFacts,
      sentences: [{ ...sentence, text: "我去了公园，心里特别开心。" }]
    };
  };
  await revisionPage.finishRevision();
  assert.deepEqual(revisionRequest.sentences[0].factIds, ["f1", "f2"], "修改请求必须提交事实编号");
  assert.deepEqual(revisionRequest.facts.map(fact => fact.id), ["f1", "f2"], "修改请求必须提交当前事实账本");
  assert.equal(revisionPage.data.diarySentences[0].text, "我去了公园，心里特别开心。", "服务器成功后客户端才应用新正文");
  assert.equal(revisionPage.data.diarySentences[0].sourceText, "我去了公园；不是开心，是特别开心", "修改后原话证据来自更新后的事实");

  const unchangedPage = createPage();
  unchangedPage.data.phase = "revise";
  unchangedPage.data.diaryTitle = "公园日记";
  unchangedPage.data.diarySentences = [sentence];
  unchangedPage.facts = structuredClone(facts);
  unchangedPage.revisionTranscript = "嗯我想一下";
  unchangedPage.request = async () => ({ changed: false, message: "还没有听到明确修改" });
  modals.length = 0;
  await unchangedPage.finishRevision();
  assert.equal(modals.at(-1).title, "还没有修改", "没有明确事实操作时必须保留原文");
  assert.equal(unchangedPage.data.diarySentences[0].text, sentence.text, "无修改不能改变当前正文");

  const legacyPage = createPage();
  legacyPage.data.phase = "revise";
  legacyPage.data.diarySentences = [{ id: "old_sentence", text: "旧日记。", factIds: [] }];
  legacyPage.revisionTranscript = "把旧日记改一下";
  let legacyRequestCount = 0;
  legacyPage.request = async () => { legacyRequestCount += 1; };
  modals.length = 0;
  await legacyPage.finishRevision();
  assert.equal(legacyRequestCount, 0, "没有事实来源的旧日记不得猜测修改");
  assert.equal(modals.at(-1).title, "旧日记暂不修改", "旧日记必须明确保留");

  console.log("miniapp fact revision regression: ok");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
