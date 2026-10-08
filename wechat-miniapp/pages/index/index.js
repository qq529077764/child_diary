const { API_BASE_URL } = require("../../utils/config");

const SEGMENT_MS = 6200;
const DIARY_HISTORY_KEY = "diaryHistory";
const LATEST_DIARY_KEY = "latestDiary";
const CLOUD_TOKEN_KEY = "cloudSessionToken";
const INSTALLATION_ID_KEY = "installationId";
const PENDING_REVISION_KEY = "pendingDiaryRevision";

Page({
  data: {
    phase: "home",
    isRecording: false,
    isFinishing: false,
    statusTitle: "正在听你说",
    statusHint: "一直说就好，小耳朵会边听边问。",
    latestText: "",
    bubbles: [],
    factChips: [],
    diaryTitle: "",
    diarySentences: [],
    diaryHistory: [],
    selectedDiary: null,
    revisionDisplay: "",
    transcriptAnchorId: "transcript_end_0",
    feedAnchorId: "feed_end_0"
  },

  onLoad() {
    this.recorder = wx.getRecorderManager();
    this.recorder.onStart(() => {
      this.segmentActive = true;
      this.setData({
        isRecording: true,
        statusTitle: this.segmentKind === "revision" ? "正在听你修改" : "正在听你说",
        statusHint: this.segmentKind === "revision" ? "请把要修改的话完整说出来。" : "看到问题后直接继续说，不用点按钮。"
      });
    });
    this.recorder.onStop(result => this.handleSegmentStop(result));
    this.recorder.onError(error => this.handleRecorderError(error));
    this.resetRuntime();
    this.loadDiaryHistory();
    this.cloudToken = wx.getStorageSync(CLOUD_TOKEN_KEY) || "";
    this.authError = null;
    this.authPromise = this.initializeCloudDiary().catch(error => {
      this.authError = error;
      return null;
    });
  },

  onUnload() {
    clearTimeout(this.segmentTimer);
    this.keepRecording = false;
    try { this.recorder.stop(); } catch (error) {}
  },

  resetRuntime() {
    clearTimeout(this.segmentTimer);
    this.keepRecording = false;
    this.segmentKind = "story";
    this.transcript = "";
    this.revisionTranscript = "";
    this.facts = [];
    this.utterances = [];
    this.questions = [];
    this.questionKeys = [];
    this.currentQuestion = null;
    this.questionTranscriptLength = 0;
    this.followupCount = 0;
    this.uploads = [];
    this.finalizeStarted = false;
    this.segmentActive = false;
    this.analysisRunning = false;
    this.analysisPending = false;
    this.analysisPromise = null;
    this.latestSegmentText = "";
    this.firstDiarySnapshot = null;
    this.revisionBaseSnapshot = null;
    this.transcriptAnchorSequence = 0;
    this.feedAnchorSequence = 0;
    this.setData({ isRecording: false, isFinishing: false, bubbles: [], factChips: [], latestText: "", revisionDisplay: "", transcriptAnchorId: "transcript_end_0", feedAnchorId: "feed_end_0" });
  },

  readDiaryHistory() {
    try {
      const stored = wx.getStorageSync(DIARY_HISTORY_KEY);
      if (Array.isArray(stored)) return stored;
      const latest = wx.getStorageSync(LATEST_DIARY_KEY);
      if (latest && latest.title && Array.isArray(latest.sentences)) {
        const migrated = [{ ...latest, id: latest.id || `legacy_${latest.savedAt || Date.now()}` }];
        wx.setStorageSync(DIARY_HISTORY_KEY, migrated);
        return migrated;
      }
    } catch (error) {}
    return [];
  },

  formatSavedTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  presentDiary(record, index = 0) {
    const savedAt = Number(record.savedAt) || Date.now();
    const sentences = (record.sentences || []).map((sentence, sentenceIndex) => {
      if (typeof sentence === "string") {
        return { id: `stored_${savedAt}_${sentenceIndex}`, text: sentence, sourceText: "" };
      }
      return { ...sentence, id: sentence.id || `stored_${savedAt}_${sentenceIndex}` };
    });
    return {
      ...record,
      id: record.id || `diary_${savedAt}_${index}`,
      title: record.title || "我的日记",
      savedAt,
      savedLabel: this.formatSavedTime(savedAt),
      sentences,
      preview: sentences.map(sentence => sentence.text).join("").slice(0, 54)
    };
  },

  loadDiaryHistory() {
    const diaryHistory = this.readDiaryHistory()
      .map((record, index) => this.presentDiary(record, index))
      .sort((left, right) => right.savedAt - left.savedAt);
    this.setData({ diaryHistory });
    return diaryHistory;
  },

  installationId() {
    let id = wx.getStorageSync(INSTALLATION_ID_KEY);
    if (!id) {
      id = `wx_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      wx.setStorageSync(INSTALLATION_ID_KEY, id);
    }
    return id;
  },

  wechatLoginCode() {
    return new Promise((resolve, reject) => wx.login({
      success: result => result.code ? resolve(result.code) : reject(new Error("微信登录没有返回 code")),
      fail: error => reject(new Error(error.errMsg || "微信登录失败"))
    }));
  },

  rawRequest(path, method = "GET", data = {}, includeAuth = true) {
    return new Promise((resolve, reject) => wx.request({
      url: `${API_BASE_URL}${path}`,
      method,
      data,
      header: {
        "content-type": "application/json",
        ...(includeAuth && this.cloudToken ? { Authorization: `Bearer ${this.cloudToken}` } : {})
      },
      success: response => response.statusCode >= 200 && response.statusCode < 300
        ? resolve(response.data)
        : (() => {
          const error = new Error(response.data?.message || response.data?.error || `请求失败 ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
        })(),
      fail: error => reject(new Error(error.errMsg || "网络请求失败"))
    }));
  },

  async initializeCloudDiary() {
    const code = await this.wechatLoginCode();
    const payload = { code, installationId: this.installationId() };
    let auth;
    try {
      auth = await this.rawRequest("/api/auth/session", "POST", payload, true);
    } catch (error) {
      if (error.statusCode !== 401 || !this.cloudToken) throw error;
      this.cloudToken = "";
      wx.removeStorageSync(CLOUD_TOKEN_KEY);
      auth = await this.rawRequest("/api/auth/session", "POST", payload, false);
    }
    if (!auth.token) throw new Error("服务器未返回登录信息");
    this.cloudToken = auth.token;
    this.authError = null;
    wx.setStorageSync(CLOUD_TOKEN_KEY, auth.token);
    const localHistory = this.readDiaryHistory();
    for (const record of localHistory) {
      try { await this.rawRequest("/api/diaries", "POST", record); } catch (error) {}
    }
    return this.refreshCloudHistory();
  },

  async ensureCloudSession() {
    if (this.cloudToken) return this.cloudToken;
    if (!this.authPromise) this.authPromise = this.initializeCloudDiary().catch(error => { throw error; });
    await this.authPromise;
    if (!this.cloudToken) {
      const error = this.authError;
      this.authPromise = null;
      this.authError = null;
      throw new Error(error?.message || "还没有连接到日记服务器");
    }
    return this.cloudToken;
  },

  async refreshCloudHistory() {
    const data = await this.rawRequest("/api/diaries", "GET");
    const diaryHistory = (data.diaries || [])
      .map((record, index) => this.presentDiary(record, index))
      .sort((left, right) => right.savedAt - left.savedAt);
    wx.setStorageSync(DIARY_HISTORY_KEY, diaryHistory);
    if (diaryHistory[0]) wx.setStorageSync(LATEST_DIARY_KEY, diaryHistory[0]);
    this.setData({ diaryHistory });
    return diaryHistory;
  },

  async openHistory() {
    this.loadDiaryHistory();
    this.setData({ phase: "history", selectedDiary: null });
    try {
      await this.ensureCloudSession();
      await this.refreshCloudHistory();
    } catch (error) {}
  },

  openDiaryRecord(event) {
    const id = event.currentTarget.dataset.id;
    const selectedDiary = this.data.diaryHistory.find(record => record.id === id);
    if (selectedDiary) this.setData({ phase: "historyDetail", selectedDiary });
  },

  backHome() {
    this.setData({ phase: "home", selectedDiary: null });
  },

  backHistory() {
    this.setData({ phase: "history", selectedDiary: null });
  },

  restoreDiaryForRevision() {
    const diary = this.data.selectedDiary;
    if (!diary) return;
    const sentences = JSON.parse(JSON.stringify(diary.sentences || []));
    this.resetRuntime();
    this.transcript = String(diary.transcript || "");
    this.utterances = this.transcript ? [this.transcript] : [];
    this.facts = JSON.parse(JSON.stringify(diary.facts || [])).map(fact => ({ ...fact, active: fact.active !== false }));
    this.firstDiarySnapshot = { title: diary.title || "我的日记", sentences: JSON.parse(JSON.stringify(sentences)) };
    this.setData({
      phase: "diary",
      selectedDiary: null,
      diaryTitle: diary.title || "我的日记",
      diarySentences: sentences,
      factChips: this.facts.filter(fact => fact.active !== false)
    });
  },

  deleteDiaryRecord() {
    const diary = this.data.selectedDiary;
    if (!diary) return;
    wx.showModal({
      title: "删除这篇日记？",
      content: "删除后，日记本里就看不到它了。",
      confirmText: "删除",
      confirmColor: "#d85f3f",
      success: async result => {
        if (!result.confirm) return;
        try {
          await this.ensureCloudSession();
          await this.rawRequest(`/api/diaries/${encodeURIComponent(diary.id)}`, "DELETE");
          const history = this.readDiaryHistory().filter(item => item.id !== diary.id);
          wx.setStorageSync(DIARY_HISTORY_KEY, history);
          if (history[0]) wx.setStorageSync(LATEST_DIARY_KEY, history[0]);
          else wx.removeStorageSync(LATEST_DIARY_KEY);
          this.setData({ phase: "history", selectedDiary: null, diaryHistory: history.map((item, index) => this.presentDiary(item, index)) });
        } catch (error) {
          wx.showModal({ title: "还没有删除成功", content: error.message || "请检查网络后再试。", showCancel: false });
        }
      }
    });
  },

  async startStory() {
    try {
      await this.ensureCloudSession();
    } catch (error) {
      wx.showModal({ title: "还没有连上服务器", content: error.message || "请稍后再试。", showCancel: false });
      return;
    }
    this.resetRuntime();
    this.setData({ phase: "listen", statusTitle: "正在打开麦克风", statusHint: "开始以后一直说就好。" });
    await this.startRecorder("story");
  },

  async startRecorder(kind) {
    const allowed = await this.ensureRecordPermission();
    if (!allowed) return;
    this.segmentKind = kind;
    this.keepRecording = true;
    this.startSegment();
  },

  ensureRecordPermission() {
    return new Promise(resolve => {
      wx.getSetting({
        success: setting => {
          if (setting.authSetting["scope.record"] === true) return resolve(true);
          if (setting.authSetting["scope.record"] === false) {
            this.openRecordSettings(resolve);
            return;
          }
          wx.authorize({
            scope: "scope.record",
            success: () => resolve(true),
            fail: () => this.openRecordSettings(resolve)
          });
        },
        fail: error => {
          this.handleRecorderError(error);
          resolve(false);
        }
      });
    });
  },

  openRecordSettings(resolve) {
    wx.showModal({
      title: "需要麦克风",
      content: "请允许使用麦克风，小耳朵才能听见故事。",
      confirmText: "去设置",
      cancelText: "暂时不要",
      success: modal => {
        if (!modal.confirm) {
          this.setData({ statusTitle: "还没有打开麦克风", statusHint: "准备好后，点下面的按钮再试一次。" });
          resolve(false);
          return;
        }
        wx.openSetting({
          success: setting => {
            const allowed = setting.authSetting["scope.record"] === true;
            if (!allowed) this.setData({ statusTitle: "还没有打开麦克风", statusHint: "请在设置里打开麦克风权限。" });
            resolve(allowed);
          },
          fail: error => {
            this.handleRecorderError(error);
            resolve(false);
          }
        });
      },
      fail: error => {
        this.handleRecorderError(error);
        resolve(false);
      }
    });
  },

  retryRecording() {
    if (this.data.isRecording || this.data.isFinishing) return;
    this.setData({ statusTitle: "正在打开麦克风", statusHint: "请在微信提示中允许录音。" });
    this.startRecorder(this.segmentKind || "story");
  },

  startSegment() {
    if (!this.keepRecording) return;
    try {
      this.segmentActive = false;
      this.recorder.start({ duration: SEGMENT_MS + 1000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: "wav" });
      clearTimeout(this.segmentTimer);
      this.segmentTimer = setTimeout(() => { if (this.keepRecording) this.recorder.stop(); }, SEGMENT_MS);
    } catch (error) {
      this.handleRecorderError(error);
    }
  },

  handleSegmentStop(result) {
    clearTimeout(this.segmentTimer);
    this.segmentActive = false;
    const kind = this.segmentKind;
    const upload = this.uploadAudio(result.tempFilePath, kind);
    this.uploads.push(upload);
    if (this.keepRecording) setTimeout(() => this.startSegment(), 120);
    else if (this.data.isFinishing) Promise.all(this.uploads).then(() => this.finalizeCurrentFlow());
  },

  handleRecorderError(error = {}) {
    clearTimeout(this.segmentTimer);
    this.keepRecording = false;
    this.segmentActive = false;
    const detail = String(error.errMsg || error.message || "").replace(/^.*?:\s*/, "").trim();
    this.setData({
      isRecording: false,
      isFinishing: false,
      statusTitle: "麦克风没有启动",
      statusHint: detail ? `请重试（${detail}）` : "请检查录音权限后再试。"
    });
  },

  uploadAudio(filePath, kind) {
    return new Promise(resolve => {
      wx.uploadFile({
        url: `${API_BASE_URL}/api/asr`, filePath, name: "audio",
        header: this.cloudToken ? { Authorization: `Bearer ${this.cloudToken}` } : {},
        formData: { kind, realtime: "1" },
        success: response => {
          try {
            const data = JSON.parse(response.data || "{}");
            if (response.statusCode < 200 || response.statusCode >= 300) {
              this.showAsrIssue(kind, data.message || `语音识别失败 ${response.statusCode}`);
              resolve();
              return;
            }
            const text = String(data.text || "").trim();
            if (text) this.acceptTranscript(text, kind);
          } catch (error) {
            this.showAsrIssue(kind, "语音识别返回了无效结果");
          }
          resolve();
        },
        fail: () => { this.showAsrIssue(kind, "这一小段暂时没有转成文字"); resolve(); }
      });
    });
  },

  showAsrIssue(kind, message) {
    if (kind === "revision") {
      this.setData({ revisionDisplay: message });
      return;
    }
    const text = `${message}，录音仍在继续`;
    const last = this.data.bubbles[this.data.bubbles.length - 1];
    if (!last || last.type !== "system" || last.text !== text) this.addBubble("system", text);
  },

  acceptTranscript(text, kind) {
    if (kind === "revision") {
      this.revisionTranscript = this.appendText(this.revisionTranscript, text);
      try {
        const pending = wx.getStorageSync(PENDING_REVISION_KEY) || {};
        wx.setStorageSync(PENDING_REVISION_KEY, { ...pending, instruction: this.revisionTranscript, updatedAt: Date.now() });
      } catch (error) {}
      this.setData({ revisionDisplay: `我听到：${this.tail(this.revisionTranscript, 72)}` });
      return;
    }
    this.latestSegmentText = text;
    this.transcript = this.appendText(this.transcript, text);
    this.transcriptAnchorSequence += 1;
    this.setData({
      latestText: this.tail(this.transcript, 86),
      transcriptAnchorId: `transcript_end_${this.transcriptAnchorSequence}`
    });
    if (/(我)?说完(了|啦)?|讲完(了|啦)?/.test(text) && !this.data.isFinishing) this.finishStory();
    else this.analyzeRealtime();
  },

  appendText(base, addition) {
    if (!base) return addition;
    if (!addition || base.includes(addition)) return base;
    if (addition.includes(base)) return addition;
    return `${base}，${addition}`;
  },

  tail(text, length) { return text.length > length ? `…${text.slice(-length)}` : text; },

  analyzeRealtime() {
    if (this.analysisRunning) { this.analysisPending = true; return this.analysisPromise; }
    this.analysisRunning = true;
    const transcriptSnapshot = this.transcript;
    const request = this.request("/api/analyze", {
      text: transcriptSnapshot, recentText: this.latestSegmentText || transcriptSnapshot, realtime: true,
      existingFacts: this.facts.map(({ slot, label, text, quote }) => ({ slot, label, text, quote })),
      currentQuestion: this.currentQuestion,
      answerTextSinceQuestion: this.currentQuestion ? transcriptSnapshot.slice(this.questionTranscriptLength) : "",
      previousQuestions: this.questions,
      previousQuestionKeys: this.questionKeys,
      followupCount: this.followupCount,
      maxFollowups: 50
    }).then(data => {
      this.mergeFacts(data.facts || []);
      const decision = data.decision || {};
      const question = String(decision.question || "").trim();
      const targetKey = String(decision.target_key || question || decision.reason).trim();
      const isNewTarget = targetKey && !this.questionKeys.some(key => this.sameQuestionTarget(key, targetKey));
      if (decision.action === "ask_followup" && question && !this.questions.includes(question) && isNewTarget) {
        this.questions.push(question);
        this.questionKeys.push(targetKey);
        this.followupCount += 1;
        this.currentQuestion = { question, target_key: targetKey, reason: decision.reason || "" };
        this.questionTranscriptLength = transcriptSnapshot.length;
        this.addBubble("ai", question);
      } else if (decision.action === "redirect" && question) {
        const last = this.data.bubbles[this.data.bubbles.length - 1];
        if (!last || last.text !== question) this.addBubble("ai", question);
      } else if (["answered", "invalidated", "skipped"].includes(decision.question_status)) {
        this.currentQuestion = null;
      }
    }).catch(() => {}).finally(() => {
      this.analysisRunning = false;
      if (this.analysisPending) { this.analysisPending = false; this.analyzeRealtime(); }
    });
    this.analysisPromise = request;
    return request;
  },

  sameQuestionTarget(left, right) {
    const normalize = value => String(value || "").replace(/[\s，。！？、,.!?]/g, "");
    const a = normalize(left);
    const b = normalize(right);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
  },

  async waitForRealtimeAnalysis() {
    while (this.analysisRunning || this.analysisPending) {
      try { await this.analysisPromise; } catch (error) {}
      if (this.analysisRunning || this.analysisPending) await new Promise(resolve => setTimeout(resolve, 40));
    }
  },

  mergeFacts(incoming) {
    (incoming || []).forEach((fact, index) => {
      if (!fact || !fact.text || fact.slot === "raw") return;
      const duplicate = this.facts.some(existing => existing.active !== false && (existing.text === fact.text || existing.text.includes(fact.text) || fact.text.includes(existing.text)));
      if (!duplicate) this.facts.push({ ...fact, id: `f_${Date.now()}_${index}`, source: "实时识别", active: true });
    });
    this.setData({ factChips: this.facts.filter(fact => fact.active !== false) });
  },

  addBubble(type, text) {
    const bubbles = this.data.bubbles.concat({ id: `${Date.now()}_${Math.random()}`, type, text });
    this.feedAnchorSequence += 1;
    this.setData({ bubbles, feedAnchorId: `feed_end_${this.feedAnchorSequence}` });
  },

  finishStory() {
    if (this.data.isFinishing) return;
    this.keepRecording = false;
    clearTimeout(this.segmentTimer);
    this.setData({ isFinishing: true, isRecording: false, statusTitle: "正在整理日记", statusHint: "正在检查事实和完整句子。" });
    if (this.segmentActive) {
      try { this.recorder.stop(); } catch (error) { Promise.all(this.uploads).then(() => this.finalizeCurrentFlow()); }
    } else {
      Promise.all(this.uploads).then(() => this.finalizeCurrentFlow());
    }
  },

  async finalizeCurrentFlow() {
    if (this.finalizeStarted) return;
    this.finalizeStarted = true;
    if (this.segmentKind === "revision") return this.finishRevision();
    if (!this.transcript) { this.finalizeStarted = false; this.setData({ isFinishing: false, statusTitle: "还没有听到故事" }); return; }
    try {
      await this.waitForRealtimeAnalysis();
      this.utterances = [this.transcript];
      const data = await this.request("/api/finalize", {
        transcript: this.transcript,
        facts: this.facts.filter(fact => fact.active !== false),
        previousQuestions: this.questions
      });
      if (Array.isArray(data.acceptedFactIds)) {
        const acceptedIds = new Set(data.acceptedFactIds);
        this.facts.forEach(fact => {
          if (fact.id && !acceptedIds.has(fact.id)) fact.active = false;
        });
        this.setData({ factChips: this.facts.filter(fact => fact.active !== false) });
      }
      this.mergeFacts(data.facts || []);
      this.applyDiaryResponse(data, true);
    } catch (error) {
      this.finalizeStarted = false;
      this.setData({ isFinishing: false, statusTitle: "整理暂时失败", statusHint: error.message || "请稍后再试。" });
    }
  },

  async composeDiary(options = {}) {
    const facts = this.facts.filter(fact => fact.active !== false);
    const requiredFacts = Array.isArray(options.requiredFacts) ? options.requiredFacts : [];
    const requestOptions = { ...options };
    delete requestOptions.requiredFacts;
    const data = await this.request("/api/compose", {
      facts,
      utterances: this.utterances,
      ...requestOptions
    });
    const returnedSentences = Array.isArray(data.sentences) ? data.sentences : [];
    const coveredFactIds = new Set(returnedSentences.flatMap(sentence => Array.isArray(sentence.factIds) ? sentence.factIds : []));
    const coveredFactTexts = returnedSentences.flatMap(sentence => Array.isArray(sentence.factTexts) ? sentence.factTexts : []);
    const missingFacts = requiredFacts.filter(fact => {
      if (fact.id && coveredFactIds.has(fact.id)) return false;
      const factText = String(fact.text || "").trim();
      if (!factText) return false;
      return !coveredFactTexts.some(text => {
        const sourceText = String(text || "").trim();
        return sourceText && (sourceText === factText || sourceText.includes(factText) || factText.includes(sourceText));
      });
    });
    if (missingFacts.length > 0) {
      throw new Error("这次修改丢失了原文内容，已自动恢复修改前版本。");
    }
    this.applyDiaryResponse(data, false);
    return data;
  },

  applyDiaryResponse(data, lockFirstVersion) {
    const sentences = (data.sentences || []).map(sentence => ({
      id: sentence.id || `sentence_${Date.now()}_${Math.random()}`,
      text: sentence.text,
      factTexts: sentence.factTexts || [],
      factIds: sentence.factIds || this.facts
        .filter(fact => (sentence.factTexts || []).some(text => text === fact.text || text.includes(fact.text) || fact.text.includes(text)))
        .map(fact => fact.id),
      sourceText: (sentence.factTexts || []).join("；")
    }));
    if (lockFirstVersion && !this.firstDiarySnapshot) {
      this.firstDiarySnapshot = { title: data.title || "我的日记", sentences: JSON.parse(JSON.stringify(sentences)) };
    }
    this.setData({ phase: "diary", isFinishing: false, diaryTitle: data.title || "我的日记", diarySentences: sentences });
  },

  async saveDiary() {
    const savedAt = Date.now();
    const record = {
      id: `diary_${savedAt}`,
      title: this.data.diaryTitle,
      sentences: JSON.parse(JSON.stringify(this.data.diarySentences)),
      transcript: this.transcript,
      facts: JSON.parse(JSON.stringify(this.facts.filter(fact => fact.active !== false))),
      savedAt
    };
    try {
      const history = this.readDiaryHistory().filter(item => item.id !== record.id);
      history.unshift(record);
      wx.setStorageSync(DIARY_HISTORY_KEY, history);
      wx.setStorageSync(LATEST_DIARY_KEY, record);
      this.loadDiaryHistory();
      try {
        await this.ensureCloudSession();
        await this.rawRequest("/api/diaries", "POST", record);
        await this.refreshCloudHistory();
        this.setData({ phase: "success" });
      } catch (error) {
        this.setData({ phase: "success" });
        wx.showModal({ title: "手机已保存", content: "云端暂时没有同步，下次打开会自动重试。", showCancel: false });
      }
    } catch (error) {
      wx.showModal({ title: "还没有保存成功", content: "手机存储空间不足，请清理后再试。", showCancel: false });
    }
  },

  async startRevision() {
    this.revisionTranscript = ""; this.uploads = []; this.finalizeStarted = false;
    this.revisionBaseSnapshot = {
      title: this.data.diaryTitle,
      sentences: JSON.parse(JSON.stringify(this.data.diarySentences)),
      facts: JSON.parse(JSON.stringify(this.facts))
    };
    try {
      wx.setStorageSync(PENDING_REVISION_KEY, { ...this.revisionBaseSnapshot, instruction: "", createdAt: Date.now() });
    } catch (error) {}
    this.setData({ phase: "revise", revisionDisplay: "", isFinishing: false });
    await this.startRecorder("revision");
  },

  applyRevision() {
    if (this.data.isFinishing) return;
    this.keepRecording = false;
    clearTimeout(this.segmentTimer);
    this.setData({ isFinishing: true, isRecording: false });
    if (this.segmentActive) {
      try { this.recorder.stop(); } catch (error) { Promise.all(this.uploads).then(() => this.finalizeCurrentFlow()); }
    } else {
      Promise.all(this.uploads).then(() => this.finalizeCurrentFlow());
    }
  },

  async finishRevision() {
    if (!this.revisionTranscript) { this.finalizeStarted = false; this.setData({ isFinishing: false, revisionDisplay: "刚才没有听清，请再说一次。" }); return; }
    try {
      const activeFacts = this.facts.filter(fact => fact.active !== false);
      const result = await this.request("/api/revise", { instruction: this.revisionTranscript, facts: activeFacts, diary: this.data.diarySentences.map(item => item.text) });
      let changed = 0;
      const appliedOperations = [];
      (result.operations || []).forEach(operation => {
        const target = this.facts.find(fact => fact.active !== false && fact.id === operation.target_fact_id);
        if (operation.type === "replace" && target && operation.new_text) {
          const oldText = target.text;
          target.text = operation.new_text; target.quote = this.revisionTranscript; target.source = "语音修改"; changed += 1; appliedOperations.push({ ...operation, old_text: oldText });
        }
        if (operation.type === "delete" && target) {
          target.active = false; changed += 1; appliedOperations.push(operation);
        }
        if (operation.type === "add" && operation.new_text) {
          const id = `rev_${Date.now()}_${changed}`;
          this.facts.push({ id, slot: operation.slot, label: operation.label || "语音修改", text: operation.new_text, quote: this.revisionTranscript, source: "语音修改", active: true });
          appliedOperations.push({ ...operation, applied_fact_id: id });
          changed += 1;
        }
      });
      if (!changed) throw new Error(result.message || "没有找到修改内容");
      const requiredFacts = this.facts
        .filter(fact => fact.active !== false)
        .map(fact => ({ id: fact.id, text: fact.text }));
      await this.composeDiary({
        lockedTitle: this.data.diaryTitle,
        lockedDiary: this.data.diarySentences.map(item => ({ id: item.id, text: item.text, factTexts: item.factTexts, factIds: item.factIds })),
        revisionOperations: appliedOperations,
        revisionInstruction: this.revisionTranscript,
        requiredFacts
      });
      this.revisionBaseSnapshot = null;
      try { wx.removeStorageSync(PENDING_REVISION_KEY); } catch (error) {}
    } catch (error) {
      if (this.revisionBaseSnapshot) {
        this.facts = JSON.parse(JSON.stringify(this.revisionBaseSnapshot.facts));
        this.setData({
          phase: "diary",
          diaryTitle: this.revisionBaseSnapshot.title,
          diarySentences: JSON.parse(JSON.stringify(this.revisionBaseSnapshot.sentences))
        });
      }
      this.finalizeStarted = false;
      this.setData({ isFinishing: false, revisionDisplay: error.message || "修改失败，请重新说一次。" });
      wx.showModal({ title: "已恢复修改前版本", content: error.message || "这次修改没有应用，请重新说一次。", showCancel: false });
    }
  },

  restart() { this.resetRuntime(); this.setData({ phase: "home", diaryTitle: "", diarySentences: [], selectedDiary: null }); },

  request(path, data) {
    return this.ensureCloudSession().then(() => this.rawRequest(path, "POST", data));
  }
});
