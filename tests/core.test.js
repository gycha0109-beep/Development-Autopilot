import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyRegistry, normalizedRegistry, applyAction, groupStatus, sessionStatus,
  activeGroupFor, activeSessionFor, overview
} from "../extension/core.js";

const epochA = "session-a";
const epochB = "session-b";
let counter = 0;
const makeId = () => "key-" + ++counter;

function snapshot() {
  return {
    groups: [
      { id: 2, windowId: 10, title: "AUTO-WORK", color: "blue" },
      { id: 8, windowId: 20, title: "OTHER", color: "red" }
    ],
    tabs: [
      { id: 101, groupId: 2, windowId: 10, url: "https://chatgpt.com/c/build", title: "BuildMap" },
      { id: 102, groupId: 2, windowId: 10, url: "https://chatgpt.com/c/beauty", title: "Bejewely" },
      { id: 201, groupId: 8, windowId: 20, url: "https://example.org", title: "Other" }
    ]
  };
}

function apply(reg, action, snap = snapshot(), epoch = epochA) {
  return applyAction(reg, action, snap, epoch, makeId, 1234567890);
}

function enrolled() {
  let reg = apply(emptyRegistry(), { type: "enrollGroup", groupId: 2 });
  reg = apply(reg, { type: "enrollTab", groupKey: reg.groups[0].key, tabId: 101 });
  return reg;
}

test("starts empty and discards incompatible registry schema", () => {
  assert.deepEqual(normalizedRegistry(null), emptyRegistry());
  assert.deepEqual(normalizedRegistry({ version: 99, groups: [1], sessions: [1] }), emptyRegistry());
});

test("explicitly enrolls a group then one tab, not the whole group", () => {
  const reg = enrolled();
  assert.equal(reg.groups.length, 1);
  assert.equal(reg.sessions.length, 1);
  assert.equal(reg.groups[0].label, "AUTO-WORK");
  assert.equal(reg.sessions[0].url, "https://chatgpt.com/c/build");
  assert.equal(activeSessionFor(reg, snapshot(), epochA, 102), undefined);
  assert.equal(overview(reg, snapshot(), epochA).activeTabs, 1);
});

test("tab cannot be enrolled before its containing group", () => {
  assert.throws(() => apply(emptyRegistry(),
    { type: "enrollTab", groupKey: "unknown", tabId: 101 }), /그룹/);
});

test("never accepts a tab from another window or group", () => {
  let reg = apply(emptyRegistry(), { type: "enrollGroup", groupId: 2 });
  assert.throws(() => apply(reg,
    { type: "enrollTab", groupKey: reg.groups[0].key, tabId: 201 }), /속하지/);
});

test("group enrollment rejects non-existent and duplicate group IDs", () => {
  let reg = apply(emptyRegistry(), { type: "enrollGroup", groupId: 2 });
  assert.throws(() => apply(reg, { type: "enrollGroup", groupId: 2 }), /이미/);
  assert.throws(() => apply(reg, { type: "enrollGroup", groupId: 999 }), /존재/);
});

test("session enrollment rejects duplicate same-session tab IDs", () => {
  const reg = enrolled();
  assert.throws(() => apply(reg,
    { type: "enrollTab", groupKey: reg.groups[0].key, tabId: 101 }), /이미/);
});

test("registration does not silently survive a new browser epoch", () => {
  const reg = enrolled();
  const sameIds = snapshot(); // Chrome may reuse numeric IDs after restart.
  assert.equal(groupStatus(reg.groups[0], sameIds, epochB), "needs-rebind");
  assert.equal(sessionStatus(reg.sessions[0], reg, sameIds, epochB), "needs-rebind");
  assert.equal(activeGroupFor(reg, sameIds, epochB, 2), undefined);
  assert.equal(overview(reg, sameIds, epochB).activeTabs, 0);
});

