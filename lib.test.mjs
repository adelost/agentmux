import { unit, feature, expect } from "bdd-vitest";
import {
  stripAnsi, splitMessage, esc, parseEnv, buildChannelMap,
  formatDuration, extractActivity, parsePane, parseCommand, parseUseArg,
} from "./lib.mjs";

feature("stripAnsi", () => {
  unit("removes color codes", {
    when: ["stripping green text", () => stripAnsi("\x1b[32mgreen\x1b[0m")],
    then: ["plain text remains", (r) => expect(r).toBe("green")],
  });

  unit("removes bold + color combo", {
    when: ["stripping bold red", () => stripAnsi("\x1b[1;31merror\x1b[0m")],
    then: ["plain text remains", (r) => expect(r).toBe("error")],
  });

  unit("passes through plain text", {
    when: ["stripping plain text", () => stripAnsi("hello world")],
    then: ["unchanged", (r) => expect(r).toBe("hello world")],
  });

  unit("handles multiple codes", {
    when: ["stripping mixed codes", () =>
      stripAnsi("\x1b[36mfoo\x1b[0m bar \x1b[33mbaz\x1b[0m"),
    ],
    then: ["all codes removed", (r) => expect(r).toBe("foo bar baz")],
  });

  unit("handles empty string", {
    when: ["stripping empty", () => stripAnsi("")],
    then: ["stays empty", (r) => expect(r).toBe("")],
  });
});

