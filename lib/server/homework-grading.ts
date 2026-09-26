import { env } from "cloudflare:workers";
import { buildHomeworkGradingPrompt, buildSubmissionReportPrompt, homeworkGradingSchema, normalizeHomeworkGrading, normalizeHomeworkReport, submissionReportSchema } from "../homework-grading-contract";
import { CAPABILITY_FRAMEWORK_VERSION } from "../homework-capability-framework.mjs";
import { buildFallbackSubmissionReport } from "../homework-report.mjs";
import { finalizeHomeworkVerdict } from "../homework-grading-rules.mjs";
import type { GradingVerdict, QuestionType } from "../types";
import { homeworkAssetDataUrl, processHomeworkAssetCleanup, recordHomeworkAssetCleanupFailure } from "./homework-assets";
import { homeworkDb } from "./homework";
import { callHomeworkModel, parseHomeworkModelText } from "./homework-model";

type AppEnv = {
  DB: D1Database;
  GRADING_AUTO_CONFIDENCE?: string;
  HOMEWORK_QUEUE_RETRY_BASE_SECONDS?: string;
  HOMEWORK_QUEUE_MAX_ATTEMPTS?: string;
  HOMEWORK_AUTO_PUBLISH_ENABLED?: string;
};
function appEnv(): AppEnv { return env as unknown as AppEnv; }
function autoPublishEnabled() { return String(appEnv().HOMEWORK_AUTO_PUBLISH_ENABLED ?? process.env.HOMEWORK_AUTO_PUBLISH_ENABLED ?? "false").toLowerCase() === "true"; }
function retryBaseSeconds() { return Math.max(1, Math.min(300, Number(appEnv().HOMEWORK_QUEUE_RETRY_BASE_SECONDS ?? process.env.HOMEWORK_QUEUE_RETRY_BASE_SECONDS) || 30)); }
function maxQueueAttempts() { return Math.max(1, Math.min(20, Number(appEnv().HOMEWORK_QUEUE_MAX_ATTEMPTS ?? process.env.HOMEWORK_QUEUE_MAX_ATTEMPTS) || 4)); }

type QuestionRow = {
  id: string; question_number: string; page_number: number; type: QuestionType; stem: string; answer: string; analysis: string;
};
type SubmissionRow = { id: string; assignment_id: string; status: string };

