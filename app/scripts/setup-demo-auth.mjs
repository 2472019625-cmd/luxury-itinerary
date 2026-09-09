import {randomBytes,scryptSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const file=process.argv[2];
if(!file)throw Error('Usage: node setup-demo-auth.mjs /var/lib/sheyou-demo/auth.json');
const login='sheyou-demo', password=randomBytes(24).toString('base64url'), salt=randomBytes(16).toString('hex');
writeFileSync(file,JSON.stringify({login,salt,hash:scryptSync(password,salt,64).toString('hex')}),{flag:'wx',mode:0o600});
console.log('账号：'+login+'\n密码：'+password+'\n请保存在密码管理器中，不要截图或发送给助手。');
