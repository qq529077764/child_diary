const crypto = require("crypto");

const FACT_SLOTS = new Set(["what", "detail", "result", "feeling"]);
const WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
const REVISION_STOP_WORDS = new Set(["我", "我们", "你", "他", "她", "它", "这", "那", "这里", "那里", "这个", "那个", "的", "了", "着", "给", "把", "被", "就", "又", "还", "然后", "先", "再", "才", "和", "跟", "在", "到"]);

function text(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function compactText(value) {
  return text(value, 30000).replace(/[\s，。！？、,.!?；;：:“”"'（）()《》]/gu, "");
}

function contentWords(value) {
  return [...WORD_SEGMENTER.segment(text(value, 10000))]
    .filter(item => item.isWordLike)
    .map(item => item.segment)
    .filter(item => !REVISION_STOP_WORDS.has(item));
}

function isUnstatedReduction(before, after, instruction, addedContext = "") {
  if (/(?:不要|别写|删除|删掉|去掉|取消|不是|改成|改为|换成|应该|其实|顺序|先.+再|先.+才)/u.test(instruction)) return false;
  const beforeWords = new Set(contentWords(before));
  const afterWords = new Set(contentWords(after));
  const contextWords = new Set(contentWords(addedContext));
  if (!beforeWords.size || !afterWords.size) return false;
  const added = [...afterWords].filter(word => !beforeWords.has(word) && !contextWords.has(word));
  const omitted = [...beforeWords].filter(word => !afterWords.has(word));
  return added.length === 0 && omitted.length > 0;
}

function eventOverlapScore(left, right) {
  const leftWords = new Set(contentWords(left));
  const rightWords = new Set(contentWords(right));
  const smaller = Math.min(leftWords.size, rightWords.size);
  if (!smaller) return 0;
  const shared = [...leftWords].filter(word => rightWords.has(word)).length;
  return shared >= 2 ? shared / smaller : 0;
}

function sharesEventCore(left, right) {
  const pairs = words => words.slice(0, -1).map((word, index) => `${word}\u0000${words[index + 1]}`);
  const leftPairs = new Set(pairs(contentWords(left)));
  if (!leftPairs.size) return false;
  return pairs(contentWords(right)).some(pair => leftPairs.has(pair));
}

function isContextOnlyExpansion(before, after, instruction) {
  const beforeWords = new Set(contentWords(before));
  const afterWords = new Set(contentWords(after));
  if (beforeWords.size < 2 || afterWords.size <= beforeWords.size) return false;
  const keepsWholeEvent = [...beforeWords].every(word => afterWords.has(word));
  return keepsWholeEvent && eventOverlapScore(before, instruction) < 0.5;
}

function normalizeRevisionInstruction(value) {
  const source = text(value, 5000);
  return source.replace(/不是([^，,。；;！？!?]{1,100})[，,]\s*(?:而)?是([^，,。；;！？!?]{1,160})/gu, (match, rejected, accepted, offset) => {
    const previous = source[offset - 1] || "";
    return !previous || /[，,。；;！？!?]/u.test(previous) ? accepted.trim() : `是${accepted.trim()}`;
  });
}

function removeRedundantClauses(value) {
  const clauses = text(value, 1200).split(/[，,；;]+/u).map(item => item.trim()).filter(Boolean);
  const kept = [];
  const keptWords = [];
  for (const clause of clauses) {
    const words = new Set(contentWords(clause));
    const repeatsEarlier = words.size >= 2 && keptWords.some(previous => [...words].every(word => previous.has(word)));
    if (repeatsEarlier) continue;
    kept.push(clause);
    keptWords.push(words);
  }
  return kept.join("，");
}

function removeRedundantSentences(values) {
  const items = values.map((sentence, index) => ({ sentence, index, words: new Set(contentWords(sentence.text)) }));
  return items.filter(item => !items.some(other => {
    if (other.index === item.index || item.words.size < 2 || other.words.size < item.words.size) return false;
    if (other.words.size === item.words.size && other.index > item.index) return false;
    return [...item.words].every(word => other.words.has(word));
  })).map(item => item.sentence);
}

function mergeRewritePlans(rewrites, sentences) {
  const indexById = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const prepared = (rewrites || []).map(item => {
    const targetSentenceIds = uniqueStrings(item?.targetSentenceIds).filter(id => indexById.has(id));
    const indexes = targetSentenceIds.map(id => indexById.get(id)).sort((left, right) => left - right);
    return { ...item, targetSentenceIds, start: indexes[0], end: indexes[indexes.length - 1] };
  }).filter(item => item.targetSentenceIds.length).sort((left, right) => left.start - right.start);
  const groups = [];
  for (const item of prepared) {
    const current = groups[groups.length - 1];
    const currentTexts = new Set((current?.items || []).flatMap(entry => (entry.sentences || []).map(sentence => compactText(sentence?.text))));
    const itemTexts = new Set((item.sentences || []).map(sentence => compactText(sentence?.text)));
    const repeatsSameResult = [...itemTexts].some(value => value && currentTexts.has(value));
    if (!current || (item.start > current.end && !repeatsSameResult)) {
      groups.push({ start: item.start, end: item.end, items: [item] });
    } else {
      current.end = Math.max(current.end, item.end);
      current.items.push(item);
    }
  }
  return groups.map(group => {
    const targetSentenceIds = sentences.slice(group.start, group.end + 1).map(sentence => sentence.id);
    const facts = group.items.flatMap(item => Array.isArray(item?.facts) ? item.facts : []);
    const factKeys = new Set(facts.map(fact => text(fact?.key, 128)).filter(Boolean));
    const sentenceByText = new Map();
    for (const sentence of group.items.flatMap(item => Array.isArray(item?.sentences) ? item.sentences : [])) {
      const sentenceText = text(sentence?.text, 1200);
      if (!sentenceText) continue;
      const existing = sentenceByText.get(sentenceText) || { ...sentence, factKeys: [] };
      existing.factKeys = uniqueStrings([...(existing.factKeys || []), ...(sentence?.factKeys || [])]).filter(key => factKeys.has(key));
      sentenceByText.set(sentenceText, existing);
    }
    return { targetSentenceIds, facts, sentences: [...sentenceByText.values()] };
  });
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(value => text(value)).filter(Boolean))];
}

function joinEvidence(values) {
  const items = uniqueStrings(values);
  if (items.length <= 1) return items[0] || "";
  return items.map(item => item.replace(/[，。；,.;]+$/u, "")).join("；");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeFact(value, options = {}) {
  const factText = text(value?.text);
  if (!factText) return null;
  const id = text(value?.id, 128) || newId(options.prefix || "fact");
  const slot = FACT_SLOTS.has(value?.slot) ? value.slot : "detail";
  return {
    id,
    sourceFactIds: uniqueStrings(value?.sourceFactIds).map(value => text(value, 128)),
    slot,
    label: text(value?.label, 80) || "日记事实",
    text: factText,
    quote: text(value?.quote, 1000),
    source: text(value?.source, 80) || options.source || "实时识别",
    active: true
  };
}

function dedupeFacts(values) {
  const result = [];
  const seenIds = new Set();
  const seenMeanings = new Set();
  for (const value of values || []) {
    const fact = normalizeFact(value);
    if (!fact || seenIds.has(fact.id)) continue;
    const meaning = compactText(fact.text);
    const quote = compactText(fact.quote);
    const key = `${fact.slot}:${meaning}:${quote}`;
    if (meaning && seenMeanings.has(key)) continue;
    seenIds.add(fact.id);
    if (meaning) seenMeanings.add(key);
    result.push(fact);
  }
  return result;
}

function transcriptContainsQuote(transcript, quote) {
  const source = compactText(transcript);
  const fragment = compactText(quote);
  return fragment.length >= 2 && source.includes(fragment);
}

function factAuditMessages(transcript, knownFacts) {
  return [
    {
      role: "system",
      content: "你是5—9岁儿童口述日记的事实整理员。你只整理事实，不写文章。对照完整口述，把实时抽取产生的重复、残缺事实合并成一份准确、有序、完整的事实清单。所有内容必须来自孩子口述，不得推测、扩写或润色。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把knownFacts整理成可直接用于成文的finalFacts。",
        schema: {
          finalFacts: [{ sourceFactIds: ["支撑这条事实的knownFacts ID"], slot: "what|detail|result|feeling", label: "简短标签", text: "人物、动作和对象完整且准确的简洁事实", quote: "仅在knownFacts完全遗漏时填写完整口述中的连续原话" }]
        },
        rules: [
          "finalFacts只选择日记的关键事件，以及与关键事件直接相关的具体描述、孩子用过的形容和明确感受；不要求使用每个knownFact。",
          "同一件事的残片能组成完整事实时才合并；仍缺少人物、动作或对象的片段不进入finalFacts，不同事件不要强行合并，相邻人物不能串换归属。",
          "按完整口述的真实顺序输出；原话明确表达先后、转折或因果时，把这层关系保留在对应事实中，无意义的口头‘然后’不必保留。",
          "保留孩子原本的称呼、物品名称、形容词、叠词和有特点的表达，不自行换词。",
          "成人引导、讲述过程讨论、无关背景声、重复细枝末节和无法确认的内容不进入finalFacts；孩子明确纠正时采用纠正后的内容。",
          "只有knownFacts完全遗漏了有效内容时，才允许sourceFactIds为空；此时quote必须是fullTranscript中逐字连续出现的原话。"
        ],
        fullTranscript: transcript,
        knownFacts: knownFacts.map(fact => ({
          id: fact.id,
          slot: fact.slot,
          text: fact.text,
          quote: fact.quote
        }))
      })
    }
  ];
}

