"use strict";
// background.js を、Firefox の API をまねた偽物の上で動かすテスト。
// 本物の Firefox の動作確認の代わりにはならないが、判定と並べ替えの筋道を確かめられる。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = ["src/reorder.js", "src/background.js"].map((p) =>
  fs.readFileSync(path.join(__dirname, "..", p), "utf8")
);

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
  };
}

const norm = (u) => new URL(u).href;

// tree: { id: { type, url?, children?: [id...] } }
function makeBrowser(tree, storageData = {}) {
  const nodes = new Map();
  nodes.set("root________", { id: "root________", type: "folder", children: [] });
  for (const [id, n] of Object.entries(tree)) nodes.set(id, { id, children: [], ...n });
  for (const n of nodes.values()) for (const c of n.children) nodes.get(c).parentId = n.id;
  for (const n of nodes.values()) {
    if (n.id !== "root________" && !n.parentId) {
      n.parentId = "root________";
      nodes.get("root________").children.push(n.id);
    }
  }
  const view = (n) => {
    const parent = nodes.get(n.parentId);
    return { id: n.id, type: n.type, url: n.url, parentId: n.parentId, index: parent ? parent.children.indexOf(n.id) : 0 };
  };
  const moves = [];
  const menuState = {};
  const storage = { ...storageData };

  const browser = {
    bookmarks: {
      async get(id) {
        if (!nodes.has(id)) throw new Error("not found");
        return [view(nodes.get(id))];
      },
      async getChildren(id) {
        return nodes.get(id).children.map((c) => view(nodes.get(c)));
      },
      async move(id, { parentId, index }) {
        const n = nodes.get(id);
        assert.equal(parentId, n.parentId, "所属フォルダを変えない");
        const list = nodes.get(parentId).children;
        const from = list.indexOf(id);
        assert.ok(index <= from, "前へ移す操作だけのはず");
        list.splice(from, 1);
        list.splice(index, 0, id);
        moves.push(id);
      },
      async search({ url }) {
        return [...nodes.values()].filter((n) => n.url && norm(n.url) === norm(url)).map(view);
      },
      onRemoved: event(),
    },
    storage: {
      local: {
        async get(key) {
          return key in storage ? { [key]: JSON.parse(JSON.stringify(storage[key])) } : {};
        },
        async set(obj) {
          Object.assign(storage, JSON.parse(JSON.stringify(obj)));
        },
      },
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event() },
    tabs: { onRemoved: event() },
    runtime: { onInstalled: event(), onStartup: event() },
    menus: {
      async removeAll() {},
      create(opts) {
        Object.assign(menuState, opts);
      },
      async update(_id, opts) {
        Object.assign(menuState, opts);
      },
      refresh() {},
      onShown: event(),
      onClicked: event(),
    },
  };

  const order = (id) => nodes.get(id).children.slice();
  const remove = async (id) => {
    const n = nodes.get(id);
    const walk = (x) => {
      nodes.get(x).children.forEach(walk);
      nodes.delete(x);
    };
    nodes.get(n.parentId).children = nodes.get(n.parentId).children.filter((c) => c !== id);
    walk(id);
    await browser.bookmarks.onRemoved.fire(id, { parentId: n.parentId, node: view(n) });
  };
  return { browser, moves, menuState, storage, order, remove };
}

function load(env) {
  const ctx = vm.createContext({ browser: env.browser, console, URL, Set, Map, Promise });
  for (const code of SRC) vm.runInContext(code, ctx);
  return env;
}

const flush = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

async function visit(env, tabId, ...urls) {
  // urls: 読み込み開始時のアドレス…, 最後が実際に開いたアドレス
  for (const url of urls.slice(0, -1)) {
    await env.browser.webNavigation.onBeforeNavigate.fire({ tabId, frameId: 0, url });
  }
  await env.browser.webNavigation.onCommitted.fire({ tabId, frameId: 0, url: urls.at(-1) });
  await flush();
}

async function toggle(env, folderId, checked) {
  await env.browser.menus.onClicked.fire({ menuItemId: "bookmark-bump-toggle", bookmarkId: folderId, checked });
  await flush();
}

// 指示書 2.4 の構造
const nested = () => ({
  A: { type: "folder", children: ["A1", "A2", "B", "C"] },
  A1: { type: "bookmark", url: "https://a1.example/" },
  A2: { type: "bookmark", url: "https://a2.example/" },
  B: { type: "folder", children: ["B1", "B2"] },
  B1: { type: "bookmark", url: "https://b1.example/" },
  B2: { type: "bookmark", url: "https://b2.example/" },
  C: { type: "folder", children: ["C1", "C2"] },
  C1: { type: "bookmark", url: "https://c1.example/" },
  C2: { type: "bookmark", url: "https://c2.example/" },
});

test("初期状態は OFF で、何も動かさない", async () => {
  const env = load(makeBrowser(nested()));
  await visit(env, 1, "https://b2.example/");
  assert.deepEqual(env.moves, []);
});