async function upsertResult(input: {
  submissionId: string; question: QuestionRow; pageId: string | null; verdict: GradingVerdict; studentAnswer: string;
  feedback: string; errorType: string; stepAnalysis?: string[]; evidenceSummary?: string; capabilityKeys?: string[];
  confidence: number; bbox: unknown; requiresReview: boolean;
}) {
  const existing = await homeworkDb().prepare("SELECT id, created_at FROM grading_items WHERE submission_id = ? AND assignment_question_id = ?")
    .bind(input.submissionId, input.question.id).first<{ id: string; created_at: number }>();
  const id = existing?.id ?? crypto.randomUUID(); const now = Date.now();
  if (existing) {
    await homeworkDb().prepare(`UPDATE grading_items SET page_id = ?, verdict = ?, student_answer = ?, feedback = ?, error_type = ?,
      step_analysis_json = ?, evidence_summary = ?, capability_keys_json = ?, confidence = ?, bbox_json = ?, requires_review = ?,
      reviewed_by = NULL, reviewed_at = NULL, wrong_book_applied_at = NULL, corrected_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(input.pageId, input.verdict, input.studentAnswer, input.feedback, input.errorType, JSON.stringify(input.stepAnalysis ?? []),
        input.evidenceSummary ?? "", JSON.stringify(input.capabilityKeys ?? []), input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null, input.requiresReview ? 1 : 0, now, id).run();
  } else {
    await homeworkDb().prepare(`INSERT INTO grading_items
      (id, submission_id, assignment_question_id, page_id, verdict, student_answer, feedback, error_type, step_analysis_json,
       evidence_summary, capability_keys_json, confidence, bbox_json, requires_review, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.submissionId, input.question.id, input.pageId, input.verdict, input.studentAnswer, input.feedback, input.errorType,
        JSON.stringify(input.stepAnalysis ?? []), input.evidenceSummary ?? "", JSON.stringify(input.capabilityKeys ?? []), input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null, input.requiresReview ? 1 : 0, now, now).run();
  }
}

async function processingSubmission(submissionId: string) {
  return homeworkDb().prepare("SELECT id, assignment_id, status FROM homework_submissions WHERE id = ?")
    .bind(submissionId).first<SubmissionRow>();
}

export async function generateSubmissionReport(submissionId: string) {
  const owner = await homeworkDb().prepare(`SELECT homework_assignments.owner_user_id FROM homework_submissions
    JOIN homework_assignments ON homework_assignments.id = homework_submissions.assignment_id WHERE homework_submissions.id = ?`)
    .bind(submissionId).first<{ owner_user_id: string }>();
  if (!owner) throw new Error("提交记录不存在");
  const { readTeacherSubmission } = await import("./homework");
  const submission = await readTeacherSubmission(submissionId, { id: owner.owner_user_id, email: "", role: "member" });
  const fallback = buildFallbackSubmissionReport(submission.gradingItems);
  let report = fallback;
  try {
    const result = await callHomeworkModel({ images: [], prompt: buildSubmissionReportPrompt(submission.gradingItems),
      schema: submissionReportSchema, schemaName: "homework_submission_report" });
    if (result.text) report = normalizeHomeworkReport(parseHomeworkModelText(result.text));
  } catch { /* Deterministic fallback keeps the automatic pipeline available. */ }
  const { saveSubmissionReport } = await import("./homework-capabilities");
  await saveSubmissionReport(submissionId, owner.owner_user_id, report, CAPABILITY_FRAMEWORK_VERSION);
  return report;
}

async function finalizeSubmissionIfComplete(submission: SubmissionRow) {
  const counts = await homeworkDb().prepare(`SELECT
      (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id = ?) AS question_count,
      (SELECT COUNT(*) FROM grading_items WHERE submission_id = ?) AS result_count,
      (SELECT COUNT(*) FROM grading_items WHERE submission_id = ? AND verdict = 'unreadable') AS unreadable_count`)
    .bind(submission.assignment_id, submission.id, submission.id).first<{ question_count: number; result_count: number; unreadable_count: number }>();
  if (!counts || Number(counts.result_count) < Number(counts.question_count)) return false;
  const now = Date.now();
  if (Number(counts.unreadable_count)) {
    const reasons = await homeworkDb().prepare(`SELECT DISTINCT error_type, feedback FROM grading_items
      WHERE submission_id = ? AND verdict = 'unreadable' ORDER BY updated_at`).bind(submission.id).all<{ error_type: string; feedback: string }>();
    const reason = reasons.results.map((item) => item.feedback || item.error_type).filter(Boolean).slice(0, 3).join("；") || "答卷存在无法辨认、漏页或无法匹配的内容，请重新上传清晰完整的照片";
    await homeworkDb().prepare(`UPDATE homework_submissions SET status = 'returned', returned_at = ?, failure_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('submitted', 'processing', 'failed')`).bind(now, reason.slice(0, 500), now, submission.id).run();
    await homeworkDb().prepare("DELETE FROM submission_reports WHERE submission_id = ?").bind(submission.id).run();
    await homeworkDb().prepare("DELETE FROM student_capability_evidence WHERE submission_id = ?").bind(submission.id).run();
    return true;
  }
  const claimed = await homeworkDb().prepare(`UPDATE homework_submissions SET status = 'ready', failure_reason = '', updated_at = ?
    WHERE id = ? AND status IN ('submitted', 'processing', 'failed')`).bind(now, submission.id).run();
  if (!claimed.meta.changes) return true;
  if (autoPublishEnabled()) {
    await generateSubmissionReport(submission.id);
    const { autoPublishSubmission } = await import("./homework");
    await autoPublishSubmission(submission.id);
  }
  return true;
}

export async function processHomeworkSubmissionPage(submissionId: string, pageNumberValue: number) {
  const submission = await processingSubmission(submissionId);
  if (!submission || !["submitted", "processing", "failed"].includes(submission.status)) return;
  const pageNumber = Math.max(1, Math.min(200, Math.floor(Number(pageNumberValue) || 1)));
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'processing', failure_reason = '', updated_at = ? WHERE id = ?")
    .bind(Date.now(), submissionId).run();

  const questionsResult = await homeworkDb().prepare(`SELECT id, question_number, page_number, type, stem, answer, analysis
    FROM assignment_questions WHERE assignment_id = ? AND page_number = ? ORDER BY sort_order`)
    .bind(submission.assignment_id, pageNumber).all<QuestionRow>();
  const questions = questionsResult.results;
  if (!questions.length) { await finalizeSubmissionIfComplete(submission); return; }

  for (const question of questions) {
    if (!question.answer.trim()) await upsertResult({ submissionId, question, pageId: null, verdict: "unreadable", studentAnswer: "",
      feedback: "作业模板缺少标准答案，暂时无法可靠批改", errorType: "答案缺失", confidence: 0, bbox: null, requiresReview: false });
  }
  const gradeable = questions.filter((question) => question.answer.trim());
  if (gradeable.length) {
    const [template, studentPage] = await Promise.all([
      homeworkDb().prepare("SELECT asset_id FROM assignment_assets WHERE assignment_id = ? AND role = 'question' AND page_order = ?")
        .bind(submission.assignment_id, pageNumber - 1).first<{ asset_id: string }>(),
      homeworkDb().prepare("SELECT id, processed_asset_id FROM submission_pages WHERE submission_id = ? AND page_order = ?")
        .bind(submissionId, pageNumber - 1).first<{ id: string; processed_asset_id: string }>(),
    ]);
    if (!template || !studentPage) {
      const reason = !template ? "题目模板缺少对应页面" : "学生答卷缺少对应页面";
      const errorType = !template ? "模板缺页" : "漏页";
      for (const question of gradeable) await upsertResult({ submissionId, question, pageId: studentPage?.id ?? null, verdict: "unreadable",
        studentAnswer: "", feedback: reason, errorType, confidence: 0, bbox: null, requiresReview: false });
    } else {
      const images = await Promise.all([homeworkAssetDataUrl(template.asset_id), homeworkAssetDataUrl(studentPage.processed_asset_id)]);
      const result = await callHomeworkModel({ images, prompt: buildHomeworkGradingPrompt(pageNumber, gradeable.map((question) => ({
        questionNumber: question.question_number, type: question.type, stem: question.stem, answer: question.answer, analysis: question.analysis,
      }))), schema: homeworkGradingSchema, schemaName: "homework_page_grading" });
      if (!result.text) throw new Error(result.error || `第 ${pageNumber} 页批改失败`);
      const extracted = normalizeHomeworkGrading(parseHomeworkModelText(result.text));
      for (const question of gradeable) {
        const item = extracted.find((candidate) => candidate.question_number === question.question_number);
        if (!item) {
          await upsertResult({ submissionId, question, pageId: studentPage.id, verdict: "unreadable", studentAnswer: "",
            feedback: "未能在答卷中定位本题作答", errorType: "无法匹配", confidence: 0, bbox: null, requiresReview: false });
          continue;
        }
        const finalized = finalizeHomeworkVerdict({ type: question.type, standardAnswer: question.answer, studentAnswer: item.student_answer,
          modelVerdict: item.verdict, confidence: item.confidence, warnings: item.warnings, threshold: .5 });
        await upsertResult({ submissionId, question, pageId: studentPage.id, verdict: finalized.verdict, studentAnswer: item.student_answer,
          feedback: item.feedback, errorType: item.error_type, stepAnalysis: item.step_analysis, evidenceSummary: item.evidence_summary,
          capabilityKeys: item.capability_keys, confidence: finalized.confidence, bbox: item.bbox, requiresReview: finalized.requiresReview });
      }
    }
  }
  await finalizeSubmissionIfComplete(submission);
}

export async function processHomeworkSubmission(submissionId: string) {
  const submission = await processingSubmission(submissionId);
  if (!submission || !["submitted", "processing", "failed"].includes(submission.status)) return;
  try {
    const pages = await homeworkDb().prepare("SELECT DISTINCT page_number FROM assignment_questions WHERE assignment_id = ? ORDER BY page_number")
      .bind(submission.assignment_id).all<{ page_number: number }>();
    for (const page of pages.results) await processHomeworkSubmissionPage(submissionId, Number(page.page_number));
    await finalizeSubmissionIfComplete(submission);
  } catch (error) {
    await homeworkDb().prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "批改失败", Date.now(), submissionId).run();
    throw error;
  }
}