function applyFactAudit(transcript, knownFacts, audit) {
  const knownIds = new Set(knownFacts.map(fact => fact.id));
  const knownById = new Map(knownFacts.map(fact => [fact.id, fact]));
  const usedIds = new Set();
  const finalFacts = [];

  for (const item of (Array.isArray(audit?.finalFacts) ? audit.finalFacts : [])) {
    const sourceFactIds = uniqueStrings(item?.sourceFactIds).map(value => text(value, 128));
    if (sourceFactIds.some(id => !knownIds.has(id) || usedIds.has(id))) continue;
    let quote = "";
    if (sourceFactIds.length) {
      sourceFactIds.forEach(id => usedIds.add(id));
      quote = joinEvidence(sourceFactIds.map(id => knownById.get(id)?.quote));
    } else {
      quote = text(item?.quote, 1000);
      if (!transcriptContainsQuote(transcript, quote)) continue;
    }
    const fact = normalizeFact({
      ...item,
      id: sourceFactIds[0] || undefined,
      sourceFactIds,
      quote,
      source: "最终事实整理"
    }, { prefix: "fact", source: "最终事实整理" });
    if (!fact) continue;
    finalFacts.push(fact);
  }
  return dedupeFacts(finalFacts);
}

function compositionMessages(facts) {
  return [
    {
      role: "system",
      content: "你是帮助5—9岁儿童学习语言组织的口述日记整理老师。把已经确认的事实整理成简洁、自然、有顺序的儿童日记。内容只能来自事实池，不得添加孩子没说过的人物、动作、地点、物品、原因、结果或心情。可以重组语序、补全必要语法成分，并根据已经确认的先后顺序添加少量自然过渡。保留孩子自己的称呼、形容词、叠词和口吻，不擅自造词，不写成人作文腔。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把finalFacts组织成一篇小学低年级能学习的短日记。",
        schema: {
          title: "简短标题",
          sentences: [{ text: "自然完整的句子。", factIds: ["本句实际使用的事实ID"] }]
        },
        rules: [
          "正文只能使用finalFacts，按清单顺序表达；factIds使用实际支撑句子的真实ID。",
          "把相关事实组成主谓宾清楚的自然句子，人物变化时说清人物，不能串换人物或留下缺少动作对象的残句。",
          "保留事实中已有的先后、转折和因果关系；事件转换需要承接时可补少量中性的时间承接词，但不能补具体时间、原因或结果。",
          "去掉收音残片和重复口头语。反复出现的‘然后’按语义删除或合并，全文‘然后’原则上不超过一次，不机械替换成一串连接词。",
          "保留孩子的称呼、物品名称、形容词、叠词和口吻；心情只能来自feeling事实，标题不拔高主题。"
        ],
        finalFacts: facts.map(fact => ({
          id: fact.id,
          slot: fact.slot,
          text: fact.text,
          quote: fact.quote
        }))
      })
    }
  ];
}

