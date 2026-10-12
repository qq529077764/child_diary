const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { finalizeFactDiary, reviseFactDiary } = require("./lib/fact-pipeline");

const ROOT = __dirname;

loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 5178);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "child-diary.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });
const database = new DatabaseSync(DB_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    wechat_openid TEXT UNIQUE,
    auth_mode TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS diaries (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    sentences_json TEXT NOT NULL,
    transcript TEXT NOT NULL DEFAULT '',
    facts_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS guardian_consents (
    user_id TEXT PRIMARY KEY,
    policy_version TEXT NOT NULL,
    consented_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_diaries_user_created
    ON diaries(user_id, created_at DESC);
`);
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, error, message) {
  sendJson(res, status, { error, message });
}

function tokenHash(token) {
  return sha256(String(token || ""));
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  return match ? match[1].trim() : "";
}

function authenticatedUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const session = database.prepare(`
    SELECT users.id, users.wechat_openid, users.auth_mode
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(tokenHash(token));
  if (!session) return null;
  database.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
    .run(Date.now(), tokenHash(token));
  return session;
}

function requireUser(req, res) {
  const user = authenticatedUser(req);
  if (!user) sendError(res, 401, "unauthorized", "请重新登录后再试。");
  return user;
}

function requireGuardianConsent(user, res) {
  const consent = database.prepare("SELECT policy_version FROM guardian_consents WHERE user_id = ?")
    .get(user.id);
  if (!consent) {
    sendError(res, 403, "guardian_consent_required", "需要监护人同意后才能使用这项功能。");
    return false;
  }
  return true;
}

async function exchangeWechatCode(code) {
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) throw new Error("wechat_auth_not_configured");
  const query = new URLSearchParams({
    appid: appId,
    secret: appSecret,
    js_code: code,
    grant_type: "authorization_code"
  });
  const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
  const data = await response.json();
  if (!response.ok || data.errcode || !data.openid) {
    throw new Error(`wechat_login_failed:${data.errcode || response.status}:${data.errmsg || "unknown"}`);
  }
  return data;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  database.prepare("INSERT INTO sessions(token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), userId, now, now);
  return token;
}

function upsertWechatUser(openid) {
  let user = database.prepare("SELECT id FROM users WHERE wechat_openid = ?").get(openid);
  if (user) return user.id;
  const id = crypto.randomUUID();
  database.prepare("INSERT INTO users(id, wechat_openid, auth_mode, created_at) VALUES (?, ?, 'wechat', ?)")
    .run(id, openid, Date.now());
  return id;
}

function upsertDeviceUser(installationId) {
  const openid = `device:${sha256(installationId).slice(0, 48)}`;
  let user = database.prepare("SELECT id FROM users WHERE wechat_openid = ?").get(openid);
  if (user) return user.id;
  const id = crypto.randomUUID();
  database.prepare("INSERT INTO users(id, wechat_openid, auth_mode, created_at) VALUES (?, ?, 'device', ?)")
    .run(id, openid, Date.now());
  return id;
}

async function handleAuthSession(req, res) {
  const presentedToken = bearerToken(req);
  const current = authenticatedUser(req);
  if (current) {
    sendJson(res, 200, { token: presentedToken, authMode: current.auth_mode });
    return;
  }
  if (presentedToken) {
    sendError(res, 401, "invalid_session", "登录信息已失效，请重新连接服务器。");
    return;
  }
  const input = await readJson(req);
  let userId;
  let authMode;
  if (input.code && process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET) {
    const session = await exchangeWechatCode(String(input.code));
    userId = upsertWechatUser(session.openid);
    authMode = "wechat";
  } else if (process.env.ALLOW_DEVICE_AUTH === "true" && input.installationId) {
    userId = upsertDeviceUser(String(input.installationId));
    authMode = "device";
  } else {
    sendError(res, 503, "wechat_auth_not_configured", "服务器尚未配置小程序 AppSecret。");
    return;
  }
  sendJson(res, 200, { token: createSession(userId), authMode });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getBoundary(contentType) {
  const match = /boundary=([^;]+)/i.exec(contentType || "");
  return match ? match[1] : "";
}

function parseMultipart(buffer, boundary) {
  if (!boundary) return {};
  const body = buffer.toString("binary");
  const marker = `--${boundary}`;
  const parts = body.split(marker).slice(1, -1);
  const fields = {};

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const splitAt = trimmed.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;
    const rawHeaders = trimmed.slice(0, splitAt);
    const rawContent = trimmed.slice(splitAt + 4);
    const name = /name="([^"]+)"/.exec(rawHeaders)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(rawHeaders)?.[1];
    const contentType = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1] || "application/octet-stream";
    const content = Buffer.from(rawContent, "binary");
    fields[name] = filename ? { filename, contentType, content } : rawContent;
  }

  return fields;
}

function hmacSha256(message, secret, encoding) {
  return crypto.createHmac("sha256", secret).update(message).digest(encoding);
}

function sha256(message, encoding = "hex") {
  return crypto.createHash("sha256").update(message).digest(encoding);
}

