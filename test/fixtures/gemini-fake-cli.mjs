#!/usr/bin/env node
// Test entry only. The installed CLI still owns the actual TUI and fake model harness.
import { spawn } from "node:child_process";
if (!process.env.AMUX_GEMINI_FAKE_RESPONSES || !process.env.AMUX_GEMINI_REAL_CLI) process.exit(2);
const child = spawn(process.env.AMUX_GEMINI_REAL_CLI, [...process.argv.slice(2),
  "--fake-responses-non-strict", process.env.AMUX_GEMINI_FAKE_RESPONSES], { stdio: "inherit", env: process.env });
child.on("error", () => process.exit(2));
child.on("exit", code => process.exit(code ?? 1));
