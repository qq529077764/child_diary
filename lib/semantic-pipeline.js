const crypto = require("crypto");
const {
  activeEvents,
  applyStoryPatch,
  normalizeStory,
  validateCompositionStructure,
  validateStory
} = require("./story-model");

function normalizedEvidenceText(value) {
  return String(value || "").replace(/[\s，。！？、,.!?；;：:“”"'（）()《》]/gu, "");
}

function segmentTranscript(value, maxChars = 220, maxSpans = 36) {
  const transcript = String(value || "").trim();
  if (!transcript) return [];
  const sentences = transcript.match(/[^。！？!?;；\n]+[。！？!?;；\n]*/gu) || [transcript];
  const pieces = [];
  const seen = new Set();
  for (const sentence of sentences.map(item => item.trim()).filter(Boolean)) {
    const chunks = [];
    if (sentence.length <= maxChars) chunks.push(sentence);
    else {
      for (let start = 0; start < sentence.length; start += maxChars) {
        chunks.push(sentence.slice(start, start + maxChars));
      }
    }
    for (const chunk of chunks) {
      const key = normalizedEvidenceText(chunk).replace(/^(嗯|呃|那个|就是)+/gu, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pieces.push(chunk);
    }
  }
  const groupSize = Math.max(1, Math.ceil(pieces.length / maxSpans));
  const grouped = [];
  for (let index = 0; index < pieces.length; index += groupSize) {
    grouped.push(pieces.slice(index, index + groupSize).join(""));
  }
  return grouped.map((text, index) => ({ id: `span_${index + 1}`, text }));
}

function hydrateExtractedStory(rawStory, sourceSpans) {
  const decisions = new Map((Array.isArray(rawStory?.spans) ? rawStory.spans : [])
    .filter(span => span?.id)
    .map(span => [String(span.id), span]));
  const roleById = new Map();
  for (const role of ["child_story", "adult_guidance", "background_audio", "meta_speech", "noise"]) {
    for (const id of Array.isArray(rawStory?.spanRoles?.[role]) ? rawStory.spanRoles[role] : []) {
      roleById.set(String(id), role);
    }
  }
  return {
    ...(rawStory || {}),
    spans: sourceSpans.map(source => {
      const decision = decisions.get(source.id) || {};
      const role = roleById.get(source.id) || decision.role || "noise";
      return {
        id: source.id,
        text: source.text,
        role,
        accepted: role === "child_story" || decision.accepted === true,
        reason: ""
      };
    })
  };
}

function compactStoryForExtractionRepair(story) {
  const { spans = [], ...rest } = story || {};
  const spanRoles = {
    child_story: [],
    adult_guidance: [],
    background_audio: [],
    meta_speech: [],
    noise: []
  };
  for (const span of spans) {
    if (spanRoles[span.role]) spanRoles[span.role].push(span.id);
  }
  return { ...rest, spanRoles };
}

function validateTranscriptEvidence(story, transcript) {
  const source = normalizedEvidenceText(transcript);
  return story.spans
    .filter(span => span.accepted && span.role === "child_story")
    .filter(span => {
      const fragment = normalizedEvidenceText(span.text);
      return fragment.length < 2 || !source.includes(fragment);
    })
    .map(span => `source_span_not_in_transcript:${span.id}`);
}

function revisionPatchSourceError(rawPatch, revisionSpanId) {
  const missingRevisionSource = rawPatch.operations.some(operation => {
    if (["update_event", "delete_event"].includes(operation?.type)) {
      return !Array.isArray(operation.sourceSpanIds) || !operation.sourceSpanIds.includes(revisionSpanId);
    }
    if (operation?.type === "add_event") {
      return !Array.isArray(operation.event?.sourceSpanIds) || !operation.event.sourceSpanIds.includes(revisionSpanId);
    }
    if (operation?.type === "set_relation") {
      return !Array.isArray(operation.relation?.sourceSpanIds) || !operation.relation.sourceSpanIds.includes(revisionSpanId);
    }
    return false;
  });
  return missingRevisionSource ? "修改内容缺少本次口述来源" : "";
}

function extractionMessages(input) {
  return [
    {
      role: "system",
      content: "你负责把5-9岁孩子断续的口述整理成语义事件账本，不写作文。逐片段区分孩子叙事、成人引导、背景声、操作讨论和噪声。合并重复与残片，采用孩子最后一次明确纠正。不得推测。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "从完整口述中建立事件、场景、关系和儿童特色用词。",
        schema: {
          titleHint: "只使用孩子已说内容的短标题线索",
          spanRoles: {
            child_story: ["span_1"],
            adult_guidance: ["span_2"],
            background_audio: [],
            meta_speech: [],
            noise: []
          },
          scenes: [{ id: "scene_1", label: "中性场景标签", order: 0, sourceSpanIds: ["span_1"] }],
          events: [{
            id: "event_1", sceneId: "scene_1", subject: "谁", action: "做什么", object: "对象或空", time: "明确时间或空",
            location: "明确地点或空", manner: "明确方式或空", result: "明确结果或空", feeling: "明确感受或空",
            polarity: "positive|negative", certainty: "certain", details: ["不适合放入其他字段的确定细节"],
            childExpressions: [{ text: "孩子自己的形容词、叠词或有特点说法", bindTo: "subject|action|object|event|feeling|result", policy: "preserve|drop" }],
            sourceSpanIds: ["span_1"]
          }],
          relations: [{ id: "relation_1", type: "before|after|causes|result_of|contrast|condition|elaborates", from: "event_1", to: "event_2", sourceSpanIds: ["span_1"] }],
          corrections: [{ id: "correction_1", discardedText: "孩子明确撤回的旧意思", adoptedText: "孩子最终确认的新意思", sourceSpanIds: ["span_1"] }]
        },
        rules: [
          "mixed片段必须拆开，不能因为同一句里有成人声音就丢掉孩子回答。",
          "一个事件是孩子想表达的一件事，不是每个动词一个事件；同一连续动作的残片合并进同一事件。",
          "人物、动作、对象、属性、否定、时间和地点必须保持原绑定关系。",
          "孩子明确说‘谁去了/到了/来到某地’时，这是一个带人物和目的地的行动事件，不得只降级成后续活动的location或scene标签。",
          "孩子明确说出的独立否定动作优先单独建事件并设置polarity=negative；如‘我没有哭，还笑了’明确属于同一主语同一场景，也可把‘没有哭’作为details保留，但不得遗漏或改变否定。",
          "action尽量只写核心动作，动作对象写入object；不要把‘洗了手、吃了午饭’整体塞进action后把object留空。",
          "‘坐在/站在/躺在/蹲在某处’的核心动作写坐/站/躺/蹲，原样地点写入location，object留空；不得误写成‘坐了某物’。",
          "同一对象连续说出的多个属性属于同一描述事件时合并保存，属性原词放入details或childExpressions，不要机械拆成多个重复‘是’事件。",
          "明确的先后、因果、转折、条件和自我纠正必须写入relations或事件字段。",
          "先后关系统一使用type=before：from必须是较早发生的事件，to必须是较晚发生的事件；不使用after表达时间顺序。",
          "孩子用‘没有A，而是/只是在B’表达对照时，分别建立相关事件，并用contrast关系连接。",
          "不确定、猜测、记不清的内容不建事件。被纠正的旧说法不建活动事件。",
          "‘A，不对，是B’表示孩子撤回A并采用B：A既不能保留为肯定事件，也不能改造成‘A不是……’的否定事件；B必须保留；同时在corrections记录discardedText=A、adoptedText=B。‘不对’本身只是纠正信号。",
          "childExpressions优先保留孩子原样使用的形容词、叠词和童趣说法；ASR乱码、无意义重复、对象绑定错误或已被纠正的词标为drop。",
          "成人提示、电视台词、操作讨论和无意义声音不得进入事件。",
          "每个活动事件必须引用至少一个accepted的child_story片段。",
          "输出必须紧凑：用spanRoles的5个数组对片段id分类，不要返回spans对象数组，不要复制片段原文，不返回reason和confidence。",
          "合并重复内容，events最多10个、scenes最多6个、corrections最多8个；空字段可以省略。",
          "sourceSpans中每个id都必须在spanRoles的某一个数组中出现一次，不得改id或自造id。"
        ],
        sourceSpans: input.sourceSpans || segmentTranscript(input.transcript)
      })
    }
  ];
}

function activeStoryView(story) {
  const auditedEvents = activeEvents(story);
  const auditedEventIds = new Set(auditedEvents.map(event => event.id));
  return {
    ...story,
    events: auditedEvents,
    relations: story.relations.filter(relation => auditedEventIds.has(relation.from) && auditedEventIds.has(relation.to))
  };
}

function storyAuditMessages(input, story) {
  const auditStory = activeStoryView(story);
  return [
    {
      role: "system",
      content: "你是独立的儿童口述来源审计员，不写文章。把事件账本逐项与完整转写核对，尤其检查说话人污染、自我纠正、否定和不确定表达。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: {
          hardErrors: [{ type: "adult_or_background_content|correction_retained|adopted_correction_missing|missing_child_event|unsupported_event|wrong_binding|negation_changed|uncertainty_promoted", eventIds: ["event_1"], discardedMeaning: "", adoptedMeaning: "", missingMeaning: "", explanation: "" }],
          verdict: "pass|hard_fail"
        },
        rules: [
          "每个事件必须是孩子对亲历故事作出的确定表达，且人物、动作、对象、属性和否定绑定正确。",
          "孩子明确说出的同行人物、不同动作或新对象不得因为成文要简洁就从事件账本消失；遗漏时报missing_child_event并在missingMeaning填原意。",
          "明确的‘谁去了/到了/来到某地’不能被只当作后续事件的时间、地点或场景；若没有对应行动事件，报missing_child_event。",
          "形容词、叠词和属性必须绑到原话中它们直接描写的人或物；不得把后一句中动物、物品的属性挂到前一事件的地点或对象上。",
          "一个sourceSpan同时出现多个动作和对象时，必须检查后一动作及其宾语是否被遗漏，并把形容词绑到它实际修饰的最近名词；不得把后一宾语的形容词绑到前一宾语。",
          "去某地、看到某物和对某物的描写只有在主谓宾绑定仍清楚时才能合并；合并后变成‘去大大的地点’这类错绑必须报wrong_binding。",
          "成人提示、电视或旁人台词、操作讨论和无关声音进入事件时报告adult_or_background_content。",
          "孩子说‘A，不对，是B’时，A已经被撤回：仅当活动事件仍表达A或把A改成否定命题时报告correction_retained；对应error必须填写discardedMeaning=A和adoptedMeaning=B。",
          "B是孩子最终采用的正确内容，绝不能把表达B的事件报告为correction_retained；如果B没有进入活动事件，报告adopted_correction_missing。",
          "优先参照story.corrections中的discardedText和adoptedText判断，不要只看事件编号顺序。",
          "‘不对、说错了、不是这个’等纠正信号本身不是日记事实。",
          "记不清、可能、猜测和不确定内容被写成确定事件时报告uncertainty_promoted。",
          "不要因为事件字段换了措辞就报错，只检查语义是否受原始转写支持。",
          "hardErrors最多6项，每项只填必要字段，explanation最多30个字；不得复制原文、事件账本或规则。"
        ],
        fullTranscript: String(input.transcript || ""),
        story: auditStory
      })
    }
  ];
}

