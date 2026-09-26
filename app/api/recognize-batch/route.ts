import { batchRecognitionSchema, buildBatchRecognitionPrompt, normalizeBatchRecognitionResult, type RecognitionCategory } from "../../../lib/recognition-contract";
import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { callRecognitionModel, parseRecognitionModelText } from "../../../lib/server/recognition-model";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    const body = await request.json() as { image?: string; textHint?: string; pageNumber?: number; fileName?: string; categories?: RecognitionCategory[] };
    if (!body.image?.startsWith("data:image/")) return Response.json({ error: "没有收到有效页面图片" }, { status: 400 });
    if (body.image.length > 20_000_000) return Response.json({ error: "页面图片过大" }, { status: 413 });
    const categories = body.categories ?? [];
    const result = await callRecognitionModel({ signal: request.signal, image: body.image, prompt: buildBatchRecognitionPrompt({ categories, fileName: body.fileName, pageNumber: body.pageNumber, textHint: body.textHint }), schema: batchRecognitionSchema, schemaName: "batch_question_extraction" });
    if (!result.text) return Response.json({ error: result.error || "中转站没有返回可用结果" }, { status: result.status >= 400 ? result.status : 502 });
    try { return Response.json({ result: normalizeBatchRecognitionResult(parseRecognitionModelText(result.text), categories) }); }
    catch { return Response.json({ error: "识别结果格式不正确，请换用支持 JSON Schema 的模型" }, { status: 502 }); }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "批量识别失败" }, { status: 500 });
  }
}