async function callTencentCloud(action, payload) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) return null;

  const service = "asr";
  const host = "asr.tencentcloudapi.com";
  const version = "2019-06-14";
  const region = process.env.TENCENT_REGION || "ap-shanghai";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);

  const httpRequestMethod = "POST";
  const canonicalUri = "/";
  const canonicalQueryString = "";
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = sha256(body);
  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload
  ].join("\n");

  const algorithm = "TC3-HMAC-SHA256";
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");

  const secretDate = hmacSha256(date, `TC3${secretKey}`);
  const secretService = hmacSha256(service, secretDate);
  const secretSigning = hmacSha256("tc3_request", secretService);
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Region": region
    },
    body
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Tencent response parse failed: ${text.slice(0, 200)}`);
  }

  const error = data?.Response?.Error;
  if (error) throw new Error(`${error.Code}: ${error.Message}`);
  return data.Response;
}

async function transcribeWithTencent(audio) {
  if (!process.env.TENCENT_SECRET_ID || !process.env.TENCENT_SECRET_KEY) return null;
  const data = audio.content.toString("base64");
  const response = await callTencentCloud("SentenceRecognition", {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: process.env.TENCENT_ASR_ENGINE_MODEL_TYPE || "16k_zh",
    SourceType: 1,
    VoiceFormat: "wav",
    UsrAudioKey: `tongxin-${Date.now()}`,
    Data: data,
    DataLen: audio.content.length
  });
  return response?.Result || "";
}

function qwenConfig() {
  return {
    apiKey: process.env.QWEN_API_KEY,
    model: process.env.QWEN_MODEL || "qwen3.8-max",
    fastModel: process.env.QWEN_FAST_MODEL || "deepseek-v4.1-flash",
    enableThinking: String(process.env.QWEN_ENABLE_THINKING || "false").toLowerCase() === "true",
    baseUrl: (process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "")
  };
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  const error = new Error("模型返回的结构数据不完整");
  error.code = "MODEL_JSON_INVALID";
  error.outputChars = trimmed.length;
  throw error;
}

async function callQwenJson(messages, options = {}) {
  const config = qwenConfig();
  if (!config.apiKey) throw new Error("QWEN_API_KEY is not configured");
  const stage = String(options.stage || "unspecified");
  const maxTokens = Math.max(800, Math.min(5000, Number(options.maxTokens) || 3600));
  const timeoutMs = Math.max(10000, Math.min(60000, Number(options.timeoutMs) || 45000));
  let lastError;
  let requestMessages = messages;
  let compactRetry = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    try {
      const fastStage = new Set([
        "audit_final_facts",
        "verify_revision_changes",
        "verify_revision_changes_retry"
      ]).has(stage);
      const model = options.model || (fastStage ? config.fastModel : config.model);
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          temperature: 0.1,
          max_tokens: maxTokens,
          enable_thinking: config.enableThinking,
          response_format: { type: "json_object" }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Qwen failed: ${response.status} ${text.slice(0, 200)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content || "";
      const finishReason = data?.choices?.[0]?.finish_reason || "";
      if (finishReason === "length") {
        const error = new Error("模型输出达到长度上限");
        error.code = "MODEL_OUTPUT_TRUNCATED";
        error.outputChars = content.length;
        throw error;
      }
      const result = extractJson(content);
      console.log("Qwen stage completed", {
        stage,
        model,
        enableThinking: config.enableThinking,
        attempt,
        elapsedMs: Date.now() - startedAt,
        outputChars: content.length,
        finishReason
      });
      return result;
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (attempt >= 2 || !retryable) break;
      console.warn("Qwen stage retry", {
        stage,
        attempt,
        elapsedMs: Date.now() - startedAt,
        reason: error.code || error.name || "unknown",
        outputChars: Number(error.outputChars) || 0
      });
      if (["MODEL_JSON_INVALID", "MODEL_OUTPUT_TRUNCATED"].includes(error.code)) {
        compactRetry = true;
        requestMessages = [
          ...messages,
          {
            role: "user",
            content: JSON.stringify({
              task: "compact_json_retry",
              reason: "上次JSON过长或不完整。重新返回一个完整、紧凑、可直接解析的JSON对象。",
              constraints: [
                "不要复制输入原文或解释原因",
                "删除reason、confidence和所有空字段",
                "合并重复项，保留事实、否定、纠正和儿童特色词",
                "JSON必须在限制内完整结束"
              ]
            })
          }
        ];
      }
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  }
  throw lastError;
}

function looksLikeNoise(text) {
  const normalized = String(text || "").replace(/[\s，。！？、,.!?]/g, "");
  if (!normalized) return false;
  const hasStorySignal = /(今天|昨天|明天|后来|然后|因为|觉得|去了|来到|看到|遇到|一起|玩了|做了|帮助|参观|吃了|喝了|回家|上学|放学)/.test(normalized);
  const latinNoise = (normalized.match(/[A-Za-z]/g) || []).length >= 6;
  const repeatedNoise = /(.)\1{3,}|(哈哈){3,}|(呵呵){3,}|(嘿嘿){3,}/.test(normalized);
  return !hasStorySignal && (latinNoise || repeatedNoise);
}

function looksLikeNarrationControl(text) {
  const value = String(text || "").replace(/[\s，。！？、,.!?]/g, "");
  if (!value) return false;
  return /^(?:(?:然后呢|还有呢|接着说|继续说|你说呀|你自己说|你先说|直接说你的))+$/u.test(value) ||
    /^(?:还有|有没有).{0,8}(?:什么|事情|内容).{0,8}(?:没说|要说|忘了说)$/u.test(value) ||
    /^(?:事情|故事).{0,6}(?:说完|讲完|完了)$/u.test(value) ||
    /^为什么.{0,8}(?:提醒|不说|还不说)$/u.test(value);
}

function isUsableDiaryFact(fact) {
  if (!fact || !fact.text) return false;
  const text = String(fact.text).trim();
  const quote = String(fact.quote || "").trim();
  if (!text) return false;
  if (looksLikeNoise(text)) return false;
  if (looksLikeNarrationControl(text) || looksLikeNarrationControl(quote)) return false;
  if (/^(我)?(说|讲)完(了|啦)?$|^结束(了)?$/u.test(text.replace(/[，。！!\s]/g, ""))) return false;
  const isIntro = /^(你好|大家好|早上好|晚上好|我叫)/u.test(text);
  const introContainsEvent = /(今天|昨天|明天|去了|来到|看到|遇到|一起|玩了|做了|帮助|上学|放学|回家)/u.test(text);
  if (isIntro && !introContainsEvent) return false;
  if (/(记不清|不记得|想不起来|不知道|不确定|可能|也许|大概|好像|猜)/u.test(text)) return false;
  const quoteIsUncertain = /(记不清|不记得|想不起来|不确定|可能是|也许是|大概是|好像是|猜.*是)/u.test(quote);
  const factIsAppearanceDetail = /(颜色|黑色|白色|红色|蓝色|粉色|衣服|鞋子|头发|长什么样)/u.test(text);
  if (quoteIsUncertain && factIsAppearanceDetail) return false;
  return true;
}

function normalizeSemanticText(text) {
  return String(text || "")
    .replace(/[，。！？、,.!?；;：:\s（）()《》“”"']/g, "")
    .replace(/^(今天|然后|后来|接着|最后|我|我们)+/g, "");
}

function semanticBigrams(text) {
  const value = normalizeSemanticText(text);
  const grams = new Set();
  for (let index = 0; index < value.length - 1; index += 1) grams.add(value.slice(index, index + 2));
  return grams;
}

function semanticSimilarity(left, right) {
  const a = normalizeSemanticText(left);
  const b = normalizeSemanticText(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 5 ? 1 : 0;
  const aGrams = semanticBigrams(a);
  const bGrams = semanticBigrams(b);
  if (!aGrams.size || !bGrams.size) return 0;
  let shared = 0;
  for (const gram of aGrams) if (bGrams.has(gram)) shared += 1;
  return (2 * shared) / (aGrams.size + bGrams.size);
}

function hasDistinctSharedPhrase(left, right) {
  const generic = new Set(["今天我", "我们一", "们一起", "然后我", "后来我", "最后我", "回家后", "的时候"]);
  const a = normalizeSemanticText(left);
  const b = normalizeSemanticText(right);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  for (let size = Math.min(5, shorter.length); size >= 3; size -= 1) {
    for (let index = 0; index <= shorter.length - size; index += 1) {
      const phrase = shorter.slice(index, index + size);
      if (generic.has(phrase) || /^(今天|我们|一起|然后|后来|最后)/u.test(phrase)) continue;
      if (longer.includes(phrase)) return true;
    }
  }
  return false;
}

function dedupeSemanticFacts(facts) {
  const unique = [];
  for (const fact of facts) {
    const factText = normalizeSemanticText(fact.text);
    const duplicateIndex = unique.findIndex(existing => {
      if (existing.slot !== fact.slot) return false;
      const existingText = normalizeSemanticText(existing.text);
      const contained = Math.min(existingText.length, factText.length) >= 5 &&
        (existingText.includes(factText) || factText.includes(existingText));
      return existingText === factText || contained || semanticSimilarity(existing.text, fact.text) >= 0.9;
    });
    if (duplicateIndex < 0) {
      unique.push(fact);
      continue;
    }
    const existing = unique[duplicateIndex];
    if (normalizeSemanticText(fact.text).length > normalizeSemanticText(existing.text).length * 1.18) {
      unique[duplicateIndex] = fact;
    }
  }
  return unique;
}

function isLowValueQuestion(question) {
  return /(什么颜色|哪种颜色|穿.{0,6}衣服|衣服.{0,6}(什么|哪种|颜色)|长什么样|多大|大小|什么形状|头发|鞋子|还在.{0,8}吗|在旁边|放在(哪里|哪儿)|带走了吗|拿回家了吗)/u.test(String(question || ""));
}

function removeAggregateDuplicateFacts(facts) {
  return facts.filter((fact, index, list) => {
    const text = String(fact.text || "");
    const quote = String(fact.quote || "");
    const containedFacts = list.filter((other, otherIndex) => {
      if (otherIndex === index) return false;
      const otherText = String(other.text || "");
      const otherQuote = String(other.quote || "");
      if (otherText.length < 4 && otherQuote.length < 4) return false;
      return (otherText && text.includes(otherText)) || (otherQuote && quote.includes(otherQuote));
    });
    return containedFacts.length < 2;
  });
}

async function refineFollowupWithQwen(input, rejectedQuestion, facts) {
  const messages = [
    {
      role: "system",
      content: "你是儿童口述日记的引导老师。当前问题可能太琐碎、重复了已问事实，或 target_key 过于笼统。请改问另一个尚未引导的具体事实或新事件；target_key 必须指向口述中可识别的具体事件，不能只写‘感受’‘细节’‘结果’等抽象维度。优先原因、关键过程、结果或感受；禁止问外貌、衣服、颜色、大小、名字。若没有高价值缺口就结束引导。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: { action: "ask_followup|suggest_finish", reason: "missing_detail|missing_result|missing_feeling|complete", question: "简短问题或空字符串", target_key: "问题针对的事实或事件简称" },
        full_transcript: input.text || "",
        known_facts: facts,
        rejected_question: rejectedQuestion,
        previous_questions: input.previousQuestions || [],
        previous_question_keys: input.previousQuestionKeys || []
      })
    }
  ];
  return callQwenJson(messages);
}

async function analyzeWithQwen(input) {
  const fallback = {
    facts: [],
    decision: { action: "keep_listening", reason: "model_unavailable", question: "", question_status: "none" },
    speech_quality: "unclear"
  };
  const messages = [
    {
      role: "system",
      content: "你是儿童口述日记产品的事实抽取和追问老师。麦克风可能同时收到孩子叙事、家长引导、旁人对话或电视声。只能抽取孩子自己在讲述主线故事的内容，家长如何提醒说话、旁人如何指挥、媒体台词和与主线无可解释关系的语句都不是日记事实。不能添加孩子没说过的事实。追问必须由本次口述动态生成，紧贴有效的孩子叙事。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "从本轮孩子口述中抽取事实，并结合已有事实判断下一步是否追问。",
        schema: {
          facts: [{ slot: "what|detail|feeling|result|raw", label: "中文短标签", text: "事实文本", quote: "孩子原话片段", source_role: "child_story|adult_guidance|background_audio|meta_speech|uncertain", story_relation: "main|related|new_explicit_event|unrelated" }],
          decision: {
            action: "ask_followup|suggest_finish|redirect",
            reason: "missing_what|missing_detail|missing_feeling|missing_result|complete",
            question: "如果需要追问，只问一个适合5-9岁孩子的问题",
            target_key: "本次问题针对的具体事实或事件简称",
            question_status: "answered|invalidated|skipped|pending|none"
          },
          speech_quality: "coherent|unclear|nonsense|unsafe",
          segment_role: "child_story|adult_guidance|background_audio|meta_speech|mixed|unclear"
        },
        rules: [
          "以 recent_text 作为本轮新收音，current_text 只用于理解上下文和故事主线。facts 的 quote 必须能在 recent_text 中找到。",
          "先判断 segment_role。家长或旁人在提示‘然后呢’‘还有什么没说’‘你自己说’、纠正说话方式、讨论是否说完时，属于 adult_guidance 或 meta_speech，facts 返回空数组。",
          "由于 ASR 没有说话人分离，出现‘我’不代表一定是孩子。‘我邀请某人一起说’‘我提醒他自己说’‘为什么还不说’等讨论讲述过程本身的语句仍是 meta_speech，不是故事事件。",
          "电视、广播、短视频或旁人对话中突然出现的台词、口号、誓词、广告语，与已知人物、地点、时间或活动没有清楚关系时，属于 background_audio，facts 返回空数组。",
          "只接收 source_role=child_story 且 story_relation 为 main、related 或 new_explicit_event 的事实。无法确定说话人或与主线关系时标为 uncertain，不要当成事实。",
          "必须抽取 recent_text 中 existing_facts 尚未覆盖的所有清晰且相关的孩子叙事；人物、活动、地点变化和后续事件都要保留。",
          "如果 current_text 无法抽取结构化事实，返回 raw。",
          "把孩子明确做过或经历过的主要事件归为 what，把对象特征、过程、见闻等补充信息归为 detail。",
          "已有事实不要重复抽取。",
          "追问最多只问一个问题。",
          "先识别 current_text 最后出现且尚未讲清楚的对象、关系或事件，再选择最有帮助的缺口：对象缺特征、行为缺过程、关系变化缺原因、事件缺结果、情绪缺原因。",
          "问题中必须自然引用 current_text 里的具体人物、物品、动作或事件词，让孩子知道你在问哪件事。",
          "不要问已经能从 current_text 或 existing_facts 回答的问题。",
          "如果有 current_question，只用 answer_text_since_question 判断问题状态，不能用提问前的旧口述冒充回答。",
          "明确回答问题返回 answered；孩子说‘你听错了’‘不是……’或纠正了问题前提返回 invalidated；孩子持续讲了另一件明确内容、已经自然跳过旧问题返回 skipped；仍在回答或新增内容很短返回 pending。",
          "屏幕上的问题都是可选表达提示，不要求孩子按顺序逐一回答；未回答的旧问题不能阻塞新问题。",
          "状态为 invalidated 或 skipped 时放弃旧问题；状态为 pending 只表示旧问题尚未回答，但孩子已继续讲出新的实质内容时，仍可生成一个不同的新问题。",
          "previous_questions 是已经显示过的问题，禁止重复或换一种说法再次询问。",
          "previous_question_keys 是已经引导过的事实或事件。同一个 target_key 整个讲述过程最多问一次，不得再追问该事实的另一个细节。",
          "只要孩子又讲出了不同的事实或新事件，且该事实还有高价值缺口，就可以继续生成新问题，直到孩子主动结束。不要因为已经问过几个问题或已达到最低成文条件就停止。",
          "先判断 recent_text 的质量。随机字母、重复音节、无意义逗趣、脏话起哄或无法组成事件的乱说标为 nonsense/unsafe：facts 返回空数组，action 返回 redirect，只温和邀请孩子回到真实故事，绝不追问乱说内容里的词。",
          "如果 recent_text 同时含有孩子故事和家长引导或背景声，segment_role 返回 mixed，但 facts 只保留孩子叙事部分。",
          "姓名、自我介绍、某个字怎么写以及语音识别纠错本身不是日记主体，不要围绕这些内容追问；纠错后回到孩子讲述的主要事件。",
          "孩子说记不清、不知道、不确定、可能或猜测的描述不能抽成确定事实，也不要继续追问这项琐碎信息。",
          "追问价值优先级：事件原因或结果 > 关键过程 > 孩子感受 > 有助识别对象的特征。除非不问就无法确认对象，否则禁止把颜色、大小、形状当作追问。",
          "问题要短，一次只问一件事，不要用‘你是怎么做的’之类泛化问题，除非没有任何更具体的问法。",
          "只有当前故事没有新的高价值表达缺口时才 suggest_finish；孩子继续讲出新事件后要重新判断，不受之前‘已完整’状态影响。"
        ],
        current_text: input.text,
        kind: input.kind,
        existing_facts: input.existingFacts || [],
        current_question: input.currentQuestion || null,
        answer_text_since_question: input.answerTextSinceQuestion || "",
        previous_questions: input.previousQuestions || [],
        previous_question_keys: input.previousQuestionKeys || [],
        recent_text: input.recentText || input.text || "",
        followup_count: input.followupCount || 0,
        max_followups: input.maxFollowups || 50
      })
    }
  ];
  const result = await callQwenJson(messages);
  const recentText = input.recentText || input.text || "";
  const quality = result.speech_quality || "coherent";
  const segmentRole = result.segment_role || "child_story";
  let candidateFacts = Array.isArray(result.facts) ? result.facts : [];
  const hasChildStoryFact = candidateFacts.some(fact => fact?.source_role === "child_story");
  if (["adult_guidance", "background_audio", "meta_speech"].includes(segmentRole) && !hasChildStoryFact) {
    return {
      facts: [],
      decision: { action: "keep_listening", reason: "non_story_audio", question: "", question_status: input.currentQuestion ? "pending" : "none" },
      speech_quality: quality,
      segment_role: segmentRole
    };
  }
  if (["nonsense", "unsafe"].includes(quality) || looksLikeNoise(recentText)) {
    return {
      facts: [],
      decision: {
        action: "redirect",
        reason: "unclear",
        question: "我们回到今天的小故事吧，你刚才和谁一起做了什么呀？",
        question_status: input.currentQuestion ? "skipped" : "none"
      },
      speech_quality: quality === "unsafe" ? "unsafe" : "nonsense"
    };
  }
  const existingFacts = Array.isArray(input.existingFacts) ? input.existingFacts : [];
  const supportedSlots = new Set(["what", "detail", "feeling", "result", "raw"]);
  const facts = dedupeSemanticFacts(removeAggregateDuplicateFacts(candidateFacts
    .filter(fact => fact && fact.slot && fact.text)
    .filter(fact => !fact.source_role || fact.source_role === "child_story")
    .filter(fact => !fact.story_relation || ["main", "related", "new_explicit_event"].includes(fact.story_relation))
    .map(fact => supportedSlots.has(fact.slot) ? fact : { ...fact, slot: "detail" })
    .filter(isUsableDiaryFact)
    .filter(fact => !existingFacts.some(existing =>
      existing.text === fact.text || semanticSimilarity(existing.text, fact.text) >= 0.72 ||
      (existing.quote && fact.quote && existing.quote === fact.quote)
    ))
    .filter((fact, index, list) => list.findIndex(other =>
      other.text === fact.text || (other.quote && fact.quote && other.quote === fact.quote)
    ) === index)));
  const allFacts = [...existingFacts.filter(isUsableDiaryFact), ...facts];
  const slots = new Set(allFacts.map(fact => fact.slot));
  const configuredLimit = Number(input.maxFollowups || 0);
  const reachedLimit = configuredLimit > 0 && Number(input.followupCount || 0) >= configuredLimit;
  const allowedStatuses = new Set(["answered", "invalidated", "skipped", "pending", "none"]);
  const rawStatus = result.decision?.question_status;
  const answerText = String(input.answerTextSinceQuestion || "").replace(/\s+/g, "");
  const correctionIntent = /(你|小耳朵)?听错(了)?|识别错(了)?|说错(了)?|不对|不是.{0,16}(是|叫)|我(没有|没)说/.test(answerText);
  const generatedDifferentQuestion = result.decision?.action === "ask_followup" &&
    result.decision?.question &&
    result.decision.question !== input.currentQuestion?.question;
  let questionStatus = "none";
  if (input.currentQuestion) {
    if (correctionIntent) questionStatus = "invalidated";
    else if (allowedStatuses.has(rawStatus) && rawStatus !== "none") questionStatus = rawStatus;
    else if (generatedDifferentQuestion && answerText.length >= 4) questionStatus = "skipped";
    else questionStatus = "pending";
  }
  let decision = { ...(result.decision || fallback.decision), question_status: questionStatus };
  if (decision.action === "ask_followup") {
    decision.target_key = String(decision.target_key || decision.question || decision.reason || "").trim();
    const previousKeys = (input.previousQuestionKeys || []).map(key => String(key).trim()).filter(Boolean);
    let genericTarget = /^(感受|心情|结果|细节|过程|原因|事件|故事|其他)$/u.test(decision.target_key);
    if (genericTarget) {
      const concreteFact = [...facts, ...existingFacts].reverse().find(fact => fact.slot === "what") ||
        [...facts, ...existingFacts].reverse().find(fact => ["detail", "result"].includes(fact.slot));
      if (concreteFact?.text) {
        decision.target_key = concreteFact.text;
        genericTarget = false;
      }
    }
    const matchingFact = [...facts, ...existingFacts].reverse().find(fact =>
      fact?.text && (hasDistinctSharedPhrase(decision.target_key, fact.text) || semanticSimilarity(decision.target_key, fact.text) >= 0.48)
    );
    if (matchingFact?.text) decision.target_key = matchingFact.text;
    const repeatsTarget = previousKeys.some(key =>
      key === decision.target_key || key.includes(decision.target_key) || decision.target_key.includes(key) ||
      semanticSimilarity(key, decision.target_key) >= 0.66
    );
    const repeatsQuestion = (input.previousQuestions || []).some(question =>
      question === decision.question || semanticSimilarity(question, decision.question) >= 0.62
    );
    if (genericTarget || repeatsTarget || repeatsQuestion) {
      const refined = await refineFollowupWithQwen(input, decision.question, allFacts);
      const refinedKey = String(refined.target_key || refined.reason || "").trim();
      const refinedGeneric = /^(感受|心情|结果|细节|过程|原因|事件|故事|其他)$/u.test(refinedKey);
      const refinedRepeats = !refinedKey || refinedGeneric || previousKeys.some(key =>
        key === refinedKey || key.includes(refinedKey) || refinedKey.includes(key) || semanticSimilarity(key, refinedKey) >= 0.66
      ) || (input.previousQuestions || []).some(question =>
        question === refined.question || semanticSimilarity(question, refined.question) >= 0.62
      );
      decision = refined.action === "ask_followup" && refined.question && !refinedRepeats
        ? { ...refined, target_key: refinedKey, question_status: questionStatus }
        : { action: "suggest_finish", reason: "duplicate_target", question: "", target_key: "", question_status: questionStatus };
    }
  }
  const storyHasEnoughShape = allFacts.some(fact => fact.slot === "feeling") &&
    allFacts.filter(fact => ["what", "detail", "result"].includes(fact.slot)).length >= 3;
  if (reachedLimit) {
    decision = { action: "suggest_finish", reason: "complete", question: "", question_status: questionStatus };
  } else if (storyHasEnoughShape && decision.action === "ask_followup" && decision.reason === "missing_result") {
    decision = { action: "suggest_finish", reason: "complete", question: "", question_status: questionStatus };
  } else if (decision.action === "ask_followup" && isLowValueQuestion(decision.question)) {
    const storySlots = new Set(allFacts.map(fact => fact.slot));
    if (storySlots.has("what") && storySlots.has("detail") && storySlots.has("feeling")) {
      decision = { action: "suggest_finish", reason: "complete", question: "", question_status: questionStatus };
    } else {
      const refined = await refineFollowupWithQwen(input, decision.question, allFacts);
      if (refined.action === "ask_followup" && refined.question && !isLowValueQuestion(refined.question)) {
        decision = { ...refined, question_status: questionStatus };
      } else {
        decision = { action: "suggest_finish", reason: "complete", question: "", question_status: questionStatus };
      }
    }
  }
  if (decision.action === "suggest_finish") {
    const previousKeys = (input.previousQuestionKeys || []).map(key => String(key).trim()).filter(Boolean);
    const newestEvent = [...facts].reverse().find(fact => fact.slot === "what");
    const eventAlreadyAsked = newestEvent && previousKeys.some(key =>
      key === newestEvent.text || key.includes(newestEvent.text) || newestEvent.text.includes(key) ||
      semanticSimilarity(key, newestEvent.text) >= 0.66
    );
    if (newestEvent && !eventAlreadyAsked) {
      const question = !slots.has("feeling")
        ? `“${newestEvent.text}”的时候，你是什么感觉呀？`
        : `“${newestEvent.text}”后来怎么样了？`;
      decision = {
        action: "ask_followup",
        reason: slots.has("feeling") ? "missing_result" : "missing_feeling",
        question,
        target_key: newestEvent.text,
        question_status: questionStatus
      };
    }
  }
  return { facts, decision, speech_quality: quality, segment_role: segmentRole };
}

async function handleAsr(req, res) {
  const body = await collectBody(req);
  const fields = parseMultipart(body, getBoundary(req.headers["content-type"]));
  const audio = fields.audio;

  if (!audio?.content?.length) {
    sendJson(res, 400, { error: "missing_audio" });
    return;
  }

  try {
    if (!process.env.TENCENT_SECRET_ID || !process.env.TENCENT_SECRET_KEY) {
      sendJson(res, 503, { error: "asr_not_configured", message: "腾讯语音识别服务未配置。" });
      return;
    }
    const text = await transcribeWithTencent(audio);
    sendJson(res, 200, { text: text || "", provider: "tencent" });
    return;
  } catch (error) {
    sendJson(res, 502, { error: "asr_failed", message: error.message });
  }
}

async function readJson(req) {
  const body = await collectBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function parseStoredJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function presentStoredDiary(row) {
  return {
    id: row.id,
    title: row.title,
    sentences: parseStoredJson(row.sentences_json, []),
    transcript: row.transcript || "",
    facts: parseStoredJson(row.facts_json, []),
    savedAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validatedDiaryInput(input) {
  const id = String(input.id || "").trim();
  const title = String(input.title || "我的日记").trim().slice(0, 80);
  const sentences = Array.isArray(input.sentences) ? input.sentences.slice(0, 80) : [];
  const facts = Array.isArray(input.facts) ? input.facts.slice(0, 200) : [];
  const transcript = String(input.transcript || "").slice(0, 30000);
  const savedAt = Number(input.savedAt);
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(id)) throw new Error("invalid_diary_id");
  if (!sentences.length || sentences.some(item => !item || typeof item.text !== "string" || item.text.length > 1000)) {
    throw new Error("invalid_diary_sentences");
  }
  return {
    id,
    title: title || "我的日记",
    sentences,
    facts,
    transcript,
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : null
  };
}

async function handleCreateDiary(req, res, user) {
  let diary;
  try {
    diary = validatedDiaryInput(await readJson(req));
  } catch (error) {
    sendError(res, 400, error.message || "invalid_diary", "日记内容格式不正确。");
    return;
  }
  const input = diary;
  const now = Date.now();
  const original = database.prepare("SELECT created_at FROM diaries WHERE user_id = ? AND id = ?").get(user.id, input.id);
  const createdAt = original?.created_at || input.savedAt || now;
  database.prepare(`
    INSERT INTO diaries(user_id, id, title, sentences_json, transcript, facts_json, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, id) DO UPDATE SET
      title = excluded.title,
      sentences_json = excluded.sentences_json,
      transcript = excluded.transcript,
      facts_json = excluded.facts_json,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(
    user.id,
    input.id,
    input.title,
    JSON.stringify(input.sentences),
    input.transcript,
    JSON.stringify(input.facts),
    createdAt,
    now
  );
  const row = database.prepare("SELECT * FROM diaries WHERE user_id = ? AND id = ?").get(user.id, input.id);
  sendJson(res, original ? 200 : 201, { diary: presentStoredDiary(row) });
}