test("manual group rebind invalidates all old tab associations", () => {
  let reg = enrolled();
  const newBrowser = snapshot();
  newBrowser.groups[0].id = 30;
  newBrowser.tabs[0].groupId = 30;
  newBrowser.tabs[1].groupId = 30;
  newBrowser.tabs[0].id = 301;
  newBrowser.tabs[1].id = 302;
  reg = apply(reg, { type: "rebindGroup", groupKey: reg.groups[0].key, groupId: 30 },
    newBrowser, epochB);
  assert.equal(groupStatus(reg.groups[0], newBrowser, epochB), "connected");
  assert.equal(sessionStatus(reg.sessions[0], reg, newBrowser, epochB), "needs-rebind");
  assert.equal(overview(reg, newBrowser, epochB).activeTabs, 0);
  reg = apply(reg, { type: "rebindTab", sessionKey: reg.sessions[0].key, tabId: 301 },
    newBrowser, epochB);
  assert.equal(sessionStatus(reg.sessions[0], reg, newBrowser, epochB), "connected");
  assert.equal(reg.sessions[0].tabId, 301);
});

test("tab navigation does not keep the old conversation enrolled", () => {
  let reg = enrolled();
  const changed = snapshot();
  changed.tabs[0].url = "https://chatgpt.com/c/another-conversation";
  assert.equal(sessionStatus(reg.sessions[0], reg, changed, epochA), "url-changed");
  assert.equal(activeSessionFor(reg, changed, epochA, 101), undefined);
  reg = apply(reg, { type: "rebindTab", sessionKey: reg.sessions[0].key, tabId: 101 }, changed);
  assert.equal(sessionStatus(reg.sessions[0], reg, changed, epochA), "connected");
});

test("rebind refuses another currently enrolled tab", () => {
  let reg = enrolled();
  reg = apply(reg, { type: "enrollTab", groupKey: reg.groups[0].key, tabId: 102 });
  assert.throws(() => apply(reg,
    { type: "rebindTab", sessionKey: reg.sessions[0].key, tabId: 102 }), /다른 등록/);
});

test("missing tabs and groups stop reporting connected", () => {
  const reg = enrolled();
  const noTab = snapshot();
  noTab.tabs = noTab.tabs.filter(t => t.id !== 101);
  assert.equal(sessionStatus(reg.sessions[0], reg, noTab, epochA), "missing");
  const noGroup = snapshot();
  noGroup.groups = noGroup.groups.filter(g => g.id !== 2);
  assert.equal(groupStatus(reg.groups[0], noGroup, epochA), "missing");
});

test("pausing registrations is explicit and persistent", () => {
  let reg = enrolled();
  const groupKey = reg.groups[0].key;
  const sessionKey = reg.sessions[0].key;
  reg = apply(reg, { type: "pauseGroup", groupKey, paused: true });
  reg = apply(reg, { type: "pauseTab", sessionKey, paused: true });
  assert.equal(reg.groups[0].paused, true);
  assert.equal(reg.sessions[0].paused, true);
  assert.equal(normalizedRegistry(JSON.parse(JSON.stringify(reg))).sessions[0].paused, true);
});

test("removing a group cascades only its enrolled tab records", () => {
  let reg = enrolled();
  const oldKey = reg.groups[0].key;
  reg = apply(reg, { type: "enrollGroup", groupId: 8 });
  reg = apply(reg, { type: "enrollTab", groupKey: reg.groups[1].key, tabId: 201 });
  reg = apply(reg, { type: "removeGroup", groupKey: oldKey });
  assert.equal(reg.groups.length, 1);
  assert.equal(reg.sessions.length, 1);
  assert.equal(reg.sessions[0].tabId, 201);
});

test("removing one tab never unregisters its group", () => {
  let reg = enrolled();
  reg = apply(reg, { type: "removeTab", sessionKey: reg.sessions[0].key });
  assert.equal(reg.groups.length, 1);
  assert.equal(reg.sessions.length, 0);
});

test("rejects unknown mutations and malformed identity requests", () => {
  assert.throws(() => apply(emptyRegistry(), { type: "doEverything" }), /지원/);
  assert.throws(() => apply(emptyRegistry(), { type: "enrollGroup", groupId: 2 },
    snapshot(), ""), /세션/);
  assert.throws(() => applyAction(emptyRegistry(), { type: "enrollGroup", groupId: 2 },
    snapshot(), epochA, () => "", 0), /식별자/);
});

test("malformed entries cannot survive schema normalization", () => {
  const restored = normalizedRegistry({
    version: 1,
    groups: [{ key: "g", groupId: "NaN", windowId: 1, sessionToken: epochA }],
    sessions: [{ key: "s", groupKey: "g", tabId: null, sessionToken: epochA }]
  });
  assert.equal(restored.groups.length, 0);
  assert.equal(restored.sessions.length, 0);
});
