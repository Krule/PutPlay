// Pure logic for build/deploy.mjs — unit tested in test/deploy-lib.test.mjs.
//
// Target: ONE rooted webOS 6 TV without Developer Mode (the owner's box).
// Install = the dev/install luna call, which only works when luna-send-pub
// runs with a PTY (ssh -tt) — without one, -i (interactive) mode no-ops
// silently and the install service never sees the request. Everyone else
// installs via the Homebrew Channel app, not this script.

/** The owner's exact working install command, for the ipk scp'ed to /tmp. */
export function devInstallRemote(id, ipk) {
  return (
    `luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/install' ` +
    `'${JSON.stringify({ id, ipkUrl: `/tmp/${ipk}`, subscribe: true })}'`
  );
}

/**
 * Success = the terminal subscription message carries "state":"installed".
 * "installing" (in any of its sub-states) must NOT match — hence the exact
 * quoted comparison. Empty output (the no-PTY no-op) is a failure.
 */
export function isInstallSuccess(out) {
  return /"state"\s*:\s*"installed"/.test(out);
}

/**
 * Secondary check: appinstalld logs every install/removal to
 * /var/log/messages (NL_APP_INSTALLED with the app id).
 */
export function installLogCheck(id) {
  return `grep -a NL_APP_INSTALLED /var/log/messages | grep -a "${id}" | tail -1`;
}

/** One-time migration: uninstall a previous build that shipped under an old app id. */
export function devUninstallRemote(id) {
  return (
    `luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/uninstall' ` +
    `'${JSON.stringify({ id })}'`
  );
}

/** Removals are logged the same way: NL_APP_REMOVED with the app id. */
export function removeLogCheck(id) {
  return `grep -a NL_APP_REMOVED /var/log/messages | grep -a "${id}" | tail -1`;
}
