import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const SIMPLE_PIPELINE_DEFAULT_ORIGIN = "http://127.0.0.1:4174";
export const APPROVED_PAYMENT_QR_PATH = "/assets/security/alipay-qr-original.png";
export const APPROVED_PAYMENT_QR_SHA256 = "b2dc93f6205f647bfeb19dad1c6da7d6bd5e715e327271d14b752b3805f34670";

export const APPROVED_PAYMENT = Object.freeze({
  accountTitle: "奢游国际指定收款账户",
  companyName: "卓越国际旅行社深圳东分公司",
  alipayAccount: "19928731347",
  accountName: "卓越国际旅行社有限公司深圳东分公司",
  bankAccount: "755964554910902",
  bankName: "招商银行深圳横岗支行",
  qrImage: APPROVED_PAYMENT_QR_PATH,
  notice: "请勿向任何个人账户转款",
});

export const FIXED_MODULE_NAMES = Object.freeze({
  booking: "预订流程",
  security: "资金安全提醒",
  payment: "指定收款账户/二维码板块",
  notes: "旅行准备与注意事项",
  footer: "固定页脚",
});

export function applyApprovedFixedModules(baseData = {}) {
  return {
    ...baseData,
    showBookingSection: baseData.showBookingSection !== false,
    showSecuritySection: baseData.showSecuritySection !== false,
    showPaymentSection: baseData.showPaymentSection !== false,
    payment: { ...APPROVED_PAYMENT },
  };
}

export function fixedModuleExpectations(data = {}) {
  const security = data.showSecuritySection !== false;
  return {
    booking: data.showBookingSection !== false,
    security,
    payment: security && data.showPaymentSection !== false,
    notes: true,
    footer: true,
  };
}

export function approvedPaymentAssetPath(root) {
  return path.join(root, "public", APPROVED_PAYMENT_QR_PATH.replace(/^\/+/, ""));
}

export function validateApprovedPayment(payment, { root, verifyAsset = true } = {}) {
  const missingFields = [];
  const mismatchedFields = [];
  for (const [key, expected] of Object.entries(APPROVED_PAYMENT)) {
    if (!payment?.[key]) missingFields.push(key);
    else if (payment[key] !== expected) mismatchedFields.push(key);
  }
  let assetStatus = "not_checked";
  let actualAssetHash = null;
  const assetPath = root ? approvedPaymentAssetPath(root) : null;
  if (verifyAsset) {
    if (!assetPath || !existsSync(assetPath)) assetStatus = "missing";
    else {
      actualAssetHash = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
      assetStatus = actualAssetHash === APPROVED_PAYMENT_QR_SHA256 ? "approved" : "hash_mismatch";
    }
  }
  return {
    passed: missingFields.length === 0 && mismatchedFields.length === 0 && (!verifyAsset || assetStatus === "approved"),
    missingFields,
    mismatchedFields,
    assetStatus,
    assetPath,
    actualAssetHash,
  };
}
