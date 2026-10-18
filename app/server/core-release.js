// Official source releases are built into the fnOS package by its maintainer.
export function parseCoreVersion(value) {
  const match = String(value || "").match(/(?:^|\bv)(\d{1,3})\.(\d+)\.(\d+)(?=$|\s|\+)/);
  return match ? match.slice(1).map(Number) : null;
}

export async function checkOfficialCoreRelease(current, fetchRelease = fetch) {
  const response = await fetchRelease("https://api.github.com/repos/NousResearch/hermes-agent/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "fnos-hermes-agent" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`官方版本查询失败（HTTP ${response.status}）`);
  const release = await response.json();
  const next = parseCoreVersion(release.tag_name) || parseCoreVersion(String(release.name || "").replace(/^Hermes Agent\s+/i, ""));
  if (!next || release.prerelease || release.draft) throw new Error("官方发布信息不是有效的稳定版");
  const previous = parseCoreVersion(current);
  const firstChange = previous ? next.findIndex((part, i) => part !== previous[i]) : -1;
  return {
    current,
    latest: `v${next.join(".")}`,
    updateAvailable: previous !== null && firstChange >= 0 && next[firstChange] > previous[firstChange],
    updateMechanism: "external",
    updateHint: "Hermes 核心随飞牛应用包更新，请安装包含新版核心的 FPK。",
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
  };
}