test("ON にしたフォルダだけ並べ替わる（親・兄弟フォルダは影響を受けない）", async () => {
  const env = load(makeBrowser(nested()));
  await toggle(env, "B", true);
  await visit(env, 1, "https://b2.example/");
  assert.deepEqual(env.order("B"), ["B2", "B1"]);
  await visit(env, 1, "https://a2.example/");
  await visit(env, 1, "https://c2.example/");
  assert.deepEqual(env.order("A"), ["A1", "A2", "B", "C"]);
  assert.deepEqual(env.order("C"), ["C1", "C2"]);
});

test("ON にした時点でサブフォルダが先頭にまとまる", async () => {
  const env = load(makeBrowser(nested()));
  await toggle(env, "A", true);
  assert.deepEqual(env.order("A"), ["B", "C", "A1", "A2"]);
  await visit(env, 1, "https://a2.example/");
  assert.deepEqual(env.order("A"), ["B", "C", "A2", "A1"]);
});

test("同じアドレスが ON と OFF のフォルダにあるとき、OFF 側は動かさない", async () => {
  const env = load(
    makeBrowser({
      on: { type: "folder", children: ["x1", "dup1"] },
      off: { type: "folder", children: ["x2", "dup2"] },
      x1: { type: "bookmark", url: "https://x.example/" },
      x2: { type: "bookmark", url: "https://x.example/" },
      dup1: { type: "bookmark", url: "https://dup.example/" },
      dup2: { type: "bookmark", url: "https://dup.example" },
    })
  );
  await toggle(env, "on", true);
  await visit(env, 1, "https://dup.example/");
  assert.deepEqual(env.order("on"), ["dup1", "x1"]);
  assert.deepEqual(env.order("off"), ["x2", "dup2"]);
});

test("リダイレクトされても、開き始めのアドレスで見つける", async () => {
  const env = load(
    makeBrowser({
      f: { type: "folder", children: ["a", "gh"] },
      a: { type: "bookmark", url: "https://a.example/" },
      gh: { type: "bookmark", url: "http://github.com/" },
    })
  );
  await toggle(env, "f", true);
  await visit(env, 1, "http://github.com/", "https://github.com/");
  assert.deepEqual(env.order("f"), ["gh", "a"]);
});

test("すでに先頭なら移動処理をしない", async () => {
  const env = load(makeBrowser(nested()));
  await toggle(env, "B", true);
  await visit(env, 1, "https://b1.example/");
  assert.deepEqual(env.moves, []);
});

test("右クリックメニューはフォルダにだけ表示し、状態をチェックに反映する", async () => {
  const env = load(makeBrowser(nested()));
  await env.browser.runtime.onInstalled.fire();
  await flush();
  await env.browser.menus.onShown.fire({ contexts: ["bookmark"], bookmarkId: "B1" });
  assert.equal(env.menuState.visible, false);
  await env.browser.menus.onShown.fire({ contexts: ["bookmark"], bookmarkId: "B" });
  assert.equal(env.menuState.visible, true);
  assert.equal(env.menuState.checked, false);
  await toggle(env, "B", true);
  await env.browser.menus.onShown.fire({ contexts: ["bookmark"], bookmarkId: "B" });
  assert.equal(env.menuState.checked, true);
  await toggle(env, "B", false);
  await visit(env, 1, "https://b2.example/");
  assert.deepEqual(env.order("B"), ["B1", "B2"]);
});

test("設定は保存され、読み込み直し（再起動相当）後も有効", async () => {
  const first = load(makeBrowser(nested()));
  await toggle(first, "B", true);
  const env = load(makeBrowser(nested(), first.storage));
  await env.browser.runtime.onStartup.fire();
  await flush();
  await visit(env, 1, "https://b2.example/");
  assert.deepEqual(env.order("B"), ["B2", "B1"]);
});

test("フォルダを削除すると、中のサブフォルダの設定も消える", async () => {
  const env = load(makeBrowser(nested()));
  await toggle(env, "A", true);
  await toggle(env, "B", true);
  await env.remove("A");
  await flush();
  assert.deepEqual(env.storage.enabledFolders, []);
});

test("同時に続けて開いても、移動が重ならず直近の順になる", async () => {
  const env = load(
    makeBrowser({
      f: { type: "folder", children: ["a", "b", "c"] },
      a: { type: "bookmark", url: "https://a.example/" },
      b: { type: "bookmark", url: "https://b.example/" },
      c: { type: "bookmark", url: "https://c.example/" },
    })
  );
  await toggle(env, "f", true);
  const fire = (tabId, url) => env.browser.webNavigation.onCommitted.fire({ tabId, frameId: 0, url });
  await Promise.all([fire(1, "https://b.example/"), fire(2, "https://c.example/")]);
  await flush();
  assert.deepEqual(env.order("f"), ["c", "b", "a"]);
});
