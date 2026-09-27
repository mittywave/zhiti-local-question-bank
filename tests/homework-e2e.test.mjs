import { loadSource } from "./load-source.mjs";
import { loopbackFetch as fetch } from './helpers/loopback-fetch.mjs';
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const INVITE = "homework-e2e-invite";

function command(args) {
  const result = spawnSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

function d1Rows(persistTo, sql) {
  const result = spawnSync(WRANGLER, ["d1", "execute", "DB", "--local", "--persist-to", persistTo,
    "--config", join(ROOT, "wrangler.jsonc"), "--command", sql, "--json"],
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout)[0]?.results ?? [];
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port)); });
  });
}

function startWorker(port, persistTo, vars) {
  const args = ["dev", "--config", CONFIG, "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persistTo];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  const child = spawn(WRANGLER, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForServer(url, worker) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (worker.child.exitCode != null) throw new Error(`Worker 提前退出\n${worker.output()}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* 等待监听端口 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`Worker 启动超时\n${worker.output()}`);
}

async function stopWorker(worker) {
  if (worker.child.exitCode != null) return; worker.child.kill("SIGINT");
  await Promise.race([new Promise((resolveExit) => worker.child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (worker.child.exitCode == null) worker.child.kill("SIGKILL");
}

async function jsonRequest(base, path, { cookie = "", method = "GET", body, headers = {} } = {}) {
  const requestHeaders = { ...headers }; if (cookie) requestHeaders.Cookie = cookie;
  if (body !== undefined) { requestHeaders["Content-Type"] = "application/json"; requestHeaders.Origin = base; }
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})); return { response, payload };
}

async function upload(base, path, cookie, bytes, name = "作业页面.jpg") {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: {
    Cookie: cookie, Origin: base, Connection: "close", "Content-Type": "image/jpeg", "X-File-Name": encodeURIComponent(name),
  }, body: bytes, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})); return { response, payload };
}

function sessionCookie(response) { return (response.headers.get("set-cookie") ?? "").split(";", 1)[0]; }

function testJpeg() {
  const width = 800; const height = 1100; const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 90; y < height - 80; y += 80) for (let x = 70; x < width - 70; x += 1) {
    const offset = (y * width + x) * 4; data[offset] = 60; data[offset + 1] = 70; data[offset + 2] = 75;
  }
  return jpeg.encode({ data, width, height }, 82).data;
}