feature("splitMessage", () => {
  unit("returns single chunk for short text", {
    when: ["splitting short text", () => splitMessage("hello", 100)],
    then: ["one chunk", (r) => expect(r).toEqual(["hello"])],
  });

  unit("splits at newline boundary", {
    given: ["text with newlines", () => "line1\nline2\nline3"],
    when: ["splitting at max=10", (text) => splitMessage(text, 10)],
    then: ["first chunk is line1", (chunks) => {
      expect(chunks[0]).toBe("line1");
      expect(chunks.join("\n")).toBe("line1\nline2\nline3");
    }],
  });

  unit("hard-cuts when no newline available", {
    given: ["20 a's", () => "a".repeat(20)],
    when: ["splitting at max=8", (text) => splitMessage(text, 8)],
    then: ["all chunks <= 8 chars, content preserved", (chunks, text) => {
      expect(chunks.every((c) => c.length <= 8)).toBe(true);
      expect(chunks.join("")).toBe(text);
    }],
  });

  unit("handles exact boundary", {
    when: ["splitting 5 chars at max=5", () => splitMessage("12345", 5)],
    then: ["single chunk", (r) => expect(r).toEqual(["12345"])],
  });

  unit("preserves content across many chunks", {
    given: ["50 lines", () => Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")],
    when: ["splitting at max=100", (text) => splitMessage(text, 100)],
    then: ["reassembled equals original", (chunks, text) => {
      expect(chunks.join("\n")).toBe(text);
    }],
  });
});

feature("esc (shell escape)", () => {
  unit("escapes single quotes", {
    when: ["escaping it's", () => esc("it's")],
    then: ["quote is escaped", (r) => expect(r).toBe("it'\\''s")],
  });

  unit("handles multiple single quotes", {
    when: ["escaping 'a' 'b'", () => esc("'a' 'b'")],
    then: ["all escaped", (r) => expect(r).toBe("'\\''a'\\'' '\\''b'\\''")],
  });

  unit("passes through text without quotes", {
    when: ["escaping plain text", () => esc("hello world")],
    then: ["unchanged", (r) => expect(r).toBe("hello world")],
  });

  unit("does not escape double quotes or backticks", {
    given: ["text with double quotes and backticks", () => 'say "hello" and `run`'],
    when: ["escaping", (input) => esc(input)],
    then: ["unchanged", (r, input) => expect(r).toBe(input)],
  });
});

feature("parseEnv", () => {
  unit("parses simple key=value", {
    when: ["parsing FOO=bar", () => parseEnv("FOO=bar")],
    then: ["FOO is bar", (r) => expect(r).toEqual({ FOO: "bar" })],
  });

  unit("strips double quotes", {
    when: ["parsing quoted value", () => parseEnv('TOKEN="abc123"')],
    then: ["quotes removed", (r) => expect(r).toEqual({ TOKEN: "abc123" })],
  });

  unit("strips single quotes", {
    when: ["parsing single-quoted value", () => parseEnv("TOKEN='abc123'")],
    then: ["quotes removed", (r) => expect(r).toEqual({ TOKEN: "abc123" })],
  });

  unit("skips comments and blank lines", {
    when: ["parsing with comments", () => parseEnv("# comment\n\nFOO=bar\n\n")],
    then: ["only FOO parsed", (r) => expect(r).toEqual({ FOO: "bar" })],
  });

  unit("handles multiple vars", {
    when: ["parsing three vars", () => parseEnv("A=1\nB=two\nC=three")],
    then: ["all parsed", (r) => expect(r).toEqual({ A: "1", B: "two", C: "three" })],
  });

  unit("preserves inline # (not treated as comment)", {
    when: ["parsing URL with fragment", () => parseEnv("URL=http://x#frag")],
    then: ["fragment preserved", (r) => expect(r).toEqual({ URL: "http://x#frag" })],
  });

  unit("trims whitespace around key and value", {
    when: ["parsing padded line", () => parseEnv("  FOO  =  bar  ")],
    then: ["trimmed", (r) => expect(r).toEqual({ FOO: "bar" })],
  });

  unit("skips lowercase keys", {
    when: ["parsing lowercase key", () => parseEnv("foo=bar")],
    then: ["empty result", (r) => expect(r).toEqual({})],
  });
});

feature("buildChannelMap", () => {
  unit("maps string discord field to pane 0", {
    given: ["yaml with two discord agents", () => `
_ai:
  dir: /home/user/project
  discord: "123456"
_ui:
  dir: /home/user/ui
  discord: "789012"
`],
    when: ["building channel map", (yaml) => buildChannelMap(yaml)],
    then: ["both agents mapped with pane 0", (map) => {
      expect(map.size).toBe(2);
      expect(map.get("123456")).toEqual({ name: "_ai", dir: "/home/user/project", pane: 0 });
      expect(map.get("789012")).toEqual({ name: "_ui", dir: "/home/user/ui", pane: 0 });
    }],
  });

  unit("maps object discord field to per-channel panes", {
    given: ["yaml with object discord", () => `
_ai:
  dir: /home/user/project
  discord:
    "111": 0
    "222": 1
`],
    when: ["building channel map", (yaml) => buildChannelMap(yaml)],
    then: ["two channels, different panes, same agent", (map) => {
      expect(map.size).toBe(2);
      expect(map.get("111")).toEqual({ name: "_ai", dir: "/home/user/project", pane: 0 });
      expect(map.get("222")).toEqual({ name: "_ai", dir: "/home/user/project", pane: 1 });
    }],
  });

  unit("skips agents without discord field", {
    given: ["yaml with one discord agent, one without", () => `
_ai:
  dir: /home/user/project
  discord: "123456"
_tmp:
  dir: /tmp
`],
    when: ["building channel map", (yaml) => buildChannelMap(yaml)],
    then: ["only discord agent mapped", (map) => {
      expect(map.size).toBe(1);
      expect(map.has("123456")).toBe(true);
    }],
  });

  unit("returns empty map for yaml with no discord fields", {
    when: ["building from yaml without discord", () => buildChannelMap("_ai:\n  dir: /x\n")],
    then: ["empty map", (map) => expect(map.size).toBe(0)],
  });

  unit("returns empty map for empty yaml", {
    when: ["building from empty string", () => buildChannelMap("")],
    then: ["empty map", (map) => expect(map.size).toBe(0)],
  });

  unit("coerces numeric discord IDs to strings", {
    when: ["building from numeric ID", () => buildChannelMap("_ai:\n  dir: /x\n  discord: 123456\n")],
    then: ["string key in map", (map) => expect(map.has("123456")).toBe(true)],
  });

  unit("handles agents with missing dir", {
    when: ["building from agent without dir", () => buildChannelMap("_ai:\n  discord: '123456'\n")],
    then: ["dir defaults to empty string", (map) => {
      expect(map.get("123456")).toEqual({ name: "_ai", dir: "", pane: 0 });
    }],
  });
});

feature("formatDuration", () => {
  unit("seconds only", {
    when: ["formatting 30s", () => formatDuration(30)],
    then: ["shows 30s", (r) => expect(r).toBe("30s")],
  });

  unit("exact minutes", {
    when: ["formatting 60s", () => formatDuration(60)],
    then: ["shows 1m", (r) => expect(r).toBe("1m")],
  });

  unit("minutes and seconds", {
    when: ["formatting 90s", () => formatDuration(90)],
    then: ["shows 1m 30s", (r) => expect(r).toBe("1m 30s")],
  });

  unit("5 minutes", {
    when: ["formatting 300s", () => formatDuration(300)],
    then: ["shows 5m", (r) => expect(r).toBe("5m")],
  });

  unit("zero", {
    when: ["formatting 0", () => formatDuration(0)],
    then: ["shows 0s", (r) => expect(r).toBe("0s")],
  });
});

feature("extractActivity", () => {
  unit("extracts last meaningful line from pane", {
    given: ["pane with tool output", () =>
      "Reading src/auth.py\nEditing src/auth.py\n                    esc to interrupt\n",
    ],
    when: ["extracting activity", (pane) => extractActivity(pane)],
    then: ["shows last line before status", (r) => expect(r).toBe("Editing src/auth.py")],
  });

  unit("strips ANSI codes", {
    given: ["pane with ANSI colors", () =>
      "\x1b[32mRunning pytest\x1b[0m\n  esc to interrupt\n",
    ],
    when: ["extracting activity", (pane) => extractActivity(pane)],
    then: ["clean text", (r) => expect(r).toBe("Running pytest")],
  });

  unit("filters out all control lines", {
    given: ["pane with only control lines", () =>
      "esc to interrupt\nEnter to select\nAllow once\n",
    ],
    when: ["extracting activity", (pane) => extractActivity(pane)],
    then: ["returns null", (r) => expect(r).toBeNull()],
  });

  unit("returns null for empty pane", {
    when: ["extracting from empty", () => extractActivity("")],
    then: ["returns null", (r) => expect(r).toBeNull()],
  });

  unit("truncates long lines", {
    given: ["pane with 100-char line", () => "A".repeat(100) + "\n"],
    when: ["extracting activity", (pane) => extractActivity(pane)],
    then: ["truncated with ellipsis", (r) => {
      expect(r.length).toBeLessThan(65);
      expect(r.endsWith("…")).toBe(true);
    }],
  });

  unit("skips bypass permissions line", {
    given: ["pane with permission text", () =>
      "Thinking about the problem\nbypass permissions\nesc to interrupt\n",
    ],
    when: ["extracting activity", (pane) => extractActivity(pane)],
    then: ["shows thinking line", (r) => expect(r).toBe("Thinking about the problem")],
  });
});

feature("parsePane", () => {
  unit("defaults to pane 0", {
    when: ["parsing plain text", () => parsePane("fix the bug")],
    then: ["pane 0, full prompt", (r) => {
      expect(r.pane).toBe(0);
      expect(r.prompt).toBe("fix the bug");
    }],
  });

  unit("parses .1 prefix", {
    when: ["parsing .1 prefix", () => parsePane(".1 fix the bug")],
    then: ["pane 1, prompt without prefix", (r) => {
      expect(r.pane).toBe(1);
      expect(r.prompt).toBe("fix the bug");
    }],
  });

  unit("parses higher pane numbers", {
    when: ["parsing .3 prefix", () => parsePane(".3 run tests")],
    then: ["pane 3", (r) => {
      expect(r.pane).toBe(3);
      expect(r.prompt).toBe("run tests");
    }],
  });

  unit("requires space after prefix", {
    when: ["parsing .1fix (no space)", () => parsePane(".1fix")],
    then: ["treated as plain text, pane 0", (r) => {
      expect(r.pane).toBe(0);
      expect(r.prompt).toBe(".1fix");
    }],
  });

  unit("preserves multiline prompt", {
    when: ["parsing prefix with newlines", () => parsePane(".1 line one\nline two")],
    then: ["full multiline prompt", (r) => {
      expect(r.pane).toBe(1);
      expect(r.prompt).toBe("line one\nline two");
    }],
  });
});

feature("parseCommand", () => {
  unit("returns null for non-command text", {
    when: ["parsing plain text", () => parseCommand("fix the bug")],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("parses command without args", {
    when: ["parsing /look", () => parseCommand("/look")],
    then: ["cmd=/look, empty args", (r) => {
      expect(r.cmd).toBe("/look");
      expect(r.args).toBe("");
    }],
  });

  unit("parses command with args", {
    when: ["parsing /use _ai.2", () => parseCommand("/use _ai.2")],
    then: ["cmd=/use, args=_ai.2", (r) => {
      expect(r.cmd).toBe("/use");
      expect(r.args).toBe("_ai.2");
    }],
  });

  unit("lowercases command", {
    when: ["parsing /LOOK", () => parseCommand("/LOOK")],
    then: ["lowercase cmd", (r) => expect(r.cmd).toBe("/look")],
  });

  unit("trims whitespace", {
    when: ["parsing padded command", () => parseCommand("  /status  ")],
    then: ["cmd=/status", (r) => expect(r.cmd).toBe("/status")],
  });

  unit("preserves args with spaces", {
    when: ["parsing /use some agent name", () => parseCommand("/use some agent name")],
    then: ["full args preserved", (r) => expect(r.args).toBe("some agent name")],
  });

  unit("normalizes double slash to single", {
    when: ["parsing //tts", () => parseCommand("//tts")],
    then: ["cmd=/tts", (r) => expect(r.cmd).toBe("/tts")],
  });

  unit("normalizes double slash with args", {
    when: ["parsing //use _ai.2", () => parseCommand("//use _ai.2")],
    then: ["cmd=/use, args=_ai.2", (r) => {
      expect(r.cmd).toBe("/use");
      expect(r.args).toBe("_ai.2");
    }],
  });
});

feature("parseUseArg", () => {
  unit("returns null for empty input", {
    when: ["parsing empty string", () => parseUseArg("")],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("parses reset", {
    when: ["parsing reset", () => parseUseArg("reset")],
    then: ["reset: true", (r) => expect(r).toEqual({ reset: true })],
  });

  unit("parses agent name", {
    when: ["parsing _ai", () => parseUseArg("_ai")],
    then: ["name=_ai, pane=0", (r) => expect(r).toEqual({ name: "_ai", pane: 0 })],
  });

  unit("parses agent with pane", {
    when: ["parsing _ai.2", () => parseUseArg("_ai.2")],
    then: ["name=_ai, pane=2", (r) => expect(r).toEqual({ name: "_ai", pane: 2 })],
  });

  unit("trims whitespace", {
    when: ["parsing padded input", () => parseUseArg("  _skybar.1  ")],
    then: ["name=_skybar, pane=1", (r) => expect(r).toEqual({ name: "_skybar", pane: 1 })],
  });

  unit("pane defaults to 0", {
    when: ["parsing agent without pane", () => parseUseArg("_claw")],
    then: ["pane=0", (r) => expect(r.pane).toBe(0)],
  });
});
