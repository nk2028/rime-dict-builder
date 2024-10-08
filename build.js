// @ts-check

import fs, { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";

import { program } from "commander";

import TshetUinh, { 音韻地位 } from "tshet-uinh";
import { 推導方案 } from "tshet-uinh-deriver-tools";

// Sorting

/**
 * Compare two strings by (full) Unicode code point order.
 * @param {string} x
 * @param {string} y
 * @returns {number}
 */
function compareFullUnicode(x, y) {
  const ix = x[Symbol.iterator]();
  const iy = y[Symbol.iterator]();
  for (;;) {
    const nx = ix.next();
    const ny = iy.next();
    if (nx.done && ny.done) {
      return 0;
    }
    const cx = nx.done ? -1 : nx.value.codePointAt(0);
    const cy = ny.done ? -1 : ny.value.codePointAt(0);
    // @ts-ignore
    const diff = cx - cy;
    if (diff) {
      return diff;
    }
  }
}

/**
 * @param {string[]} x
 * @param {string[]} y
 * @returns {number}
 */
function compareRow(x, y) {
  const diffWordLen = [...x[0]].length - [...y[0]].length;
  if (diffWordLen) {
    return diffWordLen;
  }
  const l = Math.min(x.length, y.length);
  for (let i = 0; i < l; i++) {
    const diff = compareFullUnicode(x[i], y[i]);
    if (diff) {
      return diff;
    }
  }
  return x.length - y.length;
}

/**
 * @param {string[][]} rows
 * @param {?string} [header]
 * @param {boolean} unspaced
 * @returns {IterableIterator<string>}
 */
function* uniqSortedLines(rows, header, unspaced = false) {
  if (header) {
    yield header;
  }
  let lastLine;
  for (let row of rows.slice().sort(compareRow)) {
    if (unspaced) {
      row = row.slice();
      row[1] = row[1].replace(/ /g, "=");
    }
    const line = row.join("\t") + "\n";
    if (line !== lastLine) {
      yield line;
    }
    lastLine = line;
  }
}

// Converter utils

/**
 * @param {(地位: 音韻地位) => string} derive
 * @param {{ [x: string]: string }} special地位
 * @returns {(描述: string) => string}
 */
function makeConverter(derive, special地位) {
  const cache = new Map();
  return function (x) {
    if (x.startsWith("!")) {
      const sub = special地位[x.slice(1)];
      if (!sub) {
        throw new Error(`unhandled special 地位: ${x}`);
      } else if (sub.startsWith(">")) {
        return sub.slice(1);
      } else if (sub.startsWith("=")) {
        x = sub.slice(1);
      } else {
        throw new Error(`invalid instruction for special 地位 ${x}: ${sub}`);
      }
    }
    if (cache.has(x)) {
      return cache.get(x);
    }
    const res = derive(音韻地位.from描述(x));
    cache.set(x, res);
    return res;
  };
}

// File reading

/**
 * @param {fs.PathLike} path
 * @param {(描述: string) => string} conv
 * @returns {AsyncIterableIterator<string[]>}
 */
async function* loadTsv(path, conv) {
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    const [word, input, ...rest] = line.split("\t");
    const codes = input
      .split(" ")
      .map((描述) => conv(描述))
      .join(" ");
    yield [word, codes, ...rest];
  }
}

/**
 * @param {string[][]} dict
 * @param {string} base
 * @param {string} filename
 * @param {(描述: string) => string} conv
 */
async function extendFromTsv(dict, base, filename, conv) {
  for await (const row of loadTsv(path.join(base, filename), conv)) {
    dict.push(row);
  }
}

// Main

/**
 * @param {string} name
 * @param {(描述: string) => string} conv
 * @param {string} source
 * @param {string} dest
 * @param {string} version
 */
async function generate(name, conv, source, dest, version) {
  version = JSON.stringify(version);
  const dictHeader = `# Rime dictionary
# encoding: utf-8
#
# This file is auto-generated from source dict
# Do NOT edit directly!

---
name: ${name}
version: ${version}
sort: by_weight
use_preset_vocabulary: true
import_tables:
  - ${name}.words
...

`;

  const dictUnspacedHeader = dictHeader
    .split("\n")
    .filter(
      (line) =>
        !["use_preset_vocabulary:", "import_tables:", "  -"].some((x) =>
          line.startsWith(x)
        )
    )
    .map((line) => (line === `name: ${name}` ? `name: ${name}_unspaced` : line))
    .join("\n");

  const dictWordsHeader = `# Rime dictionary
# encoding: utf-8
#
# This file is auto-generated from source dict
# Do NOT edit directly!

---
name: ${name}.words
version: ${version}
sort: by_weight
...

`;

  const dict = [];
  console.log("  reading chars.tsv");
  await extendFromTsv(dict, source, "chars.tsv", conv);
  console.log("  reading words.tsv");
  await extendFromTsv(dict, source, "words.tsv", conv);

  const dictWords = [];
  console.log("  reading extra_words.tsv");
  await extendFromTsv(dictWords, source, "extra_words.tsv", conv);

  console.log(`  writing ${name}.dict.yaml`);
  await pipeline(
    uniqSortedLines(dict, dictHeader),
    createWriteStream(path.join(dest, `${name}.dict.yaml`))
  );

  console.log(`  writing ${name}.words.dict.yaml`);
  await pipeline(
    uniqSortedLines(dictWords, dictWordsHeader),
    createWriteStream(path.join(dest, `${name}.words.dict.yaml`))
  );

  console.log(`  writing ${name}_unspaced.dict.yaml`);
  await pipeline(
    uniqSortedLines(dict.concat(dictWords), dictUnspacedHeader, true),
    createWriteStream(path.join(dest, `${name}_unspaced.dict.yaml`))
  );
}

const now = new Date();
const today = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000)
  .toISOString()
  .split("T")[0]
  .replace(/-/g, "");

program
  .option(
    "-s, --source <dir>",
    "path to dir containing source TSVs",
    "../rime-dict-source"
  )
  .option("-d, --dest <dir>", "path to the dir to put built files", ".")
  .option(
    "-v, --dict-version <version>",
    "version string in built dict, default to current date"
  );

program.parse();

const { source, dest, dictVersion = today } = program.opts();

const tupaCode = fs.readFileSync(path.join(import.meta.dirname, "tupa.js"), {
  encoding: "utf-8",
});
/** @type {import("tshet-uinh-deriver-tools").原始推導函數<string>} */
const tupaRawDeriver = new Function(
  "TshetUinh",
  "選項",
  "音韻地位",
  "字頭",
  tupaCode
).bind(null, TshetUinh);
const deriveTupa = new 推導方案(tupaRawDeriver)();

console.log("generating tupa...");
generate(
  "tupa",
  makeConverter(deriveTupa, { 精開一侵上: ">tsoymq" }),
  source,
  dest,
  dictVersion
);
