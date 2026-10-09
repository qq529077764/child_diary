const STORY_SCHEMA_VERSION = 2;

const RELATION_TYPES = new Set(["before", "after", "causes", "result_of", "contrast", "condition", "elaborates"]);
const PATCH_TYPES = new Set(["update_event", "delete_event", "add_event", "set_relation", "remove_relation", "remove_generated_phrase"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function stringList(value, maxItems = 40, maxLength = 240) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function normalizeSpan(span, index) {
  return {
    id: text(span?.id, 80) || `span_${index + 1}`,
    text: text(span?.text, 1000),
    role: ["child_story", "adult_guidance", "background_audio", "meta_speech", "noise"].includes(span?.role)
      ? span.role
      : "noise",
    accepted: span?.accepted === true,
    reason: text(span?.reason, 160)
  };
}

function normalizeExpression(expression) {
  return {
    text: text(expression?.text, 80),
    bindTo: ["subject", "action", "object", "event", "feeling", "result"].includes(expression?.bindTo)
      ? expression.bindTo
      : "event",
    policy: expression?.policy === "drop" ? "drop" : "preserve",
    reason: text(expression?.reason, 120)
  };
}

function normalizeEvent(event, index, validSpanIds) {
  const sourceSpanIds = stringList(event?.sourceSpanIds, 30, 80).filter(id => validSpanIds.has(id));
  return {
    id: text(event?.id, 80) || `event_${index + 1}`,
    sceneId: text(event?.sceneId, 80) || "scene_main",
    subject: text(event?.subject, 80),
    action: text(event?.action, 80),
    object: text(event?.object, 120),
    time: text(event?.time, 120),
    location: text(event?.location, 120),
    manner: text(event?.manner, 120),
    result: text(event?.result, 180),
    feeling: text(event?.feeling, 120),
    polarity: event?.polarity === "negative" ? "negative" : "positive",
    certainty: event?.certainty === "uncertain" ? "uncertain" : "certain",
    details: stringList(event?.details, 20, 160),
    childExpressions: (Array.isArray(event?.childExpressions) ? event.childExpressions : [])
      .map(normalizeExpression)
      .filter(item => item.text),
    sourceSpanIds,
    status: ["active", "superseded", "deleted"].includes(event?.status) ? event.status : "active",
    confidence: Math.max(0, Math.min(1, Number(event?.confidence) || 0))
  };
}

function normalizeStory(raw = {}) {
  const spans = (Array.isArray(raw.spans) ? raw.spans : []).map(normalizeSpan).filter(span => span.text);
  const validSpanIds = new Set(spans.map(span => span.id));
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .map((event, index) => normalizeEvent(event, index, validSpanIds))
    .filter(event => event.action && event.certainty === "certain");
  const eventIds = new Set(events.map(event => event.id));
  const explicitScenes = (Array.isArray(raw.scenes) ? raw.scenes : []).map((scene, index) => ({
    id: text(scene?.id, 80) || `scene_${index + 1}`,
    label: text(scene?.label, 100),
    order: Number.isFinite(Number(scene?.order)) ? Number(scene.order) : index,
    sourceSpanIds: stringList(scene?.sourceSpanIds, 40, 80).filter(id => validSpanIds.has(id))
  }));
  const sceneIds = new Set(explicitScenes.map(scene => scene.id));
  for (const event of events) {
    if (!sceneIds.has(event.sceneId)) {
      explicitScenes.push({ id: event.sceneId, label: "", order: explicitScenes.length, sourceSpanIds: [...event.sourceSpanIds] });
      sceneIds.add(event.sceneId);
    }
  }
  const eventById = new Map(events.map(event => [event.id, event]));
  const relations = (Array.isArray(raw.relations) ? raw.relations : []).map((relation, index) => ({
    id: text(relation?.id, 80) || `relation_${index + 1}`,
    type: RELATION_TYPES.has(relation?.type) ? relation.type : "elaborates",
    from: text(relation?.from, 80),
    to: text(relation?.to, 80),
    sourceSpanIds: stringList(relation?.sourceSpanIds, 20, 80).filter(id => validSpanIds.has(id))
  })).filter(relation => eventIds.has(relation.from) && eventIds.has(relation.to) && relation.from !== relation.to)
    .map(relation => normalizeExplicitTimeRelation(relation, eventById));
  const corrections = (Array.isArray(raw.corrections) ? raw.corrections : []).map((correction, index) => ({
    id: text(correction?.id, 80) || `correction_${index + 1}`,
    discardedText: text(correction?.discardedText, 200),
    adoptedText: text(correction?.adoptedText, 200),
    sourceSpanIds: stringList(correction?.sourceSpanIds, 20, 80).filter(id => validSpanIds.has(id))
  })).filter(correction => correction.discardedText && correction.adoptedText);
  const story = {
    schemaVersion: STORY_SCHEMA_VERSION,
    titleHint: text(raw.titleHint, 80),
    spans,
    scenes: explicitScenes.sort((left, right) => left.order - right.order),
    events,
    relations,
    corrections
  };
  story.scenes = orderScenesByRelations(story);
  return story;
}

function explicitTimeRank(value) {
  const time = String(value || "");
  const ranks = [/凌晨/u, /清晨|早晨|早上/u, /上午/u, /中午/u, /下午/u, /傍晚/u, /晚上|夜里|夜间/u];
  return ranks.findIndex(pattern => pattern.test(time));
}

function normalizeExplicitTimeRelation(relation, eventById) {
  if (!["before", "after"].includes(relation.type)) return relation;
  const left = eventById.get(relation.from);
  const right = eventById.get(relation.to);
  const leftRank = explicitTimeRank(left?.time);
  const rightRank = explicitTimeRank(right?.time);
  if (leftRank < 0 || rightRank < 0 || leftRank === rightRank) return relation;
  const earlier = leftRank < rightRank ? relation.from : relation.to;
  const later = earlier === relation.from ? relation.to : relation.from;
  return { ...relation, type: "before", from: earlier, to: later };
}

function orderScenesByRelations(story) {
  const original = [...(story.scenes || [])].sort((left, right) => left.order - right.order);
  const originalIndex = new Map(original.map((scene, index) => [scene.id, index]));
  const eventById = new Map((story.events || [])
    .filter(event => event.status === "active" && event.certainty === "certain")
    .map(event => [event.id, event]));
  const edges = new Map(original.map(scene => [scene.id, new Set()]));
  const indegree = new Map(original.map(scene => [scene.id, 0]));
  for (const relation of story.relations || []) {
    const ordered = relationOrder(relation);
    if (!ordered) continue;
    const fromScene = eventById.get(ordered[0])?.sceneId;
    const toScene = eventById.get(ordered[1])?.sceneId;
    if (!fromScene || !toScene || fromScene === toScene || edges.get(fromScene)?.has(toScene)) continue;
    edges.get(fromScene)?.add(toScene);
    indegree.set(toScene, (indegree.get(toScene) || 0) + 1);
  }
  const ready = original.filter(scene => indegree.get(scene.id) === 0);
  const sorted = [];
  while (ready.length) {
    ready.sort((left, right) => originalIndex.get(left.id) - originalIndex.get(right.id));
    const scene = ready.shift();
    sorted.push(scene);
    for (const nextId of edges.get(scene.id) || []) {
      indegree.set(nextId, indegree.get(nextId) - 1);
      if (indegree.get(nextId) === 0) ready.push(original.find(item => item.id === nextId));
    }
  }
  const ordered = sorted.length === original.length ? sorted : original;
  return ordered.map((scene, index) => ({ ...scene, order: index }));
}

function validateStory(story) {
  const errors = [];
  if (story?.schemaVersion !== STORY_SCHEMA_VERSION) errors.push("unsupported_schema_version");
  const unique = (items, label) => {
    const ids = new Set();
    for (const item of items || []) {
      if (!item.id) errors.push(`${label}_missing_id`);
      else if (ids.has(item.id)) errors.push(`${label}_duplicate_id:${item.id}`);
      ids.add(item.id);
    }
    return ids;
  };
  const spanIds = unique(story?.spans, "span");
  const acceptedChildSpanIds = new Set((story?.spans || [])
    .filter(span => span.accepted && span.role === "child_story")
    .map(span => span.id));
  const sceneIds = unique(story?.scenes, "scene");
  const eventIds = unique(story?.events, "event");
  unique(story?.relations, "relation");
  unique(story?.corrections, "correction");
  for (const event of story?.events || []) {
    if (!event.action) errors.push(`event_missing_action:${event.id}`);
    if (!sceneIds.has(event.sceneId)) errors.push(`event_unknown_scene:${event.id}`);
    if (!event.sourceSpanIds.length) errors.push(`event_missing_source:${event.id}`);
    for (const spanId of event.sourceSpanIds) if (!spanIds.has(spanId)) errors.push(`event_unknown_span:${event.id}:${spanId}`);
    if (!event.sourceSpanIds.some(spanId => acceptedChildSpanIds.has(spanId))) errors.push(`event_missing_child_source:${event.id}`);
    if (event.details.some(detail => /(没有|没|不|不是|不能|不会|不要|别)/u.test(detail))) {
      errors.push(`negative_detail_must_be_event:${event.id}`);
    }
  }
  for (const relation of story?.relations || []) {
    if (!eventIds.has(relation.from) || !eventIds.has(relation.to)) errors.push(`relation_unknown_event:${relation.id}`);
  }
  for (const correction of story?.corrections || []) {
    if (!correction.sourceSpanIds.length) errors.push(`correction_missing_source:${correction.id}`);
    for (const spanId of correction.sourceSpanIds) if (!spanIds.has(spanId)) errors.push(`correction_unknown_span:${correction.id}:${spanId}`);
  }
  return errors;
}

function activeEvents(story) {
  return (story?.events || []).filter(event => event.status === "active" && event.certainty === "certain");
}

function relationOrder(relation) {
  if (relation.type === "before" || relation.type === "causes") return [relation.from, relation.to];
  if (relation.type === "after" || relation.type === "result_of") return [relation.to, relation.from];
  return null;
}

function validateCompositionStructure(story, composition, options = {}) {
  const errors = [];
  const sentences = Array.isArray(composition?.sentences) ? composition.sentences : [];
  const requiredEvents = activeEvents(story);
  const requiredIds = new Set(requiredEvents.map(event => event.id));
  const usedIds = sentences.flatMap(sentence => Array.isArray(sentence?.eventIds) ? sentence.eventIds : []);
  const counts = usedIds.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
  if (!sentences.length) errors.push({ type: "empty_composition" });
  for (const id of usedIds) if (!requiredIds.has(id)) errors.push({ type: "unknown_or_inactive_event", eventId: id });
  for (const event of requiredEvents) {
    const count = counts.get(event.id) || 0;
    if (!count) errors.push({ type: "missing_event", eventId: event.id });
    if (count > 1) errors.push({ type: "duplicate_event", eventId: event.id });
  }
  const positions = new Map();
  usedIds.forEach((id, index) => { if (!positions.has(id)) positions.set(id, index); });
  for (const relation of story?.relations || []) {
    const ordered = relationOrder(relation);
    if (!ordered || !positions.has(ordered[0]) || !positions.has(ordered[1])) continue;
    if (positions.get(ordered[0]) > positions.get(ordered[1])) {
      errors.push({ type: "relation_reversed", relationId: relation.id, eventIds: ordered });
    }
  }
  if (Array.isArray(options.lockedSentences)) {
    const candidateById = new Map(sentences.filter(item => item?.id).map(item => [item.id, item]));
    const changedSceneIds = new Set(options.changedSceneIds || []);
    for (const locked of options.lockedSentences) {
      if (changedSceneIds.has(locked.sceneId)) continue;
      const candidate = candidateById.get(locked.id);
      if (!candidate || candidate.text !== locked.text || candidate.sceneId !== locked.sceneId) {
        errors.push({ type: "locked_sentence_changed", sentenceId: locked.id });
      }
    }
  }
  return errors;
}

function applyStoryPatch(story, rawPatch) {
  const next = normalizeStory(clone(story));
  const operations = Array.isArray(rawPatch?.operations) ? rawPatch.operations : [];
  const affectedSceneIds = new Set();
  const directTextEdits = [];
  const eventById = () => new Map(next.events.map(event => [event.id, event]));
  for (const operation of operations) {
    if (!PATCH_TYPES.has(operation?.type)) throw new Error(`unsupported_patch:${operation?.type || "unknown"}`);
    const events = eventById();
    if (operation.type === "update_event") {
      const target = events.get(text(operation.eventId, 80));
      if (!target) throw new Error(`patch_event_not_found:${operation.eventId}`);
      affectedSceneIds.add(target.sceneId);
      const changes = operation.changes || {};
      for (const field of ["subject", "action", "object", "time", "location", "manner", "result", "feeling"]) {
        if (Object.hasOwn(changes, field)) target[field] = text(changes[field], field === "result" ? 180 : 120);
      }
      if (Object.hasOwn(changes, "polarity")) target.polarity = changes.polarity === "negative" ? "negative" : "positive";
      if (Array.isArray(changes.details)) {
        target.details = stringList(changes.details, 20, 160);
      } else if (changes.details && typeof changes.details === "object") {
        const removeDetails = new Set(stringList(changes.details.remove, 20, 160));
        target.details = [...new Set([
          ...target.details.filter(item => !removeDetails.has(item)),
          ...stringList(changes.details.add, 20, 160)
        ])];
      }
      if (Array.isArray(changes.childExpressions)) {
        target.childExpressions = changes.childExpressions.map(normalizeExpression).filter(item => item.text);
      } else if (changes.childExpressions && typeof changes.childExpressions === "object") {
        const removeTexts = new Set(stringList(changes.childExpressions.removeTexts, 20, 80));
        const additions = (Array.isArray(changes.childExpressions.add) ? changes.childExpressions.add : [])
          .map(normalizeExpression)
          .filter(item => item.text);
        target.childExpressions = target.childExpressions.filter(item => !removeTexts.has(item.text));
        for (const addition of additions) {
          const existingIndex = target.childExpressions.findIndex(item => item.text === addition.text && item.bindTo === addition.bindTo);
          if (existingIndex >= 0) target.childExpressions[existingIndex] = addition;
          else target.childExpressions.push(addition);
        }
      }
      const revisionSources = stringList(operation.sourceSpanIds, 10, 80).filter(id => next.spans.some(span => span.id === id));
      target.sourceSpanIds = [...new Set([...target.sourceSpanIds, ...revisionSources])];
      if (changes.sceneId && changes.sceneId !== target.sceneId) {
        affectedSceneIds.add(text(changes.sceneId, 80));
        target.sceneId = text(changes.sceneId, 80);
      }
    } else if (operation.type === "delete_event") {
      const target = events.get(text(operation.eventId, 80));
      if (!target) throw new Error(`patch_event_not_found:${operation.eventId}`);
      target.status = "deleted";
      const revisionSources = stringList(operation.sourceSpanIds, 10, 80).filter(id => next.spans.some(span => span.id === id));
      target.sourceSpanIds = [...new Set([...target.sourceSpanIds, ...revisionSources])];
      affectedSceneIds.add(target.sceneId);
    } else if (operation.type === "add_event") {
      const validSpanIds = new Set(next.spans.map(span => span.id));
      const added = normalizeEvent(operation.event, next.events.length, validSpanIds);
      if (events.has(added.id)) throw new Error(`patch_duplicate_event:${added.id}`);
      if (!added.action || !added.sourceSpanIds.length) throw new Error("patch_added_event_invalid");
      next.events.push(added);
      affectedSceneIds.add(added.sceneId);
      if (!next.scenes.some(scene => scene.id === added.sceneId)) {
        next.scenes.push({ id: added.sceneId, label: "", order: next.scenes.length, sourceSpanIds: [...added.sourceSpanIds] });
      }
    } else if (operation.type === "set_relation") {
      const relation = operation.relation || {};
      if (!events.has(relation.from) || !events.has(relation.to) || !RELATION_TYPES.has(relation.type)) {
        throw new Error("patch_relation_invalid");
      }
      const relationFamily = ["before", "after"].includes(relation.type)
        ? new Set(["before", "after"])
        : ["causes", "result_of"].includes(relation.type)
          ? new Set(["causes", "result_of"])
          : new Set([relation.type]);
      next.relations = next.relations.filter(item => {
        if (item.id === relation.id) return false;
        const samePair = (item.from === relation.from && item.to === relation.to) ||
          (item.from === relation.to && item.to === relation.from);
        return !(samePair && relationFamily.has(item.type));
      });
      next.relations.push({
        id: text(relation.id, 80) || `relation_${next.relations.length + 1}`,
        type: relation.type,
        from: relation.from,
        to: relation.to,
        sourceSpanIds: stringList(relation.sourceSpanIds, 20, 80).filter(id => next.spans.some(span => span.id === id))
      });
      affectedSceneIds.add(events.get(relation.from).sceneId);
      affectedSceneIds.add(events.get(relation.to).sceneId);
    } else if (operation.type === "remove_relation") {
      const relation = next.relations.find(item => item.id === operation.relationId);
      if (!relation) throw new Error(`patch_relation_not_found:${operation.relationId}`);
      affectedSceneIds.add(events.get(relation.from)?.sceneId);
      affectedSceneIds.add(events.get(relation.to)?.sceneId);
      next.relations = next.relations.filter(item => item.id !== operation.relationId);
    } else if (operation.type === "remove_generated_phrase") {
      directTextEdits.push({ sentenceId: text(operation.sentenceId, 100), phrase: text(operation.phrase, 100) });
    }
  }
  const normalized = normalizeStory(next);
  const validationErrors = validateStory(normalized);
  if (validationErrors.length) throw new Error(`patched_story_invalid:${validationErrors.join(",")}`);
  return { story: normalized, affectedSceneIds: [...affectedSceneIds].filter(Boolean), directTextEdits };
}

module.exports = {
  STORY_SCHEMA_VERSION,
  activeEvents,
  applyStoryPatch,
  normalizeStory,
  relationOrder,
  validateCompositionStructure,
  validateStory
};
