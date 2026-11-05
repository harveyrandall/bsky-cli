import { spawn } from "node:child_process";

function run(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve() : reject(new Error(`${command} exited with status ${status}`))));
    if (input === undefined) return;
    child.stdin?.on("error", () => {}); // a tool that isn't there reports through `child` above
    child.stdin?.end(input);
  });
}

export function openUrl(url: string): Promise<void> {
  if (process.platform === "darwin") return run("open", [url]);
  // Not `cmd /c start`: cmd would expand a `%` in the link, and a did:web can have one.
  if (process.platform === "win32") return run("rundll32", ["url.dll,FileProtocolHandler", url]);
  return run("xdg-open", [url]);
}

const CLIPBOARDS: [string, string[]][] = [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["clip", []]];

export async function copyText(text: string): Promise<void> {
  for (const [command, args] of CLIPBOARDS) {
    try {
      return await run(command, args, text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error(`Couldn't find a clipboard tool (tried ${CLIPBOARDS.map(([c]) => c).join(", ")})`);
}
