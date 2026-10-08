const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

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
  const current = authenticatedUser(req);
  if (current) {
    sendJson(res, 200, { token: bearerToken(req), authMode: current.auth_mode });
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
    model: process.env.QWEN_MODEL || "qwen-plus",
    baseUrl: (process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "")
  };
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in model response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function callQwenJson(messages) {
  const config = qwenConfig();
  if (!config.apiKey) throw new Error("QWEN_API_KEY is not configured");
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.1,
          max_tokens: 1600,
          response_format: { type: "json_object" }
        })
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Qwen failed: ${response.status} ${text.slice(0, 200)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content || "";
      return extractJson(content);
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (attempt >= 2 || !retryable) break;
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  }
  throw lastError;
}

function looksLikeNoise(text) {
  const normalized = String(text || "").replace(/[\s，。！？、,.!?]/g, "");
  if (!normalized) return false;
  const hasStorySignal = /(今天|昨天|明天|后来|然后|因为|觉得|去了|看到|遇到|一起|玩了|做了|帮助|博物馆|公园|学校)/.test(normalized);
  const latinNoise = (normalized.match(/[A-Za-z]/g) || []).length >= 6;
  const repeatedNoise = /(.)\1{3,}|(哈哈){3,}|(呵呵){3,}|(嘿嘿){3,}/.test(normalized);
  return !hasStorySignal && (latinNoise || repeatedNoise);
}

function looksLikeNarrationControl(text) {
  const value = String(text || "").replace(/[\s，。！？、,.!?]/g, "");
  if (!value) return false;
  return /(然后呢|还有呢|接着说|继续说|你说呀|你自己说|你先说|直接说你的)/u.test(value) ||
    /(还有|有没有).{0,8}(什么|事情|内容).{0,8}(没说|要说|忘了说)/u.test(value) ||
    /(事情|故事).{0,6}(说完|讲完|完了)/u.test(value) ||
    /为什么.{0,8}(提醒|不说|还不说)/u.test(value);
}

function hasConcreteStorySignal(text) {
  return /(去了|来到|参观|看到|遇到|吃了|喝了|玩了|做了|帮助|买了|坐了|爬了|滑了|跑了|走了|学了|读了|画了|搭了|回家|上学|放学|睡觉|洗澡|比赛)/u.test(String(text || ""));
}

