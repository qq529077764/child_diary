const { API_BASE_URL } = require("../../utils/config");

const SEGMENT_MS = 6200;
const DIARY_HISTORY_KEY = "diaryHistory";
const LATEST_DIARY_KEY = "latestDiary";
const CLOUD_TOKEN_KEY = "cloudSessionToken";
const INSTALLATION_ID_KEY = "installationId";
const GUARDIAN_CONSENT_KEY = "guardianConsent";
const CHILD_PRIVACY_VERSION = "2026-10-09-v1";
const PRIVATE_STORAGE_KEYS = [
  DIARY_HISTORY_KEY,
  LATEST_DIARY_KEY,
  CLOUD_TOKEN_KEY,
  INSTALLATION_ID_KEY,
  GUARDIAN_CONSENT_KEY,
  "pendingDiaryRevision"
];

const CHILD_PRIVACY_SECTIONS = [
  {
    title: "我们会使用什么信息",
    text: "经监护人同意后，我们会使用微信用户标识、孩子的录音片段、语音转写文字、事实信息和生成的日记。录音片段只用于本次语音识别，本服务不会把录音文件长期保存在日记服务器。"
  },
  {
    title: "这些信息用来做什么",
    text: "用于把口述转成文字、发现故事里还可以补充的内容、整理日记、语音修改，以及保存和查询已经确认的日记。不会用于广告、用户画像或公开展示。"
  },
  {
    title: "会由谁处理",
    text: "录音片段会交给腾讯云语音识别服务转写；转写文字、事实信息和当前日记会交给阿里云通义千问完成问题引导、整理和修改。通义千问不会收到本小程序上传的原始录音。"
  },
  {
    title: "保存、删除和撤回",
    text: "确认保存的日记会保存在服务器，直到监护人主动删除。删除单篇日记会立即从正在使用的数据库中删除；备份副本与线上服务隔离，并在最长30天内自动到期。监护人也可以撤回同意并删除全部日记和账户标识。"
  },
  {
    title: "监护人的权利",
    text: "监护人可以查看和删除日记、撤回同意并删除全部数据。拒绝或撤回不会产生额外费用，但语音整理、云端保存和日记查询功能将不能继续使用。需要帮助可联系 529077764@qq.com。"
  }
];

