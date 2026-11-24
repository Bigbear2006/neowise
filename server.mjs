import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";


export const AI_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;  // защита от слишком больших запросов
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const indexHtml = await readFile(new URL("./index.html", import.meta.url));

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendHtml(response) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(indexHtml);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function readRequestText(request) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isNonEmptyString(body?.text) ? body.text : null;
  } catch {
    return null;
  }
}

async function askModel(classify, text) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("AI timeout");
      controller.abort(error);
      reject(error);
    }, AI_TIMEOUT_MS);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(raw) {
  if (typeof raw !== "string") return null;
  try {
    const data = JSON.parse(raw);
    const isObject = data !== null && typeof data === "object" && !Array.isArray(data);
    return isObject ? data : null;
  } catch {
    return null;
  }
}

function validateModelReply(raw) {
  const data = parseJsonObject(raw);
  if (!data) return null;
  if (!ALLOWED_TOPICS.has(data.topic)) return null;
  if (!isNonEmptyString(data.draft)) return null;
  return { topic: data.topic, draft: data.draft.trim() };
}

async function triage(classify, text) {
  try {
    const reply = validateModelReply(await askModel(classify, text));
    return reply ? { status: "ready", ...reply } : MANUAL_REVIEW;
  } catch {
    return MANUAL_REVIEW; // таймаут или ошибка модели
  }
}

async function handleTriage(request, response, classify) {
  const text = await readRequestText(request);
  if (text === null) return sendJson(response, 400, INVALID_INPUT);
  return sendJson(response, 200, await triage(classify, text));
}

export function createApp({ classify = mockClassify } = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        return sendHtml(response);
      }
      if (request.method === "POST" && request.url === "/api/triage") {
        return await handleTriage(request, response, classify);
      }
      sendJson(response, 404, { status: "not_found" });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
}