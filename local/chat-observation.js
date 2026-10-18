import {createHash} from "node:crypto";

export const OBSERVATION_SCHEMA_VERSION = 1;
export const OBSERVER_SOURCE_VERSION = "chat-observer-1";
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const clock = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const signalKeys = ["assistantBusy","composerHasDraft","stopControlVerified","connectionWarning",
  "lengthWarning","providerRestriction","otherWarning","uiAmbiguous","contentComplete",
  "ciWaitCue","humanActionCue","scopeCompleteCue"];

// One whitelist for IPC and persistence. Unverified provider errors are redacted.
export function projectObservation(page, observedAt = page?.observedAt, bindingFingerprint = page?.bindingFingerprint) {
  const fail = reasonCode => ({schemaVersion:1,sourceVersion:OBSERVER_SOURCE_VERSION,
    source:"chatgpt-dom",verified:false,observedAt:clock(observedAt)?observedAt:null,reasonCode});
  if (page?.schemaVersion !== 1 || page.sourceVersion !== OBSERVER_SOURCE_VERSION ||
      page.source !== "chatgpt-dom" || page.verified !== true || !clock(observedAt) ||
      !hex(bindingFingerprint) || page.bindingFingerprint !== bindingFingerprint)
    return fail("PAGE_OBSERVATION_UNVERIFIED");
  const output = {schemaVersion:1,sourceVersion:OBSERVER_SOURCE_VERSION,source:"chatgpt-dom",
    verified:true,reasonCode:"UI_OBSERVED",observedAt,bindingFingerprint,
    replyFingerprint:hex(page.replyFingerprint)?page.replyFingerprint:null};
  if(page.humanActionCategory!==undefined&&page.humanActionCategory!==null&&
    !["cost","local_test","login","approval","design"].includes(page.humanActionCategory))return fail("PAGE_OBSERVATION_INVALID");
  output.humanActionCategory=page.humanActionCategory??null;
  for (const key of signalKeys) {
    if (typeof page[key] !== "boolean" && !(["assistantBusy","composerHasDraft"].includes(key) && page[key] === null))
      return fail("PAGE_OBSERVATION_INVALID");
    output[key]=page[key];
  }
  return output;
}

// Read-only orchestration seam. No default real-browser implementation.
// The future worker must revalidate enrollment/permission before injection.
export async function observeRegisteredChat({registration, getLiveTab, readPage, permitted = false, now = Date.now}) {
  const observedAt = now();
  const result = reasonCode => ({schemaVersion:1, sourceVersion:OBSERVER_SOURCE_VERSION,
    source:"chatgpt-dom", verified:false, observedAt, reasonCode});
  if (permitted !== true) return result("OBSERVATION_NOT_PERMITTED");
  let url;
  try { url = new URL(registration?.url); } catch { return result("INVALID_REGISTRATION"); }
  if (!clock(observedAt) || !identifier(registration?.workstreamId) || !identifier(registration.sessionKey) ||
      !Number.isSafeInteger(registration.tabId) || registration.tabId < 0 ||
      !Number.isSafeInteger(registration.windowId) || registration.windowId < 0 ||
      !Number.isInteger(registration.groupId) || url.origin !== "https://chatgpt.com" ||
      url.username || url.password || url.search || url.hash ||
      !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(url.pathname)) return result("INVALID_REGISTRATION");
  // Copy before await: a changed caller object cannot silently rebind a read.
  const binding = {...registration};
  const matches = tab => tab?.id === binding.tabId && tab.windowId === binding.windowId &&
    tab.groupId === binding.groupId && tab.url === binding.url;
  const bindingFingerprint = fingerprint([binding.workstreamId,binding.sessionKey,binding.tabId,
    binding.windowId,binding.groupId,binding.url]);
  try {
    if (!matches(await getLiveTab(binding.tabId))) return result("REGISTERED_TAB_MISMATCH");
    const page = await readPage(binding.tabId,{permitted:true,expectedPath:url.pathname,bindingFingerprint});
    if (!matches(await getLiveTab(binding.tabId))) return result("REGISTERED_TAB_CHANGED");
    return projectObservation(page,observedAt,bindingFingerprint);
  } catch { return result("OBSERVATION_UNAVAILABLE"); }
}

