import { studioUpstreamFailure, studioCaughtFailure } from "../../../../lib/answer-studio-concurrency";
import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { callRecognitionModel, parseRecognitionModelText } from "../../../../lib/server/recognition-model";
import { normalizeStudioRecords, studioRecognitionPrompt, studioRecognitionSchema } from "../../../../lib/answer-studio-contract";
export async function POST(request:Request) {
  try {
    requireSameOrigin(request); await requireUser(request);
    const body=await request.json() as {image:string;role:"question"|"answer";lesson:string;pageId:string;context?:string;answerOnly?:boolean;concurrent?:boolean};
    if (!body || !["question","answer"].includes(body.role) || typeof body.lesson!=="string" || body.lesson.length>200 || typeof body.pageId!=="string" || !/^data:image\/(png|jpeg);base64,/.test(body.image) || body.image.length>25_000_000) return Response.json({error:"页面或讲次无效"},{status:400});
    if(body.concurrent!==undefined&&typeof body.concurrent!=="boolean" || body.context!==undefined&&typeof body.context!=="string")return Response.json({error:"Invalid transcription context",retryable:false},{status:400});
    const extra=body.answerOnly&&body.role==='answer'?"\n本次只有答案材料，没有干净原题。按材料原顺序识别全部答案条目；没有题干时stem留空，禁止猜测题目或自行解题。只有结果时照录结果并在warnings中说明缺少步骤。利用上页条目判断跨页续解，continuation只在明确续题时为true。解答图和模糊字必须标记待人工确认。":"";
const parallelContext=body.concurrent?"\n并发识别补充规则：所附上下文来自本批之前已确认页面，不保证是紧邻前一页。优先使用本页可见讲次、栏目与题号；页首明显是续解但归属不明时，仍逐字保留，continuation=true，并在warnings写明‘并发续页归属待确认’，不得套用不相关的旧题号。缺少栏目或讲次且无法从本页确定时也写入warnings，供随后顺序复核。":"";
    const modelStart=performance.now();
    const result=await callRecognitionModel({signal:request.signal,image:body.image,prompt:studioRecognitionPrompt(body.role,body.lesson,body.context||"")+extra+parallelContext,schema:studioRecognitionSchema,schemaName:"teacher_answer_transcription"});
    if (result.status>=400 || !result.text) return studioUpstreamFailure(result,"识别服务未返回结果，请重试当前页");
    const modelMs=performance.now()-modelStart,normalizeStart=performance.now();
    const records=normalizeStudioRecords(parseRecognitionModelText(result.text),body.pageId,body.lesson);
    return Response.json({records},{headers:{"Server-Timing":`model;dur=${modelMs.toFixed(1)}, normalize;dur=${(performance.now()-normalizeStart).toFixed(1)}`}});
  } catch(e) { if (e instanceof Response) return e; return studioCaughtFailure(e,"识别失败"); }
}