function isLikelyNarrationControlFact(fact, recentText) {
  if (!looksLikeNarrationControl(recentText)) return false;
  const combined = `${fact?.text || ""}${fact?.quote || ""}`;
  return !hasConcreteStorySignal(combined);
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

function dedupeSemanticFacts(facts) {
  const unique = [];
  for (const fact of facts) {
    const duplicateIndex = unique.findIndex(existing =>
      existing.slot === fact.slot && semanticSimilarity(existing.text, fact.text) >= 0.72
    );
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
      content: "你是儿童口述日记的引导老师。当前问题可能太琐碎、重复了已问事实，或 target_key 过于笼统。请改问另一个尚未引导的具体事实或新事件；target_key 必须是‘玩滑滑梯’这样的具体事件，不能只写‘感受’‘细节’‘结果’。优先原因、关键过程、结果或感受；禁止问外貌、衣服、颜色、大小、名字。若没有高价值缺口就结束引导。只返回 JSON。"
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
            target_key: "本次问题针对的事实或事件简称，例如：玩滑滑梯",
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
  if (["adult_guidance", "background_audio", "meta_speech"].includes(segmentRole)) {
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
  let candidateFacts = Array.isArray(result.facts) ? result.facts : [];
  const supportedSlots = new Set(["what", "detail", "feeling", "result", "raw"]);
  const facts = dedupeSemanticFacts(removeAggregateDuplicateFacts(candidateFacts
    .filter(fact => fact && fact.slot && fact.text)
    .filter(fact => !fact.source_role || fact.source_role === "child_story")
    .filter(fact => !fact.story_relation || ["main", "related", "new_explicit_event"].includes(fact.story_relation))
    .filter(fact => !isLikelyNarrationControlFact(fact, recentText))
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

function factIsCovered(fact, usedFactTexts, sentences = []) {
  if ([...usedFactTexts].some(text =>
    text === fact.text || String(text).includes(fact.text) || fact.text.includes(String(text)) ||
    semanticSimilarity(text, fact.text) >= 0.68
  )) return true;
  return sentences.some(sentence =>
    semanticSimilarity(sentence.text, fact.text) >= 0.52 || hasDistinctSharedPhrase(sentence.text, fact.text)
  );
}

function hasDistinctSharedPhrase(left, right) {
  const generic = new Set(["今天我", "我们一", "们一起", "在公园", "公园里", "然后我", "后来我", "最后我", "回家后", "的时候"]);
  const a = normalizeSemanticText(left);
  const b = normalizeSemanticText(right);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  for (let size = Math.min(5, shorter.length); size >= 3; size -= 1) {
    for (let index = 0; index <= shorter.length - size; index += 1) {
      const phrase = shorter.slice(index, index + size);
      if (generic.has(phrase) || /^(今天|我们|一起|然后|后来|最后|公园)/u.test(phrase)) continue;
      if (longer.includes(phrase)) return true;
    }
  }
  return false;
}

function dedupeCompositionSentences(sentences) {
  const unique = [];
  for (const sentence of sentences || []) {
    if (!sentence?.text) continue;
    const duplicate = unique.find(existing => semanticSimilarity(existing.text, sentence.text) >= 0.68);
    if (!duplicate) {
      unique.push(sentence);
      continue;
    }
    duplicate.factTexts = [...new Set([
      ...(Array.isArray(duplicate.factTexts) ? duplicate.factTexts : []),
      ...(Array.isArray(sentence.factTexts) ? sentence.factTexts : [])
    ])];
  }
  return unique;
}

function normalizeRepeatedThen(sentences) {
  let seenThen = false;
  let replacementIndex = 0;
  const replacements = ["接着", "后来", "接下来"];
  return (sentences || []).map(sentence => ({
    ...sentence,
    text: String(sentence.text || "").replace(/然后/gu, () => {
      if (!seenThen) {
        seenThen = true;
        return "然后";
      }
      const replacement = replacements[Math.min(replacementIndex, replacements.length - 1)];
      replacementIndex += 1;
      return replacement;
    })
  }));
}

function compositionPenalty(draft) {
  const sentences = Array.isArray(draft?.sentences) ? draft.sentences : [];
  let penalty = sentences.length ? 0 : 100;
  const thenCount = (sentences.map(sentence => String(sentence?.text || "")).join("").match(/然后/gu) || []).length;
  if (thenCount > 1) penalty += (thenCount - 1) * 10;
  for (const sentence of sentences) {
    const text = String(sentence?.text || "").trim();
    if (text.length < 5) penalty += 8;
    if (!/[。！？!?]$/.test(text)) penalty += 2;
    if (/(与之前矛盾|保留原话|事实冲突|编辑说明)/u.test(text)) penalty += 20;
    if (/(.{2,5})(?:之后|以后|接着|然后).{0,4}\1/u.test(text)) penalty += 12;
    if (/(吃完|做完|玩完|看完|说完).{0,6}\1/u.test(text)) penalty += 12;
    if (/(之后|以后|接着|然后|因为|所以|但是)[，。！？!?]?$/u.test(text)) penalty += 10;
    if (!/(我|我们|爸爸|妈妈|老师|哥哥|姐姐|弟弟|妹妹|同学|朋友|小朋友|他|她|大家)/u.test(text)) penalty += 3;
  }
  return penalty;
}

async function repairCompositionWithQwen(input, draft, facts, missingFacts) {
  const messages = [
    {
      role: "system",
      content: "你是儿童日记的事实覆盖校对老师。把遗漏事实自然合并进现有短日记，不能简单追加重复句，不能新增事实。相同活动的连续动作要合成一个事件；感受放在对应事件之后。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: { title: "短标题", sentences: [{ text: "一句日记", factTexts: ["实际使用的事实 text"] }] },
        rules: [
          "所有 facts 都必须覆盖且每个事实只表达一次。",
          "每个独立句子必须有明确主语和谓语，优先使用孩子事实中的‘我、我们、爸爸、妈妈、老师、哥哥’作为主语；禁止写‘在公园玩了滑滑梯’这类缺主语句，应写‘我在公园玩了滑滑梯’。并列动作可以共用一次主语。",
          "爬上滑梯、从滑梯滑下等同一活动的连续阶段合并成一句或一个紧凑事件，不能拆成重复叙述。",
          "按时间和事件顺序组织：发生了什么、过程或结果、最后感受；感受不得放在对应事情之前。",
          "离开某地点、回家、吃晚饭或睡觉等收尾事件出现后，之前地点的活动绝不能再放到文章末尾。遗漏事实必须合并回它原本发生的位置。",
          "忽略并禁止写入记不清、不确定、可能、猜测的内容。",
          "保持儿童口吻，不写编辑说明，不添加原话没有的信息。"
        ],
        facts,
        missing_facts: missingFacts,
        current_draft: draft,
        original_utterances: input.utterances || []
      })
    }
  ];
  return callQwenJson(messages);
}

async function polishCompositionWithQwen(input, draft, facts) {
  const messages = [
    {
      role: "system",
      content: "你是小学低年级句子表达校对老师。只调整已有事实的句子结构、先后顺序和衔接，不新增任何事实。让孩子能从成文中学习完整的主谓宾句子，同时保留孩子自己的形容和口吻。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: { title: "短标题", sentences: [{ text: "完整句子", factTexts: ["实际使用的事实 text"] }] },
        rules: [
          "每个独立句子都要有明确主语和谓语，需要宾语的动作必须有宾语。地点或时间可以放句首，但后面仍必须出现主语，例如‘在公园里，我遇到了哥哥’。",
          "按小学低年级句子表达组织正文：一句主要表达一件事或一个连续动作，句子过长时按事件边界断句，不能把许多事情只用逗号串成一整句。",
          "同一主语的连续动作可以在一句中共享一次主语；换了人物或另起一句时必须重新写出主语，不能出现无主句和零散短语。",
          "严格按孩子口述的时间顺序。公园活动全部放在离开公园或回家之前；回家、吃晚饭、洗澡、睡觉等收尾事件之后不能再出现白天或公园活动。",
          "每个事实只表达一次。已经合并进句子的滑滑梯、荡秋千、比赛等活动不得在末尾再次补写。",
          "优先原样保留孩子口述中的形容词和有特点的表达，不擅自替换成近义词；禁止新增原话没有的形容词、副词、天气、心情、评价、因果或华丽词语。",
          "把重复口头禅改成自然衔接，全文‘然后’最多一次，可以按真实先后使用‘……之后、接着、后来、最后’。",
          "factTexts 必须使用 facts 中的原始 text，列出该句覆盖的全部事实；不得只列一部分而导致系统误判遗漏。"
        ],
        facts,
        current_draft: draft,
        original_utterances: input.utterances || []
      })
    }
  ];
  return callQwenJson(messages);
}

async function composeWithQwen(input) {
  const facts = dedupeSemanticFacts((input.facts || [])
    .filter(fact => ["what", "detail", "result", "feeling"].includes(fact.slot))
    .filter(isUsableDiaryFact));
  const messages = [
    {
      role: "system",
      content: "你是帮助5-9岁儿童学习完整表达的口述日记整理老师。必须事实约束生成：不得添加孩子没说过的人物、地点、时间、天气、颜色、数量、动作、因果、评价或情绪。你可以调整语序、合并重复片段、补充必要的语法成分和连接词，让每句话完整、自然，前后有清楚的事件顺序，同时尽量保留孩子原本的词语和口吻。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "参考孩子完整口述，把事实池整理成句子完整、顺序清楚、适合5-9岁孩子学习表达的短日记。",
        schema: {
          title: "短标题",
          sentences: [{ text: "一句日记", factTexts: ["这句话使用到的事实 text"] }]
        },
        rules: [
          "每一句只能表达 facts 中已有的事实，factTexts 必须逐项列出该句实际使用的事实 text。",
          "可以调整语序、主语和谓语位置，合并相邻事实，去掉口头重复和无意义语气词。",
          "每个独立句子必须符合小学低年级可学习的完整表达：有明确主语和谓语，需要宾语时写清宾语。地点或时间放句首后仍要写主语，例如‘在公园里，我遇到了哥哥’，不能写成‘在公园遇到了哥哥’。",
          "一句主要表达一件事或一个连续动作；一个句子包含多个不同事件时，按事件边界用句号断开，不能只用逗号一直串联。连续动作仍应合并，不能为了断句重复同一活动。",
          "优先原样保留孩子收音中使用的形容词、叠词和有特点的说法，不擅自替换成更成人化的近义词，也不新增原话没有的形容词或副词。",
          "不要逐句照抄口头禅。孩子反复说‘然后’时，按真实先后关系自然改成‘……之后、接着、后来、最后’或直接分句；全文‘然后’最多出现一次。",
          "连接词只用于孩子已经明确表达的时间先后，不得为了文采新增因果、感受或场景。语言要比口述完整，但仍像孩子自己的日记，不使用成人化华丽词语。",
          "按真实时间顺序写：先写事件，再写过程和结果，最后写与该事件对应的感受；不能把感受放到事情发生之前。",
          "离开公园、回家、吃晚饭、洗澡或睡觉属于收尾节点；这些节点之后禁止再出现此前的公园或白天活动。",
          "同一个活动只叙述一次。连续动作属于同一事件时要合并，例如‘一起爬上滑梯’和‘再一起滑下来’应组成一个完整事件，不能拆成两次滑滑梯。",
          "严禁为了衔接而重复同一动作，不能写出‘吃完之后就只吃完’这类前后同义、缺少新信息的病句。",
          "可以使用‘今天、然后、后来、但是、所以’等连接词，但不能用连接词暗示孩子没有说过的因果。",
          "不要逐条照抄事实；要把零散短语组织成主谓完整、前后连贯的句子。",
          "人物、地点、物品和属性必须保持原绑定关系，禁止把‘公园里人多’改写成‘滑滑梯上人多’之类主体转移。",
          "同一主体的事实直接冲突时，只有原口述明确出现纠正关系才能采用较后的纠正；否则省略不确定冲突，不要自行判断。",
          "正文禁止出现‘与之前矛盾、保留原话、事实冲突’等编辑说明或括号注释。",
          "孩子说记不清、不知道、不确定、可能、猜测的内容不属于事实，禁止写入正文，也不能把猜测改成确定描述。",
          "保持儿童口吻，不使用成人作文腔，不扩写、不编细节。",
          "如果没有 feeling，不要写心情。"
        ],
        facts,
        original_utterances: input.utterances || []
      })
    }
  ];
  let result = await callQwenJson(messages);
  if (!Array.isArray(result.sentences)) result.sentences = [];
  result.sentences = dedupeCompositionSentences(result.sentences);
  if (compositionPenalty(result) > 0) {
    try {
      const polished = await polishCompositionWithQwen(input, result, facts);
      if (Array.isArray(polished.sentences)) polished.sentences = dedupeCompositionSentences(polished.sentences);
      if (compositionPenalty(polished) < compositionPenalty(result)) result = polished;
    } catch (error) {
      console.error("Optional composition polish failed:", error.message);
    }
  }
  let usedFactTexts = new Set(
    result.sentences.flatMap(sentence => Array.isArray(sentence.factTexts) ? sentence.factTexts : [])
  );
  let missingFacts = facts.filter(fact => !factIsCovered(fact, usedFactTexts, result.sentences));
  if (missingFacts.length) {
    try {
      const repaired = await repairCompositionWithQwen(input, result, facts, missingFacts);
      if (!Array.isArray(repaired.sentences)) repaired.sentences = [];
      repaired.sentences = dedupeCompositionSentences(repaired.sentences);
      if (repaired.sentences.length) result = repaired;
    } catch (error) {
      console.error("Optional composition repair failed:", error.message);
    }
  }
  // 不再把模型认为遗漏的事实机械追加到文章末尾。机械追加会破坏时间顺序，
  // 也会把已经合并表达过的活动再次写一遍；遗漏只允许通过上面的整体重排修复。
  result.sentences = normalizeRepeatedThen(dedupeCompositionSentences(result.sentences));
  return result;
}