function normalizeComposition(raw, facts, options = {}) {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const allowedSentenceIds = new Set(options.allowedSentenceIds || []);
  const seenSentenceIds = new Set();
  const invalidFactIds = [];
  const sentences = [];
  for (const item of (Array.isArray(raw?.sentences) ? raw.sentences : []).slice(0, 20)) {
    let sentenceText = text(item?.text, 1200);
    if (!sentenceText) continue;
    if (!/[。！？!?]$/u.test(sentenceText)) sentenceText += "。";
    const requestedIds = uniqueStrings(item?.factIds).map(value => text(value, 128));
    for (const id of requestedIds) if (!factById.has(id)) invalidFactIds.push(id);
    const factIds = requestedIds.filter(id => factById.has(id));
    if (!factIds.length) continue;
    let id = text(item?.id, 128);
    if (!id || seenSentenceIds.has(id) || (allowedSentenceIds.size && !allowedSentenceIds.has(id))) id = newId("sentence");
    seenSentenceIds.add(id);
    const linkedFacts = factIds.map(factId => factById.get(factId));
    const factTexts = uniqueStrings(linkedFacts.map(fact => fact.text));
    const sourceTexts = uniqueStrings(linkedFacts.map(fact => fact.quote));
    sentences.push({
      id,
      text: sentenceText,
      factIds,
      factTexts,
      factSummary: factTexts.join("；"),
      sourceText: joinEvidence(sourceTexts)
    });
  }
  return {
    title: text(raw?.title, 80) || options.fallbackTitle || "我的日记",
    sentences,
    diagnostics: { invalidFactIds: uniqueStrings(invalidFactIds) }
  };
}

