#!/usr/bin/env node
import { run } from "../src/cli.ts";

run(process.argv.slice(2))
  .then((msg) => { console.log(msg); })
  .catch((err) => { console.error("错误:", err.message); process.exit(1); });