// Pure signal classification only. These are observations, not action grants.
export function classifyObservation(current, {previous = null, now, stableForMs, maxAgeMs} = {}) {
  let assistantStable = false;
  const verdict = (state,reasonCode) => ({schemaVersion:1,source:"chatgpt-dom",sourceVersion:OBSERVER_SOURCE_VERSION,state,reasonCode,
    assistantStable,
    verified:state !== "UNKNOWN",observedAt:clock(current?.observedAt) ? current.observedAt : null,
    observationFingerprint:fingerprint([current?.bindingFingerprint,current?.replyFingerprint,
      current?.observedAt,state,reasonCode])});
  const unknown = reason => verdict("UNKNOWN",reason);
  if (!clock(now) || !Number.isSafeInteger(stableForMs) || stableForMs <= 0 ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < stableForMs) return unknown("INVALID_OBSERVATION_POLICY");
  if (current?.schemaVersion !== 1 || current?.sourceVersion !== OBSERVER_SOURCE_VERSION ||
      current.source !== "chatgpt-dom" || current.verified !== true ||
      !hex(current.bindingFingerprint)) return unknown("OBSERVATION_UNVERIFIED");
  if (!clock(current.observedAt) || current.observedAt > now || now-current.observedAt > maxAgeMs)
    return unknown("OBSERVATION_STALE");
  for (const key of signalKeys) {
    if (typeof current[key] !== "boolean" && !(["assistantBusy","composerHasDraft"].includes(key) && current[key] === null))
      return unknown("OBSERVATION_INVALID");
  }
  const sampleReady = sample => sample?.assistantBusy === false && sample.composerHasDraft === false &&
    sample.uiAmbiguous === false && sample.otherWarning === false && sample.connectionWarning === false &&
    sample.lengthWarning === false && sample.providerRestriction === false && sample.stopControlVerified === false &&
    sample.contentComplete === true && hex(sample.replyFingerprint);
  if (sampleReady(current) && sampleReady(previous) &&
      previous.bindingFingerprint === current.bindingFingerprint && previous.replyFingerprint === current.replyFingerprint &&
      previous.observedAt < current.observedAt && current.observedAt-previous.observedAt >= stableForMs) {
    const baseline = classifyObservation(previous,{now,stableForMs,maxAgeMs});
    assistantStable = ["RESPONSE_STABILIZING","EXACT_CI_LOOKUP_REQUIRED","HUMAN_ACTION_CUE"].includes(baseline.reasonCode);
  }
  if (current.providerRestriction) return verdict("WAIT_HUMAN","PROVIDER_RESTRICTION");
  if (current.humanActionCue) return verdict("WAIT_HUMAN","HUMAN_ACTION_CUE");
  if (current.composerHasDraft === true) return unknown("USER_DRAFT_PRESENT");
  if (current.composerHasDraft === null) return unknown("COMPOSER_DRAFT_UNKNOWN");
  if (current.uiAmbiguous || current.otherWarning) return unknown("UI_AMBIGUOUS");
  if (current.stopControlVerified && current.assistantBusy !== true) return unknown("CONFLICTING_SIGNALS");
  if (Number(current.connectionWarning)+Number(current.lengthWarning)+Number(current.ciWaitCue)>1 ||
      (current.scopeCompleteCue && (current.ciWaitCue || current.connectionWarning || current.lengthWarning)))
    return unknown("CONFLICTING_SIGNALS");
  if (current.connectionWarning) return verdict("DISCONNECTED","CONNECTION_WARNING_OBSERVED");
  if (current.lengthWarning) return verdict("LENGTH_LIMIT","LENGTH_WARNING_OBSERVED");
  if (current.ciWaitCue) return verdict("CI_WAIT_CUE","EXACT_CI_LOOKUP_REQUIRED");
  if (current.assistantBusy === true) return verdict("GENERATING","ASSISTANT_GENERATING");
  if (current.assistantBusy !== false || !current.contentComplete || !hex(current.replyFingerprint))
    return unknown("RESPONSE_COMPLETION_UNPROVEN");
  // Both samples must be valid normal responses of the same exact enrollment.
  // A draft/error/busy sample cannot be used as the stability baseline.
  if (!assistantStable) return unknown("RESPONSE_STABILIZING");
  return verdict("RESPONSE_COMPLETE","STABLE_ASSISTANT_RESPONSE");
}