function correctionTextMatchesEvent(event, value) {
  const textValue = normalizedMeaning(value);
  if (textValue.length < 2) return false;
  const full = normalizedMeaning([event.subject, event.action, event.object, ...event.details].filter(Boolean).join(""));
  const positiveAction = String(event.action || "").replace(/^(?:没(?:有)?|不)/u, "") || event.action;
  const positive = normalizedMeaning([event.subject, positiveAction, event.object, ...event.details].filter(Boolean).join(""));
  const attribute = /^(?:是|不是)$/u.test(String(event.action || ""))
    ? normalizedMeaning([event.subject, event.object, ...event.details].filter(Boolean).join(""))
    : "";
  const textWithoutCopula = textValue.replace(/不是/gu, "").replace(/是/gu, "");
  return [full, positive, attribute].filter(candidate => candidate.length >= 2).some(candidate => {
    const candidateWithoutCopula = candidate.replace(/不是/gu, "").replace(/是/gu, "");
    return textValue.includes(candidate)
      || candidate.includes(textValue)
      || (textWithoutCopula.length >= 2 && candidateWithoutCopula.length >= 2
        && (textWithoutCopula.includes(candidateWithoutCopula) || candidateWithoutCopula.includes(textWithoutCopula)));
  });
}

function groundedCorrection(transcript, correction) {
  const full = normalizedMeaning(transcript);
  const discardedRaw = normalizedMeaning(correction?.discardedText);
  const discarded = discardedRaw.replace(/^(?:不是|不对|说错(?:了)?)/u, "");
  const adopted = normalizedMeaning(correction?.adoptedText);
  if (discarded.length < 2 || adopted.length < 2) return false;
  const discardedIndex = full.indexOf(discarded);
  const adoptedIndex = full.indexOf(adopted, discardedIndex + discarded.length);
  if (discardedIndex < 0 || adoptedIndex < 0) return false;
  const prefix = full.slice(Math.max(0, discardedIndex - 6), discardedIndex);
  const bridge = full.slice(discardedIndex + discarded.length, adoptedIndex);
  return /(?:不是|不对|说错(?:了)?|应该|改成)/u.test(prefix)
    || /(?:不对|说错(?:了)?|应该|改成|不是)/u.test(bridge);
}

