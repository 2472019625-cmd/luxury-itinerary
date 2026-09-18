# 图片搜索链路工作区交接

更新时间：2026-09-18

## 1. 唯一工作目录与 Git 边界

- 当前图片链路工作目录：`D:\奢游\行程单报价单\奢游行程单美化-图片链路`
- 当前分支：`codex/image-search-chain-v1`
- 当前稳定提交：`1e8dff7 feat: stabilize image knowledge search chain`
- 基线提交：`66ab1d1 feat: refine Step4 editing and targeted recovery`
- 前端产品工作区：`D:\奢游\行程单报价单\奢游行程单美化-智能体试验区`，分支 `codex/simple-pipeline-frontend-v1`
- 旧验证副本 `D:\奢游\行程单报价单\奢游行程单美化-Planner输出精简验证-20260917` 的 `.git` 身份不安全，不得在该目录执行 Git 写操作。

Query、Scope、知识库、图片审核、Web 图片搜索及图片链路测试只在当前图片工作区继续开发。普通前端界面与产品交互修改回到前端产品工作区处理。不得在两个工作区复制整文件覆盖彼此的修改。

## 2. 接手时必须先做的只读检查

```powershell
git status
git branch --show-current
git log --oneline -5
git remote -v
```

预期分支为 `codex/image-search-chain-v1`，预期至少包含提交 `1e8dff7`。在确认前不得执行 `pull`、`merge`、`rebase`、`reset`、`checkout` 或切换分支。

## 3. 必须阅读的文件

按顺序完整读取：

1. `AGENTS.md`
2. `rules/00-当前规则索引.md`
3. `rules/01-产品流程与完成状态.md`
4. `rules/04-图片搜索与使用规范.md`
5. `rules/06-技术运行与文件保存.md`
6. `docs/产品设计/行程成品生成智能体产品蓝图.md`
7. 本文件

实现与测试重点：

- `app/server/simple-image-skill.mjs`
- `app/server/knowledge-image-search.mjs`
- `app/server/knowledge-scope-resolver.mjs`
- `app/server/image-candidate-eligibility.mjs`
- `app/server/image-search.mjs`
- `app/server/image-download.mjs`
- `app/server/image-audit.mjs`
- `app/server/agent-planner-app.mjs`
- `app/tests/simple-image-skill.test.mjs`
- `app/tests/knowledge-scope-resolver.test.mjs`
- `app/tests/image-security.test.mjs`

## 4. 已完成状态

提交 `1e8dff7` 已整理并提交图片知识库、Query、Scope、候选审核、下载安全、Planner 图片位适配、Step4 人工图片处理及对应规则和测试。

当前已具备：

- `knowledge_only`、`knowledge_first`、`web_only` 三种图片来源模式。
- Knowledge Query Plan 与 Scope Plan。
- 知识库 preview-first、按需下载 matched file、来源路径判断和精确下载 origin 白名单。
- Query 顺序执行、候选池分批审核、exact/高质量 eligible 早停。
- 知识库候选与 Web 候选共用同一套下载、视觉审核、去重和采用门禁。
- `knowledge_first` 下知识库未产生最终合格图时进入现有 Web 搜索层；知识库已产生合格图时停止，不重复访问 Web。
- `knowledge_only` 下不会调用公网搜索。
- 单个图片位失败不会中断其他图片位、Copy 或 Step4 草稿。

最近验证：

- `node --test tests/*.test.mjs`：540/540 通过。
- `npm run build`：通过。
- 测试夹具已同步当前视觉审核契约，显式返回核心主体、核心动作和可见地点/身份冲突判断。

## 5. GitHub 状态

提交 `1e8dff7` 已存在于本机图片分支，但截至本文件创建前尚未成功推送到 GitHub。三次 `git push -u origin codex/image-search-chain-v1` 均在认证前失败：本机无法建立到 `github.com:443` 的 TCP 连接，错误分别为 `Connection was reset` 和 `Could not connect to server`。

浏览器或 Codex 已登录 GitHub 不等于 Git CLI 已完成传输；不过本次失败发生在 HTTPS 连接阶段，尚未进入 GitHub 身份认证，因此当前主因不是账号密码或仓库权限。

网络恢复后执行：

```powershell
git push -u origin codex/image-search-chain-v1
```

若在另一台电脑继续，必须先确认远端已经包含 `1e8dff7` 及本交接文档对应提交；否则只能在当前电脑的本地 worktree 继续。

## 6. 下一任务：知识库失败后接入真实联网图片搜索

下一步不是重新开发 fallback 调度。`simple-image-skill.mjs` 已实现 `knowledge_first`：知识库成功采用则停止；知识库没有最终合格图则进入现有 Web source layer。

下一任务应聚焦真实接线与回归：

1. 确认实际运行入口使用 `knowledge_first`，当前程序默认仍为 `web_only`。
2. 接通并验证真实联网图片搜索服务，不创建第二套 Query、Scope、候选或审核状态。
3. 验证知识库 `no_match`、`empty`、`unavailable`、超时、请求失败和候选全部不合格时的 Web 进入条件。
4. 验证知识库已有合格图时 Web 调用数为零。
5. Web 搜索继续使用 Planner 已确定并经 Query Builder 清洗的 Query，不得重新决定画面。
6. Web 候选继续经过来源页提取、下载安全、技术校验、视觉审核、全局去重和本地保存，不能因 fallback 降低门槛。
7. 保留知识库候选和失败证据，并在运行记录中明确记录 `knowledge -> web` 的原因。
8. 使用全新测试项目做真实回归；不得使用旧项目、缓存结果或历史截图证明当前实现。

实施前先输出：当前真实调用链、现有 Web 搜索适配器、缺口、最小修改文件、需要的外部服务/权限和测试方案。不要修改模型、API Key、接口地址、计费配置或任何 `.env` 文件，除非用户明确授权。

## 7. 不得恢复或新增的机制

- 不新增第二套图片状态、第二套项目数据或第二套 Query/Scope。
- 不恢复独立图片审核页。
- 不增加 Planner 调用或自动第二轮业务补搜。
- 不因知识库失败而放宽错误地点、错误主体、错误动作、错误酒店、AI 图、水印、低清或下载安全门禁。
- 不把 preview、远程 URL、占位图或未终审候选直接写入正式客户成品。
- 不修改本次联网图片搜索范围之外的前端、Parser、Copy、Renderer、项目 schema 或登录体系。

## 8. 新 Codex 账号接续提示

```text
只在 D:\奢游\行程单报价单\奢游行程单美化-图片链路 工作。
先完整读取 AGENTS.md、rules/00、rules/01、rules/04、rules/06、产品蓝图和 audit/HANDOFF-image-search-chain-20260918.md，再执行只读 Git 检查。
当前分支必须是 codex/image-search-chain-v1，当前稳定提交至少包含 1e8dff7。
下一步是在已有 knowledge_first 调度基础上接通并真实验证知识库无合格图后的 Web 图片搜索，不要重新实现 Query、Scope、Planner、审核或图片状态体系。
实施前先报告真实调用链、已有能力、缺口、最小修改文件和测试方案。
```