function quoteAppearsInTranscript(quote, transcript) {
  const source = normalizeSemanticText(transcript);
  const fragment = normalizeSemanticText(quote);
  return fragment.length >= 2 && source.includes(fragment);
}

async function finalizeWithQwen(input) {
  const existingFacts = dedupeSemanticFacts((input.facts || [])
    .filter(fact => ["what", "detail", "result", "feeling"].includes(fact.slot))
    .filter(isUsableDiaryFact));
  const transcript = String(input.transcript || "");
  const messages = [
    {
      role: "system",
      content: "你是5-9岁儿童口述日记的最终事实审计器。麦克风里可能同时有孩子叙事、家长引导、旁人对话和电视声。先确定孩子持续讲述的主线事件，再审核已有事实和遗漏内容。只保留孩子在讲主线故事或明确相关后续事件的内容，不负责写文章。所有事实必须来自原始口述，不得新增、推测或润色。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "先识别主线故事并过滤串音，再逐段扫描 full_transcript，审核 known_facts 并补充遗漏事实。",
        schema: {
          main_story: { summary: "主线事件简述", anchors: ["主线人物、地点、时间或活动词"] },
          accepted_existing_fact_ids: ["应保留的 known_facts id"],
          excluded_existing_facts: [{ id: "应排除的 known_facts id", reason: "adult_guidance|background_audio|meta_speech|unrelated|uncertain" }],
          facts: [{ slot: "what|detail|feeling|result", label: "简短标签", text: "遗漏事实", quote: "孩子原话片段", source_role: "child_story", story_relation: "main|related|new_explicit_event" }]
        },
        rules: [
          "主线是孩子连续、重复或具有时间与人物关系的亲历事件。同一次出行中的多个活动、同行人、饮食、见闻和感受都可以属于主线，不能因为有多个活动就删掉。",
          "家长或旁人在提示下一句、追问还有什么没说、要求孩子自己说、讨论是否说完或纠正说话方式，都是 adult_guidance 或 meta_speech，必须排除。",
          "突然出现的广告语、台词、誓词、口号或成人化长句，如果与主线的人物、地点、时间和活动无清楚关系，视为 background_audio 并排除。不能因为它语法通顺就保留。",
          "与主线语义距离很大且没有明确过渡的单句按 unrelated 排除。孩子明确使用‘后来’‘回家后’‘第二天’等引入的新事件可标为 new_explicit_event 保留。",
          "accepted_existing_fact_ids 只能使用 known_facts 中真实存在的 id。每个 known_fact 必须在 accepted 或 excluded 中二选一，不能遗漏。",
          "facts 只返回 known_facts 没有覆盖、确定来自孩子叙事且与主线相关的事实，quote 必须是 full_transcript 里真实出现的片段。",
          "逐段扫描全部口述，主线中的人物、地点、活动、先后变化、结果和感受都不能丢；引导话、背景声、乱说、猜测和否定纠错不能当成新事实。",
          "事实 text 保留孩子原话里的关键形容词、叠词和人物关系，不改写成作文句子。",
          "同一事实不要重复返回；无法确定是孩子叙事还是旁人串音时，宁可标为 uncertain 排除，不得写入日记。"
        ],
        full_transcript: transcript,
        known_facts: existingFacts,
        previous_questions: input.previousQuestions || []
      })
    }
  ];
  let audit;
  try {
    audit = await callQwenJson(messages);
  } catch (error) {
    console.error("Final fact audit failed; using realtime facts:", error.message);
    audit = {
      accepted_existing_fact_ids: existingFacts.map(fact => fact.id).filter(Boolean),
      facts: [],
      main_story: null
    };
  }
  const knownIds = new Set(existingFacts.map(fact => fact.id).filter(Boolean));
  const allowedExclusionReasons = new Set(["adult_guidance", "background_audio", "meta_speech", "unrelated", "uncertain"]);
  const explicitlyExcludedIds = new Set((Array.isArray(audit.excluded_existing_facts) ? audit.excluded_existing_facts : [])
    .filter(item => knownIds.has(item?.id) && allowedExclusionReasons.has(item?.reason))
    .map(item => item.id));
  // A long model response can be truncated before every accepted id is listed. Only an
  // explicit exclusion with a supported reason may remove an existing realtime fact.
  const acceptedIds = new Set([...knownIds].filter(id => !explicitlyExcludedIds.has(id)));
  const acceptedExistingFacts = existingFacts.filter(fact => !fact.id || acceptedIds.has(fact.id));
  const excludedFactIds = existingFacts
    .filter(fact => fact.id && !acceptedIds.has(fact.id))
    .map(fact => fact.id);
  const candidates = Array.isArray(audit.facts) ? audit.facts : [];
  const newFacts = dedupeSemanticFacts(candidates
    .filter(fact => !fact.source_role || fact.source_role === "child_story")
    .filter(fact => !fact.story_relation || ["main", "related", "new_explicit_event"].includes(fact.story_relation))
    .filter(isUsableDiaryFact)
    .filter(fact => quoteAppearsInTranscript(fact.quote, transcript))
    .filter(fact => !acceptedExistingFacts.some(existing => semanticSimilarity(existing.text, fact.text) >= 0.72)));
  const allFacts = dedupeSemanticFacts([...acceptedExistingFacts, ...newFacts]);
  const result = await composeWithQwen({ facts: allFacts, utterances: [transcript] });
  return {
    facts: newFacts,
    acceptedFactIds: [...acceptedIds],
    excludedFactIds,
    mainStory: audit.main_story || null,
    title: result.title || "我的日记",
    sentences: normalizeRepeatedThen(result.sentences || [])
  };
}