type QueueBody = { kind?: string; submissionId?: string; pageNumber?: number; jobId?: string };
type QueueMessage = { body: QueueBody; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void };
type QueueBatch = { messages: QueueMessage[] };

async function recordFinalQueueFailure(submissionId: string, error: unknown) {
  const reason = error instanceof Error ? error.message.slice(0, 500) : "批改失败";
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
    .bind(reason, Date.now(), submissionId).run();
}

export async function processHomeworkQueue(batch: QueueBatch) {
  for (const message of batch.messages) {
    const { kind, submissionId, jobId } = message.body;
    const cleanup = kind === "cleanup_homework_assets" && Boolean(jobId);
    const grading = Boolean(submissionId) && ["grade_submission", "grade_submission_page", "recompute_submission_report"].includes(String(kind));
    if (!cleanup && !grading) { message.ack(); continue; }
    try {
      if (cleanup) await processHomeworkAssetCleanup(jobId!);
      else if (kind === "grade_submission_page") await processHomeworkSubmissionPage(submissionId!, Number(message.body.pageNumber));
      else if (kind === "recompute_submission_report") await generateSubmissionReport(submissionId!);
      else await processHomeworkSubmission(submissionId!);
      message.ack();
    } catch (error) {
      const attempts = Math.max(1, Number(message.attempts) || 1);
      if (cleanup) await recordHomeworkAssetCleanupFailure(jobId!, error, attempts >= maxQueueAttempts());
      else if (attempts >= maxQueueAttempts()) await recordFinalQueueFailure(submissionId!, error);
      message.retry({ delaySeconds: Math.min(300, retryBaseSeconds() * 2 ** Math.max(0, attempts - 1)) });
    }
  }
}
