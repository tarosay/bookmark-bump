// 並べ替えの計画を立てる純粋関数（Firefox API を使わないので単体テストできる）。
//
// ルール:
// - セパレーター（区切り線）をまたいで項目を動かさない。区切り線で分かれた範囲ごとに扱う。
// - 各範囲の中では、サブフォルダを先頭にまとめる（サブフォルダ同士の順序は保つ）。
// - 使ったブックマークは、その範囲のサブフォルダ群の直後に置く。
// - ほかのブックマークの順序は保つ。
"use strict";

const isSeparator = (n) => n.type === "separator";
const isFolder = (n) => n.type === "folder";

// children: getChildren() の結果（index 順）
// bumpId: 先頭へ移すブックマークの id（null ならサブフォルダをまとめるだけ）
// 戻り値: 順に実行する移動 [{ id, index }]。必要なければ空配列。
function planMoves(children, bumpId = null) {
  const moves = [];
  let start = 0;
  while (start <= children.length) {
    let end = start;
    while (end < children.length && !isSeparator(children[end])) end++;
    const section = children.slice(start, end);
    if (bumpId === null || section.some((n) => n.id === bumpId)) {
      moves.push(...planSection(section, start, bumpId));
    }
    start = end + 1;
  }
  return moves;
}

function planSection(section, offset, bumpId) {
  const folders = section.filter(isFolder);
  const bumped = section.filter((n) => n.id === bumpId && !isFolder(n));
  const rest = section.filter((n) => !isFolder(n) && n.id !== bumpId);
  const desired = [...folders, ...bumped, ...rest];

  // 目的の位置より後ろにある項目を前へ移すだけで並びが揃う（前へ移す操作のみ）
  const current = section.slice();
  const moves = [];
  for (let i = 0; i < desired.length; i++) {
    if (current[i].id === desired[i].id) continue;
    const from = current.findIndex((n) => n.id === desired[i].id);
    const [item] = current.splice(from, 1);
    current.splice(i, 0, item);
    moves.push({ id: item.id, index: offset + i });
  }
  return moves;
}

if (typeof module !== "undefined") module.exports = { planMoves };