async function reviseWithQwen(input) {
  const messages = [
    {
      role: "system",
      content: "你是儿童口述日记的事实修改模块。把孩子的语音修改指令转换为可验证的事实操作。只能修改明确对应的事实，不得猜测、不得改动未提及事实。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "根据 instruction 对 facts 生成替换、删除或补充操作。",
        schema: {
          operations: [{
            type: "replace|delete|add",
            target_fact_id: "replace/delete 必须填写现有事实 id；add 为空",
            anchor_fact_id: "add 若是对已有事件的补充，填写最相关的现有事实 id；独立新事件为空",
            placement: "add 使用 merge|before|after|independent；其他操作为空",
            slot: "what|detail|feeling|result",
            label: "简短中文标签",
            new_text: "replace/add 后的完整事实；delete 为空",
            reason: "为什么执行此操作"
          }],
          message: "没有安全可执行操作时，告诉孩子怎样说得更清楚"
        },
        rules: [
          "‘不是A，是B’通常是 replace，只修改包含A且语义对应的事实。",
          "‘我没有说A/删掉A’通常是 delete，只删除明确对应的事实。",
          "‘还要加上A/我还想说A’通常是 add，A必须是孩子明确说出的事实。",
          "如果现有事实是否定或误识别句，而 instruction 给出了同一事件的正确肯定说法，必须 replace 这条错误事实，不能只 add 正确说法后同时保留错误说法。例如现有‘没有读绘本’，孩子改为‘睡醒后开始读绘本’，应替换原事实。",
          "如果同一个错误事实在 facts 中有多个近似版本，返回对应的 delete 操作一并清除重复项，只保留一条修改后的正确事实。",
          "replace/delete 的 target_fact_id 必须来自 facts，禁止编造 id。",
          "孩子重新讲了一大段故事时，没再提到的旧事实不等于要删除；只把新信息作为 add，对明确纠正的同一事实作为 replace。",
          "已经出现在 facts 或 diary 中的人物、地点、活动和句子不得再返回 add；即使孩子在修改时又讲了一遍，也只视为原事实的重述。",
          "add 若补充同一事件内部的细节、结果或感受，填写 anchor_fact_id 且 placement=merge。",
          "add 若由‘之前、以前、之后、后来’等引入相邻事件，填写 anchor_fact_id 且 placement=before 或 after。独立新事件使用 independent。",
          "只有 instruction 明确说‘删掉’‘不要写’‘我没说’或‘不是……’时才能 delete；绝不能为了用新故事取代旧故事而批量 delete。",
          "不能确定目标事实时 operations 返回空数组，不得凭相似词强行修改。",
          "不要把指令措辞写进日记事实，只保留修改后的事实内容。"
        ],
        instruction: input.instruction || "",
        facts: input.facts || [],
        diary: input.diary || []
      })
    }
  ];
  return callQwenJson(messages);
}

