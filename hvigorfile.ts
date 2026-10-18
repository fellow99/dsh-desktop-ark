import { appTasks, OhosAppContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { getNode } from '@ohos/hvigor';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 签名材料注入（与 ohos-node-bridge / pi-desktop-ark 同一套约定，仓库内不落任何密钥）。
 *
 * 优先级：
 *   ① 环境变量 CERTPATH / STORE_FILE / PROFILE / KEY_ALIAS / KEY_PASSWORD / STORE_PASSWORD / SIGN_ALG
 *   ② signing.<SIGN_MODE>.local.json（本地、gitignored）
 * 两者都没有 ⇒ 产出未签名包（不报错）；要装机时在 DevEco 为
 * `org.fellow99.dsh.DshDesktopArk` 生成调试签名，或填写 ②。
 */
const PROJECT_ROOT = __dirname;

type SignMode = 'debug' | 'release';

interface SigningMaterial {
  certpath: string;
  storeFile: string;
  profile: string;
  keyAlias: string;
  keyPassword: string;
  storePassword: string;
  signAlg: string;
}

const REQUIRED_FIELDS = ['certpath', 'storeFile', 'keyPassword', 'storePassword'] as const;

function fail(message: string): never {
  console.error(`[hvigorfile] 签名配置错误：${message}`);
  throw new Error(message);
}

function resolveMaterialPaths(m: SigningMaterial): SigningMaterial {
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p));
  return { ...m, certpath: abs(m.certpath), storeFile: abs(m.storeFile), profile: m.profile === '' ? '' : abs(m.profile) };
}

function resolveSignMode(): SignMode {
  const raw = (process.env.SIGN_MODE || '').trim();
  if (raw === '') return 'debug';
  if (raw === 'debug' || raw === 'release') return raw;
  return fail(`非法的 SIGN_MODE="${raw}"：只允许 "debug" 或 "release"。`);
}

function loadMaterialFile(file: string): SigningMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fail(`无法解析签名配置 ${file}：${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`签名配置 ${file} 的顶层必须是 JSON 对象。`);
  }
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const missing = REQUIRED_FIELDS.filter((k) => str(k).trim() === '');
  if (missing.length > 0) {
    return fail(`签名配置 ${file} 缺少必填字段：${missing.join(', ')}。`);
  }
  return resolveMaterialPaths({
    certpath: str('certpath'),
    storeFile: str('storeFile'),
    profile: str('profile'),
    keyAlias: str('keyAlias') || 'debugKey',
    keyPassword: str('keyPassword'),
    storePassword: str('storePassword'),
    signAlg: str('signAlg') || 'SHA256withECDSA'
  });
}

function loadSigningConfig(mode: SignMode): SigningMaterial | null {
  const env = process.env;
  if (env.CERTPATH && env.STORE_FILE && env.STORE_PASSWORD && env.KEY_PASSWORD) {
    return resolveMaterialPaths({
      certpath: env.CERTPATH,
      storeFile: env.STORE_FILE,
      profile: env.PROFILE || '',
      keyAlias: env.KEY_ALIAS || 'debugKey',
      keyPassword: env.KEY_PASSWORD,
      storePassword: env.STORE_PASSWORD,
      signAlg: env.SIGN_ALG || 'SHA256withECDSA'
    });
  }
  const file = path.join(PROJECT_ROOT, `signing.${mode}.local.json`);
  if (fs.existsSync(file)) {
    return loadMaterialFile(file);
  }
  return null;
}

getNode(__filename).afterNodeEvaluate((node) => {
  const mode = resolveSignMode();
  const appContext = node.getContext(OhosPluginId.OHOS_APP_PLUGIN) as OhosAppContext;
  const buildProfileOpt = appContext.getBuildProfileOpt();
  const material = loadSigningConfig(mode);
  const products = buildProfileOpt['app']['products'];

  if (!material) {
    // DevEco「自动生成签名」会把 signingConfigs 直接写进 build-profile.json5；
    // 只有 signingConfigs 而 product 未指向它时补上指针，否则同样产出未签名包。
    const inline = buildProfileOpt['app']['signingConfigs'];
    const inlineCount = Array.isArray(inline) ? inline.length : 0;
    if (inlineCount === 0) {
      console.warn(
        `[hvigorfile] SIGN_MODE=${mode}：既没有 signing.${mode}.local.json（与环境变量），` +
        `build-profile.json5 里也没有 signingConfigs —— 本次构建产出未签名包。`
      );
    } else {
      const first = inline[0] as Record<string, unknown>;
      const firstName = typeof first.name === 'string' ? first.name : 'default';
      if (Array.isArray(products)) {
        for (const p of products) {
          const product = p as Record<string, unknown>;
          if (product['signingConfig'] === undefined) product['signingConfig'] = firstName;
        }
      }
      appContext.setBuildProfileOpt(buildProfileOpt);
      console.log(`[hvigorfile] 使用 build-profile.json5 里的签名配置（${inlineCount} 条，product → ${firstName}）。`);
    }
    return;
  }

  buildProfileOpt['app']['signingConfigs'] = [
    { name: 'default', type: 'HarmonyOS', material }
  ];
  if (Array.isArray(products)) {
    for (const p of products) {
      (p as Record<string, unknown>)['signingConfig'] = 'default';
    }
  }
  appContext.setBuildProfileOpt(buildProfileOpt);
});

export default {
  system: appTasks,
  plugins: []
};
