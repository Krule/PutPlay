/**
 * Homebrew Channel repo.json — pure entry construction.
 *
 * Schema verified against the official webosbrew/docs schemas
 * (HomebrewRepository + HomebrewPackageManifest) and the live immich entry
 * on repo.webosbrew.org: top-level {id, title, shortDescription,
 * fullDescriptionUrl, iconUri, manifest}, where manifest carries
 * {id, version, type, title, appDescription, iconUri, sourceUrl,
 * rootRequired, ipkUrl, ipkHash: {sha256}, ipkSize}.
 *
 * The TV's DetailsPanel fetches fullDescriptionUrl, DOMPurify-sanitizes it
 * (style/script/form/input/button tags are STRIPPED) and renders it into a
 * moonstone BodyText; without it, the panel falls back to shortDescription.
 */

export function repoEntry({ appId, title, shortDescription, appDescription, fullDescriptionUrl, version, iconUri, sourceUrl, ipkUrl, sha256, size }) {
  return {
    id: appId,
    title,
    shortDescription,
    fullDescriptionUrl,
    iconUri,
    manifest: {
      id: appId,
      version,
      type: "web",
      title,
      appDescription,
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