async function extractSupplementalRevisionOperations(input) {
  const messages = [
    {
      role: "system",
      content: "你是儿童日记的续讲事实提取器。孩子正在已有日记后继续讲新的事情。逐段提取所有明确的新事件和感受，不重写旧日记，不把修改指令、家长提示、电视声或无意义语句当成事实。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "从 supplemental_speech 中找出 existing_facts 和 diary 尚未记录的全部明确事实，每件不同事情单独返回一项。",
        schema: { additions: [{ slot: "what|detail|feeling|result", label: "简短标签", text: "新增事实", quote: "口述中的原话片段", anchor_fact_id: "相关 existing_facts id 或空", placement: "merge|before|after|independent" }] },
        rules: [
          "按口述顺序扫描到结尾，人物、地点、活动、结果和感受都不能只取前两项就停止。",
          "text 保留孩子使用的人物关系、动作和形容词，但去掉嗯、然后然后等口头填充词。",
          "quote 必须逐字出现在 supplemental_speech 中；无法找到原话依据的内容不得返回。",
          "与 existing_facts 或 diary 已有内容相同、近似重复或只是换一种说法的内容不要返回。",
          "同一事件内部补充使用 merge；‘回家前’等发生在锚点事件前的内容用 before；‘之后、后来’用 after；无关系才用 independent。",
          "一句家长追问、操作说明、要求继续说或与故事无关的背景声不要返回。",
          "不要合并互不相同的事件，也不要添加孩子没有说过的原因、时间、地点或感受。"
        ],
        supplemental_speech: input.instruction || "",
        existing_facts: input.facts || [],
        diary: input.diary || []
      })
    }
  ];
  const result = await callQwenJson(messages);
  const existingTexts = [
    ...(input.facts || []).map(fact => fact?.text),
    ...(input.diary || []).map(sentence => typeof sentence === "string" ? sentence : sentence?.text)
  ].filter(Boolean);
  const removeKnownClauses = text => String(text || "")
    .split(/[，,。；;]/u)
    .map(clause => clause.trim())
    .filter(Boolean)
    .filter(clause => !existingTexts.some(existing =>
      semanticSimilarity(existing, clause) >= 0.52 ||
      (normalizeSemanticText(clause).length >= 5 && normalizeSemanticText(existing).includes(normalizeSemanticText(clause)))
    ))
    .join("，");
  return (Array.isArray(result.additions) ? result.additions : [])
    .filter(item => item?.text && item?.quote && quoteAppearsInTranscript(item.quote, input.instruction || ""))
    .map(item => ({ item, newText: removeKnownClauses(item.text) }))
    .filter(({ newText }) => newText)
    .map(({ item, newText }) => ({
        type: "add",
        target_fact_id: "",
        slot: ["what", "detail", "feeling", "result"].includes(item.slot) ? item.slot : "detail",
        label: item.label || "语音补充",
        new_text: newText,
        anchor_fact_id: (input.facts || []).some(fact => fact.id === item.anchor_fact_id) ? item.anchor_fact_id : "",
        placement: ["merge", "before", "after", "independent"].includes(item.placement) ? item.placement : "independent",
        reason: "孩子在历史日记后继续讲出的新事实"
      }));
}

function hasNegation(text) {
  return /(没有|没能|没去|没做|没看|没读|不是|不再|不会)/u.test(String(text || ""));
}

function sharesSpecificBigram(left, right) {
  const ignored = new Set(["今天", "然后", "后来", "我们", "之后", "开始", "一起", "回家"]);
  const strip = value => String(value || "").replace(/没有|没能|没去|没做|没看|没读|不是|不再|不会/gu, "");
  const leftGrams = semanticBigrams(strip(left));
  const rightGrams = semanticBigrams(strip(right));
  for (const gram of leftGrams) {
    if (!ignored.has(gram) && rightGrams.has(gram)) return true;
  }
  return false;
}

function normalizeRevisionOperations(input, operations) {
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const instruction = String(input.instruction || "");
  const compactInstruction = normalizeSemanticText(instruction);
  const isLongNarration = compactInstruction.length >= 36;
  const hasDeleteCue = /(删掉|删除|去掉|不要写|别写|我(没有|没)说|这句不对|不是)/u.test(instruction);
  const normalized = [...operations];
  for (let index = 0; index < normalized.length; index += 1) {
    const operation = normalized[index];
    if (operation?.type !== "add" || !operation.new_text || hasNegation(operation.new_text)) continue;
    const conflicting = facts.find(fact =>
      fact?.id && hasNegation(fact.text) && sharesSpecificBigram(fact.text, operation.new_text)
    );
    if (!conflicting) continue;
    normalized[index] = {
      ...operation,
      type: "replace",
      target_fact_id: conflicting.id,
      slot: operation.slot || conflicting.slot,
      label: operation.label || conflicting.label,
      reason: operation.reason || "用孩子刚刚说出的正确事实替换原来的否定误识别"
    };
  }

  const replacements = normalized.filter(operation => operation?.type === "replace");
  for (const replacement of replacements) {
    const target = facts.find(fact => fact.id === replacement.target_fact_id);
    if (!target) continue;
    for (const fact of facts) {
      if (!fact?.id || fact.id === target.id) continue;
      if (semanticSimilarity(fact.text, target.text) < 0.7) continue;
      if (normalized.some(operation => operation.type === "delete" && operation.target_fact_id === fact.id)) continue;
      normalized.push({ type: "delete", target_fact_id: fact.id, slot: fact.slot, label: fact.label, new_text: "", reason: "清除同一错误事实的重复版本" });
    }
  }
  const safe = [];
  const normalizeAddPlacement = operation => {
    const anchorExists = facts.some(fact => fact.id === operation.anchor_fact_id);
    const anchorFactId = anchorExists ? operation.anchor_fact_id : "";
    let placement = ["merge", "before", "after", "independent"].includes(operation.placement)
      ? operation.placement
      : anchorFactId ? "merge" : "independent";
    if (!anchorFactId && placement !== "independent") placement = "independent";
    return { ...operation, target_fact_id: "", anchor_fact_id: anchorFactId, placement };
  };
  for (const operation of normalized) {
    if (!operation || !["replace", "delete", "add"].includes(operation.type)) continue;
    const target = facts.find(fact => fact.id === operation.target_fact_id);
    if (operation.type === "delete") {
      if (!target || !hasDeleteCue || (isLongNarration && !sharesSpecificBigram(instruction, target.text))) continue;
    }
    if (operation.type === "replace") {
      if (!target || !operation.new_text) continue;
      const correctionCue = /(不是|听错|识别错|说错|改成|应该是|其实是|是.{1,20}不是)/u.test(instruction);
      const related = sharesSpecificBigram(target.text, operation.new_text) ||
        sharesSpecificBigram(instruction, target.text) ||
        semanticSimilarity(target.text, operation.new_text) >= 0.45;
      if (!related || (isLongNarration && !correctionCue && !sharesSpecificBigram(instruction, target.text))) {
        safe.push(normalizeAddPlacement({ ...operation, type: "add", target_fact_id: "" }));
        continue;
      }
    }
    const safeOperation = operation.type === "add" ? normalizeAddPlacement(operation) : operation;
    if (safeOperation.type === "add") {
      const duplicatesExisting = facts.some(fact =>
        normalizeSemanticText(fact.text) === normalizeSemanticText(safeOperation.new_text) ||
        normalizeSemanticText(fact.text).includes(normalizeSemanticText(safeOperation.new_text)) ||
        normalizeSemanticText(safeOperation.new_text).includes(normalizeSemanticText(fact.text)) ||
        semanticSimilarity(fact.text, safeOperation.new_text) >= 0.55
      );
      if (duplicatesExisting) continue;
    }
    const duplicatesOperation = safe.some(existing => {
      if (existing.type !== safeOperation.type) return false;
      if (safeOperation.type !== "add" && existing.target_fact_id !== safeOperation.target_fact_id) return false;
      if (!existing.new_text && !safeOperation.new_text) return true;
      return normalizeSemanticText(existing.new_text) === normalizeSemanticText(safeOperation.new_text) ||
        normalizeSemanticText(existing.new_text).includes(normalizeSemanticText(safeOperation.new_text)) ||
        normalizeSemanticText(safeOperation.new_text).includes(normalizeSemanticText(existing.new_text)) ||
        semanticSimilarity(existing.new_text, safeOperation.new_text) >= (safeOperation.type === "add" ? 0.76 : 0.86);
    });
    if (duplicatesOperation) continue;
    safe.push(safeOperation);
  }
  return safe;
}