function handleListDiaries(res, user) {
  const rows = database.prepare(`
    SELECT * FROM diaries
    WHERE user_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 500
  `).all(user.id);
  sendJson(res, 200, { diaries: rows.map(presentStoredDiary) });
}

function handleGetDiary(res, user, diaryId) {
  const row = database.prepare("SELECT * FROM diaries WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
    .get(user.id, diaryId);
  if (!row) {
    sendError(res, 404, "diary_not_found", "没有找到这篇日记。");
    return;
  }
  sendJson(res, 200, { diary: presentStoredDiary(row) });
}

function handleDeleteDiary(res, user, diaryId) {
  const result = database.prepare("DELETE FROM diaries WHERE user_id = ? AND id = ?")
    .run(user.id, diaryId);
  if (!result.changes) {
    sendError(res, 404, "diary_not_found", "没有找到这篇日记。");
    return;
  }
  sendJson(res, 200, { deleted: true, id: diaryId });
}

async function handleGuardianConsent(req, res, user) {
  const input = await readJson(req);
  const policyVersion = String(input.policyVersion || "").trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(policyVersion)) {
    sendError(res, 400, "invalid_policy_version", "监护人同意版本格式不正确。");
    return;
  }
  const now = Date.now();
  database.prepare(`
    INSERT INTO guardian_consents(user_id, policy_version, consented_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      policy_version = excluded.policy_version,
      consented_at = CASE
        WHEN guardian_consents.policy_version = excluded.policy_version THEN guardian_consents.consented_at
        ELSE excluded.consented_at
      END,
      updated_at = excluded.updated_at
  `).run(user.id, policyVersion, now, now);
  sendJson(res, 200, { consented: true, policyVersion, consentedAt: now });
}

