import { randomInt } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { provisionInitialAdmin } from "../server/demo-auth.mjs";

const [credentialFile, usersFile, login, name] = process.argv.slice(2);
if (!credentialFile || !usersFile || !login || !name) {
  process.stderr.write("用法：node scripts/provision-initial-admin.mjs <原账号文件> <员工账号文件> <管理账号登录名> <负责人姓名>\n");
  process.exitCode = 2;
} else {
  const handoffFile = path.resolve(`${usersFile}.initial-admin.txt`);
  if (existsSync(handoffFile)) throw new Error("初始凭据交付文件已存在，请先完成安全交付和清理");
  const password = String(randomInt(0, 1_000_000)).padStart(6, "0");
  writeFileSync(handoffFile, `登录账号：${login}\n初始PIN：${password}\n请私下交付负责人，随后删除此文件。\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    provisionInitialAdmin({ credentialFile, usersFile, login, name, password });
  } catch (error) {
    unlinkSync(handoffFile);
    throw error;
  }
  process.stdout.write(`初始管理账号已创建；凭据仅保存在：${handoffFile}\n`);
}