function applyGroundedCorrections(story, transcript) {
  const supersededIds = new Set();
  const grounded = [];
  for (const correction of story.corrections || []) {
    if (!groundedCorrection(transcript, correction)) continue;
    const active = activeEvents(story);
    const adoptedExists = active.some(event => correctionTextMatchesEvent(event, correction.adoptedText));
    if (!adoptedExists) continue;
    grounded.push(correction);
    for (const event of active) {
      if (correctionTextMatchesEvent(event, correction.discardedText)
        && !correctionTextMatchesEvent(event, correction.adoptedText)) {
        supersededIds.add(event.id);
      }
    }
  }
  if (!grounded.length) return story;
  return normalizeStory({
    ...story,
    events: story.events.map(event => {
      if (supersededIds.has(event.id)) return { ...event, status: "superseded" };
      if (event.status !== "active") return event;
      const discarded = grounded
        .map(correction => normalizedMeaning(correction.discardedText).replace(/^(?:不是|不对|说错(?:了)?)/u, ""))
        .filter(Boolean);
      const retainsDiscarded = value => {
        const normalized = normalizedMeaning(value);
        return discarded.some(fragment => normalized.includes(fragment));
      };
      return {
        ...event,
        details: (event.details || []).filter(detail => !retainsDiscarded(detail)),
        childExpressions: (event.childExpressions || []).filter(expression => !retainsDiscarded(expression.text))
      };
    })
  });
}

function repairSpatialPostureEvents(story) {
  const sourceById = new Map((story.spans || []).map(span => [span.id, normalizedMeaning(span.text)]));
  let changed = false;
  const events = story.events.map(event => {
    const action = String(event.action || "");
    const actionCore = action.replace(/了$/u, "");
    const object = normalizedMeaning(event.object);
    if (event.status !== "active" || event.location || !/^(?:坐|站|躺|蹲)$/u.test(actionCore) || !object) return event;
    const escapedObject = object.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`${actionCore}在${escapedObject}([上下里旁边前后])?`, "u");
    for (const sourceId of event.sourceSpanIds || []) {
      const match = (sourceById.get(sourceId) || "").match(pattern);
      if (!match) continue;
      changed = true;
      return { ...event, action: actionCore, object: "", location: `${event.object}${match[1] || ""}` };
    }
    return event;
  });
  return changed ? normalizeStory({ ...story, events }) : story;
}

function sourceAuditErrors(story, audit) {
  const validIds = new Set(activeEvents(story).map(event => event.id));
  return (Array.isArray(audit?.hardErrors) ? audit.hardErrors : []).filter(error => {
    const ids = Array.isArray(error?.eventIds) ? error.eventIds : [];
    const activeIds = ids.filter(id => validIds.has(id));
    if (ids.length && !activeIds.length) return false;
    if (error?.type === "missing_child_event" && activeIds.length && error.missingMeaning) {
      const missing = canonicalEventMeaning(error.missingMeaning);
      const alreadyCovered = story.events
        .filter(event => activeIds.includes(event.id))
        .some(event => {
          const candidates = [
            [event.subject, event.action, event.object].join(""),
            [event.subject, event.action, event.location].join(""),
            [event.subject, event.action, event.object, event.location].join("")
          ].map(canonicalEventMeaning).filter(Boolean);
          return candidates.some(candidate => missing.includes(candidate) || candidate.includes(missing));
        });
      if (alreadyCovered) return false;
    }
    if (error?.type === "correction_retained" && activeIds.length) {
      const flagged = story.events.filter(event => activeIds.includes(event.id));
      const falsePositive = flagged.every(event => (story.corrections || []).some(correction =>
        correctionTextMatchesEvent(event, correction.adoptedText)
        && !correctionTextMatchesEvent(event, correction.discardedText)));
      if (falsePositive) return false;
    }
    if (error?.type === "adopted_correction_missing") {
      const adoptedExists = (story.corrections || []).some(correction =>
        activeEvents(story).some(event => correctionTextMatchesEvent(event, correction.adoptedText)));
      if (adoptedExists) return false;
    }
    if (error?.type === "uncertainty_promoted" && activeIds.length) {
      const explicitUncertainty = /(?:可能|也许|好像|大概|猜|记不清|不确定)/u;
      const sourceById = new Map((story.spans || []).map(span => [span.id, span.text]));
      const hasCue = story.events.filter(event => activeIds.includes(event.id)).some(event =>
        event.sourceSpanIds.some(id => explicitUncertainty.test(sourceById.get(id) || "")));
      if (!hasCue) return false;
    }
    if (error?.type === "wrong_binding" && activeIds.length) {
      const sourceById = new Map((story.spans || []).map(span => [span.id, normalizedMeaning(span.text)]));
      const bindingSupported = story.events.filter(event => activeIds.includes(event.id)).every(event => {
        const expressions = (event.childExpressions || []).filter(item => item.policy === "preserve");
        if (!expressions.length) return false;
        return expressions.every(expression => event.sourceSpanIds.some(id => {
          const source = sourceById.get(id) || "";
          const phrase = normalizedMeaning(expression.text);
          const anchors = [event.object, event.subject].map(normalizedMeaning).filter(value => value.length >= 1);
          return anchors.some(anchor => {
            if (!source.includes(phrase) || !source.includes(anchor)) return false;
            if (anchor.includes(phrase) || phrase.includes(anchor)) return true;
            const phraseIndex = source.indexOf(phrase);
            const anchorIndex = source.indexOf(anchor);
            if (phraseIndex < anchorIndex && anchorIndex - phraseIndex <= 12) return true;
            if (anchorIndex < phraseIndex && phraseIndex - anchorIndex <= 16) {
              const bridge = source.slice(anchorIndex + anchor.length, phraseIndex);
              return /(?:它|他|她|这个|这只|就是|是)/u.test(bridge);
            }
            return false;
          });
        }));
      });
      if (bindingSupported) return false;
    }
    return true;
  });
}