function handleDeleteAccount(res, user) {
  const result = database.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  if (!result.changes) {
    sendError(res, 404, "account_not_found", "没有找到需要删除的账户数据。");
    return;
  }
  sendJson(res, 200, { deleted: true });
}

async function handleAnalyze(req, res) {
  const input = await readJson(req);
  const result = await analyzeWithQwen(input);
  sendJson(res, 200, { ...result, provider: qwenConfig().apiKey ? "qwen" : "local" });
}

async function handleCompose(req, res) {
  await readJson(req);
  sendError(res, 410, "legacy_compose_removed", "成文已经合并到新的事实整理流程，请更新小程序版本。");
}

async function handleFinalize(req, res) {
  const startedAt = Date.now();
  const input = await readJson(req);
  console.log("Finalize started", {
    transcriptChars: String(input.transcript || "").length,
    inputFacts: Array.isArray(input.facts) ? input.facts.length : 0
  });
  const result = await finalizeFactDiary(input, callQwenJson);
  console.log("Finalize completed", {
    elapsedMs: Date.now() - startedAt,
    inputFacts: Array.isArray(input.facts) ? input.facts.length : 0,
    outputFacts: Array.isArray(result.facts) ? result.facts.length : 0,
    outputSentences: Array.isArray(result.sentences) ? result.sentences.length : 0
  });
  sendJson(res, 200, { ...result, provider: qwenConfig().apiKey ? "qwen" : "local" });
}

