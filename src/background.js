// BookmarkBump 本体。
// ページが開かれたら、そのアドレスのブックマークのうち「並べ替え ON」のフォルダにあるものを
// そのフォルダの先頭側（サブフォルダ群の直後）へ移す。
/* global planMoves */
"use strict";

const MENU_ID = "bookmark-bump-toggle";
const STORAGE_KEY = "enabledFolders";

// ---- 設定（ON のフォルダ ID の集合） ----

let enabledCache = null;

async function getEnabled() {
  if (!enabledCache) {
    const { [STORAGE_KEY]: ids = [] } = await browser.storage.local.get(STORAGE_KEY);
    enabledCache = new Set(ids);
  }
  return enabledCache;
}

async function saveEnabled(set) {
  enabledCache = set;
  await browser.storage.local.set({ [STORAGE_KEY]: [...set] });
}

// 存在しなくなったフォルダの設定を消す（起動時の不整合の掃除）
async function pruneEnabled() {
  const set = await getEnabled();
  let changed = false;
  for (const id of [...set]) {
    try {
      const [node] = await browser.bookmarks.get(id);
      if (node.type !== "folder") throw new Error("not a folder");
    } catch {
      set.delete(id);
      changed = true;
    }
  }
  if (changed) await saveEnabled(set);
}

// ---- 処理の直列化（移動が重ならないように 1 本の列で順に実行する） ----

let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((e) => console.error("BookmarkBump:", e));
  return queue;
}

async function applyPlan(folderId, bumpId) {
  const children = await browser.bookmarks.getChildren(folderId);
  for (const { id, index } of planMoves(children, bumpId)) {
    await browser.bookmarks.move(id, { parentId: folderId, index });
  }
}

// ---- ページを開いたときの処理 ----

// タブごとに、読み込み開始時のアドレスを覚えておく（リダイレクト前のアドレスで照合するため）
const pendingUrls = new Map();

function isWebUrl(url) {
  return /^(https?|file):/i.test(url);
}

browser.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0 || !isWebUrl(d.url)) return;
  if (!pendingUrls.has(d.tabId)) pendingUrls.set(d.tabId, new Set());
  pendingUrls.get(d.tabId).add(d.url);
});

browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const urls = pendingUrls.get(d.tabId) || new Set();
  pendingUrls.delete(d.tabId);
  if (isWebUrl(d.url)) urls.add(d.url);
  if (urls.size) enqueue(() => bumpForUrls(urls));
});

browser.tabs.onRemoved.addListener((tabId) => pendingUrls.delete(tabId));

async function bumpForUrls(urls) {
  const enabled = await getEnabled();
  if (!enabled.size) return;

  const seen = new Set();
  for (const url of urls) {
    let found;
    try {
      found = await browser.bookmarks.search({ url });
    } catch {
      continue; // 検索できない形式のアドレス
    }
    for (const b of found) {
      if (seen.has(b.id) || !enabled.has(b.parentId)) continue;
      seen.add(b.id);
      await applyPlan(b.parentId, b.id);
    }
  }
}

// ---- フォルダの右クリックメニュー ----

function createMenu() {
  browser.menus.removeAll().then(() => {
    browser.menus.create({
      id: MENU_ID,
      title: "使用したブックマークを先頭に移動",
      type: "checkbox",
      contexts: ["bookmark"],
      visible: false,
    });
  });
}

browser.runtime.onInstalled.addListener(createMenu);
browser.runtime.onStartup.addListener(() => {
  createMenu();
  enqueue(pruneEnabled);
});

browser.menus.onShown.addListener(async (info) => {
  if (!info.contexts.includes("bookmark") || !info.bookmarkId) return;
  let visible = false;
  let checked = false;
  try {
    const [node] = await browser.bookmarks.get(info.bookmarkId);
    // ルート（全体の一番上）は並べ替えの対象にしない
    visible = node.type === "folder" && node.id !== "root________";
    checked = visible && (await getEnabled()).has(node.id);
  } catch {
    // 取得できないものには表示しない
  }
  await browser.menus.update(MENU_ID, { visible, checked });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.bookmarkId) return;
  const folderId = info.bookmarkId;
  enqueue(async () => {
    const set = new Set(await getEnabled());
    if (info.checked) {
      set.add(folderId);
      await saveEnabled(set);
      // ON にした時点で、サブフォルダを先頭側にまとめる
      await applyPlan(folderId, null);
    } else {
      set.delete(folderId);
      await saveEnabled(set);
    }
  });
});

// ---- フォルダが削除されたら設定も消す ----
// 中のサブフォルダも一緒に消えるので、ON の各フォルダがまだ存在するかをまとめて確かめる。
// フォルダの移動・名前の変更では ID が変わらないので、何もしなくてよい。

browser.bookmarks.onRemoved.addListener((id, removeInfo) => {
  if (removeInfo.node && removeInfo.node.type !== "folder") return;
  enqueue(pruneEnabled);
});
