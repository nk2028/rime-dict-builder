// @ts-check

import fs, { createReadStream, createWriteStream, existsSync } from "fs";
import path from "path";
import { createInterface } from "readline";
import { pipeline } from "stream/promises";

import { program } from "commander";

import { 音韻地位 } from "qieyun";
import { kyonh, tupa } from "qieyun-examples";

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
 * @param {string} version
 */
async function generate(name, conv, source, version) {
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
  console.log("  reading chars");
  await extendFromTsv(dict, source, "chars.tsv", conv);
  console.log("  reading words");
  await extendFromTsv(dict, source, "words.tsv", conv);

  const dictWords = [];
  console.log("  reading extra_words");
  await extendFromTsv(dictWords, source, "extra_words.tsv", conv);

  console.log("  writing dict");
  await pipeline(
    uniqSortedLines(dict, dictHeader),
    createWriteStream(`${name}.dict.yaml`)
  );

  console.log("  writing words");
  await pipeline(
    uniqSortedLines(dictWords, dictWordsHeader),
    createWriteStream(`${name}.words.dict.yaml`)
  );

  console.log("  writing unspaced");
  await pipeline(
    uniqSortedLines(dict.concat(dictWords), dictUnspacedHeader, true),
    createWriteStream(`${name}_unspaced.dict.yaml`)
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
  .option(
    "-v, --dict-version <version>",
    "version string in built dict, default to current date"
  )
  .argument(
    "[schemas...]",
    "schemas to generate; can be autodetected from <name>.schema.yaml if not specified"
  );

program.parse();

const { source, dictVersion = today } = program.opts();

/** @type {Set<string>} */
const names = new Set(program.args);

const kAllNames = ["tupa", "kyonh"];

if (!names.size) {
  for (const name of kAllNames) {
    if (existsSync(`./${name}.schema.yaml`)) {
      names.add(name);
    }
  }
  console.log(`detected: ${Array.from(names).join(", ")}`);
}

if (!names.size) {
  console.error(
    `no schema specified, and no {${kAllNames}}.schema.yaml detected`
  );
  process.exit(2);
}

const deriveTupa = tupa.schema({ 模式: "寬鬆" });

/** @type {[string, (描述: string) => string][]} */
const schemas = Array.from(names).map((name) => {
  switch (name) {
    case "tupa":
      return [name, makeConverter(deriveTupa, { 精一侵上: ">tsoimq" })];
    case "kyonh":
      return [name, makeConverter(kyonh, { 精一侵上: "=莊侵上" })];
    default:
      console.error(`unknown schema: ${name}`);
      process.exit(1);
  }
});

for (const [name, conv] of schemas) {
  console.log(`generating ${name}...`);
  generate(name, conv, source, dictVersion);
}