function normalizedMeaning(value) {
  return String(value || "").replace(/[\s，。！？、,.!?；;：:“”"'（）()《》]/gu, "");
}

function canonicalEventMeaning(value) {
  return normalizedMeaning(value)
    .replace(/(?:来)?到了?/gu, "到")
    .replace(/去了?/gu, "到")
    .replace(/[的地得]/gu, "");
}

function eventMatchesDiscardedCorrection(story, eventId) {
  const event = story.events.find(item => item.id === eventId && item.status === "active");
  if (!event) return false;
  return (story.corrections || []).some(correction => correctionTextMatchesEvent(event, correction.discardedText));
}

function compositionMessages(story, options = {}) {
  const sceneFilter = new Set(options.sceneIds || []);
  const selectedScenes = sceneFilter.size ? story.scenes.filter(scene => sceneFilter.has(scene.id)) : story.scenes;
  const selectedSceneIds = new Set(selectedScenes.map(scene => scene.id));
  const events = activeEvents(story).filter(event => selectedSceneIds.has(event.sceneId));
  const eventIds = new Set(events.map(event => event.id));
  const relations = story.relations.filter(relation => eventIds.has(relation.from) && eventIds.has(relation.to));
  return [
    {
      role: "system",
      content: "你是小学低年级口述日记整理老师。根据语义事件重新写文章，不修补原病句。事实边界严格，语言组织自由。写得简洁、清楚、有主谓关系，需要宾语时写清宾语；同一主体的连续动作可以共用主语。保留孩子自己的形容词和叠词，不创造新词。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: sceneFilter.size ? "只重新组织指定场景" : "把完整事件账本整理成一篇短日记",
        schema: {
          title: "简短标题",
          sentences: [{ sceneId: "scene_1", text: "完整自然的句子。", eventIds: ["event_1"] }]
        },
        rules: [
          "返回对象只能包含title和sentences；禁止返回content、正文字符串或其他格式。sentences中的每项都必须有sceneId、text和eventIds。",
          "只能表达events中的确定内容，不得新增人物、动作、对象、属性、时间、地点、原因、评价或感受。",
          "eventIds只是来源绑定；正文必须重新组织，不得照抄零碎字段。",
          "每个事件覆盖一次。同一主体、同一场景、关系紧密的连续动作可合成一句，不能按事件数量机械拆句。",
          "同一对象的多个属性应合成自然表达，不要在相邻分句机械重复同一个主语和‘是’。",
          "主体切换或可能歧义时写清主语；动作需要对象且事件提供对象时写清宾语。",
          "坐、站、躺、蹲与location组织成‘坐在/站在/躺在/蹲在某处’，不得把地点当成这些动作的宾语。",
          "遵守relations中的先后、因果、转折和条件；没有因果关系时不得擅自使用所以、因为。",
          "negative事件必须保留否定。",
          "details中的明确否定内容也必须进入正文，不得丢失、反转或改绑到其他人。",
          "同一主体在同一场景中用否定与肯定动作形成对照时，优先合成‘没有……，只是/而是……’的紧凑表达，不要拆成重复主语的两句。",
          "policy=preserve的childExpressions尽量原样放回它绑定的对象；policy=drop的表达禁止写入。",
          "去掉语气词、指令、重复、倒装和无独立意义的动作残片。",
          "正文应比有效口述更清楚，并保持同样简洁或更精炼；不要写成人作文腔。",
          "没有感受事件时不补心情；标题也不得新增事实。"
        ],
        titleHint: story.titleHint,
        scenes: selectedScenes,
        events,
        relations,
        currentSceneText: options.currentSceneText || []
      })
    }
  ];
}

function auditMessages(story, composition, options = {}) {
  return [
    {
      role: "system",
      content: "你是独立的儿童日记语义审计员，不参与写作。逐项比较事件账本与候选正文。模型申报的eventIds只能帮助定位，不能当作正确证明。只报告真实问题，不因换词、换语序或合并句子判错。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: {
          hardErrors: [{ type: "unsupported_claim|contradiction|wrong_binding|missing_event|duplicate_event|relation_reversed|inactive_content_retained|locked_text_changed", sentenceId: "", eventIds: [], explanation: "" }],
          softIssues: [{ type: "unclear_subject|missing_object|disfluent|verbose|repeated_subject|contrast_split|adult_tone|child_expression_lost", sentenceId: "", explanation: "" }],
          verdict: "pass|hard_fail|soft_rewrite"
        },
        hardRules: [
          "拦截无来源的新事实、否定翻转、人物动作对象属性错绑、明确关系反转、必需事件遗漏、同一事件重复和删除内容残留。",
          "若提供lockedSentences，未列入changedSceneIds的句子必须逐字不变；列入changedSceneIds的场景允许重写，不得对它报locked_text_changed。",
          "只有候选正文仍表达了inactiveEvents中已删除或已撤回的事件时，才报inactive_content_retained。"
        ],
        softRules: [
          "检查主谓是否清楚、需要时宾语是否明确、是否有病句或流水账、是否过度成人化、儿童特色词是否无故丢失。",
          "同一对象的连续属性如果机械重复主语和‘是’，标为repeated_subject并建议合并成紧凑表达。",
          "自然的省略主语、事件合并和语序重组不算错误。"
        ],
        story: activeStoryView(story),
        inactiveEvents: (story.events || []).filter(event => event.status !== "active"),
        composition,
        lockedSentences: options.lockedSentences || [],
        changedSceneIds: options.changedSceneIds || []
      })
    }
  ];
}

function deterministicStyleIssues(story, composition) {
  const issues = [];
  const eventById = new Map(activeEvents(story).map(event => [event.id, event]));
  const sentenceIndexByEvent = new Map();
  for (const [sentenceIndex, sentence] of (composition.sentences || []).entries()) {
    const events = (sentence.eventIds || []).map(id => eventById.get(id)).filter(Boolean);
    for (const event of events) sentenceIndexByEvent.set(event.id, sentenceIndex);
    const copularGroups = new Map();
    for (const event of events.filter(item => item.subject && item.action === "是")) {
      const key = `${event.subject}\u0000${event.action}`;
      if (!copularGroups.has(key)) copularGroups.set(key, []);
      copularGroups.get(key).push(event);
    }
    for (const group of copularGroups.values()) {
      if (group.length < 2) continue;
      const phrase = `${group[0].subject}是`;
      if (String(sentence.text || "").split(phrase).length - 1 > 1) {
        issues.push({ type: "repeated_subject", sentenceId: sentence.id, explanation: "同一对象的连续属性机械重复了主语和‘是’，应合并为紧凑表达。" });
      }
    }
  }
  for (const relation of story.relations || []) {
    if (relation.type !== "contrast") continue;
    const left = sentenceIndexByEvent.get(relation.from);
    const right = sentenceIndexByEvent.get(relation.to);
    if (Number.isInteger(left) && Number.isInteger(right) && left !== right) {
      issues.push({ type: "contrast_split", sentenceId: composition.sentences[right]?.id || "", explanation: "同一场景中的明确对照被拆成重复主语的两句，应在不改变事实的前提下紧凑合并。" });
    }
  }
  return issues;
}

function repairMessages(story, draft, audit, options = {}) {
  return [
    ...compositionMessages(story, options),
    { role: "assistant", content: JSON.stringify(draft) },
    {
      role: "user",
      content: JSON.stringify({
        task: "根据独立审计只修复列出的问题，保持正确事实、儿童用词和简洁程度。返回完整JSON。",
        audit
      })
    }
  ];
}

