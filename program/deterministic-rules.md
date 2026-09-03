# Program Deterministic Rules

来源：`docs/产品设计/simple-skill-pipeline-四类规则归一.md`  
版本：当前确认版本  
定位：按 Program 责任拆分的后续程序实现与自动测试依据；内容业务规则仍追溯到 `rules/01—06`，不构成第二套并列业务规则。

## 1. Purpose

Program Deterministic Rules 不是 Skill，也不是 Prompt，不作为模型能力调用。它们是后续程序在输入、合并、持久化、图片处理、渲染和导出过程中必须直接保证的确定性行为。

- 不把规则实现为二十多个串行 Gate。
- 能直接判断的就在正常执行过程中判断。
- 不为这些规则额外增加模型调用、Reviewer、Agent 决策或多轮审核。

## 2. Input Contract

Program 接收主输入、补充资料、用户确认、Planner 计划、Copy Skill 结果、Image Skill 结果及渲染所需数据。不同阶段只消费其职责所需的最小数据，不把内部信息泄露到客户数据。

### 输入解析与结构

- 主行程一次只接受一份受支持 Excel，不继承演示事实。
- 补充资料不能覆盖主 Excel 或用户确认事实。
- 输入必须转换为合法、完整、可验证的数据结构；JSON 或字段非法时返回明确错误。
- 多天、少天、重复、越界 DAY 和跨天事实必须明确拒绝。
- DAY 连续，日期跨度、人数、酒店晚数、夜宿、交通保证、体验状态和费用状态保持一致。
- 原始资料重要字段必须有客户展示、内部保留、重复合并或明确舍弃去向。

### 事实与状态保护

- 事实优先级为：用户确认 > 本次供应商资料与适用的已核验官方资料 > 确定性归一 > AI 表达。
- AI 不能覆盖高优先级事实；缺字段时保留原值，不得用推测补齐。
- 日期、人数、路线、酒店、晚数、餐食、交通保证、费用、履约和体验状态必须保持一致。
- 已含、自费可选、需预约、待确认和需核验等状态不得被静默改变或升级。

## 3. Customer/Internal Data Isolation

以下信息不得进入客户模型输入、客户 JSON、预览或 PNG：

- 成本、汇率、加价倍率、利润、供应商底价和公式；
- 内部备注、模型提示词、图片评分和候选内部状态；
- 内部路径、来源账本和供应商沟通信息。

客户结果必须通过明确白名单生成。

## 4. Structure and Slot Contract

- 模块顺序固定，必需模块不能缺失；可选模块无数据时隐藏并收缩。
- 注意事项使用 `{title, items[], tone?}[]`，不能拼成长字符串。
- Planner 的每个 Copy Task 必须包含稳定 `targetId`、精确 `targetPath` 和 `outputSchema`。`targetPath` 使用客户行程数据根对象下已授权文案字段的点路径，数组下标从 0 开始，不得指向确定性事实字段；`outputSchema` 必须与 `app/config/itinerary-schema.json` 中对应字段相容。
- Copy Skill 每个成功结果必须原样返回 `targetId`、`targetPath` 和符合 `outputSchema` 的 `value`。Program 必须验证任务标识、路径和结构后再按 `targetPath` 确定性写回，不得根据自然语言猜测模块或字段，也不得允许 Copy Skill 改写目标路径。
- 产品亮点由 Planner 最终确定并逐项建立任务。Program 不得允许 Copy Skill 增删、重排或重新筛选亮点；亮点任务接口不完整时保留明确的单项接口错误，不得自动重新规划。
- 图片位使用稳定 `slotId`，必需性由版本化配置确定。
- Planner 图片 slot 契约为 `slotId`、`moduleType`、`required`、按需提供的 `location/hotel/activity/subject`、`visualGoal`、`visualContext`、`copyTargetId`、`aspectRatio`、`userLocked`，以及可选的 `adjacentCopy`。
- `copyTargetId` 必须关联一个确定的 Copy Task。Copy 结果已存在时，Program 可以按该关联补充 `adjacentCopy`；Copy 结果尚不存在时，不得阻止 Image Skill 根据事实、`visualGoal` 和 `visualContext` 开始首轮搜索，从而允许 Copy Skill 与 Image Skill 并行。
- `mustHave`、`prefer`、`forbid` 不属于 Planner 输出；它们由 Image Skill 根据 slot 事实、`moduleType`、`visualGoal`、`visualContext` 和正式图片规则内部构建。Program 不得要求 Planner 生成这些字段，也不得用它们覆盖原始事实。
- 最低必需覆盖为封面 1 张、每个展示酒店 1 张主图、每个展示 DAY 1 张主图。
- 必需位不允许为空；可选位无图时移除并重排。
- 用户选择、上传、移动或清空后的内容必须记录并锁定，自动处理不得覆盖。

