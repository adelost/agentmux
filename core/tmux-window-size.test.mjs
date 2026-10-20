// Guards: an attached client must never resize the fleet's panes. On 2026-10-20 a 120x29 client under
// `window-size latest` shrank session lsrc, its 15 panes fell to 29x6 and lsrc:7's compact failed five times.
//
// The fake is the real adapter over an exec that models one tmux window, hazard included: under `latest`
// the window takes the attached client's size, and `resize-window` pins `manual` (both as measured on tmux 3.2a).

import { feature, unit, expect } from "bdd-vitest";
import { createTmuxAdapter } from "./tmux.mjs";
import { settleTmuxWindowSize } from "./tmux-window-size.mjs";

const SMALL_CLIENT = { columns: 120, rows: 29 };
const NEW_DETACHED_WINDOW = { columns: 80, rows: 24 };

function fakeTmuxWindow({ client }) {
  const windowState = { sizePolicy: "latest", ...(client || NEW_DETACHED_WINDOW) };
  const exec = async (command) => {
    const policy = command.match(/set-window-option .* window-size (\w+)/)?.[1];
    const resize = command.match(/resize-window .* -x (\d+) -y (\d+)/);
    if (policy) windowState.sizePolicy = policy;
    if (resize) Object.assign(windowState, { sizePolicy: "manual", columns: Number(resize[1]), rows: Number(resize[2]) });
    if (client && windowState.sizePolicy === "latest") Object.assign(windowState, client);
    return { stdout: command.includes("#{session_attached}") ? `${client ? 1 : 0}\n` : "" };
  };
  return { windowState, tmux: createTmuxAdapter({ socket: "/tmp/fake-tmux.sock", exec }) };
}

const settle = async ({ windowState, tmux }) => ({ windowState, relayout: await settleTmuxWindowSize(tmux, "lsrc") });
const pinnedAndRelaid = ({ windowState, relayout }) => {
  expect(windowState).toEqual({ sizePolicy: "manual", columns: 340, rows: 100 });
  expect(relayout).toBe(true);
};

feature("settleTmuxWindowSize: the fleet's window size is never the client's", () => {
  unit("pins manual 340x100 on an attached session", {
    given: ["a session a 120x29 client is attached to, so its window is client-sized", () => fakeTmuxWindow({ client: SMALL_CLIENT })],
    when: ["settling the window size", settle],
    then: ["the window is manual 340x100 and the caller re-applies the layout", pinnedAndRelaid],
  });

  unit("pins manual 340x100 on a detached session", {
    given: ["a new detached session at tmux's 80x24 default", () => fakeTmuxWindow({ client: null })],
    when: ["settling the window size", settle],
    then: ["the window is manual 340x100 and the caller re-applies the layout", pinnedAndRelaid],
  });
});