function revisionMessages(input, story, composition) {
  const revisionSpanId = input.revisionSpanId;
  return [
    {
      role: "system",
      content: "你负责把孩子自然说出的修改转成语义事件补丁，不写正文。孩子不必使用删除、替换等口令。只修改明确涉及的事件；最新明确内容与旧内容冲突时采用最新内容，兼容信息继续保留。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: {
          intent: "correct|delete|add|reorder|restate_scene|unclear",
          operations: [
            { type: "update_event", eventId: "event_1", changes: { object: "只列出本次明确改变或补充的字段", details: { add: ["本次新增细节"], remove: ["被明确纠正的旧细节"] }, childExpressions: { add: [{ text: "本次新增的儿童说法", bindTo: "object", policy: "preserve" }], removeTexts: ["被明确纠正的旧说法"] } }, sourceSpanIds: [revisionSpanId] },
            { type: "delete_event", eventId: "event_1", sourceSpanIds: [revisionSpanId] },
            { type: "add_event", event: { id: "event_new_1", sceneId: "scene_1", subject: "", action: "", object: "", time: "", location: "", manner: "", result: "", feeling: "", polarity: "positive", certainty: "certain", details: [], childExpressions: [], sourceSpanIds: [revisionSpanId], status: "active", confidence: 0.9 } },
            { type: "set_relation", relation: { id: "relation_new_1", type: "before|after|causes|result_of|contrast|condition|elaborates", from: "event_1", to: "event_2", sourceSpanIds: [revisionSpanId] } },
            { type: "remove_relation", relationId: "relation_1" },
            { type: "remove_generated_phrase", sentenceId: "sentence_1", phrase: "要删除的正文短语" }
          ],
          message: "无法确定修改时的简短提示"
        },
        rules: [
          "自然重说相关场景时，把新信息拆成字段更新、细节补充、新事件或关系修改；不得把整段口述塞进一个字段。",
          "update_event.changes只写本次口述明确改变或补充的字段。未提到的字段绝对不能返回空值、空数组或默认值，否则会误删原内容。",
          "儿童特色词只用childExpressions.add增加，用removeTexts删除孩子明确纠正的旧说法；不得因本次没提到而删除原有特色词。",
          "用‘不是旧对象，是新对象’明确替换对象时，与旧对象绑定且与新说法冲突的details和childExpressions必须分别写入remove和removeTexts。",
          "修改原话中的每个明确新细节都要进入事件：例如动作持续了多久放入manner或details.add，不能只改对象后就遗漏。",
          "普通细节只用details.add补充，用details.remove删除孩子明确纠正的旧细节；不得整组覆盖。",
          `update_event和delete_event也必须在sourceSpanIds中引用本次修改来源 ${revisionSpanId}。`,
          "只因语序或语气不同不得覆盖事件。只有人物、动作、对象、属性、数量、时间、地点或否定明确冲突时才更新旧字段。",
          "补充原事件的描述、结果或感受使用update_event；真正新增的一件事才使用add_event。",
          "事件顺序修改使用set_relation，不能把顺序说明新增成事件。",
          "删除AI正文中的多余词但不删除事件时，使用remove_generated_phrase。",
          `新事件和新关系必须引用本次修改来源 ${revisionSpanId}，并保留修改口述中的儿童形容词和叠词。`,
          "没有明确修改时operations返回空数组。"
        ],
        revisionSpan: { id: revisionSpanId, text: String(input.instruction || ""), role: "child_story", accepted: true },
        story,
        currentComposition: composition
      })
    }
  ];
}

function normalizeComposition(raw, story, options = {}) {
  const sceneIds = new Set(story.scenes.map(scene => scene.id));
  const eventById = new Map(activeEvents(story).map(event => [event.id, event]));
  const sceneResults = Array.isArray(raw?.sentences)
    ? raw.sentences.map(sentence => ({ sceneId: sentence?.sceneId, sentences: [sentence] }))
    : Array.isArray(raw?.scenes) ? raw.scenes : [];
  if (!sceneResults.length) {
    console.error("Semantic composition returned no scenes", { keys: raw && typeof raw === "object" ? Object.keys(raw) : [], sentenceCount: Array.isArray(raw?.sentences) ? raw.sentences.length : 0 });
  }
  const sentences = [];
  for (const sceneResult of sceneResults) {
    const sceneId = String(sceneResult?.sceneId || "").trim();
    if (!sceneIds.has(sceneId)) continue;
    for (const sentence of Array.isArray(sceneResult?.sentences) ? sceneResult.sentences : []) {
      const sentenceText = String(sentence?.text || "").trim();
      if (!sentenceText) continue;
      const eventIds = [...new Set((Array.isArray(sentence.eventIds) ? sentence.eventIds : []).filter(id => eventById.get(id)?.sceneId === sceneId))];
      sentences.push({
        id: String(sentence.id || "").trim() || `sentence_${crypto.randomUUID()}`,
        sceneId,
        text: sentenceText,
        eventIds,
        sourceSpanIds: [...new Set(eventIds.flatMap(id => eventById.get(id)?.sourceSpanIds || []))]
      });
    }
  }
  return { title: String(options.lockedTitle || raw?.title || story.titleHint || "我的日记").trim().slice(0, 80), sentences };
}

function compositionAsSceneResponse(composition) {
  const groups = new Map();
  for (const sentence of composition.sentences || []) {
    if (!groups.has(sentence.sceneId)) groups.set(sentence.sceneId, []);
    groups.get(sentence.sceneId).push(sentence);
  }
  return { title: composition.title, scenes: [...groups].map(([sceneId, sentences]) => ({ sceneId, sentences })) };
}

function spliceScenes(story, current, replacements, affectedSceneIds) {
  const affected = new Set(affectedSceneIds);
  const replacementsByScene = new Map();
  for (const sentence of replacements.sentences || []) {
    if (!replacementsByScene.has(sentence.sceneId)) replacementsByScene.set(sentence.sceneId, []);
    replacementsByScene.get(sentence.sceneId).push(sentence);
  }
  const currentByScene = new Map();
  for (const sentence of current.sentences || []) {
    if (!currentByScene.has(sentence.sceneId)) currentByScene.set(sentence.sceneId, []);
    currentByScene.get(sentence.sceneId).push(sentence);
  }
  const sentences = [];
  for (const scene of story.scenes) {
    sentences.push(...(affected.has(scene.id) ? replacementsByScene.get(scene.id) || [] : currentByScene.get(scene.id) || []));
  }
  return { title: current.title, sentences };
}

function applyDirectTextEdits(composition, edits) {
  const next = JSON.parse(JSON.stringify(composition));
  for (const edit of edits) {
    const sentence = next.sentences.find(item => item.id === edit.sentenceId);
    if (!sentence || !edit.phrase || !sentence.text.includes(edit.phrase)) throw new Error("revision_phrase_not_found");
    sentence.text = sentence.text.split(edit.phrase).join("")
      .replace(/，{2,}/gu, "，")
      .replace(/，([。！？!?])/gu, "$1")
      .replace(/^[，。；;\s]+|[，；;\s]+$/gu, "")
      .trim();
    if (!sentence.text) throw new Error("不能删除整句内容，请说明要删除的是哪件事");
    if (sentence.text && !/[。！？!?]$/u.test(sentence.text)) sentence.text += "。";
  }
  return next;
}

async function auditCandidate(callJson, story, composition, options = {}) {
  const structuralErrors = validateCompositionStructure(story, composition, options);
  const semanticAudit = await callJson(auditMessages(story, composition, options), {
    stage: options.auditStage || "composition_audit",
    maxTokens: 1400
  });
  const structuralTypes = new Set(structuralErrors.map(error => error.type));
  const inactiveIds = new Set((story.events || []).filter(event => event.status !== "active").map(event => event.id));
  const semanticHardErrors = (Array.isArray(semanticAudit?.hardErrors) ? semanticAudit.hardErrors : []).filter(error => {
    if (error?.type === "locked_text_changed" && !structuralTypes.has("locked_sentence_changed")) return false;
    if (error?.type === "inactive_content_retained") {
      return (Array.isArray(error.eventIds) ? error.eventIds : []).some(id => inactiveIds.has(id));
    }
    return true;
  });
  const hardErrors = [...structuralErrors, ...semanticHardErrors];
  const softIssues = [
    ...(Array.isArray(semanticAudit?.softIssues) ? semanticAudit.softIssues : []),
    ...deterministicStyleIssues(story, composition)
  ];
  return { hardErrors, softIssues, verdict: hardErrors.length ? "hard_fail" : softIssues.length ? "soft_rewrite" : "pass" };
}