function compositionIssues(composition, facts, options = {}) {
  const hardIssues = [];
  const softIssues = [];
  if (!composition.sentences.length) hardIssues.push({ type: "empty_diary" });
  if (composition.diagnostics.invalidFactIds.length) {
    softIssues.push({ type: "ignored_unknown_fact_ids", factIds: composition.diagnostics.invalidFactIds });
  }
  const useCount = new Map(facts.map(fact => [fact.id, 0]));
  for (const sentence of composition.sentences) {
    for (const id of sentence.factIds) useCount.set(id, (useCount.get(id) || 0) + 1);
  }
  const missing = [...useCount].filter(([, count]) => count === 0).map(([id]) => id);
  const duplicate = [...useCount].filter(([, count]) => count > 1).map(([id]) => id);
  if (missing.length) softIssues.push({ type: "unmapped_facts", factIds: missing });
  if (duplicate.length) softIssues.push({ type: "reused_fact_binding", factIds: duplicate });
  const article = composition.sentences.map(sentence => sentence.text).join("");
  const thenCount = (article.match(/然后/gu) || []).length;
  if (thenCount > 1) softIssues.push({ type: "repeated_then", count: thenCount });
  return { hardIssues, softIssues };
}

async function composeFacts(facts, callJson, options = {}) {
  const messages = options.messages || compositionMessages(facts);
  const raw = await callJson(messages, { stage: options.stage || "compose_fact_diary", maxTokens: 2400, timeoutMs: 45000 });
  const composition = normalizeComposition(raw, facts, {
    fallbackTitle: options.fallbackTitle,
    allowedSentenceIds: options.allowedSentenceIds
  });
  const issues = compositionIssues(composition, facts);
  if (issues.hardIssues.length) {
    const error = new Error("日记事实没有完整整理好，请再试一次");
    error.code = "FACT_COMPOSITION_INVALID";
    error.issues = issues.hardIssues;
    throw error;
  }
  return { ...composition, quality: { softIssues: issues.softIssues } };
}

