// Guards: an attached client must never resize the fleet's panes, and a person viewing an attached session keeps
// their zoom and hand-sized panes across deliveries.
//
// 2026-10-20: a 120x29 client under `window-size latest` shrank session lsrc, its 15 panes fell to 29x6 and
// lsrc:7's compact failed five times, so every window is pinned manual 340x100. The caller (agent.mjs) re-applies
// the layout when settleTmuxWindowSize returns true, and on tmux 3.2a select-layout unzooms a zoomed pane and resets
// hand-resized panes. Row 52 rule (api:0, 2026-10-20): a detached session is re-tiled at every settle, an attached
// one only when the pin changed its size. The returned boolean is therefore what these tests read for the zoom.
//
// The fake is the real adapter over an exec that models one tmux window, hazard included: under `latest`
// the window takes the attached client's size, and `resize-window` pins `manual` (both as measured on tmux 3.2a).

import { feature, unit, expect } from "bdd-vitest";
import { createTmuxAdapter } from "./tmux.mjs";
import { settleTmuxWindowSize } from "./tmux-window-size.mjs";

const SMALL_CLIENT = { columns: 120, rows: 29 };
const NEW_DETACHED_WINDOW = { columns: 80, rows: 24 };
const FLEET_WINDOW = { sizePolicy: "manual", columns: 340, rows: 100 };

// `window` overrides the starting window; `unreadable` names a format tmux fails to answer.
function fakeTmuxWindow({ client, window, unreadable }) {
  const windowState = { sizePolicy: "latest", ...(client || NEW_DETACHED_WINDOW), ...window };
  const answer = (command) => {
    if (command.includes("#{session_attached}")) return `${client ? 1 : 0}\n`;
    if (command.includes("#{window_width}x#{window_height}")) return `${windowState.columns}x${windowState.rows}\n`;
    return "";
  };
  const exec = async (command) => {
    if (unreadable && command.includes(unreadable)) throw new Error("tmux: server exited unexpectedly");
    const policy = command.match(/set-window-option .* window-size (\w+)/)?.[1];
    const resize = command.match(/resize-window .* -x (\d+) -y (\d+)/);
    if (policy) windowState.sizePolicy = policy;
    if (resize) Object.assign(windowState, { sizePolicy: "manual", columns: Number(resize[1]), rows: Number(resize[2]) });
    if (client && windowState.sizePolicy === "latest") Object.assign(windowState, client);
    return { stdout: answer(command) };
  };
  return { windowState, tmux: createTmuxAdapter({ socket: "/tmp/fake-tmux.sock", exec }) };
}

const settle = async ({ windowState, tmux }) => ({ windowState, relayout: await settleTmuxWindowSize(tmux, "lsrc") });
const pinnedAndRelaid = ({ windowState, relayout }) => {
  expect(windowState).toEqual(FLEET_WINDOW);
  expect(relayout).toBe(true);
};
const pinnedAndLeftAlone = ({ windowState, relayout }) => {
  expect(windowState).toEqual(FLEET_WINDOW);
  expect(relayout).toBe(false);
};

feature("settleTmuxWindowSize: the fleet's window size is never the client's", () => {
  unit("an attached session a 120x29 client shrank is pinned back to manual 340x100 and re-tiled", {
    given: ["a session a 120x29 client is attached to, so its window is client-sized", () => fakeTmuxWindow({ client: SMALL_CLIENT })],
    when: ["settling the window size", settle],
    then: ["the window is manual 340x100 and the caller re-applies the layout", pinnedAndRelaid],
  });

  unit("a new detached session at tmux's 80x24 default is pinned and re-tiled", {
    given: ["a new detached session at tmux's 80x24 default", () => fakeTmuxWindow({ client: null })],
    when: ["settling the window size", settle],
    then: ["the window is manual 340x100 and the caller re-applies the layout", pinnedAndRelaid],
  });
});

feature("settleTmuxWindowSize: a person's zoom survives deliveries", () => {
  unit("an attached session already at manual 340x100 is left alone, so the person's zoom and pane sizes are kept", {
    given: ["a session a client views, its window already manual 340x100", () => fakeTmuxWindow({ client: SMALL_CLIENT, window: FLEET_WINDOW })],
    when: ["settling the window size", settle],
    then: ["the window stays manual 340x100 and the caller is told not to re-apply the layout", pinnedAndLeftAlone],
  });

  unit("a detached session already at manual 340x100 is still re-tiled, which heals a zoom a crashed delivery left", {
    given: ["a detached session whose window is already manual 340x100", () => fakeTmuxWindow({ client: null, window: FLEET_WINDOW })],
    when: ["settling the window size", settle],
    then: ["the window stays manual 340x100 and the caller re-applies the layout", pinnedAndRelaid],
  });

  unit("an attached session whose size tmux cannot read is re-tiled as if the pin had resized it", {
    given: ["a viewed window at manual 340x100 while tmux fails every window size read", () =>
      fakeTmuxWindow({ client: SMALL_CLIENT, window: FLEET_WINDOW, unreadable: "#{window_width}" })],
    when: ["settling the window size", settle],
    then: ["the window is still pinned and the caller re-applies the layout", pinnedAndRelaid],
  });

  unit("an unreadable attached count does not suppress the pin", {
    given: ["a client-shrunk window while tmux fails the attached count read", () =>
      fakeTmuxWindow({ client: SMALL_CLIENT, unreadable: "#{session_attached}" })],
    when: ["settling the window size", settle],
    then: ["the window is manual 340x100", pinnedAndRelaid],
  });
});