function fallbackRevisionOperations(input) {
  const instruction = String(input.instruction || "").trim();
  const facts = (input.facts || []).filter(fact => fact?.id && fact?.text);
  const clean = value => String(value || "")
    .replace(/^[“”'"，,。；;：:\s]+|[“”'"，,。；;：:\s]+$/gu, "")
    .replace(/^(?:这句|这一句|文章里|日记里)/u, "")
    .trim();
  const findTarget = fragment => {
    const targetText = clean(fragment);
    if (!targetText) return null;
    const direct = facts.find(fact => fact.text.includes(targetText) || targetText.includes(fact.text));
    if (direct) return direct;
    return facts
      .map(fact => ({ fact, score: semanticSimilarity(fact.text, targetText) }))
      .filter(item => item.score >= 0.52)
      .sort((left, right) => right.score - left.score)[0]?.fact || null;
  };

  const correction = /不是(.{1,100}?)[，,。；;\s]*(?:而是|应该是|是)(.{1,140})/u.exec(instruction) ||
    /把(.{1,100}?)(?:改成|改为|换成|换为)(.{1,140})/u.exec(instruction);
  if (correction) {
    const target = findTarget(correction[1]);
    const newText = clean(correction[2]);
    if (target && newText) {
      return [{ type: "replace", target_fact_id: target.id, slot: target.slot || "detail", label: target.label || "语音修改", new_text: newText, reason: "按孩子明确说出的替换指令修改" }];
    }
  }

  const deletion = /(?:把)?(.{1,120}?)(?:删掉|删除|去掉|不要写)/u.exec(instruction) ||
    /(?:删掉|删除|去掉|不要写)(.{1,120})/u.exec(instruction);
  if (deletion) {
    const target = findTarget(deletion[1]);
    if (target) return [{ type: "delete", target_fact_id: target.id, slot: target.slot || "detail", label: target.label || "语音修改", new_text: "", reason: "按孩子明确说出的删除指令修改" }];
  }

  const addition = /(?:加上|补充|还要写|还要加上)(.{1,160})/u.exec(instruction);
  const newText = clean(addition?.[1]);
  if (newText && !facts.some(fact => semanticSimilarity(fact.text, newText) >= 0.78)) {
    return [{ type: "add", target_fact_id: "", anchor_fact_id: "", placement: "independent", slot: "detail", label: "语音补充", new_text: newText, reason: "按孩子明确说出的补充指令增加" }];
  }
  return [];
}

function dedupeRevisedSentences(sentences) {
  const unique = [];
  for (const sentence of sentences || []) {
    if (!sentence?.text) continue;
    const normalized = normalizeSemanticText(sentence.text);
    const duplicate = unique.find(existing =>
      normalizeSemanticText(existing.text) === normalized
    );
    if (!duplicate) {
      unique.push(sentence);
      continue;
    }
    duplicate.factTexts = [...new Set([
      ...(Array.isArray(duplicate.factTexts) ? duplicate.factTexts : []),
      ...(Array.isArray(sentence.factTexts) ? sentence.factTexts : [])
    ])];
    duplicate.factIds = [...new Set([
      ...(Array.isArray(duplicate.factIds) ? duplicate.factIds : []),
      ...(Array.isArray(sentence.factIds) ? sentence.factIds : [])
    ])];
  }
  return unique;
}

function sentenceMatchesRevision(sentence, operation, originalFact, anchorFact) {
  if (operation.target_fact_id && (sentence.factIds || []).includes(operation.target_fact_id)) return true;
  if (operation.type === "add" && operation.placement === "merge" && operation.anchor_fact_id && (sentence.factIds || []).includes(operation.anchor_fact_id)) return true;
  const candidates = [
    operation.old_text,
    originalFact?.text,
    operation.type === "add" && operation.placement === "merge" ? anchorFact?.text : ""
  ].filter(Boolean);
  return candidates.some(text =>
    String(sentence.text || "").includes(text) ||
    (sentence.factTexts || []).some(source => semanticSimilarity(source, text) >= 0.58)
  );
}

function deterministicRevisionText(sentence, operations, linkedFacts) {
  let text = String(sentence.text || "");
  let replaced = false;
  for (const operation of operations) {
    if (operation.type === "replace" && operation.old_text && operation.new_text && text.includes(operation.old_text)) {
      text = text.replace(operation.old_text, operation.new_text);
      replaced = true;
    }
  }
  if (replaced) return text;
  return linkedFacts.length ? `${linkedFacts.map(fact => fact.text).join("，")}。` : "";
}

function revisionChangeIsValid(change, operations) {
  if (!change?.text) return false;
  return operations.every(operation => {
    if (operation.type !== "replace") return true;
    const includesNew = operation.new_text && (
      String(change.text).includes(operation.new_text) ||
      semanticSimilarity(change.text, operation.new_text) >= 0.48
    );
    const keepsOld = operation.old_text && String(change.text).includes(operation.old_text);
    return includesNew && !keepsOld;
  });
}

async function reviseLockedCompositionWithQwen(input) {
  const lockedDiary = Array.isArray(input.lockedDiary) ? input.lockedDiary : [];
  const operations = Array.isArray(input.revisionOperations) ? input.revisionOperations : [];
  const facts = (input.facts || []).filter(fact => fact.active !== false && isUsableDiaryFact(fact));
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const originalFacts = new Map();
  for (const operation of operations) {
    if (operation.target_fact_id && operation.old_text) {
      originalFacts.set(operation.target_fact_id, { id: operation.target_fact_id, text: operation.old_text });
    }
  }
  const operationsForSentence = sentence => operations.filter(operation =>
    sentenceMatchesRevision(sentence, operation, originalFacts.get(operation.target_fact_id), factById.get(operation.anchor_fact_id))
  );
  const affectedSentences = lockedDiary.filter(sentence => operationsForSentence(sentence).length > 0);
  const addedFacts = operations
    .filter(operation => operation.type === "add" && operation.applied_fact_id && !(operation.anchor_fact_id && operation.placement === "merge"))
    .map(operation => factById.get(operation.applied_fact_id))
    .filter(Boolean);
  const messages = [
    {
      role: "system",
      content: "你是儿童日记的局部修改器。第一版日记已锁定，只能改写包含本次受影响事实的句子，其他句子一个字也不能改。不得重新生成整篇，不得加入修改指令之外的新信息。只返回 JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: {
          changes: [{ sentenceId: "受影响的原句 id", text: "修改后完整句子", factTexts: ["本句使用的有效事实 text"] }],
          additions: [{ anchorSentenceId: "相关原句 id 或空", position: "before|after|end", text: "新增事实组成的完整句子", factTexts: ["新增事实 text"] }]
        },
        rules: [
          "changes 只能使用 affected_sentences 中的 sentenceId。",
          "replace 要在原句位置替换错误信息；delete 只删除目标事实，保留该句里其他事实。",
          "未受影响的句子不返回，系统会原样保留。",
          "placement=merge 的 add 必须合并进对应 affected_sentence。before/after 按 operation 的 anchor_fact_id 找到原句并设置位置。",
          "独立新增事件按时间和语境选择相邻原句；无法判断时 position=end。",
          "每个修改后句子要有主语和谓语，不重复动作，不新增事实。",
          "factTexts 只能使用 active_facts 里完整的 text。"
        ],
        instruction: input.revisionInstruction || "",
        operations,
        affected_sentences: affectedSentences,
        added_facts: addedFacts,
        active_facts: facts
      })
    }
  ];
  let result;
  try {
    result = await callQwenJson(messages);
  } catch {
    result = { changes: [], additions: [] };
  }
  const changes = new Map((result.changes || []).map(change => [change.sentenceId, change]));
  const activeFactTexts = new Set(facts.map(fact => fact.text));
  const revised = [];
  for (const sentence of lockedDiary) {
    const sentenceOperations = operationsForSentence(sentence);
    if (!sentenceOperations.length) {
      revised.push(sentence);
      continue;
    }
    const linkedIds = new Set(sentence.factIds || []);
    for (const operation of sentenceOperations) {
      if (operation.target_fact_id) linkedIds.add(operation.target_fact_id);
      if (operation.applied_fact_id) linkedIds.add(operation.applied_fact_id);
    }
    const linkedActiveFacts = [...linkedIds].map(id => factById.get(id)).filter(Boolean);
    if (!linkedActiveFacts.length) continue;
    const change = changes.get(sentence.id);
    const validFactTexts = (change?.factTexts || []).filter(text => activeFactTexts.has(text));
    const coversLinkedFacts = linkedActiveFacts.every(fact => validFactTexts.includes(fact.text));
    const validChange = validFactTexts.length && coversLinkedFacts && revisionChangeIsValid(change, sentenceOperations);
    const fallbackText = deterministicRevisionText(sentence, sentenceOperations, linkedActiveFacts);
    revised.push({
      ...sentence,
      text: validChange ? change.text : fallbackText,
      factTexts: validChange ? validFactTexts : linkedActiveFacts.map(fact => fact.text),
      factIds: validChange
        ? facts.filter(fact => validFactTexts.includes(fact.text)).map(fact => fact.id)
        : linkedActiveFacts.map(fact => fact.id)
    });
  }
  const additions = (Array.isArray(result.additions) ? result.additions : [])
    .map(item => ({
      ...item,
      matchingFacts: addedFacts.filter(fact => (item.factTexts || []).includes(fact.text))
    }))
    .filter(item => item.text && item.matchingFacts.length)
    .sort((left, right) => right.matchingFacts.length - left.matchingFacts.length);
  const coveredAddedFactIds = new Set();
  const generatedAdditionSentences = [];
  const placementForFact = fact => {
    const operation = operations.find(item => item.type === "add" && item.applied_fact_id === fact.id);
    const anchorSentence = operation?.anchor_fact_id
      ? lockedDiary.find(sentence => (sentence.factIds || []).includes(operation.anchor_fact_id))
      : null;
    return {
      anchorSentenceId: anchorSentence?.id || "",
      position: ["before", "after"].includes(operation?.placement) ? operation.placement : ""
    };
  };
  for (const addition of additions) {
    const uncoveredFacts = addition.matchingFacts.filter(fact => !coveredAddedFactIds.has(fact.id));
    if (!uncoveredFacts.length) continue;
    const allFactsAreUncovered = addition.matchingFacts.every(fact => !coveredAddedFactIds.has(fact.id));
    if (!allFactsAreUncovered) continue;
    const factPlacements = addition.matchingFacts.map(placementForFact);
    const operationPlacement = factPlacements[0];
    const hasMixedPlacement = factPlacements.some(placement =>
      placement.anchorSentenceId !== operationPlacement.anchorSentenceId || placement.position !== operationPlacement.position
    );
    if (hasMixedPlacement) continue;
    const anchorSentenceId = operationPlacement.anchorSentenceId || (lockedDiary.some(sentence => sentence.id === addition.anchorSentenceId) ? addition.anchorSentenceId : "");
    const position = operationPlacement.position || (["before", "after", "end"].includes(addition.position) ? addition.position : "end");
    generatedAdditionSentences.push({
      id: `sentence_added_${Date.now()}_${revised.length + generatedAdditionSentences.length}`,
      text: addition.text,
      factTexts: addition.matchingFacts.map(fact => fact.text),
      factIds: addition.matchingFacts.map(fact => fact.id),
      anchorSentenceId,
      position
    });
    addition.matchingFacts.forEach(fact => coveredAddedFactIds.add(fact.id));
  }
  for (const fact of addedFacts) {
    if (coveredAddedFactIds.has(fact.id)) continue;
    const placement = placementForFact(fact);
    generatedAdditionSentences.push({
      id: `sentence_added_${Date.now()}_${revised.length + generatedAdditionSentences.length}`,
      text: `${fact.text}。`,
      factTexts: [fact.text],
      factIds: [fact.id],
      ...placement,
      position: placement.position || "end"
    });
  }
  const additionsBeforeSentence = new Map();
  const additionsAfterSentence = new Map();
  const trailingAdditions = [];
  for (const addition of generatedAdditionSentences) {
    const { anchorSentenceId, position, ...sentence } = addition;
    if (!anchorSentenceId || position === "end") { trailingAdditions.push(sentence); continue; }
    const target = position === "before" ? additionsBeforeSentence : additionsAfterSentence;
    if (!target.has(anchorSentenceId)) target.set(anchorSentenceId, []);
    target.get(anchorSentenceId).push(sentence);
  }
  const orderedSentences = [];
  for (const sentence of revised) {
    orderedSentences.push(...(additionsBeforeSentence.get(sentence.id) || []), sentence, ...(additionsAfterSentence.get(sentence.id) || []));
  }
  orderedSentences.push(...trailingAdditions);
  let title = input.lockedTitle || "我的日记";
  for (const operation of operations) {
    if (operation.type === "replace" && operation.old_text && operation.new_text && title.includes(operation.old_text)) {
      title = title.replace(operation.old_text, operation.new_text);
    }
  }
  return {
    title,
    sentences: dedupeRevisedSentences(orderedSentences)
  };
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
  const result = database.prepare(`
    UPDATE diaries SET deleted_at = ?, updated_at = ?
    WHERE user_id = ? AND id = ? AND deleted_at IS NULL
  `).run(Date.now(), Date.now(), user.id, diaryId);
  if (!result.changes) {
    sendError(res, 404, "diary_not_found", "没有找到这篇日记。");
    return;
  }
  sendJson(res, 200, { deleted: true, id: diaryId });
}