async function finalizeFactDiary(input, callJson) {
  const transcript = text(input?.transcript, 30000);
  if (!transcript) throw new Error("没有听到可以写进日记的事情");
  const knownFacts = dedupeFacts((Array.isArray(input?.facts) ? input.facts : []).filter(fact => fact?.active !== false));
  let audit = null;
  try {
    audit = await callJson(factAuditMessages(transcript, knownFacts), {
      stage: "audit_final_facts",
      maxTokens: 1800,
      timeoutMs: 40000
    });
  } catch (error) {
    if (!knownFacts.length) throw error;
    console.error("Final fact audit failed; using realtime facts:", error.code || error.message);
  }
  const facts = applyFactAudit(transcript, knownFacts, audit);
  if (!facts.length) throw new Error("没有听到可以写进日记的事情");
  const composition = await composeFacts(facts, callJson);
  return { title: composition.title, sentences: composition.sentences, facts, quality: composition.quality };
}

function revisionMessages(input, facts, sentences) {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  return [
    {
      role: "system",
      content: "你是儿童口述日记的局部修改老师。当前日记是底稿，修改口述只表达与底稿不同的部分：口述没有再次说到的细节不等于删除。请做最小改动，不猜测新事实。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "比较instruction与当前日记，分别返回新增内容和确实改变的旧内容；程序会把其余原句原样保留。",
        schema: {
          additions: [{
            insertBeforeSentenceId: "在这条原句前插入；与insertAfterSentenceId二选一",
            insertAfterSentenceId: "在这条原句后插入；与insertBeforeSentenceId二选一",
            facts: [{ key: "本次新增内唯一短ID", slot: "what|detail|result|feeling", label: "简短标签", text: "新增的完整事实" }],
            sentences: [{ text: "只写新增内容的完整句子", factKeys: ["本句使用的新增事实key"] }]
          }],
          rewrites: [{
            targetSentenceIds: ["确实被纠正、删除或调序的连续原句ID"],
            facts: [{ key: "本次改写内唯一短ID", slot: "what|detail|result|feeling", label: "简短标签", text: "改写范围内的完整事实" }],
            sentences: [{ text: "改写后的完整句子", factKeys: ["本句使用的改写事实key"] }]
          }],
          message: "没有明确修改时additions和rewrites都返回空数组，并简短说明还需要说清什么"
        },
        boundaries: [
          "按人物、动作、对象和发生阶段判断是不是同一事件，不按字面是否相同判断。同一事件换说法、补细节或纠正内容都放入rewrites；只有日记中没有对应事件才放入additions。",
          "同一事件的人物、地点、对象或结果与旧内容不同，就是冲突和纠正，即使口述没有说‘不是’也必须放入rewrites，不能把新旧两种说法并排新增。",
          "省略不是删除：旧内容只有被明确否定、纠正、删除或与新表达冲突时才改变，其他细节原样保留。",
          "新增内容只包含日记中原本不存在的事件；口述中顺带提到的原有前后事件只用于确定插入位置。",
          "先分别提取additions和rewrites，不能用rewrite承载新增事件。无法确定修改对象时两者都为空。"
        ],
        modeExample: {
          existing: "原句是事件B，含有B的具体细节。",
          instruction: "补充事件A，做完A以后还是事件B。",
          correctPlan: "additions只返回事件A并插在原句B之前，rewrites为空；原句B及其细节由程序原样保留。"
        },
        instruction: text(input?.instruction, 5000),
        diary: sentences.map(sentence => ({
          id: sentence.id,
          text: sentence.text,
          facts: (sentence.factIds || []).map(id => factById.get(id)).filter(Boolean).map(fact => ({ id: fact.id, slot: fact.slot, text: fact.text }))
        }))
      })
    }
  ];
}