function revisionPatchAuditMessages(input, beforeStory, rawPatch, appliedStory, affectedSceneIds) {
  const affected = new Set(affectedSceneIds || []);
  return [
    {
      role: "system",
      content: "你是独立的儿童日记修改补丁审计员，不写正文。核对孩子本次自然修改与修改后事件，既不能漏掉明确新信息，也不能擅改没提到的事实。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        schema: {
          hardErrors: [{ type: "missing_explicit_content|unsupported_change|wrong_event|old_conflict_retained|child_expression_misbound", eventIds: ["event_1"], missingMeaning: "", conflictingTexts: ["与新说法冲突的旧details或childExpressions原文"], explanation: "" }],
          verdict: "pass|hard_fail"
        },
        rules: [
          "本次修改里明确说出的人物、动作、对象、数量、属性、时间、地点、结果、感受和‘做了好久’这类方式细节，都必须进入对应事件字段、details或childExpressions。",
          "明确纠正旧对象或属性时，旧的冲突内容不得继续绑定；与新说法兼容的旧信息应保留。",
          "报old_conflict_retained时，conflictingTexts必须逐字列出当前事件中真正冲突的details或childExpressions，不得编造。",
          "报missing_explicit_content时，missingMeaning必须是本次修改原话中可直接定位的简短原意。",
          "孩子没有提到的旧场景和事件不得改动。",
          "语气词、口吃和无意义重复不算明确新信息。"
        ],
        revisionInstruction: String(input.instruction || ""),
        patch: rawPatch,
        beforeEvents: activeEvents(beforeStory),
        afterEvents: activeEvents(appliedStory).filter(event => affected.has(event.sceneId)),
        affectedSceneIds: [...affected]
      })
    }
  ];
}

function applyAuditDirectedPatchFixes(rawPatch, beforeStory, audit, instruction) {
  const fixed = JSON.parse(JSON.stringify(rawPatch || {}));
  if (!Array.isArray(fixed.operations)) return fixed;
  const instructionMeaning = normalizedMeaning(instruction);
  const hasReplacementCue = /(?:不是|不对|说错(?:了)?).*(?:是|而是|改成)/u.test(String(instruction || ""));
  const beforeById = new Map((beforeStory.events || []).map(event => [event.id, event]));
  for (const error of Array.isArray(audit?.hardErrors) ? audit.hardErrors : []) {
    const eventIds = Array.isArray(error?.eventIds) ? error.eventIds : [];
    for (const eventId of eventIds) {
      const operation = fixed.operations.find(item => item?.type === "update_event" && item.eventId === eventId);
      const before = beforeById.get(eventId);
      if (!operation || !before) continue;
      operation.changes = operation.changes && typeof operation.changes === "object" ? operation.changes : {};
      if (error.type === "old_conflict_retained" && hasReplacementCue) {
        const actualExpressions = (before.childExpressions || []).map(item => item.text);
        const actualDetails = before.details || [];
        const conflicts = (Array.isArray(error.conflictingTexts) ? error.conflictingTexts : []).map(String);
        const matchesConflict = (actual, reported) => {
          const actualMeaning = normalizedMeaning(actual);
          const reportedMeaning = normalizedMeaning(reported);
          return actualMeaning.length >= 2 && reportedMeaning.length >= 2
            && (actualMeaning.includes(reportedMeaning) || reportedMeaning.includes(actualMeaning));
        };
        const expressionRemovals = actualExpressions.filter(actual => conflicts.some(reported => matchesConflict(actual, reported)));
        const detailRemovals = actualDetails.filter(actual => conflicts.some(reported => matchesConflict(actual, reported)));
        if (expressionRemovals.length) {
          const current = operation.changes.childExpressions && typeof operation.changes.childExpressions === "object"
            ? operation.changes.childExpressions : {};
          operation.changes.childExpressions = {
            ...current,
            removeTexts: [...new Set([...(Array.isArray(current.removeTexts) ? current.removeTexts : []), ...expressionRemovals])]
          };
        }
        if (detailRemovals.length) {
          const current = operation.changes.details && typeof operation.changes.details === "object" ? operation.changes.details : {};
          operation.changes.details = {
            ...current,
            remove: [...new Set([...(Array.isArray(current.remove) ? current.remove : []), ...detailRemovals])]
          };
        }
      }
      if (error.type === "missing_explicit_content") {
        const missing = String(error.missingMeaning || "").trim();
        const normalizedMissing = normalizedMeaning(missing);
        if (normalizedMissing.length >= 2 && instructionMeaning.includes(normalizedMissing)) {
          const current = operation.changes.details && typeof operation.changes.details === "object" ? operation.changes.details : {};
          operation.changes.details = {
            ...current,
            add: [...new Set([...(Array.isArray(current.add) ? current.add : []), missing])]
          };
        }
      }
    }
  }
  return fixed;
}

function revisionPatchHardErrors(appliedStory, audit) {
  const activeById = new Map(activeEvents(appliedStory).map(event => [event.id, event]));
  const eventValues = event => [
    event.subject, event.action, event.object, event.time, event.location, event.manner,
    event.result, event.feeling, ...(event.details || []), ...(event.childExpressions || []).map(item => item.text)
  ].filter(Boolean).map(normalizedMeaning);
  return (Array.isArray(audit?.hardErrors) ? audit.hardErrors : []).filter(error => {
    const events = (Array.isArray(error?.eventIds) ? error.eventIds : []).map(id => activeById.get(id)).filter(Boolean);
    if (error?.type === "old_conflict_retained" && events.length && Array.isArray(error.conflictingTexts)) {
      const conflicts = error.conflictingTexts.map(normalizedMeaning).filter(value => value.length >= 2);
      const retained = events.some(event => eventValues(event).some(value => conflicts.some(conflict =>
        value === conflict || (value.length >= 2 && conflict.length >= 2 && value.includes(conflict)))));
      if (!retained) return false;
    }
    if (error?.type === "missing_explicit_content" && events.length) {
      const missing = normalizedMeaning(error.missingMeaning);
      if (missing.length >= 2 && events.some(event => eventValues(event).some(value => value.includes(missing) || missing.includes(value)))) {
        return false;
      }
    }
    return true;
  });
}