async function handleAnalyze(req, res) {
  const input = await readJson(req);
  const result = await analyzeWithQwen(input);
  sendJson(res, 200, { ...result, provider: qwenConfig().apiKey ? "qwen" : "local" });
}

async function handleCompose(req, res) {
  const input = await readJson(req);
  const result = Array.isArray(input.lockedDiary) && Array.isArray(input.revisionOperations)
    ? await reviseLockedCompositionWithQwen(input)
    : await composeWithQwen(input);
  sendJson(res, 200, { ...result, provider: qwenConfig().apiKey ? "qwen" : "local" });
}

async function handleFinalize(req, res) {
  const input = await readJson(req);
  const result = await finalizeWithQwen(input);
  sendJson(res, 200, { ...result, provider: qwenConfig().apiKey ? "qwen" : "local" });
}

async function handleRevise(req, res) {
  const input = await readJson(req);
  const result = await reviseWithQwen(input);
  const validIds = new Set((input.facts || []).map(fact => fact.id));
  let rawOperations = Array.isArray(result.operations) ? [...result.operations] : [];
  const revisionInstruction = String(input.instruction || "");
  const hasExplicitEditCue = /不是.{1,160}?(?:而是|应该是|是)|(?:改成|改为|换成|换为|删掉|删除|去掉|不要写)/u.test(revisionInstruction);
  const isSupplementalNarration = normalizeSemanticText(revisionInstruction).length >= 36 && !hasExplicitEditCue;
  if (isSupplementalNarration) {
    try {
      const supplementalOperations = await extractSupplementalRevisionOperations(input);
      if (supplementalOperations.length) {
        rawOperations = rawOperations.filter(operation => operation?.type !== "add");
        rawOperations.push(...supplementalOperations);
      }
    } catch (error) {
      console.error("Supplemental revision extraction failed:", error.message);
    }
  }
  let normalizedOperations = normalizeRevisionOperations(input, rawOperations);
  if (!normalizedOperations.length) normalizedOperations = normalizeRevisionOperations(input, fallbackRevisionOperations(input));
  const operations = normalizedOperations.filter(operation => {
    if (!["replace", "delete", "add"].includes(operation?.type)) return false;
    if (operation.type === "add") return Boolean(operation.new_text);
    if (!validIds.has(operation.target_fact_id)) return false;
    return operation.type === "delete" || Boolean(operation.new_text);
  });
  sendJson(res, 200, {
    operations,
    revisionMode: isSupplementalNarration ? "supplemental_narration" : "targeted_edit",
    message: result.message || "",
    provider: qwenConfig().apiKey ? "qwen" : "local"
  });
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

  if (pathname === "/api/diaries" || pathname.startsWith("/api/diaries/")) {
    const user = requireUser(req, res);
    if (!user) return;
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
      console.error("Finalize failed:", error.message);
      sendJson(res, 500, { error: error.message });
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
      storage: Boolean(database),
      auth: process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET ? "wechat" : process.env.ALLOW_DEVICE_AUTH === "true" ? "device-test" : "not-configured"
    });
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`童心日记 API 已启动：http://127.0.0.1:${PORT}`);
  if (!process.env.TENCENT_SECRET_ID || !process.env.TENCENT_SECRET_KEY) {
    console.log("未配置腾讯 ASR，/api/asr 会返回配置错误，不会伪造识别文本。");
  }
  console.log(qwenConfig().apiKey ? "已配置通义千问。" : "未配置通义千问，AI 接口会明确返回错误。");
});
