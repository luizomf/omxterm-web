import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { parse } = require("dotenv");

const [, , dotenvPath] = process.argv;

if (!dotenvPath) {
  throw new Error("Expected a dotenv file path");
}

const parsed = parse(readFileSync(dotenvPath));

for (const [name, value] of Object.entries(parsed)) {
  if (name.includes("\0") || value.includes("\0")) {
    throw new Error("Dotenv names and values cannot contain null bytes");
  }

  process.stdout.write(`${name}=${value}\0`);
}
