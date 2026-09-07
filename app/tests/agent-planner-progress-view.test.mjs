import test from "node:test";
import assert from "node:assert/strict";
import {
  SIMPLE_DESIGNER_STAGES,
  getDesignerCurrentAction,
  getDesignerHighlights,
  getDesignerSummary,
  getDesignerTripTitle,
} from "../src/lib/agentProgressView.js";

test("Simple Pipeline 六阶段使用定制师可理解的业务语言", () => {
  assert.deepEqual(SIMPLE_DESIGNER_STAGES.map((stage) => stage.label), [
    "读取并整理行程资料",
    "梳理整程节奏与亮点",
    "完善客户版行程文案",
    "匹配酒店、体验与交通图片",
    "检查费用和重要信息",
    "生成并检查行程长图",
  ]);
});

test("默认实时状态把内部图片路径转换为客户行程动作", () => {
  const snapshot = {
    project: { status: "running" },
    activeJob: {
      currentAction: "Image Skill 正在判断候选图片 · image:transport:imported-transport-2:primary:exact",
      stages: [{ id: "image_skill", status: "running" }],
    },
  };
  const label = getDesignerCurrentAction(snapshot);
  assert.equal(label, "正在为本次游猎与接驳交通匹配合适图片");
  assert.doesNotMatch(label, /Image Skill|image:|transport-2|primary|exact/);
});

test("每日文案动作显示具体天数而不泄漏任务标识", () => {
  const snapshot = {
    project: { status: "running" },
    activeJob: {
      currentAction: "Copy Skill running copy:day:4",
      stages: [{ id: "copy_skill", status: "running" }],
    },
  };
  assert.equal(getDesignerCurrentAction(snapshot), "正在完善第 4 天的客户版行程介绍");
});

test("定制摘要从确认事实提取项目名和四个体验重点", () => {
  const snapshot = {
    project: {
      status: "running",
      factBasis: {
        destination: "肯尼亚",
        dayCount: 8,
        sourcePosterHighlights: [
          "顶奢连住 | 国际品牌+私保营地",
          "C位蹲守 | 独赏天国之渡",
          "私人保护区游猎 | 徒步夜巡双绝",
          "草原飞机接驳 | 拒绝长途拉车",
        ],
      },
    },
    result: { data: { title: "肯尼亚8日顶奢游猎" } },
  };
  assert.equal(getDesignerTripTitle(snapshot), "肯尼亚8日顶奢游猎");
  assert.deepEqual(getDesignerHighlights(snapshot), ["顶奢连住", "C位蹲守", "私人保护区游猎", "草原飞机接驳"]);
  assert.match(getDesignerSummary(snapshot), /日期、酒店、路线和费用/);
});

test("可编辑草稿状态明确说明问题可在编辑页继续处理", () => {
  const summary = getDesignerSummary({ project: { status: "partial" } });
  const action = getDesignerCurrentAction({ project: { status: "partial" } });
  assert.match(summary, /可编辑草稿/);
  assert.match(summary, /编辑页继续补充/);
  assert.match(action, /编辑页继续处理/);
});
