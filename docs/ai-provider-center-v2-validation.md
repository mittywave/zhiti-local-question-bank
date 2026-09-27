# AI Provider Center V2 — 验证与升级说明

## 范围与版本

目标仓库：`mittywave/zhiti-local-question-bank`。开发分支：`feature/ai-provider-center-v2`，PR #3。主分支核对基线为 `8ab8dba8e48524a206d245968772b42728b42b96`；本轮接续实现基线为 `e6fc4b381ead6d8fa6a10584030c4f4dd8578b85`。完整需求见同目录 `ai-provider-center-v2-taskbook.md`。

本分支不自动合并 main，不部署生产，不执行远程数据库迁移。以下区分代码覆盖、实测结果和未验证边界，不以 fixture 成功代替真实服务验收。

## 本轮补齐

- DeepSeek Chat 与 Responses 分别构造请求；不再复制 OpenAI body 后删字段。Chat 使用 JSON mode 与独立 thinking 参数，Responses 使用 text.format/reasoning。只解析最终正文。
- 模型目录新增模型级思考档位；保存于既有模型 metadata JSON，无须新建或改写已执行迁移。只使用当前模型的目录能力，支持恢复上游默认或兼容默认；刷新目录保留模型覆盖项，修改覆盖项使旧探测记录失效。
- Sub2API 明确区分 OpenAI、Antigravity Gemini、Antigravity Claude。切换模式不改写用户 Base URL；建议地址独立确认应用，保留部署/租户前缀。Claude 不默认断言目录存在，手动模型仍可使用。改变凭据范围需要重新输入 Key。
- 管理错误附带不可回放的 diagnosticId；服务端仅记录编号、稳定错误码、状态，不记录原始异常、正文、Header 或 Key。429 保留 Retry-After。
- 图片探测改为四张独立合成色块。正确顺序只留在服务端验证函数，不放入提示或 schema。未通过后置校验不会记为成功，也不会触发备用。它仍不是题库视觉质量认证。
- OpenAI 兼容 Chat 仅在明确不支持 max_completion_tokens 时尝试有界 max_tokens 兼容，保留同样输出上限和总预算。非 JSON 的 429 保持限流分类，不轮换提供方。
- 模型编辑中不能再次点击新增/编辑覆盖未保存表单。保留取消、dirty、焦点和键盘确认操作。
- 作业 E2E 的数据库观察改为实际本地 D1 SQLite 的只读查询，避免每次断言/清理轮询额外启动 Wrangler/workerd。保留全部作业、队列、权限、清理和 404 断言，不扩大超时或删除断言。
- Word 从真实网页下载后，使用独立 LibreOffice profile 转 PDF，再渲染每页 PNG。验证文件、页数与可提取正文，保留 PDF、PNG、文本与哈希报告供逐页检查。

## 验证结果与证据

本地执行记录（2026-09-27 UTC）：

| 项目 | 结果 | 边界 |
|---|---|---|
| 依赖 | GitHub 隔离 workspace 的 npm ci 成功，锁文件未改 | 本地使用该锁文件对应依赖归档；未伪称本机在线 npm ci |
| npm run lint | 通过，0 errors / 17 warnings | 既有 warning 未隐藏 |
| npm run test:studio | 140/140 通过 | 不替代实际应用浏览器 |
| V2 专项测试 | 54/54 通过 | SQLite + 合成上游，非真实 AI |
| npm run benchmark:studio | 通过 | 请求数与并发断言保留 |
| npm test（本轮首轮） | 最终通过 | 337 项普通回归通过；作业 E2E 首次通过；scoped-library E2E 首次 GET /api/students 超时，既有单次重试通过，不能称首次全绿 |
| tsc --noEmit | 未通过 | 基线和修改后均 237 个诊断，按文件/错误内容去掉行号比较，新增 0 / 消失 0；包含既有 Cloudflare 类型声明问题 |
| 本机 Chromium | 未通过环境导航 | ERR_BLOCKED_BY_ADMINISTRATOR；未关闭浏览器安全策略，改用仓库 Actions 的实际浏览器验收 |

最终 CI、三次无整轮重试的作业稳定性测试、Chromium/WebKit 与 Word 逐页视觉结果，应以本次提交关联的 Actions 和最终补充记录为准。尚未取得的结果不能由本表推断为成功。

常规持续验证：

- `.github/workflows/math-recognition-regression.yml`：lint、Studio、benchmark、全量回归；实际 Worker/D1 + Chromium/WebKit；Word 每页渲染；上传 `studio-browser-results` 和 regression 日志。
- `.github/workflows/ai-provider-v2-validation.yml`：全量入口、原始源码归档、保留失败的首轮日志，另外独立运行作业 E2E 三次，每轮失败即停止，不能用后一轮掩盖前一轮。
- `scripts/verify-ai-settings-browser.py`：真实 layout、全局 CSS、主题初始化、390/768/1440 宽度与深浅主题、按钮对比度、CRUD/迁移/路由/能力/取消/冲突/真实 Word 下载。外部 AI 服务为本机合成 HTTP fixture；本站 API、身份验证、D1 与 Worker 不 mock。
- `scripts/render-word-evidence.py`：实际 DOCX 的每页 PNG、`render-report.json` 与文件哈希。渲染成功不是人工视觉签字，更不代表 Word/WPS 实机兼容认证。

## 接入策略及真实实例边界

