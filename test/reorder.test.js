"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { planMoves } = require("../src/reorder.js");

const F = (id) => ({ id, type: "folder" });
const B = (id) => ({ id, type: "bookmark" });
const S = (id) => ({ id, type: "separator" });

// bookmarks.move（同じフォルダ内で前へ移す）を再現して、移動後の並びを返す
function apply(children, moves) {
  const list = children.slice();
  for (const { id, index } of moves) {
    const from = list.findIndex((n) => n.id === id);
    assert.ok(index <= from, `前へ移す操作だけのはず (${id}: ${from} -> ${index})`);
    const [item] = list.splice(from, 1);
    list.splice(index, 0, item);
  }
  return list.map((n) => n.id);
}

test("使ったブックマークがサブフォルダ群の直後に来る（指示書 2.2 の例）", () => {
  const c = [F("sub1"), F("sub2"), B("google"), B("github"), B("mozilla")];
  const moves = planMoves(c, "github");
  assert.deepEqual(apply(c, moves), ["sub1", "sub2", "github", "google", "mozilla"]);
  assert.equal(moves.length, 1);
});

test("すでに目的の位置なら移動しない", () => {
  const c = [F("sub1"), B("github"), B("google")];
  assert.deepEqual(planMoves(c, "github"), []);
});

test("散らばったサブフォルダを先頭にまとめ、順序を保つ", () => {
  const c = [B("a"), F("f1"), B("b"), F("f2"), B("c")];
  assert.deepEqual(apply(c, planMoves(c, "c")), ["f1", "f2", "c", "a", "b"]);
});

test("まとめるだけ（bumpId なし）でもブックマークの順序は保つ", () => {
  const c = [B("a"), F("f1"), B("b"), F("f2")];
  assert.deepEqual(apply(c, planMoves(c, null)), ["f1", "f2", "a", "b"]);
});

test("続けて別のブックマークを使うと、直近に使った順になる", () => {
  let c = [F("f"), B("a"), B("b"), B("c")];
  for (const id of ["b", "c", "a"]) {
    const order = apply(c, planMoves(c, id));
    c = order.map((x) => (x === "f" ? F(x) : B(x)));
  }
  assert.deepEqual(c.map((n) => n.id), ["f", "a", "c", "b"]);
});

test("区切り線をまたがない（使ったブックマークのある範囲の中だけで並べ替える）", () => {
  const c = [B("a"), B("b"), S("s1"), B("c"), F("f"), B("d")];
  assert.deepEqual(apply(c, planMoves(c, "d")), ["a", "b", "s1", "f", "d", "c"]);
});

test("bumpId なしなら区切り線の各範囲でサブフォルダをまとめる", () => {
  const c = [B("a"), F("f1"), S("s1"), B("b"), F("f2")];
  assert.deepEqual(apply(c, planMoves(c, null)), ["f1", "a", "s1", "f2", "b"]);
});

test("フォルダ ID を渡しても動かさない（ブックマーク以外は対象外）", () => {
  const c = [F("f1"), F("f2"), B("a")];
  assert.deepEqual(planMoves(c, "f2"), []);
});

test("空のフォルダ・末尾が区切り線でも壊れない", () => {
  assert.deepEqual(planMoves([], "x"), []);
  const c = [B("a"), B("b"), S("s")];
  assert.deepEqual(apply(c, planMoves(c, "b")), ["b", "a", "s"]);
});
