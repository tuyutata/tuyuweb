#!/usr/bin/env node
// CI_BUILD: incremental
// 单平台目录不重复包装 web。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

function required(value, message) {
  if (!value) throw new Error(message);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    required(key?.startsWith("--") && value !== undefined, `CI 参数无效：${key || "(empty)"}`);
    required(!Object.hasOwn(result, key.slice(2)), `CI 参数重复：${key}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function validateSource(sourceSHA) {
  required(/^[0-9a-f]{40}$/.test(sourceSHA || ""), "途遇官网 CI 源提交无效");
  required(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === sourceSHA,
    "途遇官网 CI checkout 与源提交不一致");
  for (const path of [
    "tuyuweb/package.json",
    "tuyuweb/package-lock.json",
  ]) {
    required(existsSync(path), `途遇官网缺少 ${path}`);
    execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "ignore" });
  }
}

try {
  const [command, ...values] = process.argv.slice(2);
  const args = parseArgs(values);
  if (command === "validate-source") {
    validateSource(args["source-sha"]);
  } else {
    throw new Error(`途遇官网 CI 子命令未登记：${command || "(empty)"}`);
  }
} catch (error) {
  console.error(`途遇官网 CI 失败：${error.message}`);
  process.exitCode = 1;
}
