import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";

const interfaces = os.networkInterfaces();
const addresses = Object.entries(interfaces).flatMap(([name, entries = []]) =>
  entries
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => ({ name, address: entry.address }))
);

const preferred = addresses.find(({ name }) => /^(en0|en1|wi-?fi|wlan|airport)/i.test(name));
const lanAddress = preferred?.address || addresses[0]?.address;
const port = process.env.ICPH_FORM_BUILDER_PORT || "5173";

console.log("\nICPH LAN broadcast\n");
if (lanAddress) {
  console.log(`Open on this computer: http://localhost:${port}`);
  console.log(`Open on another device on the same Wi-Fi: http://${lanAddress}:${port}`);
} else {
  console.log("No non-local IPv4 address was found. Connect this computer to Wi-Fi or Ethernet.");
}
console.log("\nKeep this terminal running. Press Ctrl+C to stop the app.\n");

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(command, ["run", "dev"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, HOST: "0.0.0.0" },
  stdio: "inherit"
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
