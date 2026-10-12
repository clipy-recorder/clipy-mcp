#!/usr/bin/env node
// Library tools (update/organize/privacy/folders/comments/analytics/upload/
// delete) driven over stdio against a mock Clipy API.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "clipy-mcp-library-"));
const mov = join(dir, "Repro steps.mov");
const bytes = Buffer.alloc(32);
bytes.write("ftypqt  ", 4, "ascii");
writeFileSync(mov, bytes);

const calls = [];
let loseComplete = false;
let privacyPending = false;
let queuePending = false;
const api = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const json = (req.headers["content-type"] ?? "").includes("json") && raw ? JSON.parse(raw) : raw;
  calls.push({ method: req.method, url: req.url, body: json });
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const path = req.url.split("?")[0];
  if (path === "/api/v1/recordings/rec-1/comments" && req.method === "POST") return send(201, { comment: { id: "c9" } });
  if (path === "/api/v1/recordings/rec-1/comments") return send(200, { comments: [] });
  if (path === "/api/v1/recordings/rec-1/analytics") return send(200, { gated: true, viewCount: 2 });
  if (path === "/api/v1/recordings/rec-1" && req.method === "DELETE") return send(200, { deleted: true });
  if (path === "/api/v1/recordings/rec-1" && req.method === "PATCH") return send(200, { recording: { id: "rec-1" } });
  if (path === "/api/v1/recordings/rec-1/access") return send(403, { error: "API key missing required scope(s): recordings:write" });
  if (path === "/api/videos/raw-upload/initiate") return send(200, { uploadToken: "tok", publicId: "up-1" });
  if (path === "/api/videos/raw-upload/chunk") return send(200, { appended: true });
  if (path === "/api/videos/raw-upload/finalize") return send(200, { finalized: true });
  if (path === "/api/videos/raw-upload/complete") {
    if (loseComplete) return res.writeHead(504, { "content-type": "text/html" }).end("<html>Gateway Timeout</html>");
    if (privacyPending) return send(503, { error: "sharing not applied", code: "access_mode_pending" });
    if (queuePending) return send(503, { error: "waiting to be queued", code: "queue_pending" });
    return send(201, { public_id: "up-1" });
  }
  if (path === "/api/videos/raw-upload/abort") return send(409, { error: "attached", code: "already_attached" });
  send(404, { error: `unexpected ${req.method} ${req.url}` });
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, CLIPY_API_KEY: "clipy_sk_test", CLIPY_API_URL: apiUrl, HOME: dir, XDG_CONFIG_HOME: dir },
  stdio: ["pipe", "pipe", "ignore"],
});
let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}
async function call(name, args) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content[0].text };
}

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  // every mutating tool tells the client to confirm; reads are marked safe
  const { result: listed } = await rpc("tools/list", {});
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ["delete_recording", "update_recording", "organize_recording", "set_recording_privacy"]) {
    assert.equal(byName[name].annotations?.readOnlyHint, false, name);
    assert.equal(byName[name].annotations?.destructiveHint, true, name);
    assert.ok(byName[name].annotations?.title, name);
  }
  for (const name of ["add_comment", "upload_video", "create_folder"]) {
    assert.equal(byName[name].annotations?.readOnlyHint, false, name);
    assert.equal(byName[name].annotations?.destructiveHint, false, name);
  }
  for (const name of ["list_comments", "get_analytics", "list_folders"]) {
    assert.equal(byName[name].annotations?.readOnlyHint, true, name);
  }

  // delete refuses a mismatched confirmation without calling the API
  let r = await call("delete_recording", { id: "rec-1", confirm: "rec-2" });
  assert.ok(r.isError);
  assert.equal(calls.length, 0);
  r = await call("delete_recording", { id: "https://clipy.online/video/rec-1", confirm: "rec-1" });
  assert.ok(!r.isError, r.text);
  assert.equal(calls.at(-1).url, "/api/v1/recordings/rec-1?confirm=rec-1");

  // comments: a reply carries the parent, and posting is a single attempt
  r = await call("add_comment", { id: "rec-1", body: "Fixed", parentCommentId: "c1" });
  assert.ok(!r.isError, r.text);
  assert.deepEqual(calls.at(-1).body, { kind: "reply", body: "Fixed", parentCommentId: "c1" });

  r = await call("get_analytics", { id: "rec-1", rangeDays: 14 });
  assert.equal(calls.at(-1).url, "/api/v1/recordings/rec-1/analytics?range=14");

  r = await call("update_recording", { id: "rec-1", description: null });
  assert.deepEqual(calls.at(-1).body, { description: null });

  // a scope refusal names the scope and how to get it
  r = await call("set_recording_privacy", { id: "rec-1", mode: "private" });
  assert.ok(r.isError);
  assert.match(r.text, /recordings:write/);
  assert.match(r.text, /clipy login/);

  // upload accepts a QuickTime .mov and titles it after the file
  const start = calls.length;
  r = await call("upload_video", { path: mov, access: "private", type: "bug" });
  assert.ok(!r.isError, r.text);
  assert.equal(JSON.parse(r.text).shareUrl, `${apiUrl}/video/up-1`);
  const upload = calls.slice(start);
  assert.deepEqual(upload.map((c) => c.url), [
    "/api/videos/raw-upload/initiate",
    "/api/videos/raw-upload/chunk",
    "/api/videos/raw-upload/finalize",
    "/api/videos/raw-upload/complete",
  ]);
  assert.match(upload[1].body, /filename="part-1\.mp4"/);
  assert.equal(upload[3].body.name, "Repro steps");
  assert.equal(upload[3].body.accessMode, "private");
  assert.equal(upload[3].body.recordingKind, "bug_report");

  // a /complete that committed but never answered is reported as uploaded
  loseComplete = true;
  r = await call("upload_video", { path: mov });
  loseComplete = false;
  assert.ok(!r.isError, r.text);
  assert.equal(JSON.parse(r.text).publicId, "up-1");
  assert.equal(calls.at(-1).url, "/api/videos/raw-upload/abort");

  // ...but sharing that could not be applied is a failure, never a share link
  privacyPending = true;
  r = await call("upload_video", { path: mov, access: "private" });
  privacyPending = false;
  assert.ok(r.isError, r.text);
  assert.match(r.text, /up-1/);
  assert.match(r.text, /set_recording_privacy/);
  assert.match(r.text, /Do not upload again/);
  // reported straight from the coded answer: no abort that could fail
  assert.equal(calls.at(-1).url, "/api/videos/raw-upload/complete");

  // ...and any other unconfirmed completion names the recording too
  queuePending = true;
  r = await call("upload_video", { path: mov });
  queuePending = false;
  assert.ok(r.isError, r.text);
  assert.match(r.text, /up-1/);
  assert.match(r.text, /get_recording/);
  assert.match(r.text, /Do not upload again/);

  console.log("library tools: ok");
} finally {
  child.kill();
  api.close();
}