function onePassFinalizeMessages(sourceSpans) {
  return [
    {
      role: "system",
      content: "你是小学低年级口述日记整理老师。一次完成去噪、语义事件归纳和简洁成文。保留孩子的形容词、叠词和口吻，不创造新事实或新词。只返回紧凑JSON，不解释。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把断续、重复、夹有成人提问的收音整理成一篇能读的小学生日记，同时返回正文使用的简明事件。",
        schema: {
          title: "孩子原话支持的短标题",
          events: [{
            id: "e1", subject: "谁", action: "做什么", object: "对象或空", time: "明确时间或空",
            location: "明确地点或空", manner: "明确方式或空", feeling: "明确感受或空",
            details: ["其他必要细节"], expressions: ["孩子的原样特色用词"], sourceSpanIds: ["span_1"]
          }],
          sentences: [{ text: "完整自然的句子。", eventIds: ["e1"] }],
          corrections: [{ discardedText: "被孩子撤回的旧说法", adoptedText: "最后采用的说法", sourceSpanIds: ["span_1"] }]
        },
        rules: [
          "只使用sourceSpans中孩子明确表达的内容；成人问句、提示、应用操作语、背景台词和无意义声音全部忽略。",
          "合并ASR断句、口吃、重复和同一件事的残片，不把‘然后、我、。’之类残片写入正文。",
          "每个事件必须引用1个或多个原始span id，不得自造id；句子必须引用它实际表达的event id。",
          "被孩子纠正的旧内容不得进入events和sentences，只记入corrections；保留最后采用的内容。",
          "事件按孩子叙述顺序排列，人物、动作、对象、时间、地点、否定和形容词不得错绑。",
          "正文使用小学生能学会的清楚主谓宾结构，去掉无效收音，但尽量原样保留expressions中合理的形容词和叠词。",
          "只写孩子说过的感受；不自动补‘我很开心’、道理、总结或成人作文腔。",
          "events最多12个，sentences最多8句，details每个最多3项，expressions每个最多2项，corrections最多4项；空字段省略。",
          "返回对象只能包含title、events、sentences、corrections；不得复制sourceSpans，不返回解释、审计过程、reason或confidence。"
        ],
        sourceSpans
      })
    }
  ];
}

function simpleEventSentence(event) {
  const location = event.location ? `在${event.location}` : "";
  const sentence = [event.time, event.subject, location, event.manner, event.action, event.object, ...(event.details || [])]
    .filter(Boolean).join("");
  return sentence ? `${sentence.replace(/[。！？!?]+$/u, "")}。` : "";
}

function normalizeOnePassFinalization(raw, sourceSpans) {
  const validSpanIds = new Set(sourceSpans.map(span => span.id));
  const idMap = new Map();
  const events = [];
  for (const [index, item] of (Array.isArray(raw?.events) ? raw.events : []).slice(0, 12).entries()) {
    const sourceSpanIds = [...new Set((Array.isArray(item?.sourceSpanIds) ? item.sourceSpanIds : [])
      .map(String).filter(id => validSpanIds.has(id)))];
    if (!String(item?.action || "").trim() || !sourceSpanIds.length) continue;
    const id = `event_${events.length + 1}`;
    idMap.set(String(item.id || `e${index + 1}`), id);
    const expressions = (Array.isArray(item.expressions) ? item.expressions : [])
      .map(expression => typeof expression === "string" ? expression : expression?.text)
      .map(value => String(value || "").trim()).filter(Boolean).slice(0, 2);
    events.push({
      id,
      sceneId: "scene_main",
      subject: item.subject,
      action: item.action,
      object: item.object,
      time: item.time,
      location: item.location,
      manner: item.manner,
      feeling: item.feeling,
      details: (Array.isArray(item.details) ? item.details : []).slice(0, 3),
      childExpressions: expressions.map(text => ({ text, bindTo: "event", policy: "preserve" })),
      sourceSpanIds
    });
  }
  if (!events.length) throw new Error("没有听到可以写进日记的事情");
  const usedSpanIds = new Set(events.flatMap(event => event.sourceSpanIds));
  const corrections = (Array.isArray(raw?.corrections) ? raw.corrections : []).slice(0, 4).map((item, index) => ({
    id: `correction_${index + 1}`,
    discardedText: item?.discardedText,
    adoptedText: item?.adoptedText,
    sourceSpanIds: [...new Set((Array.isArray(item?.sourceSpanIds) ? item.sourceSpanIds : [])
      .map(String).filter(id => validSpanIds.has(id)))]
  }));
  let story = normalizeStory({
    titleHint: raw?.title,
    spans: sourceSpans.map(span => ({
      ...span,
      role: usedSpanIds.has(span.id) ? "child_story" : "noise",
      accepted: usedSpanIds.has(span.id)
    })),
    scenes: [{ id: "scene_main", label: "", order: 0, sourceSpanIds: [...usedSpanIds] }],
    events,
    relations: [],
    corrections
  });
  story = applyGroundedCorrections(story, sourceSpans.map(span => span.text).join(""));
  story = repairSpatialPostureEvents(story);
  const activeIds = new Set(activeEvents(story).map(event => event.id));
  const consumed = new Set();
  const sentences = [];
  for (const item of (Array.isArray(raw?.sentences) ? raw.sentences : []).slice(0, 8)) {
    const text = String(item?.text || "").trim();
    const eventIds = [...new Set((Array.isArray(item?.eventIds) ? item.eventIds : [])
      .map(id => idMap.get(String(id))).filter(id => activeIds.has(id) && !consumed.has(id)))];
    if (!text || !eventIds.length) continue;
    eventIds.forEach(id => consumed.add(id));
    sentences.push({ sceneId: "scene_main", text, eventIds });
  }
  for (const event of activeEvents(story)) {
    if (consumed.has(event.id)) continue;
    const text = simpleEventSentence(event);
    if (text) sentences.push({ sceneId: "scene_main", text, eventIds: [event.id] });
  }
  const composition = normalizeComposition({ title: raw?.title, sentences }, story);
  const storyErrors = validateStory(story);
  const compositionErrors = validateCompositionStructure(story, composition);
  if (storyErrors.length || compositionErrors.length) {
    throw new Error("日记结构整理失败，请再试一次");
  }
  return { ...composition, story, quality: { softIssues: [] } };
}

async function finalizeSemanticDiary(input, callJson) {
  const sourceSpans = segmentTranscript(input.transcript);
  if (!sourceSpans.length) throw new Error("没有听到可以写进日记的事情");
  const raw = await callJson(onePassFinalizeMessages(sourceSpans), {
    stage: "finalize_one_pass",
    maxTokens: 2800,
    timeoutMs: 40000
  });
  return normalizeOnePassFinalization(raw, sourceSpans);
}

