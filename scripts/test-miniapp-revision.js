const assert = require("node:assert/strict");

let pageDefinition;
const storage = new Map();
const modals = [];

global.Page = definition => { pageDefinition = definition; };
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  showModal: options => { modals.push(options); },
  getRecorderManager: () => ({ stop() {} })
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

async function run() {
  const facts = [
    { id: "f1", text: "去了公园", slot: "what", active: true },
    { id: "f2", text: "很开心", slot: "feeling", active: true }
  ];
  const page = createPage();
  const restored = page.presentDiary({
    id: "diary_old",
    title: "公园日记",
    savedAt: 100,
    facts,
    sentences: [{ id: "s1", text: "我去了公园。", factTexts: ["去了公园"] }]
  });
  assert.deepEqual(restored.sentences[0].factIds, ["f1"], "历史日记应补全事实关联");

  page.data.selectedDiary = restored;
  page.restoreDiaryForRevision();
  assert.equal(page.editingDiaryId, "diary_old", "恢复历史日记后应保留原编号");
  assert.equal(page.editingDiarySavedAt, 100, "恢复历史日记后应保留原保存时间");

  let savedRecord;
  page.readDiaryHistory = () => [restored];
  page.loadDiaryHistory = () => [];
  page.ensureCloudSession = async () => "token";
  page.rawRequest = async (path, method, record) => { if (path === "/api/diaries" && method === "POST") savedRecord = record; return {}; };
  page.refreshCloudHistory = async () => [];
  page.data.diaryTitle = restored.title;
  page.data.diarySentences = restored.sentences;
  page.transcript = "我去了公园";
  page.facts = structuredClone(facts);
  await page.saveDiary();
  assert.equal(savedRecord.id, "diary_old", "修改历史日记后应更新原记录，不能新增一篇");
  assert.equal(page.data.phase, "success", "本地保存后应立即进入成功页");

  const revisionPage = createPage();
  revisionPage.data.phase = "revise";
  revisionPage.data.diaryTitle = "公园日记";
  revisionPage.data.diarySentences = [
    { id: "s1", text: "我去了公园。", factIds: ["f1"], factTexts: ["去了公园"] },
    { id: "s2", text: "我很开心。", factIds: ["f2"], factTexts: ["很开心"] }
  ];
  revisionPage.facts = structuredClone(facts);
  revisionPage.revisionTranscript = "不是很开心，是特别开心";
  revisionPage.revisionBaseSnapshot = {
    title: revisionPage.data.diaryTitle,
    sentences: structuredClone(revisionPage.data.diarySentences),
    facts: structuredClone(revisionPage.facts)
  };
  revisionPage.request = async path => {
    assert.equal(path, "/api/revise");
    return { operations: [{ type: "replace", target_fact_id: "f2", new_text: "特别开心", slot: "feeling" }] };
  };
  let composeOptions;
  revisionPage.composeDiary = async options => { composeOptions = options; };
  await revisionPage.finishRevision();
  assert.equal(revisionPage.facts.find(fact => fact.id === "f2").text, "特别开心", "明确替换应更新目标事实");
  assert.equal(composeOptions.lockedDiary[0].text, "我去了公园。", "未涉及句子必须锁定");
  assert.equal(composeOptions.revisionOperations[0].old_text, "很开心", "局部成文必须知道被替换的旧事实");

  const unclearPage = createPage();
  unclearPage.data.phase = "revise";
  unclearPage.data.diarySentences = restored.sentences;
  unclearPage.facts = structuredClone(facts);
  unclearPage.revisionTranscript = "嗯我想一下";
  unclearPage.request = async () => ({ operations: [], message: "请说清楚要改哪里" });
  modals.length = 0;
  await unclearPage.finishRevision();
  assert.equal(modals.at(-1).title, "还没有修改", "无明确操作时不能误报已恢复版本");

  console.log("miniapp revision regression: ok");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