function applyRevisionPlan(facts, sentences, raw, instruction, title) {
  const mode = raw?.mode;
  if (mode === "no_change" || !["replace", "insert"].includes(mode)) {
    return { changed: false, message: text(raw?.message, 200) || "还没有找到明确要修改的内容，请再说清楚一点。" };
  }
  const sentenceIndex = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  let spliceStart;
  let spliceDeleteCount;
  let targetSentences = [];
  if (mode === "replace") {
    const targetSentenceIds = uniqueStrings(raw?.targetSentenceIds).map(value => text(value, 128));
    const indexes = targetSentenceIds.map(id => sentenceIndex.get(id));
    if (!indexes.length || indexes.some(index => index === undefined)) {
      return { changed: false, message: "还没有找到明确要修改的句子，请再说清楚一点。" };
    }
    indexes.sort((left, right) => left - right);
    const start = indexes[0];
    const end = indexes[indexes.length - 1];
    if (indexes.length !== end - start + 1) {
      return { changed: false, message: "这次修改涉及的位置还不够清楚，请按事情顺序再说一次。" };
    }
    targetSentences = sentences.slice(start, end + 1);
    if (targetSentences.some(sentence => !targetSentenceIds.includes(sentence.id))) {
      return { changed: false, message: "这次修改涉及的位置还不够清楚，请按事情顺序再说一次。" };
    }
    const proposedFacts = (Array.isArray(raw?.facts) ? raw.facts : []).map(item => text(item?.text)).filter(Boolean);
    if (targetSentences.length > 1 && proposedFacts.length) {
      const matched = targetSentences.filter(sentence => {
        const existing = (sentence.factIds || []).map(id => factById.get(id)?.text).filter(Boolean).join("；") || sentence.text;
        return proposedFacts.some(proposed => eventOverlapScore(existing, proposed) >= 0.5 || sharesEventCore(existing, proposed))
          || eventOverlapScore(existing, raw?.semanticInstruction) >= 0.25
          || sharesEventCore(existing, raw?.semanticInstruction);
      });
      const matchedIndexes = matched.map(sentence => sentenceIndex.get(sentence.id));
      const matchedAreContiguous = matchedIndexes.length && Math.max(...matchedIndexes) - Math.min(...matchedIndexes) + 1 === matchedIndexes.length;
      if (matchedAreContiguous) targetSentences = matched;
    }
    const narrowedIndexes = targetSentences.map(sentence => sentenceIndex.get(sentence.id));
    spliceStart = Math.min(...narrowedIndexes);
    spliceDeleteCount = targetSentences.length;
  } else {
    const beforeId = text(raw?.insertBeforeSentenceId, 128);
    const afterId = text(raw?.insertAfterSentenceId, 128);
    if ((!beforeId && !afterId) || (beforeId && afterId)) {
      return { changed: false, message: "还没有找到新增内容应放的位置，请把前后顺序再说清楚一点。" };
    }
    const anchorIndex = sentenceIndex.get(beforeId || afterId);
    if (anchorIndex === undefined) {
      return { changed: false, message: "还没有找到新增内容应放的位置，请把前后顺序再说清楚一点。" };
    }
    spliceStart = beforeId ? anchorIndex : anchorIndex + 1;
    spliceDeleteCount = 0;
  }
  const targetFactIds = uniqueStrings(targetSentences.flatMap(sentence => sentence.factIds || []));
  const outsideFactIds = new Set(sentences
    .filter(sentence => !targetSentences.includes(sentence))
    .flatMap(sentence => sentence.factIds || []));
  const removableFactIds = targetFactIds.filter(id => !outsideFactIds.has(id));
  const evidence = joinEvidence([
    ...targetFactIds.map(id => factById.get(id)?.quote),
    instruction
  ]);
  const reusableIds = mode === "replace" ? [...removableFactIds] : [];
  const localFacts = [];
  const factKeyToId = new Map();
  for (const item of (Array.isArray(raw?.facts) ? raw.facts : []).slice(0, 30)) {
    const key = text(item?.key, 128);
    if (!key || factKeyToId.has(key)) continue;
    const fact = normalizeFact({
      ...item,
      text: normalizeRevisionInstruction(removeRedundantClauses(item?.text)),
      id: reusableIds.shift() || newId("fact"),
      sourceFactIds: targetFactIds,
      quote: evidence,
      source: "语音修改"
    }, { source: "语音修改" });
    if (!fact) continue;
    localFacts.push(fact);
    factKeyToId.set(key, fact.id);
  }

  const replacementSentences = [];
  const usedLocalFactIds = new Set();
  for (const item of (Array.isArray(raw?.sentences) ? raw.sentences : []).slice(0, 20)) {
    let sentenceText = normalizeRevisionInstruction(removeRedundantClauses(item?.text));
    if (!sentenceText) continue;
    if (!/[。！？!?]$/u.test(sentenceText)) sentenceText += "。";
    const factIds = uniqueStrings(item?.factKeys).map(key => factKeyToId.get(key)).filter(Boolean);
    if (!factIds.length) continue;
    factIds.forEach(id => usedLocalFactIds.add(id));
    const reuseId = mode === "replace" ? targetSentences[replacementSentences.length]?.id : "";
    replacementSentences.push({ id: reuseId || newId("sentence"), text: sentenceText, factIds });
  }
  const conciseSentences = removeRedundantSentences(replacementSentences);
  replacementSentences.splice(0, replacementSentences.length, ...conciseSentences);
  usedLocalFactIds.clear();
  replacementSentences.flatMap(sentence => sentence.factIds).forEach(id => usedLocalFactIds.add(id));
  const usedLocalFacts = localFacts.filter(fact => usedLocalFactIds.has(fact.id));
  if (usedLocalFacts.length && !replacementSentences.length) {
    return { changed: false, message: "修改内容还没有组成完整句子，请按想要的说法再讲一次。" };
  }
  if (mode === "replace" && targetSentences.length === 1 && usedLocalFacts.length && replacementSentences.length) {
    const beforeMeaning = targetFactIds.map(id => factById.get(id)?.text).filter(Boolean).join("；") || targetSentences[0].text;
    const afterMeaning = usedLocalFacts.map(fact => fact.text).join("；");
    if (isContextOnlyExpansion(beforeMeaning, afterMeaning, raw?.semanticInstruction || instruction)) {
      return { changed: false, message: "这部分只是修改口述中的前后提示，原句已经保留。" };
    }
    if (isUnstatedReduction(beforeMeaning, afterMeaning, instruction, raw?.additionContext)) {
      return { changed: false, message: "修改口述只是简略提到原来的内容，原有细节已经保留。" };
    }
  }

  const removableSet = new Set(removableFactIds);
  const remainingFacts = facts.filter(fact => !removableSet.has(fact.id));
  let factInsertAt;
  if (mode === "replace") {
    const firstFactIndex = facts.findIndex(fact => removableSet.has(fact.id));
    factInsertAt = firstFactIndex < 0
      ? remainingFacts.length
      : facts.slice(0, firstFactIndex).filter(fact => !removableSet.has(fact.id)).length;
  } else {
    const neighbor = sentences[spliceStart] || sentences[spliceStart - 1];
    const neighborIndexes = (neighbor?.factIds || []).map(id => remainingFacts.findIndex(fact => fact.id === id)).filter(index => index >= 0);
    factInsertAt = neighborIndexes.length
      ? (sentences[spliceStart] ? Math.min(...neighborIndexes) : Math.max(...neighborIndexes) + 1)
      : remainingFacts.length;
  }
  remainingFacts.splice(factInsertAt, 0, ...usedLocalFacts);
  const combinedSentences = [
    ...sentences.slice(0, spliceStart),
    ...replacementSentences,
    ...sentences.slice(spliceStart + spliceDeleteCount)
  ];
  if (!combinedSentences.length) throw new Error("这次修改会删掉整篇日记，请直接使用删除日记功能");
  const composition = normalizeComposition({ title, sentences: combinedSentences }, remainingFacts, { fallbackTitle: title });
  if (!composition.sentences.length) {
    return { changed: false, message: "修改内容还没有组成完整句子，请按想要的说法再讲一次。" };
  }
  const beforeText = sentences.map(sentence => sentence.text).join("");
  const afterText = composition.sentences.map(sentence => sentence.text).join("");
  if (beforeText === afterText) return { changed: false, message: "这次说法和原来的日记基本一样，原文已经保留。" };
  return { changed: true, title, sentences: composition.sentences, facts: dedupeFacts(remainingFacts) };
}