async function reviseSemanticDiary(input, callJson) {
  const currentStory = normalizeStory(input.story || {});
  const storyErrors = validateStory(currentStory);
  if (storyErrors.length || !activeEvents(currentStory).length) throw new Error("这篇旧日记还没有语义事件账本，暂时不能使用新版修改");
  const currentComposition = {
    title: String(input.title || "我的日记"),
    sentences: Array.isArray(input.sentences) ? input.sentences : []
  };
  if (validateCompositionStructure(currentStory, currentComposition).length) {
    throw new Error("当前日记与语义事件账本不一致，原日记已保留");
  }
  const revisionSpanId = `revision_${crypto.randomUUID()}`;
  const revisionSpan = { id: revisionSpanId, text: String(input.instruction || ""), role: "child_story", accepted: true, reason: "revision" };
  const storyWithRevisionSpan = normalizeStory({ ...currentStory, spans: [...currentStory.spans, revisionSpan] });
  const messages = revisionMessages({ ...input, revisionSpanId }, storyWithRevisionSpan, currentComposition);
  let rawPatch = await callJson(messages, { stage: "extract_revision_patch", maxTokens: 1800 });
  if (!Array.isArray(rawPatch?.operations) || !rawPatch.operations.length) {
    return { changed: false, message: rawPatch?.message || "还没有找到明确要修改的内容。" };
  }
  let applied;
  try {
    const sourceError = revisionPatchSourceError(rawPatch, revisionSpanId);
    if (sourceError) throw new Error(sourceError);
    applied = applyStoryPatch(storyWithRevisionSpan, rawPatch);
  } catch (firstError) {
    rawPatch = await callJson([
      ...messages,
      { role: "assistant", content: JSON.stringify(rawPatch) },
      { role: "user", content: JSON.stringify({ task: "事件补丁没有通过结构或来源校验。保持修改意思不变，只修正补丁。", error: firstError.message }) }
    ], { stage: "repair_revision_patch_structure", maxTokens: 1800 });
    if (!Array.isArray(rawPatch?.operations) || !rawPatch.operations.length) throw new Error("修改补丁校验失败，原日记已保留");
    const sourceError = revisionPatchSourceError(rawPatch, revisionSpanId);
    if (sourceError) throw new Error(`${sourceError}，原日记已保留`);
    applied = applyStoryPatch(storyWithRevisionSpan, rawPatch);
  }
  if (!activeEvents(applied.story).length) throw new Error("修改会删掉整篇日记，请直接使用删除日记功能");
  let patchAudit = await callJson(
    revisionPatchAuditMessages(input, storyWithRevisionSpan, rawPatch, applied.story, applied.affectedSceneIds),
    { stage: "audit_revision_patch", maxTokens: 1200 }
  );
  let patchHardErrors = revisionPatchHardErrors(applied.story, patchAudit);
  if (patchHardErrors.length) {
    rawPatch = await callJson([
      ...messages,
      { role: "assistant", content: JSON.stringify(rawPatch) },
      { role: "user", content: JSON.stringify({ task: "独立审计发现修改补丁漏掉或错改了内容。完整保留孩子本次明确的新信息，只修正补丁，不写正文。", audit: patchAudit }) }
    ], { stage: "repair_revision_patch_meaning", maxTokens: 1800 });
    rawPatch = applyAuditDirectedPatchFixes(rawPatch, storyWithRevisionSpan, patchAudit, input.instruction);
    if (!Array.isArray(rawPatch?.operations) || !rawPatch.operations.length) throw new Error("修改补丁核对失败，原日记已保留");
    const sourceError = revisionPatchSourceError(rawPatch, revisionSpanId);
    if (sourceError) throw new Error(`${sourceError}，原日记已保留`);
    applied = applyStoryPatch(storyWithRevisionSpan, rawPatch);
    patchAudit = await callJson(
      revisionPatchAuditMessages(input, storyWithRevisionSpan, rawPatch, applied.story, applied.affectedSceneIds),
      { stage: "reaudit_revision_patch", maxTokens: 1200 }
    );
    patchHardErrors = revisionPatchHardErrors(applied.story, patchAudit);
  }
  if (patchHardErrors.length) {
    if (process.env.SEMANTIC_DEBUG === "true") {
      console.error("Semantic revision patch debug", JSON.stringify({ patch: rawPatch, story: activeStoryView(applied.story), audit: patchAudit }, null, 2));
    }
    console.error("Semantic revision patch rejected", patchHardErrors.map(error => ({ type: error.type, eventIds: error.eventIds || [] })));
    throw new Error("修改内容没有完整进入事件，原日记已保留");
  }
  let candidate = applyDirectTextEdits(currentComposition, applied.directTextEdits);
  if (applied.affectedSceneIds.length) {
    let rawScenes = await callJson(compositionMessages(applied.story, {
      sceneIds: applied.affectedSceneIds,
      currentSceneText: currentComposition.sentences.filter(sentence => applied.affectedSceneIds.includes(sentence.sceneId))
    }), { stage: "compose_revision_scenes", maxTokens: 1600 });
    let replacement = normalizeComposition(rawScenes, applied.story, { lockedTitle: currentComposition.title });
    candidate = spliceScenes(applied.story, candidate, replacement, applied.affectedSceneIds);
    let audit = await auditCandidate(callJson, applied.story, candidate, {
      lockedSentences: currentComposition.sentences,
      changedSceneIds: applied.affectedSceneIds,
      auditStage: "audit_revision_diary"
    });
    if (audit.verdict !== "pass") {
      rawScenes = await callJson(repairMessages(applied.story, rawScenes, audit, {
        sceneIds: applied.affectedSceneIds,
        currentSceneText: currentComposition.sentences.filter(sentence => applied.affectedSceneIds.includes(sentence.sceneId))
      }), { stage: "repair_revision_diary", maxTokens: 1600 });
      replacement = normalizeComposition(rawScenes, applied.story, { lockedTitle: currentComposition.title });
      candidate = spliceScenes(applied.story, applyDirectTextEdits(currentComposition, applied.directTextEdits), replacement, applied.affectedSceneIds);
      audit = await auditCandidate(callJson, applied.story, candidate, {
        lockedSentences: currentComposition.sentences,
        changedSceneIds: applied.affectedSceneIds,
        auditStage: "reaudit_revision_diary"
      });
    }
    if (audit.hardErrors.length) {
      if (process.env.SEMANTIC_DEBUG === "true") {
        console.error("Semantic revision debug", JSON.stringify({ patch: rawPatch, story: activeStoryView(applied.story), candidate, audit }, null, 2));
      }
      console.error("Semantic revision rejected", audit.hardErrors.map(error => ({ type: error.type, eventIds: error.eventIds || [], relationId: error.relationId || "" })));
      throw new Error("修改后的事实核对没有通过，原日记已保留");
    }
    return { ...candidate, story: applied.story, changed: true, changedSceneIds: applied.affectedSceneIds, quality: { softIssues: audit.softIssues } };
  }
  const audit = await auditCandidate(callJson, applied.story, candidate, {
    lockedSentences: currentComposition.sentences.filter(sentence => !applied.directTextEdits.some(edit => edit.sentenceId === sentence.id)),
    changedSceneIds: [],
    auditStage: "audit_revision_text_edit"
  });
  if (audit.hardErrors.length) {
    console.error("Semantic revision rejected", audit.hardErrors.map(error => ({ type: error.type, eventIds: error.eventIds || [], relationId: error.relationId || "" })));
    throw new Error("修改后的事实核对没有通过，原日记已保留");
  }
  return { ...candidate, story: applied.story, changed: true, changedSceneIds: [], quality: { softIssues: audit.softIssues } };
}

module.exports = {
  auditMessages,
  compositionAsSceneResponse,
  compositionMessages,
  deterministicStyleIssues,
  extractionMessages,
  finalizeSemanticDiary,
  normalizeComposition,
  revisionPatchAuditMessages,
  revisionMessages,
  segmentTranscript,
  storyAuditMessages,
  reviseSemanticDiary
};