function startMockModel(port) {
  const state = { failEnabled: true, failureCalls: 0, gradingCalls: 0, extractionCalls: 0, recoveryCalls: 0 };
  const server = createHttpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const prompt = String(payload.input?.[0]?.content?.find((item) => item.type === "input_text")?.text ?? "");
    if (prompt.includes("标准答案补全助手")) {
      state.recoveryCalls += 1;
      const pageRange = prompt.match(/答案文件第 (\d+) 至 (\d+) 张/u);
      const pageStart = Number(pageRange?.[1] ?? 0);
      const pageEnd = Number(pageRange?.[2] ?? 0);
      if (pageStart === 1 && pageEnd === 5) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ output_text: JSON.stringify({ answers: [] }) }));
        return;
      }
      const answers = pageStart === 1 && pageEnd === 4
        ? [{ question_number: "19", answer: "x=-3", analysis: "移项并合并同类项", confidence: .98, warnings: [] }]
        : pageStart === 5 && pageEnd === 5
          ? [{ question_number: "20", answer: "x=1", analysis: "去分母后求解", confidence: .97, warnings: [] }]
          : [
            { question_number: "19", answer: "x=-3", analysis: "移项并合并同类项", confidence: .98, warnings: [] },
            { question_number: "20", answer: "x=1", analysis: "去分母后求解", confidence: .97, warnings: [] },
          ];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({ answers }) }));
      return;
    }
    if (prompt.includes("作业模板录入助手")) {
      state.extractionCalls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({ questions: [
        { question_number: "19", page_number: 1, type: "解答题", stem: "解方程 3x-1=5(x+1)", options: [], answer: "", analysis: "", bbox: null, confidence: .96, warnings: ["答案页未包含第19题的参考答案与解析"], knowledge_tags: ["一元一次方程"], capability_keys: ["skill:reasoning", "skill:expression"] },
        { question_number: "20", page_number: 1, type: "解答题", stem: "解下列方程", options: [], answer: "", analysis: "", bbox: null, confidence: .95, warnings: ["答案页未包含第20题的参考答案与解析"], knowledge_tags: ["一元一次方程"], capability_keys: ["skill:calculation"] },
      ] }) }));
      return;
    }
    if (prompt.includes("学习诊断助手")) {
      const corrected = prompt.includes('"question_number":"1","question_type":"单选题","verdict":"correct"');
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({
        overall_summary: corrected ? "老师修正后，第 1 题正确，当前优先补全第 2 题步骤。" : "本次方程作业已完成，计算与步骤表达仍需巩固。",
        student_message: corrected ? "重做第 2 题并补全最终验算。" : "先重做第 1、2 题，再逐步核对符号和结论。",
        strengths: corrected ? [{ title: "第 1 题判断正确", detail: "老师核对原卷后确认作答正确。", question_numbers: ["1"], capability_key: null }] : [],
        gaps: corrected ? [{ title: "步骤需要完整", detail: "第 2 题只完成了部分推导。", question_numbers: ["2"], capability_key: "skill:expression" }] : [
          { title: "选择判断需更仔细", detail: "第 1 题选择与标准答案不同。", question_numbers: ["1"], capability_key: "skill:concept" },
          { title: "步骤需要完整", detail: "第 2 题只完成了部分推导。", question_numbers: ["2"], capability_key: "skill:expression" },
        ],
        actions: corrected ? ["重做第 2 题并补全最终验算。"] : ["重做第 1、2 题并写出错误原因。", "完成后用代入法检查结果。"], warnings: [],
      }) }));
      return;
    }
    if (state.failEnabled && prompt.includes("MOCK_ALWAYS_FAIL")) {
      state.failureCalls += 1; response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "mock grading unavailable" } })); return;
    }
    state.gradingCalls += 1;
    const numbers = [...prompt.matchAll(/题号 ([^\n]+)/g)].map((match) => match[1].trim());
    const unreadable = prompt.includes("MOCK_UNREADABLE");
    const results = numbers.map((number, index) => ({
      question_number: number, page_number: 1, student_answer: number === "2" ? "只写到 x=1" : "B",
      verdict: unreadable ? "unreadable" : number === "2" ? "partial" : "incorrect",
      feedback: unreadable ? "答卷照片无法与题目页面可靠匹配" : number === "2" ? "推导未完成" : "选择项与标准答案不同",
      error_type: unreadable ? "无法匹配" : number === "2" ? "步骤" : "审题", confidence: unreadable ? .15 : number === "2" ? .86 : .98,
      step_analysis: unreadable ? [] : number === "2" ? ["正确写出了部分移项过程", "缺少最终求解和验算"] : [],
      evidence_summary: unreadable ? "页面结构与模板不一致" : number === "2" ? "学生只写到 x=1" : "学生选择 B，标准答案为 A",
      capability_keys: number === "2" ? ["skill:reasoning", "skill:expression"] : ["skill:concept"],
      bbox: { x: 90, y: 120 + index * 280, width: 760, height: 190 }, warnings: [],
    }));
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ output_text: JSON.stringify({ results }) }));
  });
  return new Promise((resolveStart, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolveStart({ server, state })); });
}