async function handleRevise(req, res) {
  const input = await readJson(req);
  const result = await reviseFactDiary(input, callQwenJson);
  sendJson(res, 200, { ...result, provider: qwenConfig().apiKey ? "qwen" : "local" });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const pathname = requestUrl.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });
    res.end();
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/session") {
    handleAuthSession(req, res).catch(error => sendError(res, 502, "auth_failed", error.message));
    return;
  }

  if (req.method === "POST" && pathname === "/api/guardian-consent") {
    const user = requireUser(req, res);
    if (!user) return;
    handleGuardianConsent(req, res, user).catch(error => sendError(res, 500, "consent_save_failed", error.message));
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/account") {
    const user = requireUser(req, res);
    if (!user) return;
    handleDeleteAccount(res, user);
    return;
  }

  if (pathname === "/api/diaries" || pathname.startsWith("/api/diaries/")) {
    const user = requireUser(req, res);
    if (!user) return;
    if (!requireGuardianConsent(user, res)) return;
    const diaryId = decodeURIComponent(pathname.slice("/api/diaries/".length));
    if (req.method === "POST" && pathname === "/api/diaries") {
      handleCreateDiary(req, res, user).catch(error => sendError(res, 500, "diary_save_failed", error.message));
      return;
    }
    if (req.method === "GET" && pathname === "/api/diaries") {
      handleListDiaries(res, user);
      return;
    }
    if (req.method === "GET" && diaryId) {
      handleGetDiary(res, user, diaryId);
      return;
    }
    if (req.method === "DELETE" && diaryId) {
      handleDeleteDiary(res, user, diaryId);
      return;
    }
    sendError(res, 405, "method_not_allowed", "不支持该操作。");
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/api/")) {
    const user = requireUser(req, res);
    if (!user) return;
    if (!requireGuardianConsent(user, res)) return;
  }

  if (req.method === "POST" && pathname === "/api/asr") {
    handleAsr(req, res).catch(error => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/analyze") {
    handleAnalyze(req, res).catch(error => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/compose") {
    handleCompose(req, res).catch(error => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/finalize") {
    handleFinalize(req, res).catch(error => {
      console.error("Finalize failed:", error.code || error.message);
      const modelIncomplete = ["MODEL_JSON_INVALID", "MODEL_OUTPUT_TRUNCATED"].includes(error.code);
      const modelTimeout = error.name === "TimeoutError" || error.name === "AbortError";
      sendJson(res, 500, {
        error: modelIncomplete || modelTimeout
          ? "模型返回不完整，已自动重试但仍未完成，请再试一次。"
          : error.message
      });
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/revise") {
    handleRevise(req, res).catch(error => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    sendJson(res, 200, {
      ok: true,
      service: "tongxin-diary-api",
      asr: Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),
      qwen: Boolean(qwenConfig().apiKey),
      factDiarySchema: 1,
      legacyCompose: false,
      storage: Boolean(database),
      auth: process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET ? "wechat" : process.env.ALLOW_DEVICE_AUTH === "true" ? "device-test" : "not-configured"
    });
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`童心日记 API 已启动：http://127.0.0.1:${PORT}`);
    if (!process.env.TENCENT_SECRET_ID || !process.env.TENCENT_SECRET_KEY) {
      console.log("未配置腾讯 ASR，/api/asr 会返回配置错误，不会伪造识别文本。");
    }
    console.log(qwenConfig().apiKey ? "已配置通义千问。" : "未配置通义千问，AI 接口会明确返回错误。");
  });
}

module.exports = { server };