| 接入 | 代码/契约验证 | 真实实例 |
|---|---|---|
| OpenAI 兼容 | Responses、Chat；固定或同范围 auto；有界参数协商、输入图片、本地结构校验 | 未验证任意第三方中转站 |
| DeepSeek | 动态 /models 元数据；根地址不强加 /v1；Chat JSON mode、Responses text.format；模型级能力/档位；reasoning 与正文分离 | 未使用真实 Key，未执行计费 smoke |
| Sub2API OpenAI | 部署前缀内 Responses/Chat，模型别名原样保留 | 未验证用户部署版本/分组 |
| Sub2API Gemini | 明确 /antigravity/v1beta 等用户前缀；generateContent、inlineData、schema 转换 | 未验证用户实例 |
| Sub2API Claude | 明确 /antigravity/v1 等用户前缀；Messages 图片块及正文；目录缺失可手动配置 | 未验证用户实例 |

协议文档复核入口（2026-09-27）：DeepSeek `https://api-docs.deepseek.com/api/create-response/`、`https://api-docs.deepseek.com/api/list-models/`、`https://api-docs.deepseek.com/guides/thinking_mode/`。Sub2API 路径仍以用户实例对外文档为准，预设不是连通性保证。

真实 smoke 只在管理员本地私密填写 Key 后，通过设置页明确勾选可能计费并点击测试；不要在聊天、Issue、PR、日志或截图公开 Key。需要记录版本/镜像标签、对外 Base URL、模型 ID、分组和脱敏结果。不需要 Google/Anthropic 的账号密码或 OAuth refresh token。目录通过、简单 JSON 通过、实际题目质量验收是三件事。

## 数据与并发

仍只新增 `0015_ai_provider_center_v2.sql` 相对原任务书基线的表结构；没有改写 0014，没有 DROP 旧表。本轮模型参数复用 metadata JSON，没有额外 SQL 迁移。

首次读取 V2 在 D1 batch 中复制旧 global 到 legacy-global，保留原密文字节及 v1 解密；原四角色经旧选择规则解析后写入。新 Key 是绑定 providerId 的 v2 AES-GCM。完成标记防止重复迁移和删除后复活。只有 V2 可写，旧写接口返回 409。

Provider revision、全局 configuration revision、带 CHECK 的 write guard 和数据库引用限制共同保护并发。目录与探测有配置版本检查；模型级参数有独立配置指纹，旧诊断变更后失效。删除仍被主/备/默认引用的连接返回 409；停用须确认，不自动换到其他提供方。

未知能力的历史模型仅为保持原绑定允许旧契约继续；新路由依实际图片输入校验。人工能力标注只代表管理员声明，不代表测试通过。

## 本地更新与验收

先运行 `git status --short`。存在未提交修改时先自行保存；不要执行 reset --hard 或 force checkout。工作区干净后：

```bash
 git fetch origin
 git switch feature/ai-provider-center-v2
 git pull --ff-only
 npm ci
 npm run dev
```

`npm run dev` 执行本地迁移，不操作远程 D1。建议单独克隆或使用独立工作树/本地数据库备份，避免试验影响日常题库。项目规则以 AGENTS.md 为准。

自建网关需在私密 `.env.local` 配置 `AI_PROVIDER_ALLOWED_BASES`，值为逗号分隔的可信 HTTPS 地址，尽量限定租户/部署前缀。`npm run dev` 同步这些设置到私密 `.dev.vars`。本地开发默认密钥只用于本地；保留原 `AI_PROVIDER_ENCRYPTION_KEY`，不要为了升级生成新 Secret 导致旧 Key 无法解密。

本地回归：

```bash
 npm run lint
 npm run test:studio
 npm test
 npm run benchmark:studio
 python -m pip install playwright==1.57.0
 python -m playwright install chromium webkit
 python scripts/verify-ai-settings-browser.py --out ai-settings-browser-results --browsers chromium,webkit
 python scripts/render-word-evidence.py ai-settings-browser-results/chromium/actual-page-export.docx --out ai-settings-browser-results/chromium/word-pages
 python scripts/render-word-evidence.py ai-settings-browser-results/webkit/actual-page-export.docx --out ai-settings-browser-results/webkit/word-pages
```

渲染需安装 LibreOffice、Poppler 和合适中文字体；Linux CI 安装 Noto CJK。DOCX 中的宋体/Times New Roman 字体契约仍检查，Linux 渲染时的可用字体替代不能声称等同用户 Mac 或 Word/WPS。

用户最终验收：旧连接仍可调用；分别添加三个接口模式/官方连接，刷新或手工模型；按模型设置档位；给四角色分配不同模型；检查缺图能力拒绝、换地址换 Key、未保存切换、取消和主备同意；深浅主题及手机宽度；真实样例识题、优化、重绘、批改；实际 Word 下载并逐页检查公式、表格和图。

## 生产升级与回退（均需另行授权）

先备份远程 D1 和当前发布代码，保留原加密 Secret；在独立本地数据副本演练 0015 与旧数据复制，确认旧密文可解密，再单独授权生产 schema migration 和发布。不要运行本地验证命令的 --remote 变体。本次没有执行这些生产步骤。

代码回退不等于数据恢复。旧 global 表只是升级前快照，不含 V2 后新增的 Provider、路由、模型或换 Key。回到旧代码时只能恢复该旧快照的行为；要完整回到升级前，需按备份恢复数据库与原 Secret。要保留 V2 新增设置，应先在私密受控备份中保留整套 V2 数据，再确定转换方案，不能声称保留旧表即可自动无损回退。

## 剩余边界

真实 DeepSeek/Sub2API 计费调用和 Word/WPS 实机验收未执行。SSRF 防护依赖可信目的地 allowlist 与禁重定向，不宣称字符串过滤能控制所有 DNS 解析结果；服务端配置者应仅批准可信网关，并可使用受控出站代理。流式上游不会冒充非流式成功。模型简单合成能力测试不代表复杂题库质量。上层作业队列保留独立有界恢复，不能宣称全系统 exactly-once。
