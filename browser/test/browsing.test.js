const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Browsing } = require("../dist/session/browsing.js");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-browsing-"));
  return new Browsing(path.join(dir, "browsing.db"));
}

const MINUTE = 60 * 1000;

test("history keeps web pages and counts visits", () => {
  const store = freshStore();
  store.visit("", { url: "https://github.com/zenbu-labs", title: "" }, true, 1000);
  store.visit("", { url: "https://github.com/zenbu-labs", title: "zenbu-labs" }, false, 2000);
  store.visit("", { url: "https://github.com/zenbu-labs", title: "zenbu-labs" }, true, 3000);
  store.visit("", { url: "about:blank", title: "" }, true, 4000);
  store.visit("", { url: "terminal-browser://start", title: "Start" }, true, 5000);
  assert.deepEqual(store.search("", "", 10), [{ url: "https://github.com/zenbu-labs", title: "zenbu-labs" }]);
});

test("a title update keeps the earlier title when the new one is empty", () => {
  const store = freshStore();
  store.visit("", { url: "https://example.com/", title: "Example" }, true, 1000);
  store.visit("", { url: "https://example.com/", title: "" }, true, 2000);
  assert.deepEqual(store.search("", "exa", 1), [{ url: "https://example.com/", title: "Example" }]);
});

test("search matches every word in the address or the title, address starts first", () => {
  const store = freshStore();
  store.visit("", { url: "https://news.ycombinator.com/", title: "Hacker News" }, true, 1000);
  store.visit("", { url: "https://www.github.com/", title: "GitHub" }, true, 2000);
  store.visit("", { url: "https://blog.example.com/github-tips", title: "Tips" }, true, 3000);
  assert.deepEqual(
    store.search("", "git", 5).map((page) => page.url),
    ["https://www.github.com/", "https://blog.example.com/github-tips"],
  );
  assert.deepEqual(
    store.search("", "hacker news", 5).map((page) => page.url),
    ["https://news.ycombinator.com/"],
  );
  assert.deepEqual(store.search("", "100%_", 5), []);
});

test("history is kept per profile and can be cleared", () => {
  const store = freshStore();
  store.visit("", { url: "https://a.example/", title: "A" }, true, 1000);
  store.visit("ssh-devbox", { url: "https://b.example/", title: "B" }, true, 1000);
  assert.deepEqual(store.search("", "", 5).map((page) => page.url), ["https://a.example/"]);
  store.clearHistory("");
  assert.deepEqual(store.search("", "", 5), []);
  assert.deepEqual(store.search("ssh-devbox", "", 5).map((page) => page.url), ["https://b.example/"]);
});

test("a window comes back in the same place, and only once while it is open", () => {
  const store = freshStore();
  const now = Date.now();
  const tabs = [
    { url: "https://a.example/", title: "A" },
    { url: "https://b.example/", title: "B" },
  ];
  store.saveWindow({ id: "w1", profile: "", place: "block:1", owner: "100-1" }, tabs, 1, now - 10 * MINUTE);
  store.saveWindow(
    { id: "w2", profile: "", place: "block:2", owner: "100-2" },
    [{ url: "https://c.example/", title: "C" }],
    0,
    now - 5 * MINUTE,
  );

  const gone = () => false;
  const open = (owner) => owner.startsWith("200-");
  assert.deepEqual(store.claimWindow("", "block:1", "200-1", gone, now), { id: "w1", tabs, active: 1 });
  assert.equal(store.claimWindow("", "block:1", "200-2", open, now + MINUTE)?.id, "w2");
  assert.equal(store.claimWindow("", "block:1", "200-3", open, now + MINUTE), null);
});

test("an open window is not taken; a closed, killed or silent one is", () => {
  const store = freshStore();
  const now = Date.now();
  const tabs = [{ url: "https://a.example/", title: "A" }];
  const open = () => true;
  store.saveWindow({ id: "w1", profile: "", place: null, owner: "100-1" }, tabs, 0, now - 30 * 1000);
  assert.equal(store.claimWindow("", null, "200-1", open, now), null);
  assert.equal(store.claimWindow("", null, "200-1", () => false, now)?.id, "w1");
  store.saveWindow({ id: "w1", profile: "", place: null, owner: null }, tabs, 0, now - 30 * 1000);
  assert.equal(store.claimWindow("", null, "200-2", open, now)?.id, "w1");
  store.saveWindow({ id: "w1", profile: "", place: null, owner: "300-1" }, tabs, 0, now - 10 * MINUTE);
  assert.equal(store.claimWindow("", null, "200-3", open, now)?.id, "w1");
});

test("windows are kept per profile and empty ones are dropped", () => {
  const store = freshStore();
  const now = Date.now();
  store.saveWindow({ id: "w1", profile: "ssh-devbox", place: null, owner: null }, [{ url: "https://a/", title: "" }], 0, now - MINUTE);
  store.saveWindow({ id: "w2", profile: "", place: null, owner: null }, [], 0, now - MINUTE);
  assert.equal(store.claimWindow("", null, "200-1", () => false, now), null);
  assert.equal(store.claimWindow("ssh-devbox", null, "200-1", () => false, now)?.id, "w1");
});
