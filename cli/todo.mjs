import {
  DEFAULT_TODOS_PATH,
  SECTION_BLOCKED,
  SECTION_NOW,
  SECTION_PARKED,
  addTodo,
  doneTodo,
  findItem,
  formatActiveList,
  formatItemLine,
  listDone,
  loadTodos,
  rmTodo,
  saveTodos,
} from "../core/todos.mjs";

/**
 * WHAT: Routes persistent todo subcommands against one explicit task file.
 * WHY: Keeps todo mutation and presentation out of the general CLI dispatcher.
 */
export async function cmdTodo(args, { parseFlags }) {
  const { flags, positional } = parseFlags(args, {
    all: "boolean",
    parked: "boolean",
    blocked: "boolean",
    dry: "boolean",
    path: "string",
  });
  const path = flags.path || DEFAULT_TODOS_PATH;
  const sub = positional[0];

  const printList = (parsed) => {
    console.log(formatActiveList(parsed));
    if (flags.all) {
      const done = listDone(parsed, 20);
      if (done.length) {
        console.log("\n## Klart (senaste)");
        for (const item of done) {
          console.log(`  ${formatItemLine(item, { includeCreated: true })}`);
        }
      }
    }
  };

  if (!sub) {
    printList(loadTodos(path));
    return;
  }

  switch (sub) {
    case "list":
    case "ls":
      printList(loadTodos(path));
      return;
    case "add": {
      const text = positional.slice(1).join(" ").trim();
      if (!text) {
        console.error('Usage: amux todo add "text" [--parked|--blocked]');
        process.exit(1);
      }
      const parsed = loadTodos(path);
      const section = flags.parked ? SECTION_PARKED
        : flags.blocked ? SECTION_BLOCKED : SECTION_NOW;
      const { item } = addTodo(parsed, text, { section });
      if (flags.dry) {
        console.log(`(dry) would add: ${formatItemLine(item)} → ${section}`);
        return;
      }
      saveTodos(parsed, path);
      console.log(`added: ${formatItemLine(item)} → ${section}`);
      return;
    }
    case "done":
    case "do": {
      const target = positional.slice(1).join(" ").trim();
      if (!target) {
        console.error("Usage: amux todo done <id|substring>");
        process.exit(1);
      }
      const parsed = loadTodos(path);
      if (!findItem(parsed, target)) {
        console.error(`No todo found matching "${target}"`);
        process.exit(1);
      }
      const result = doneTodo(parsed, target);
      if (flags.dry) {
        console.log(`(dry) would close: ${formatItemLine(result.item)} (was in ${result.fromSection})`);
        return;
      }
      saveTodos(parsed, path);
      console.log(`closed: ${formatItemLine(result.item)} (was in ${result.fromSection})`);
      return;
    }
    case "rm":
    case "remove": {
      const target = positional.slice(1).join(" ").trim();
      if (!target) {
        console.error("Usage: amux todo rm <id|substring>");
        process.exit(1);
      }
      const parsed = loadTodos(path);
      const result = rmTodo(parsed, target);
      if (!result.found) {
        console.error(`No todo found matching "${target}"`);
        process.exit(1);
      }
      if (flags.dry) {
        console.log(`(dry) would remove: ${formatItemLine(result.item)}`);
        return;
      }
      saveTodos(parsed, path);
      console.log(`removed: ${formatItemLine(result.item)}`);
      return;
    }
    case "edit": {
      const editor = process.env.EDITOR || "vi";
      const { spawn } = await import("node:child_process");
      const child = spawn(editor, [path], { stdio: "inherit" });
      await new Promise((resolve) => child.on("close", resolve));
      return;
    }
    case "path":
      console.log(path);
      return;
    default:
      console.error(`Unknown todo subcommand: ${sub}`);
      console.error("Usage: amux todo [list|add|done|rm|edit|path] [--all|--parked|--blocked|--dry]");
      process.exit(1);
  }
}
