/**
 * 钉死的 NapCat 制品清单。
 *
 * **为什么要钉**：上游 `NapNeko/NapCatQQ` 已清空（仓库只剩一句话、releases 为空），
 * 目前唯一能拿到**官方 CI 构建产物**的源是归档镜像 `XingYunStar/NapCatQQ`。
 * 镜像不是一手源 → 必须钉死 sha256：校验不过就丢弃，**绝不**安装未校验的包。
 *
 * 换版本时要同时换 url 与 sha256（两者必须来自同一次发布）。
 */

export interface NapCatArtifact {
  /** 版本号（如 `4.18.42`）。 */
  version: string;
  /** 下载地址。 */
  url: string;
  /** 期望的制品 sha256（小写十六进制）。 */
  sha256: string;
  /** 制品字节数（用于进度展示与自检）。 */
  size: number;
  /** 允许的下载源 host（出网红线：不在清单里的一律拒绝）。 */
  allowedHosts: string[];
  /** 该制品覆盖的平台。 */
  platforms: NodeJS.Platform[];
}

/** 当前支持的制品（键 = 版本号）。 */
export const NAPCAT_ARTIFACTS: Record<string, NapCatArtifact> = {
  '4.18.42': {
    version: '4.18.42',
    url: 'https://github.com/XingYunStar/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip',
    sha256: '77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed',
    size: 124162399,
    // GitHub 的 release 资产会 302 到 release-assets.githubusercontent.com（新资产域），
    // 逐跳校验必须放行，否则安装直接被下载源闸门拒绝
    allowedHosts: [
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'api.github.com',
      'raw.githubusercontent.com',
    ],
    platforms: ['win32'],
  },
};

/** 取某个版本的制品；没有或当前平台不支持时返回 undefined。 */
export function resolveArtifact(
  version: string,
  platform: NodeJS.Platform = process.platform,
): NapCatArtifact | undefined {
  const found = NAPCAT_ARTIFACTS[version];
  if (!found) return undefined;
  if (!found.platforms.includes(platform)) return undefined;
  return found;
}

/** 当前平台可用的版本号列表（给面板做下拉）。 */
export function availableVersions(platform: NodeJS.Platform = process.platform): string[] {
  return Object.keys(NAPCAT_ARTIFACTS).filter((v) => NAPCAT_ARTIFACTS[v].platforms.includes(platform));
}