## 5. Image Technical Safety and Capacity

- 外部图片只允许公开 HTTP/HTTPS，禁止本机、内网和私有 IP。
- 图片必须真实下载并成功解码；格式为 JPEG、PNG 或 WebP，至少 900×500，比例 0.65—3.2，单文件不超过 14MB。
- 技术失败不能伪造缩略图、默认分数或通过状态；远程不稳定地址和搜索结果 Data URL 不直接进入成品。
- 全项目最多 48 个图片位是技术安全上限，但不得静默截断。超限时明确返回原因和超出项，由 Planner 减少可选位；必需位不得因容量被静默删除。
- 数值评分只用于候选排序；图片资格以地点、酒店身份、活动、主体、水印、破图和明显低质判断。
- 最终图片保存为本地可用资源；每个候选使用独立记录 ID，使用 SHA-256 和 dHash/pHash 辅助去重，并保存来源、slot、查询、尺寸、哈希和处理结果。

## 6. Skill Result Handling

- Copy Skill 结果按 `targetId` 独立接收并保留单项状态；成功结果按原任务 `targetPath` 和 `outputSchema` 校验 `value` 后确定性写回，不得因一个 target 失败丢弃其他成功结果。
- Image Skill 结果按 `slotId` 独立接收，状态为 `success | not_found | needs_user_action | failed`。
- `not_found` 或 `needs_user_action` 不得触发自动业务重搜。
- 空返回、JSON 异常、请求异常、下载或解码异常等技术问题由 Program 记录到对应最小责任单元；不得伪造业务成功。
- 技术问题的处理不得演变为 Reviewer、Agent 决策或业务内容/图片自动多轮重做。

## 7. Minimum Responsibility Unit Failure

默认按最小责任单元处理和隔离失败：

- DAY3 文案失败，只记录 DAY3 失败，其他 DAY 继续。
- 酒店B图片 `not_found`，只让酒店B等待处理，其他图片继续。
- 一个可选模块失败，不得让无依赖任务一起停止。

未解决的必需问题可以阻止最终 100%，但不能阻止其他仍可执行的任务先完成。

只有下列项目级错误才允许中断整条链：

- 主输入无法解析；
- 核心事实结构无法建立；
- 关键事实或费用发生无法继续的冲突；
- 项目保存系统失败；
- 其他确实导致所有后续任务无法继续的错误。

不得把最小责任单元失败重新实现为单个目标失败后整阶段重跑。

## 8. Completion, Renderer and Export

- 新智能体不设置 98% 状态。
- 必需内容、必需图片和实际 2000px 版面形成有效结果后，才能显示 100%。
- 必需图片缺失时返回用户处理；不得用空白、占位图、破图、不合格图或 AI 图伪造完成。
- 商业图片授权与生成完成分开：授权待确认可进入编辑状态，但不能正式导出。
- 标准客户交付为宽 2000px、高度自适应 PNG。
- 标题以实际单行显示和是否溢出判断，不使用 24 字硬门槛。
- 严重溢出、文字或卡片截断、破图、异常空白、下半部分缺失、必需模块/图片或固定页脚缺失必须阻止正式导出。
- 使用唯一视觉基准和批准的字体、Logo、Slogan、分隔器与页脚资产，不生成假账户、假二维码或假联系方式。

## 9. File and Runtime Safety

- 智能体开发与运行使用智能体试验区；npm、测试和构建命令从 `app/` 执行。
- 智能体不得读取固定流程的状态和数据；结果与任务状态写入受控目录。
- 文件保存失败必须明确返回，不能显示成功。
- 不修改或输出模型、API Key、接口地址、计费配置或 `.env`。
- 数据结构升级必须兼容旧项目读取或提供迁移。
- 第一批项目全部保留，不提供永久删除和回收站。

## 10. Output Contract

Program 对每个最小责任单元保存：

- 稳定标识（`targetId`、`slotId` 或模块/项目标识）；
- 当前状态与明确错误；
- 已成功产物；
- 警告、缺失输入或所需用户动作；
- 必要的技术处理和保存结果。

项目汇总状态必须由单项结果、必需问题和项目级错误确定，不能把局部失败伪装成通过，也不能用局部失败抹去其他成功结果。

## 11. Disabled Legacy Mechanisms

本节只用于迁移与实现防回归，不是新的内容业务规则。`simple-skill-pipeline` 不启用：

- `review_decision`
- finding package
- 多层 Reviewer
- Reviewer 发现问题后自动重生成
- 图片自动第二轮搜索
- 自动定向重搜
- stage budget 驱动业务流程
- 98% 完成状态
- 无视觉判断默认 pass
- 酒店图自动替代 DAY 活动图
- 单个目标失败导致整阶段重跑

不得把上述机制重新包装成串行 Gate、额外模型调用或自动审核修复闭环。
