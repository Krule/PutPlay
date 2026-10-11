/**
 * Homebrew Channel repo.json — pure entry construction.
 *
 * Schema verified against the live community example
 * (RF1705/youtube-webos-cobalt-adfree repo.json): top-level
 * {id, title, shortDescription, iconUri, manifest}, where manifest carries
 * {id, version, type, title, iconUri, sourceUrl, rootRequired, ipkUrl,
 * ipkHash: {sha256}, ipkSize}.
 */

export function repoEntry({ appId, title, shortDescription, version, iconUri, sourceUrl, ipkUrl, sha256, size }) {
  return {
    id: appId,
    title,
    shortDescription,
    iconUri,
    manifest: {
      id: appId,
      version,
      type: "web",
      title,
      iconUri,
      sourceUrl,
      rootRequired: false,
      ipkUrl,
      ipkHash: { sha256 },
      ipkSize: size,
    },
  };
}

/**
 * Replace the entry with the same package id, or append. Other publishers'
 * entries are never touched. Returns a new object; the input is not mutated.
 */
export function upsertPackage(repo, entry) {
  const packages = (repo.packages || []).filter((p) => p.id !== entry.id);
  packages.push(entry);
  return { packages };
}
