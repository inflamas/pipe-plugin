// A free TCP port on localhost, for a dev server that must not collide with another worktree's.
import { createServer } from "node:net";

const tryPort = (port) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1" }, () => s.close(() => resolve(true)));
  });

export const freePort = async (from) => {
  for (let p = from; p < from + 200; p++) if (await tryPort(p)) return p;
  return from;
};

/** The Run and URL lines of AGENTS.md with {port} filled in. */
export const appLines = (run, url, port) => ({
  run: run?.replaceAll("{port}", String(port)),
  url: url?.replaceAll("{port}", String(port)),
});