async function reviseFactDiary(input, callJson) {
  const facts = dedupeFacts((Array.isArray(input?.facts) ? input.facts : []).filter(fact => fact?.active !== false));
  const sentences = (Array.isArray(input?.sentences) ? input.sentences : [])
    .map(item => ({ id: text(item?.id, 128), text: text(item?.text, 1200), factIds: uniqueStrings(item?.factIds) }))
    .filter(item => item.id && item.text);
  const rawInstruction = text(input?.instruction, 5000);
  if (!rawInstruction) return { changed: false, message: "刚才没有听清要修改的内容。" };
  const semanticInstruction = normalizeRevisionInstruction(rawInstruction);
  if (!facts.length || !sentences.length) return { changed: false, message: "这篇旧日记缺少事实来源，原文已经保留。" };
  const parsed = await callJson(revisionMessages(input, facts, sentences), {
    stage: "revise_local_diary",
    maxTokens: 2000,
    timeoutMs: 40000
  });
  const additions = Array.isArray(parsed?.additions) ? parsed.additions : [];
  const rewrites = mergeRewritePlans(Array.isArray(parsed?.rewrites) ? parsed.rewrites : [], sentences);
  const plans = [
    ...additions.map(item => ({ ...item, mode: "insert" })),
    ...rewrites.map(item => ({
      ...item,
      mode: "replace",
      semanticInstruction,
      additionContext: additions.flatMap(addition => [
        ...(Array.isArray(addition?.facts) ? addition.facts.map(fact => fact?.text) : []),
        ...(Array.isArray(addition?.sentences) ? addition.sentences.map(sentence => sentence?.text) : [])
      ]).filter(Boolean).join("；")
    }))
  ];
  console.log("Revision plan", {
    additions: additions.length,
    rewrites: rewrites.length,
    targetSentences: plans.reduce((total, plan) => total + (Array.isArray(plan.targetSentenceIds) ? plan.targetSentenceIds.length : 0), 0),
    outputFacts: plans.reduce((total, plan) => total + (Array.isArray(plan.facts) ? plan.facts.length : 0), 0),
    outputSentences: plans.reduce((total, plan) => total + (Array.isArray(plan.sentences) ? plan.sentences.length : 0), 0)
  });
  if (!plans.length) {
    return { changed: false, message: text(parsed?.message, 200) || "还没有找到明确要修改的内容，请再说清楚一点。" };
  }
  let state = { facts, sentences };
  let changed = false;
  let message = "";
  const title = text(input?.title, 80) || "我的日记";
  for (const plan of plans.slice(0, 10)) {
    const result = applyRevisionPlan(state.facts, state.sentences, plan, rawInstruction, title);
    if (!result.changed) {
      message ||= result.message || "";
      continue;
    }
    changed = true;
    state = { facts: result.facts, sentences: result.sentences };
  }
  return changed ? { changed: true, title, ...state } : { changed: false, message: message || "这次没有找到可以安全修改的内容，原文已经保留。" };
}

module.exports = {
  applyFactAudit,
  applyRevisionPlan,
  compositionIssues,
  compositionMessages,
  factAuditMessages,
  finalizeFactDiary,
  normalizeComposition,
  reviseFactDiary
};
