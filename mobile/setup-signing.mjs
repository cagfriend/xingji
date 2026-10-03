import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=path.join(root,'signing');await mkdir(dir,{recursive:true});
const configPath=path.join(dir,'private.json');
let config;
try {config=JSON.parse(await readFile(configPath,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;config={password:randomBytes(32).toString('base64url')};await writeFile(configPath,JSON.stringify(config),{flag:'wx'});}
const java=process.env.JAVA_HOME;if(!java)throw new Error('请设置 JDK 21 的 JAVA_HOME');
const key=path.join(dir,'xingji.jks');
try {await readFile(key);console.log('保留已有签名证书，后续 APK 可以覆盖更新。');}
catch(error){if(error.code!=='ENOENT')throw error;
const result=spawnSync(path.join(java,'bin/keytool.exe'),['-genkeypair','-keystore',key,'-storetype','JKS','-storepass:env','XINGJI_KEY_PASSWORD','-keypass:env','XINGJI_KEY_PASSWORD','-alias','xingji','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Xingji Local, OU=Personal, O=Xingji, C=CN'],{env:{...process.env,XINGJI_KEY_PASSWORD:config.password},stdio:['ignore','pipe','pipe']});
if(result.status!==0)throw new Error('签名证书创建失败');console.log('已创建个人 APK 签名证书；请保留 signing 文件夹用于未来更新。');}
