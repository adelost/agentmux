import { expect, it, vi } from "vitest";
vi.mock("../cli/dream.mjs", async original => ({ ...await original(), cmdDream: vi.fn(async (_ctx, flags) => flags) }));
import { dispatch } from "../cli/commands.mjs";

it("preserves explicit historical-import authority through the real command router", async () => {
  const flags = await dispatch(["dream", "--recover", "/isolated/original.json", "--source-sha256", "a".repeat(64), "--import-historical", "--dry"], {});
  expect(flags).toMatchObject({ recover: "/isolated/original.json", "source-sha256": "a".repeat(64), "import-historical": true, dry: true });
});