Page({
  data: {
    phase: "home",
    isRecording: false,
    isFinishing: false,
    isSaving: false,
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
    feedAnchorId: "feed_end_0",
    showGuardianConsent: false,
    showChildPrivacyRules: false,
    guardianConsentRecorded: false,
    childPrivacySections: CHILD_PRIVACY_SECTIONS
  },

  onLoad() {
    // 旧版曾写入但从未安全恢复的修改草稿，升级后一次性清理。
    try { wx.removeStorageSync("pendingDiaryRevision"); } catch (error) {}
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
    this.authPromise = null;
    this.guardianConsentServerSynced = false;
    this.cloudHistoryInitialized = false;
    this.pendingProtectedAction = "";
    this.privacyAuthorizationResolvers = [];
    this.privacyAuthorizationRequestActive = false;
    this.guardianConsentSubmitting = false;
    this.privacyAuthorizationHandler = resolve => {
      if (typeof resolve === "function") this.privacyAuthorizationResolvers.push(resolve);
      this.setData({ showGuardianConsent: true });
    };
    if (typeof wx.onNeedPrivacyAuthorization === "function") {
      wx.onNeedPrivacyAuthorization(this.privacyAuthorizationHandler);
    }
    const guardianConsentRecorded = this.hasGuardianConsent();
    this.setData({ guardianConsentRecorded });
    if (guardianConsentRecorded) {
      this.startCloudInitialization().catch(error => {
        this.authError = error;
      });
    }
  },

  onUnload() {
    clearTimeout(this.segmentTimer);
    this.keepRecording = false;
    try { this.recorder.stop(); } catch (error) {}
    if (typeof wx.offNeedPrivacyAuthorization === "function" && this.privacyAuthorizationHandler) {
      wx.offNeedPrivacyAuthorization(this.privacyAuthorizationHandler);
    }
  },

  resetRuntime() {
    this.runtimeToken = (this.runtimeToken || 0) + 1;
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
    this.revisionBaseSnapshot = null;
    this.editingDiaryId = null;
    this.editingDiarySavedAt = null;
    this.transcriptAnchorSequence = 0;
    this.feedAnchorSequence = 0;
    this.setData({ isRecording: false, isFinishing: false, isSaving: false, bubbles: [], factChips: [], latestText: "", revisionDisplay: "", transcriptAnchorId: "transcript_end_0", feedAnchorId: "feed_end_0" });
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
    const facts = Array.isArray(record.facts) ? record.facts.map(fact => ({ ...fact, active: fact.active !== false })) : [];
    const sentences = (record.sentences || []).map((sentence, sentenceIndex) => {
      if (typeof sentence === "string") {
        const matchingFacts = facts.filter(fact =>
          fact?.text && (sentence.includes(fact.text) || fact.text.includes(sentence))
        );
        return {
          id: `stored_${savedAt}_${sentenceIndex}`,
          text: sentence,
          factTexts: matchingFacts.map(fact => fact.text),
          factIds: matchingFacts.map(fact => fact.id),
          sourceText: matchingFacts.map(fact => fact.text).join("；")
        };
      }
      const factTexts = Array.isArray(sentence.factTexts) ? sentence.factTexts : [];
      const factIds = Array.isArray(sentence.factIds) && sentence.factIds.length
        ? sentence.factIds
        : facts
          .filter(fact => factTexts.some(text => text === fact.text || text.includes(fact.text) || fact.text.includes(text)))
          .map(fact => fact.id);
      return {
        ...sentence,
        id: sentence.id || `stored_${savedAt}_${sentenceIndex}`,
        factTexts,
        factIds,
        sourceText: sentence.sourceText || factTexts.join("；")
      };
    });
    return {
      ...record,
      id: record.id || `diary_${savedAt}_${index}`,
      title: record.title || "我的日记",
      facts,
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

  hasGuardianConsent() {
    try {
      const consent = wx.getStorageSync(GUARDIAN_CONSENT_KEY);
      return Boolean(consent?.agreed && consent.policyVersion === CHILD_PRIVACY_VERSION);
    } catch (error) {
      return false;
    }
  },

  requireGuardianConsent(action) {
    if (this.hasGuardianConsent()) return true;
    this.pendingProtectedAction = action || this.pendingProtectedAction || "";
    this.setData({ showGuardianConsent: true, guardianConsentRecorded: false });
    this.requestWechatPrivacyAuthorization();
    return false;
  },

  requestWechatPrivacyAuthorization() {
    if (this.privacyAuthorizationRequestActive || typeof wx.requirePrivacyAuthorize !== "function") return;
    this.privacyAuthorizationRequestActive = true;
    wx.requirePrivacyAuthorize({
      success: () => { this.privacyAuthorizationRequestActive = false; },
      fail: () => { this.privacyAuthorizationRequestActive = false; }
    });
  },

  resolvePrivacyAuthorization(eventName) {
    const resolvers = this.privacyAuthorizationResolvers.splice(0);
    resolvers.forEach(resolve => {
      try {
        resolve({
          event: eventName,
          buttonId: eventName === "agree" ? "guardian-agree-button" : "guardian-decline-button"
        });
      } catch (error) {}
    });
  },

  async confirmGuardianConsent() {
    if (this.guardianConsentSubmitting) return;
    this.guardianConsentSubmitting = true;
    const agreedAt = Date.now();
    try {
      wx.setStorageSync(GUARDIAN_CONSENT_KEY, {
        agreed: true,
        policyVersion: CHILD_PRIVACY_VERSION,
        agreedAt
      });
      this.guardianConsentServerSynced = false;
      this.setData({
        showGuardianConsent: false,
        guardianConsentRecorded: true
      });
      this.resolvePrivacyAuthorization("agree");
      const action = this.pendingProtectedAction;
      this.pendingProtectedAction = "";
      await this.ensureCloudSession();
      if (action === "story") await this.beginStory();
      if (action === "history") await this.enterHistory();
    } catch (error) {
      wx.showModal({
        title: "暂时没有连接成功",
        content: error.message || "请检查网络后再试。监护人同意记录已经保留。",
        showCancel: false
      });
    } finally {
      this.guardianConsentSubmitting = false;
    }
  },

  declineGuardianConsent() {
    this.pendingProtectedAction = "";
    this.setData({ showGuardianConsent: false, guardianConsentRecorded: false });
    this.resolvePrivacyAuthorization("disagree");
  },

  openChildPrivacyRules() {
    this.setData({ showChildPrivacyRules: true });
  },

  closeChildPrivacyRules() {
    this.setData({ showChildPrivacyRules: false });
  },

  openWechatPrivacyContract() {
    if (typeof wx.openPrivacyContract !== "function") {
      wx.showModal({ title: "当前微信版本暂不支持", content: "请更新微信后再查看《小程序隐私保护指引》。", showCancel: false });
      return;
    }
    wx.openPrivacyContract({
      fail: error => wx.showModal({
        title: "暂时无法打开",
        content: error?.errMsg || "请稍后再试。",
        showCancel: false
      })
    });
  },

  openPrivacyCenter() {
    this.setData({
      phase: "privacy",
      guardianConsentRecorded: this.hasGuardianConsent(),
      selectedDiary: null
    });
  },

  clearPrivateLocalData() {
    PRIVATE_STORAGE_KEYS.forEach(key => {
      try { wx.removeStorageSync(key); } catch (error) {}
    });
    this.cloudToken = "";
    this.authPromise = null;
    this.authError = null;
    this.guardianConsentServerSynced = false;
    this.cloudHistoryInitialized = false;
    this.pendingProtectedAction = "";
    this.loadDiaryHistory();
  },

  withdrawGuardianConsent() {
    if (!this.hasGuardianConsent()) {
      this.clearPrivateLocalData();
      this.resetRuntime();
      this.setData({ phase: "home", guardianConsentRecorded: false, selectedDiary: null });
      return;
    }
    wx.showModal({
      title: "撤回同意并删除全部数据？",
      content: "服务器中的全部日记和账户标识都会删除，手机里的日记副本也会清除。此操作不能恢复。",
      confirmText: "全部删除",
      confirmColor: "#d85f3f",
      success: async result => {
        if (!result.confirm) return;
        wx.showLoading({ title: "正在删除", mask: true });
        try {
          await this.ensureAccountSessionForDeletion();
          await this.rawRequest("/api/account", "DELETE");
          this.clearPrivateLocalData();
          this.resetRuntime();
          this.setData({
            phase: "home",
            guardianConsentRecorded: false,
            selectedDiary: null,
            diaryTitle: "",
            diarySentences: []
          });
          wx.showModal({ title: "已经删除", content: "监护人同意、云端日记和手机副本都已删除。", showCancel: false });
        } catch (error) {
          wx.showModal({ title: "还没有删除成功", content: error.message || "请检查网络后再试。", showCancel: false });
        } finally {
          wx.hideLoading();
        }
      }
    });
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
      timeout: path === "/api/finalize" ? 120000 : path === "/api/compose" ? 90000 : 60000,
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
    if (!this.hasGuardianConsent()) throw new Error("需要监护人同意后才能连接日记服务器");
    await this.authenticateCloudSession();
    await this.syncGuardianConsent();
    return this.synchronizeDiaryHistory();
  },

  async authenticateCloudSession() {
    if (this.cloudToken) {
      try {
        const current = await this.rawRequest("/api/auth/session", "POST", {}, true);
        if (current.token) return current.token;
      } catch (error) {
        if (error.statusCode !== 401) throw error;
        this.cloudToken = "";
        wx.removeStorageSync(CLOUD_TOKEN_KEY);
      }
    }
    const code = await this.wechatLoginCode();
    const payload = { code, installationId: this.installationId() };
    const auth = await this.rawRequest("/api/auth/session", "POST", payload, false);
    if (!auth.token) throw new Error("服务器未返回登录信息");
    this.cloudToken = auth.token;
    this.authError = null;
    wx.setStorageSync(CLOUD_TOKEN_KEY, auth.token);
    return auth.token;
  },

  async ensureAccountSessionForDeletion() {
    return this.authenticateCloudSession();
  },

  startCloudInitialization() {
    if (!this.hasGuardianConsent()) return Promise.reject(new Error("需要监护人同意后才能继续"));
    if (!this.authPromise) {
      this.authPromise = this.initializeCloudDiary()
        .catch(error => {
          this.authError = error;
          throw error;
        })
        .finally(() => {
          this.authPromise = null;
        });
    }
    return this.authPromise;
  },

  async syncGuardianConsent() {
    if (this.guardianConsentServerSynced) return;
    if (!this.cloudToken) throw new Error("还没有连接到日记服务器");
    const consent = wx.getStorageSync(GUARDIAN_CONSENT_KEY) || {};
    await this.rawRequest("/api/guardian-consent", "POST", {
      policyVersion: CHILD_PRIVACY_VERSION,
      agreedAt: Number(consent.agreedAt) || Date.now()
    });
    this.guardianConsentServerSynced = true;
  },

  async synchronizeDiaryHistory() {
    if (this.cloudHistoryInitialized) return this.data.diaryHistory;
    const localHistory = this.readDiaryHistory();
    for (const record of localHistory) {
      try { await this.rawRequest("/api/diaries", "POST", record); } catch (error) {}
    }
    const history = await this.refreshCloudHistory();
    this.cloudHistoryInitialized = true;
    return history;
  },

  async ensureCloudSession() {
    if (!this.hasGuardianConsent()) throw new Error("需要监护人同意后才能继续");
    if (!this.cloudToken) await this.startCloudInitialization();
    else await this.syncGuardianConsent();
    if (!this.cloudToken) {
      const error = this.authError;
      this.authError = null;
      throw new Error(error?.message || "还没有连接到日记服务器");
    }
    if (!this.cloudHistoryInitialized) await this.synchronizeDiaryHistory();
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
    if (!this.requireGuardianConsent("history")) return;
    await this.enterHistory();
  },

  async enterHistory() {
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

  cancelCurrentFlow() {
    if (this.data.isFinishing || this.data.isSaving) return;
    const phase = this.data.phase;
    const isRevision = phase === "revise";
    wx.showModal({
      title: isRevision ? "取消这次修改？" : phase === "diary" ? "暂时不保存吗？" : "退出这次讲述？",
      content: isRevision ? "已经生成的日记会保留，这次还没提交的修改会取消。" : phase === "diary" ? "退出后，这篇还没有保存的日记会被丢弃。" : "退出后，刚才说的内容不会保存。",
      confirmText: isRevision ? "取消修改" : "退出",
      confirmColor: "#d85f3f",
      success: result => {
        if (!result.confirm) return;
        this.runtimeToken = (this.runtimeToken || 0) + 1;
        this.keepRecording = false;
        clearTimeout(this.segmentTimer);
        if (this.segmentActive) {
          this.discardNextSegment = true;
          try { this.recorder.stop(); } catch (error) {}
        }
        if (isRevision) {
          const snapshot = this.revisionBaseSnapshot;
          if (snapshot) {
            this.facts = JSON.parse(JSON.stringify(snapshot.facts || []));
            this.setData({
              phase: "diary",
              isRecording: false,
              diaryTitle: snapshot.title,
              diarySentences: JSON.parse(JSON.stringify(snapshot.sentences || [])),
              factChips: this.facts.filter(fact => fact.active !== false)
            });
          } else {
            this.setData({ phase: "diary", isRecording: false });
          }
          this.revisionTranscript = "";
          this.uploads = [];
          this.finalizeStarted = false;
          this.revisionBaseSnapshot = null;
          return;
        }
        this.resetRuntime();
        this.setData({ phase: "home", diaryTitle: "", diarySentences: [], selectedDiary: null });
      }
    });
  },

  restoreDiaryForRevision() {
    const diary = this.data.selectedDiary;
    if (!diary) return;
    const sentences = JSON.parse(JSON.stringify(diary.sentences || []));
    this.resetRuntime();
    this.transcript = String(diary.transcript || "");
    this.utterances = this.transcript ? [this.transcript] : [];
    this.facts = JSON.parse(JSON.stringify(diary.facts || [])).map(fact => ({ ...fact, active: fact.active !== false }));
    this.editingDiaryId = diary.id;
    this.editingDiarySavedAt = diary.savedAt;
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
      content: "日记会从服务器和手机中删除，不能恢复。隔离备份中的副本会在最长30天内自动到期。",
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
    if (!this.requireGuardianConsent("story")) return;
    await this.beginStory();
  },

  async beginStory() {
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
    if (this.data.phase === "revise") {
      this.revisionTranscript = "";
      this.uploads = [];
      this.finalizeStarted = false;
      this.setData({ revisionDisplay: "" });
    }
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
    if (this.discardNextSegment) {
      this.discardNextSegment = false;
      return;
    }
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
    const runtimeToken = this.runtimeToken;
    return new Promise(resolve => {
      wx.uploadFile({
        url: `${API_BASE_URL}/api/asr`, filePath, name: "audio",
        header: this.cloudToken ? { Authorization: `Bearer ${this.cloudToken}` } : {},
        formData: { kind, realtime: "1" },
        success: response => {
          if (runtimeToken !== this.runtimeToken) { resolve(); return; }
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
        fail: () => {
          if (runtimeToken === this.runtimeToken) this.showAsrIssue(kind, "这一小段暂时没有转成文字");
          resolve();
        }
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
    const runtimeToken = this.runtimeToken;
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
      if (runtimeToken !== this.runtimeToken) return;
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
      if (runtimeToken !== this.runtimeToken) return;
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
      this.applyDiaryResponse(data);
    } catch (error) {
      this.finalizeStarted = false;
      this.setData({ isFinishing: false, statusTitle: "整理暂时失败", statusHint: error.message || "请稍后再试。" });
    }
  },

  async composeDiary(options = {}) {
    const facts = this.facts.filter(fact => fact.active !== false);
    const data = await this.request("/api/compose", {
      facts,
      utterances: this.utterances,
      ...options
    });
    this.applyDiaryResponse(data);
    return data;
  },

  applyDiaryResponse(data) {
    const sentences = (data.sentences || []).map(sentence => ({
      id: sentence.id || `sentence_${Date.now()}_${Math.random()}`,
      text: sentence.text,
      factTexts: sentence.factTexts || [],
      factIds: sentence.factIds || this.facts
        .filter(fact => (sentence.factTexts || []).some(text => text === fact.text || text.includes(fact.text) || fact.text.includes(text)))
        .map(fact => fact.id),
      sourceText: (sentence.factTexts || []).join("；")
    }));
    this.setData({ phase: "diary", isFinishing: false, diaryTitle: data.title || "我的日记", diarySentences: sentences });
  },

  async saveDiary() {
    if (this.data.isSaving) return;
    this.setData({ isSaving: true });
    const savedAt = this.editingDiarySavedAt || Date.now();
    const record = {
      id: this.editingDiaryId || `diary_${savedAt}`,
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
      this.setData({ phase: "success" });
      try {
        await this.ensureCloudSession();
        await this.rawRequest("/api/diaries", "POST", record);
        await this.refreshCloudHistory();
      } catch (error) {
        wx.showModal({ title: "手机已保存", content: "云端暂时没有同步，下次打开会自动重试。", showCancel: false });
      }
    } catch (error) {
      wx.showModal({ title: "还没有保存成功", content: "手机存储空间不足，请清理后再试。", showCancel: false });
    } finally {
      this.setData({ isSaving: false });
    }
  },

  async startRevision() {
    this.revisionTranscript = ""; this.uploads = []; this.finalizeStarted = false;
    this.revisionBaseSnapshot = {
      title: this.data.diaryTitle,
      sentences: JSON.parse(JSON.stringify(this.data.diarySentences)),
      facts: JSON.parse(JSON.stringify(this.facts))
    };
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
      // 旧版历史日记的句子与事实关联可能不完整，修改时必须提供该篇保存的全部有效事实。
      const activeFacts = this.facts.filter(fact => fact.active !== false);
      const revisionDiary = this.data.diarySentences.map(item => ({
        id: item.id,
        text: item.text,
        factTexts: item.factTexts || [],
        factIds: item.factIds || []
      }));
      const result = await this.request("/api/revise", { instruction: this.revisionTranscript, facts: activeFacts, diary: revisionDiary });
      let changed = 0;
      const appliedOperations = [];
      (result.operations || []).forEach(operation => {
        const target = this.facts.find(fact => fact.active !== false && fact.id === operation.target_fact_id);
        if (operation.type === "replace" && target && operation.new_text) {
          const oldText = target.text;
          target.text = operation.new_text; target.quote = this.revisionTranscript; target.source = "语音修改"; changed += 1; appliedOperations.push({ ...operation, old_text: oldText });
        }
        if (operation.type === "delete" && target) {
          target.active = false; changed += 1; appliedOperations.push({ ...operation, old_text: target.text });
        }
        if (operation.type === "add" && operation.new_text) {
          const id = `rev_${Date.now()}_${changed}`;
          this.facts.push({ id, slot: operation.slot, label: operation.label || "语音修改", text: operation.new_text, quote: this.revisionTranscript, source: "语音修改", active: true });
          appliedOperations.push({ ...operation, applied_fact_id: id });
          changed += 1;
        }
        if (operation.type === "remove_phrase" && operation.target_sentence_id && operation.old_text) {
          changed += 1;
          appliedOperations.push(operation);
        }
      });
      if (!changed) {
        this.finalizeStarted = false;
        this.setData({ isFinishing: false, revisionDisplay: result.message || "还没有找到要修改的地方，请再说清楚一点。" });
        wx.showModal({
          title: "还没有修改",
          content: result.message || "请把想改的那件事重新说完整，也可以直接指出要去掉的内容。原来的日记没有变化。",
          showCancel: false
        });
        return;
      }
      const lockedDiary = this.data.diarySentences.map(item => ({
        id: item.id,
        text: item.text,
        factTexts: item.factTexts,
        factIds: item.factIds
      }));
      await this.composeDiary({
        lockedTitle: this.data.diaryTitle,
        lockedDiary,
        revisionOperations: appliedOperations,
        revisionInstruction: this.revisionTranscript,
        revisionMode: result.revisionMode || ""
      });
      this.revisionBaseSnapshot = null;
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
      wx.showModal({ title: "修改暂时失败", content: `${error.message || "这次修改没有应用，请重新说一次。"}\n原来的日记已完整保留。`, showCancel: false });
    }
  },

  restart() { this.resetRuntime(); this.setData({ phase: "home", diaryTitle: "", diarySentences: [], selectedDiary: null }); },

  request(path, data) {
    return this.ensureCloudSession().then(() => this.rawRequest(path, "POST", data));
  }
});
