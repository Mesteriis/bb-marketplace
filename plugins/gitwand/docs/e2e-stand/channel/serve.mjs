// HTTPS static server for the stand's update channel. Usage: node serve.mjs <dir> <cert> <key> <port>
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
const [dir, cert, key, port] = process.argv.slice(2);
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "https://x").pathname));
  try {
    const body = readFileSync(join(dir, p));
    console.log(`200 ${p}`);
    res.writeHead(200);
    res.end(body);
  } catch {
    console.log(`404 ${p}`);
    res.writeHead(404);
    res.end();
  }
}).listen(Number(port), "127.0.0.1", () => console.log(`channel on https://127.0.0.1:${port}/`));
