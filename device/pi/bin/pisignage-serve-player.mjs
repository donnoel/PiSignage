#!/usr/bin/env node
import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const repoRoot = process.cwd();
const host = process.env.PISIGNAGE_PLAYER_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PISIGNAGE_PLAYER_PORT ?? "5173", 10);
const distRoot = path.resolve(repoRoot, process.env.PISIGNAGE_PLAYER_DIST ?? "player/dist");
const contentRoot = path.resolve(
  repoRoot,
  process.env.PISIGNAGE_CONTENT_ROOT ?? "sample-content"
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".svg", "image/svg+xml"]
]);

function textResponse(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(message);
}

function pathWithin(root, requestPath) {
  const normalizedPath = path.posix.normalize(`/${requestPath}`).replace(/^\/+/, "");
  const resolvedPath = path.resolve(root, normalizedPath);

  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function fileExists(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function resolveRequestPath(pathname) {
  if (pathname === "/playlist.local.json") {
    return pathWithin(contentRoot, "playlist.local.json");
  }

  if (pathname.startsWith("/assets/")) {
    const contentAssetPath = pathWithin(contentRoot, pathname);
    if (contentAssetPath && (await fileExists(contentAssetPath))) {
      return contentAssetPath;
    }
  }

  const distPath = pathWithin(distRoot, pathname === "/" ? "index.html" : pathname);
  if (distPath && (await fileExists(distPath))) {
    return distPath;
  }

  return pathWithin(distRoot, "index.html");
}

function parseByteRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (!match) {
    return null;
  }

  const startText = match[1];
  const endText = match[2];
  let start = startText ? Number.parseInt(startText, 10) : 0;
  let end = endText ? Number.parseInt(endText, 10) : fileSize - 1;

  if (!startText && endText) {
    const suffixLength = Number.parseInt(endText, 10);
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1)
  };
}

async function serveFile(request, response, filePath) {
  const stats = await fs.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const contentType = contentTypes.get(extension) ?? "application/octet-stream";
  const noStore = filePath.startsWith(contentRoot);
  const range = extension === ".mp4" ? parseByteRange(request.headers.range, stats.size) : null;

  if (request.headers.range && extension === ".mp4" && !range) {
    response.writeHead(416, {
      "content-range": `bytes */${stats.size}`,
      "cache-control": "no-store"
    });
    response.end();
    return;
  }

  if (range) {
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": range.end - range.start + 1,
      "content-range": `bytes ${range.start}-${range.end}/${stats.size}`,
      "content-type": contentType
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath, range).pipe(response);
    return;
  }

  response.writeHead(200, {
    "accept-ranges": extension === ".mp4" ? "bytes" : "none",
    "cache-control": noStore ? "no-store" : "public, max-age=31536000, immutable",
    "content-length": stats.size,
    "content-type": contentType
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  if (!request.url || (request.method !== "GET" && request.method !== "HEAD")) {
    textResponse(response, 405, "Method not allowed");
    return;
  }

  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const filePath = await resolveRequestPath(decodeURIComponent(requestUrl.pathname));
    await serveFile(request, response, filePath);
  } catch (error) {
    console.error(error);
    textResponse(response, 500, "PiSignage player server error");
  }
});

server.listen(port, host, () => {
  console.log(`PiSignage player serving ${distRoot} on http://${host}:${port}`);
  console.log(`PiSignage content serving ${contentRoot}`);
});