async function waitForSubmission(base, cookie, id, expected, worker, timeout = 30_000) {
  const deadline = Date.now() + timeout; let latest;
  while (Date.now() < deadline) {
    latest = await jsonRequest(base, `/api/submissions/${id}`, { cookie });
    if (expected.includes(latest.payload.submission?.status)) return latest.payload.submission;
    if (worker.child.exitCode != null) throw new Error(`Worker 提前退出\n${worker.output()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error(`等待提交状态 ${expected.join("/")} 超时，最后状态 ${latest?.payload?.submission?.status}\n${worker.output()}`);
}

async function prepareAssignment(base, teacherCookie, studentIds, bytes, title, questions) {
  const created = await jsonRequest(base, "/api/assignments", { cookie: teacherCookie, method: "POST", body: { assignment: { title, targetStudentIds: studentIds } } });
  assert.equal(created.response.status, 201); const assignmentId = created.payload.assignment.id;
  const questionAsset = await upload(base, `/api/homework-assets?assignmentId=${assignmentId}&role=question&pageOrder=0`, teacherCookie, bytes, "空白题目卷.jpg");
  const answerAsset = await upload(base, `/api/homework-assets?assignmentId=${assignmentId}&role=answer&pageOrder=0`, teacherCookie, bytes, "标准答案与解析.jpg");
  assert.equal(questionAsset.response.status, 201); assert.equal(answerAsset.response.status, 201);
  const saved = await jsonRequest(base, `/api/assignments/${assignmentId}`, { cookie: teacherCookie, method: "PUT", body: { assignment: {
    action: "publish", title, instructions: "按步骤完成", dueAt: null, targetStudentIds: studentIds, questions,
  } } });
  assert.equal(saved.response.status, 200); assert.equal(saved.payload.assignment.status, "published");
  assert.deepEqual([...saved.payload.assignment.targetStudentIds].sort(), [...studentIds].sort());
  return { assignmentId, questionAsset: questionAsset.payload.asset, answerAsset: answerAsset.payload.asset };
}

async function uploadSubmissionPage(base, cookie, submissionId, bytes, prefix, quality = { score: .97, warnings: [], blocking: false }) {
  const original = await upload(base, `/api/homework-assets?submissionId=${submissionId}&role=submission_original&pageOrder=0`, cookie, bytes, `${prefix}-原件.jpg`);
  const processed = await upload(base, `/api/homework-assets?submissionId=${submissionId}&role=submission_processed&pageOrder=0`, cookie, bytes, `${prefix}-校准.jpg`);
  assert.equal(original.response.status, 201); assert.equal(processed.response.status, 201);
  const saved = await jsonRequest(base, `/api/student/submissions/${submissionId}`, { cookie, method: "PUT", body: { action: "save-pages", pages: [{
    originalAssetId: original.payload.asset.id, processedAssetId: processed.payload.asset.id, quality,
  }] } });
  assert.equal(saved.response.status, 200); return { original: original.payload.asset, processed: processed.payload.asset };
}

test("homework flow auto-publishes readable work, auto-returns unreadable work, syncs corrections, isolates accounts, and retries failures", { timeout: 180_000 }, async () => {
  const [port, modelPort] = await Promise.all([freePort(), freePort()]); const stateDir = await mkdtemp(join(tmpdir(), "zhiti-homework-e2e-"));
  command(["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "--config", join(ROOT, "wrangler.jsonc")]);
  const mock = await startMockModel(modelPort); const worker = startWorker(port, stateDir, {
    LOCAL_ADMIN_MODE: "false", AI_PROVIDER_LOCAL_HTTP: "true", AI_PROVIDER_ALLOWED_BASES: `http://127.0.0.1:${modelPort}/v1`, AI_PROVIDER_ENCRYPTION_KEY: "synthetic-homework-v2-secret", HOMEWORK_GRADING_ENABLED: "true", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@homework.test",
    OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, OPENAI_API_MODE: "responses",
    HOMEWORK_GRADING_MODEL: "mock-homework", HOMEWORK_QUEUE_RETRY_BASE_SECONDS: "1", HOMEWORK_QUEUE_MAX_ATTEMPTS: "4", HOMEWORK_AUTO_PUBLISH_ENABLED: "true",
    STUDENT_PORTAL_ORIGIN: "http://192.168.50.10:3001",
  });
  const base = `http://localhost:${port}`; const bytes = testJpeg();
  try {
    await waitForServer(`${base}/api/auth/me`, worker);
    const teacherOneRegistration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: "one@homework.test", password: "password123", inviteCode: INVITE } });
    const teacherTwoRegistration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: "two@homework.test", password: "password123", inviteCode: INVITE } });
    assert.equal(teacherOneRegistration.response.status, 201); assert.equal(teacherTwoRegistration.response.status, 201);
    const teacherOne = sessionCookie(teacherOneRegistration.response); const teacherTwo = sessionCookie(teacherTwoRegistration.response);
    // Exercise the real V2 grading route through D1 and the homework queue.
    // Other roles retain the explicit read-only environment fallback in this suite.
    const adminRegistration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: "admin@homework.test", password: "password123", inviteCode: INVITE } });
    assert.equal(adminRegistration.response.status, 201);
    const adminCookie = sessionCookie(adminRegistration.response);
    const { newProvider } = await loadSource("lib/ai-provider-presets.ts");
    const providerResponse = await jsonRequest(base, "/api/admin/ai-providers", { cookie: adminCookie, method: "POST", body: {
      ...newProvider(), name: "Homework V2 fixture", baseUrl: `http://127.0.0.1:${modelPort}/v1`, wireApi: "responses", enabled: true, credential: { action: "replace", value: "mock-key" },
    } });
    assert.equal(providerResponse.response.status, 200); const gradingProvider = providerResponse.payload.provider;
    let center = (await jsonRequest(base, "/api/admin/ai-providers", { cookie: adminCookie })).payload;
    const modelResponse = await jsonRequest(base, `/api/admin/ai-providers/${gradingProvider.id}/models`, { cookie: adminCookie, method: "POST", body: {
      id: "mock-homework", expectedRevision: gradingProvider.revision, expectedConfigurationRevision: center.routing.revision,
      capabilities: { text: "supported", vision: "supported", structured: "supported" },
    } });
    assert.equal(modelResponse.response.status, 200);
    center = (await jsonRequest(base, "/api/admin/ai-providers", { cookie: adminCookie })).payload;
    center.routing.routes.find(route => route.role === "grading").primary = { providerId: gradingProvider.id, modelId: "mock-homework" };
    assert.equal((await jsonRequest(base, "/api/admin/ai-routing", { cookie: adminCookie, method: "PUT", body: center.routing })).response.status, 200);


    const emptyDraft = await jsonRequest(base, "/api/assignments", { cookie: teacherOne, method: "POST", body: { assignment: { title: "先保存设置的草稿" } } });
    assert.equal(emptyDraft.response.status, 201);
    const savedEmptyDraft = await jsonRequest(base, `/api/assignments/${emptyDraft.payload.assignment.id}`, { cookie: teacherOne, method: "PUT", body: { assignment: {
      title: "先保存设置的草稿", instructions: "题目稍后上传", dueAt: null, targetStudentIds: [], questions: [],
    } } });
    assert.equal(savedEmptyDraft.response.status, 200); assert.deepEqual(savedEmptyDraft.payload.assignment.questions, []);
    assert.equal((await jsonRequest(base, `/api/assignments/${emptyDraft.payload.assignment.id}`, { cookie: teacherOne, method: "PUT", body: { assignment: { action: "publish" } } })).response.status, 400);

    const studentOne = await jsonRequest(base, "/api/students", { cookie: teacherOne, method: "POST", body: { student: { name: "小宇", className: "初一（1）班" } } });
    const studentTwo = await jsonRequest(base, "/api/students", { cookie: teacherOne, method: "POST", body: { student: { name: "小林", className: "初一（1）班" } } });
    assert.equal(studentOne.response.status, 201); assert.equal(studentTwo.response.status, 201);
    const studentOneId = studentOne.payload.student.id; const studentTwoId = studentTwo.payload.student.id;
    const accountOne = await jsonRequest(base, `/api/students/${studentOneId}/account`, { cookie: teacherOne, method: "POST", body: { loginId: "S001", password: "initial001" } });
    const accountTwo = await jsonRequest(base, `/api/students/${studentTwoId}/account`, { cookie: teacherOne, method: "POST", body: { loginId: "S002", password: "initial002" } });
    assert.equal(accountOne.response.status, 200); assert.equal(accountTwo.response.status, 200);
    assert.equal(accountOne.payload.account.mustChangePassword, false); assert.equal(accountTwo.payload.account.mustChangePassword, false);
    const teacherStudents = await jsonRequest(base, "/api/students", { cookie: teacherOne });
    assert.equal(teacherStudents.payload.students.find((student) => student.id === studentOneId).loginId, "s001");
    assert.ok(teacherStudents.payload.students.every((student) => !("password" in student)));
    const portal = await jsonRequest(base, "/api/student-portal", { cookie: teacherOne });
    assert.equal(portal.payload.url, `http://192.168.50.10:3001/student/${portal.payload.code}`);

    const extractionDraft = await jsonRequest(base, "/api/assignments", { cookie: teacherOne, method: "POST", body: { assignment: { title: "答案补全回归" } } });
    assert.equal(extractionDraft.response.status, 201);
    const extractionId = extractionDraft.payload.assignment.id;
    assert.equal((await upload(base, `/api/homework-assets?assignmentId=${extractionId}&role=question&pageOrder=0`, teacherOne, bytes, "题目卷.jpg")).response.status, 201);
    assert.equal((await upload(base, `/api/homework-assets?assignmentId=${extractionId}&role=answer&pageOrder=0`, teacherOne, bytes, "答案解析.jpg")).response.status, 201);
    const extractedAssignment = await jsonRequest(base, `/api/assignments/${extractionId}/extract`, { cookie: teacherOne, method: "POST", body: {} });
    assert.equal(extractedAssignment.response.status, 200);
    assert.equal(mock.state.extractionCalls, 1);
    assert.equal(mock.state.recoveryCalls, 1);
    const recoveredQuestions = extractedAssignment.payload.assignment.questions;
    assert.deepEqual(recoveredQuestions.map((question) => question.questionNumber), ["19", "20"]);
    assert.equal(recoveredQuestions[0].answer, "x=-3");
    assert.equal(recoveredQuestions[1].answer, "x=1");
    assert.deepEqual(recoveredQuestions.flatMap((question) => question.warnings), []);
    assert.ok(recoveredQuestions.every((question) => question.taxonomyKeys.includes("cn-math:topic:linear-equation")));

    const batchedDraft = await jsonRequest(base, "/api/assignments", { cookie: teacherOne, method: "POST", body: { assignment: { title: "答案分批补全回归" } } });
    assert.equal(batchedDraft.response.status, 201);
    const batchedId = batchedDraft.payload.assignment.id;
    assert.equal((await upload(base, `/api/homework-assets?assignmentId=${batchedId}&role=question&pageOrder=0`, teacherOne, bytes, "题目卷.jpg")).response.status, 201);
    for (let pageOrder = 0; pageOrder < 5; pageOrder += 1) {
      assert.equal((await upload(base, `/api/homework-assets?assignmentId=${batchedId}&role=answer&pageOrder=${pageOrder}`, teacherOne, bytes, `答案解析-${pageOrder + 1}.jpg`)).response.status, 201);
    }
    const batchedExtraction = await jsonRequest(base, `/api/assignments/${batchedId}/extract`, { cookie: teacherOne, method: "POST", body: {} });
    assert.equal(batchedExtraction.response.status, 200);
    assert.equal(mock.state.recoveryCalls, 4);
    assert.deepEqual(batchedExtraction.payload.assignment.questions.map((question) => question.answer), ["x=-3", "x=1"]);

    const loginOne = await jsonRequest(base, "/api/student-auth/login", { method: "POST", body: { teacherCode: portal.payload.code, loginId: "S001", password: "initial001" } });
    const loginTwo = await jsonRequest(base, "/api/student-auth/login", { method: "POST", body: { teacherCode: portal.payload.code, loginId: "S002", password: "initial002" } });
    assert.equal(loginOne.payload.student.mustChangePassword, false); assert.equal(loginTwo.payload.student.mustChangePassword, false);
    assert.doesNotMatch(loginOne.response.headers.get("set-cookie") ?? "", /;\s*Secure\b/i);
    const studentOneCookie = sessionCookie(loginOne.response); const studentTwoCookie = sessionCookie(loginTwo.response);

    const questions = [
      { questionNumber: "1", pageNumber: 1, type: "单选题", stem: "1 + 1 的正确选项", options: ["A. 2", "B. 3"], answer: "A", analysis: "1 + 1 = 2", confidence: 1, warnings: [], knowledgeTags: ["有理数运算"], capabilityKeys: ["skill:calculation", "skill:concept"], sortOrder: 0 },
      { questionNumber: "2", pageNumber: 1, type: "解答题", stem: "解方程 2x=4", options: [], answer: "x=2", analysis: "两边同除以 2", confidence: 1, warnings: [], knowledgeTags: ["一元一次方程"], capabilityKeys: ["skill:reasoning", "skill:expression"], sortOrder: 1 },
    ];
    const prepared = await prepareAssignment(base, teacherOne, [studentOneId, studentTwoId], bytes, "一次方程作业", questions);
    const lockedUpload = await upload(base, `/api/homework-assets?assignmentId=${prepared.assignmentId}&role=question&pageOrder=1`, teacherOne, Buffer.alloc(0));
    assert.equal(lockedUpload.response.status, 404);
    const studentAssignment = await jsonRequest(base, "/api/student/assignments", { cookie: studentOneCookie });
    assert.deepEqual(studentAssignment.payload.assignments[0].assets.map((asset) => asset.role), ["question"]);
    assert.ok(studentAssignment.payload.assignments[0].questions.every((question) => !question.answer && !question.analysis));
    assert.equal((await fetch(`${base}${prepared.questionAsset.url}`, { headers: { Cookie: studentOneCookie } })).status, 200);
    assert.equal((await fetch(`${base}${prepared.answerAsset.url}`, { headers: { Cookie: studentOneCookie } })).status, 404);
    const forbiddenPasswordChange = await jsonRequest(base, "/api/student-auth/password", { cookie: studentOneCookie, method: "POST", body: { password: "student-one-new" } });
    assert.equal(forbiddenPasswordChange.response.status, 403); assert.match(forbiddenPasswordChange.payload.error, /只能由老师/);
    const originalPasswordStillWorks = await jsonRequest(base, "/api/student-auth/login", { method: "POST", body: { teacherCode: portal.payload.code, loginId: "S001", password: "initial001" } });
    assert.equal(originalPasswordStillWorks.response.status, 200);

    const submissionOneResult = await jsonRequest(base, "/api/student/submissions", { cookie: studentOneCookie, method: "POST", body: { assignmentId: prepared.assignmentId } });
    const submissionTwoResult = await jsonRequest(base, "/api/student/submissions", { cookie: studentTwoCookie, method: "POST", body: { assignmentId: prepared.assignmentId } });
    const submissionOneId = submissionOneResult.payload.submission.id; const submissionTwoId = submissionTwoResult.payload.submission.id;
    const pageOne = await uploadSubmissionPage(base, studentOneCookie, submissionOneId, bytes, "小宇");
    const crossReuse = await jsonRequest(base, `/api/student/submissions/${submissionTwoId}`, { cookie: studentTwoCookie, method: "PUT", body: { action: "save-pages", pages: [{
      originalAssetId: pageOne.original.id, processedAssetId: pageOne.processed.id, quality: { score: 1, warnings: [] },
    }] } });
    assert.equal(crossReuse.response.status, 400);
    assert.equal((await fetch(`${base}${pageOne.processed.url}`, { headers: { Cookie: studentTwoCookie } })).status, 404);
    await uploadSubmissionPage(base, studentTwoCookie, submissionTwoId, bytes, "小林");

    const prePublish = await jsonRequest(base, `/api/student/submissions/${submissionOneId}`, { cookie: studentOneCookie });
    assert.deepEqual(prePublish.payload.submission.gradingItems, []);
    assert.equal(prePublish.payload.submission.report, null);
    assert.equal((await jsonRequest(base, `/api/student/capability-profile?assignmentId=${prepared.assignmentId}`, { cookie: studentOneCookie })).response.status, 404);
    assert.equal((await jsonRequest(base, `/api/student/submissions/${submissionOneId}`, { cookie: studentOneCookie, method: "PUT", body: { action: "submit" } })).response.status, 200);
    let teacherSubmissionOne = await waitForSubmission(base, teacherOne, submissionOneId, ["published"], worker);
    assert.equal(teacherSubmissionOne.gradingItems.find((item) => item.questionNumber === "1").verdict, "incorrect");
    assert.equal(teacherSubmissionOne.gradingItems.find((item) => item.questionNumber === "1").requiresReview, false);
    assert.equal(teacherSubmissionOne.gradingItems.find((item) => item.questionNumber === "2").requiresReview, false);
    assert.deepEqual(teacherSubmissionOne.gradingItems.find((item) => item.questionNumber === "2").stepAnalysis, ["正确写出了部分移项过程", "缺少最终求解和验算"]);
    assert.match(teacherSubmissionOne.report.overallSummary, /方程作业/);
    const publishedForStudent = await jsonRequest(base, `/api/student/submissions/${submissionOneId}`, { cookie: studentOneCookie });
    assert.equal(publishedForStudent.payload.submission.gradingItems.length, 2);
    assert.match(publishedForStudent.payload.submission.report.studentMessage, /重做第 1、2 题/);
    const studentOneProfile = await jsonRequest(base, `/api/student/capability-profile?assignmentId=${prepared.assignmentId}`, { cookie: studentOneCookie });
    assert.equal(studentOneProfile.response.status, 200);
    assert.ok(studentOneProfile.payload.profile.nodes.some((node) => node.highlighted));
    assert.equal(studentOneProfile.payload.profile.viewMode, "student");
    assert.ok(studentOneProfile.payload.profile.nodes.some((node) => node.key === "cn-math:topic:linear-equation"));
    assert.ok(studentOneProfile.payload.profile.edges.some((edge) => edge.targetKey === "cn-math:topic:linear-equation"));
    assert.deepEqual(studentOneProfile.payload.profile.textbookEditions.map((edition) => edition.label), ["人教版", "北师大版", "苏教版"]);
    const teacherProfile = await jsonRequest(base, `/api/students/${studentOneId}/capability-profile?assignmentId=${prepared.assignmentId}`, { cookie: teacherOne });
    assert.equal(teacherProfile.payload.profile.viewMode, "teacher");
    const teacherKnowledgeGraph = await jsonRequest(base, `/api/knowledge-graph?studentId=${studentOneId}`, { cookie: teacherOne });
    assert.equal(teacherKnowledgeGraph.response.status, 200);
    assert.equal(teacherKnowledgeGraph.payload.profile.nodes.filter((node) => node.dimension === "knowledge").length, 33);
    assert.equal(teacherKnowledgeGraph.payload.profile.edges.filter((edge) => edge.sourceKey.startsWith("cn-math:")).length, 29);
    assert.ok(teacherKnowledgeGraph.payload.profile.nodes.some((node) => node.evidenceCount > 0));
    assert.equal((await jsonRequest(base, `/api/student/capability-profile?assignmentId=${prepared.assignmentId}`, { cookie: studentTwoCookie })).response.status, 404);
    assert.equal((await fetch(`${base}${prepared.answerAsset.url}`, { headers: { Cookie: studentOneCookie } })).status, 200);
    let wrongOne = await jsonRequest(base, "/api/student/wrong-questions", { cookie: studentOneCookie });
    assert.equal(wrongOne.payload.entries.length, 2); assert.ok(wrongOne.payload.entries.every((entry) => entry.mistakeCount === 1));
    assert.ok(wrongOne.payload.entries.every((entry) => entry.answerCropAssetId));
    assert.equal((await fetch(`${base}/api/homework-assets/${wrongOne.payload.entries[0].answerCropAssetId}`, { headers: { Cookie: studentOneCookie } })).status, 200);
    await jsonRequest(base, `/api/submissions/${submissionOneId}`, { cookie: teacherOne, method: "PUT", body: { action: "publish" } });
    wrongOne = await jsonRequest(base, "/api/student/wrong-questions", { cookie: studentOneCookie });
    assert.ok(wrongOne.payload.entries.every((entry) => entry.mistakeCount === 1));
    const firstItem = teacherSubmissionOne.gradingItems.find((item) => item.questionNumber === "1");
    teacherSubmissionOne = (await jsonRequest(base, `/api/submissions/${submissionOneId}`, { cookie: teacherOne, method: "PUT", body: { action: "correct", items: [{
      id: firstItem.id, verdict: "correct", studentAnswer: "A", feedback: "老师核对原卷后确认选择正确", errorType: "", confidence: 1,
    }] } })).payload.submission;
    assert.equal(teacherSubmissionOne.gradingItems.find((item) => item.questionNumber === "1").verdict, "correct");
    assert.match(teacherSubmissionOne.report.overallSummary, /老师修正后/);
    const correctedForStudent = await jsonRequest(base, `/api/student/submissions/${submissionOneId}`, { cookie: studentOneCookie });
    assert.match(correctedForStudent.payload.submission.report.studentMessage, /重做第 2 题/);
    wrongOne = await jsonRequest(base, "/api/student/wrong-questions", { cookie: studentOneCookie });
    assert.equal(wrongOne.payload.entries.length, 1);
    assert.equal(d1Rows(stateDir, `SELECT COUNT(*) AS count FROM grading_item_revisions WHERE submission_id = '${submissionOneId}'`)[0].count, 1);
    assert.equal(d1Rows(stateDir, `SELECT COUNT(*) AS count FROM student_capability_evidence WHERE submission_id = '${submissionOneId}' AND verdict = 'incorrect'`)[0].count, 0);
    assert.equal(d1Rows(stateDir, `SELECT taxonomy_keys_json FROM assignment_questions WHERE assignment_id = '${prepared.assignmentId}' AND question_number = '2'`)[0].taxonomy_keys_json,
      '["cn-math:topic:linear-equation"]');

    assert.equal((await jsonRequest(base, `/api/assignments/${prepared.assignmentId}`, { cookie: teacherTwo })).response.status, 404);
    assert.equal((await jsonRequest(base, `/api/submissions/${submissionOneId}`, { cookie: teacherTwo })).response.status, 404);
    assert.equal((await fetch(`${base}${pageOne.processed.url}`, { headers: { Cookie: teacherTwo } })).status, 404);
    const crossTeacherAssignment = await jsonRequest(base, "/api/assignments", { cookie: teacherTwo, method: "POST", body: { assignment: { title: "越权作业", targetStudentIds: [studentOneId] } } });
    assert.equal(crossTeacherAssignment.response.status, 400);

    assert.equal((await jsonRequest(base, `/api/student/submissions/${submissionTwoId}`, { cookie: studentTwoCookie, method: "PUT", body: { action: "submit" } })).response.status, 200);
    await waitForSubmission(base, teacherOne, submissionTwoId, ["published"], worker);
    const classPublish = await jsonRequest(base, `/api/assignments/${prepared.assignmentId}/publish-results`, { cookie: teacherOne, method: "POST", body: {} });
    assert.deepEqual(classPublish.payload, { published: 0, total: 2 });

    const unreadableAssignment = await prepareAssignment(base, teacherOne, [studentTwoId], bytes, "自动退回答卷", [{
      questionNumber: "U", pageNumber: 1, type: "解答题", stem: "MOCK_UNREADABLE 页面匹配测试", options: [], answer: "完整过程", analysis: "按步骤推导", confidence: 1,
      warnings: [], knowledgeTags: ["一元一次方程"], capabilityKeys: ["skill:expression"], sortOrder: 0,
    }]);
    const unreadableDraft = await jsonRequest(base, "/api/student/submissions", { cookie: studentTwoCookie, method: "POST", body: { assignmentId: unreadableAssignment.assignmentId } });
    const unreadableId = unreadableDraft.payload.submission.id;
    await uploadSubmissionPage(base, studentTwoCookie, unreadableId, bytes, "无法匹配");
    await jsonRequest(base, `/api/student/submissions/${unreadableId}`, { cookie: studentTwoCookie, method: "PUT", body: { action: "submit" } });
    const unreadable = await waitForSubmission(base, teacherOne, unreadableId, ["returned"], worker);
    assert.match(unreadable.failureReason, /无法与题目页面可靠匹配/);
    assert.equal(unreadable.report, null);
    assert.equal(d1Rows(stateDir, `SELECT COUNT(*) AS count FROM student_capability_evidence WHERE submission_id = '${unreadableId}'`)[0].count, 0);
    const wrongTwoAfterReturn = await jsonRequest(base, "/api/student/wrong-questions", { cookie: studentTwoCookie });
    assert.equal(wrongTwoAfterReturn.payload.entries.length, 2);
    assert.equal((await jsonRequest(base, `/api/student/capability-profile?assignmentId=${unreadableAssignment.assignmentId}`, { cookie: studentTwoCookie })).response.status, 404);
    const blockingDraft = await jsonRequest(base, "/api/student/submissions", { cookie: studentTwoCookie, method: "POST", body: { assignmentId: unreadableAssignment.assignmentId } });
    assert.equal(blockingDraft.payload.submission.version, 2);
    const blockingId = blockingDraft.payload.submission.id;
    await uploadSubmissionPage(base, studentTwoCookie, blockingId, bytes, "严重模糊", { score: .2, warnings: ["照片严重模糊"], blocking: true });
    const blockingSubmit = await jsonRequest(base, `/api/student/submissions/${blockingId}`, { cookie: studentTwoCookie, method: "PUT", body: { action: "submit" } });
    assert.equal(blockingSubmit.payload.submission.status, "returned");
    assert.match(blockingSubmit.payload.submission.failureReason, /第 1 页照片质量不足.*严重模糊/);
    assert.equal(d1Rows(stateDir, `SELECT COUNT(*) AS count FROM grading_items WHERE submission_id = '${blockingId}'`)[0].count, 0);

    const failing = await prepareAssignment(base, teacherOne, [studentOneId], bytes, "队列失败恢复", [{
      questionNumber: "F", pageNumber: 1, type: "单选题", stem: "MOCK_ALWAYS_FAIL", options: ["A", "B"], answer: "A", analysis: "A", confidence: 1, warnings: [], sortOrder: 0,
    }]);
    const failedDraft = await jsonRequest(base, "/api/student/submissions", { cookie: studentOneCookie, method: "POST", body: { assignmentId: failing.assignmentId } });
    const failedId = failedDraft.payload.submission.id; await uploadSubmissionPage(base, studentOneCookie, failedId, bytes, "失败重试");
    await jsonRequest(base, `/api/student/submissions/${failedId}`, { cookie: studentOneCookie, method: "PUT", body: { action: "submit" } });
    const failed = await waitForSubmission(base, teacherOne, failedId, ["failed"], worker, 30_000);
    assert.match(failed.failureReason, /上游服务失败/); assert.doesNotMatch(failed.failureReason, /mock grading unavailable/); assert.ok(mock.state.failureCalls >= 4);
    const diagnosticRows = d1Rows(stateDir, `SELECT role,model_id,MAX(upper_attempt) AS attempts FROM ai_provider_diagnostics WHERE provider_id='${gradingProvider.id}' AND kind='task' AND code='UPSTREAM_FAILED'`);
    assert.equal(diagnosticRows[0].role, "grading"); assert.equal(diagnosticRows[0].model_id, "mock-homework"); assert.equal(diagnosticRows[0].attempts, 4);
    const studentFailure = await jsonRequest(base, `/api/student/submissions/${failedId}`, { cookie: studentOneCookie });
    assert.equal(studentFailure.payload.submission.failureReason, "自动批改暂时失败，老师会处理或重新尝试");
    mock.state.failEnabled = false;
    assert.equal((await jsonRequest(base, `/api/student/submissions/${failedId}`, { cookie: studentOneCookie, method: "PUT", body: { action: "retry" } })).response.status, 200);
    assert.equal((await waitForSubmission(base, teacherOne, failedId, ["published"], worker)).status, "published");
    assert.equal((await jsonRequest(base, `/api/assignments/${failing.assignmentId}`, { cookie: teacherOne, method: "DELETE", body: {} })).response.status, 200);
    const cleanupDeadline = Date.now() + 10_000; let cleanupStatus = "";
    while (Date.now() < cleanupDeadline) {
      cleanupStatus = String(d1Rows(stateDir, "SELECT status FROM homework_asset_cleanup_jobs ORDER BY created_at DESC LIMIT 1")[0]?.status ?? "");
      if (cleanupStatus === "completed") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    assert.equal(cleanupStatus, "completed");
    assert.equal((await fetch(`${base}${failing.questionAsset.url}`, { headers: { Cookie: teacherOne } })).status, 404);
  } catch (error) {
    console.error(worker.output());
    throw error;
  } finally {
    await stopWorker(worker); mock.server.closeAllConnections(); await new Promise((resolveClose) => mock.server.close(resolveClose));
  }
});
