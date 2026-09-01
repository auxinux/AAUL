/**
 * Shared package-management security policy (dashboard side).
 *
 * This mirrors the agent's own validation (agent/app/lib/packages.py) so that
 * dangerous requests are rejected before a command is ever queued. The agent
 * re-validates everything — neither side trusts the other.
 */

// Must start alphanumeric, then a small safe charset. No spaces / shell chars.
//
// `@` is allowed because Homebrew versions its formulae that way (openssl@3,
// python@3.11, node@20). Without it, no macOS package could ever be updated —
// the fleet update refused the whole batch with "Invalid package name".
// It stays safe: commands are executed as fixed argument lists, never through a
// shell, and a name can still not start with `@`.
export const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,100}$/;
// Search queries may contain spaces but no control/shell characters.
export const SEARCH_QUERY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,100}$/;

// Boot / system critical packages — never installable or removable remotely.
const BLACKLIST = [
  /^grub/, /grub2/, /grub-/,
  /^linux-image/, /^linux-headers/, /^linux-firmware/,
  /^kernel/, /-kernel/, /^linux$/, /^linux-lts/,
  /^systemd$/, /^systemd-/, /^init$/, /^sysvinit/, /^upstart$/,
  /^libc6$/, /^glibc/, /^libc-bin$/, /^musl$/,
  /^dpkg$/, /^apt$/, /^apt-get$/, /^rpm$/, /^dnf$/, /^yum$/,
  /^pacman$/, /^zypper$/, /^portage$/,
  /^bash$/, /^dash$/, /^coreutils$/, /^util-linux$/,
  /^shim/, /^efibootmgr$/, /^os-prober$/,
  /^mkinitcpio$/, /^dracut$/, /^initramfs-tools/,
  /^syslinux/, /^refind/, /^bootctl$/, /^sudo$/
];

export function isBlacklisted(name) {
  const low = String(name || "").trim().toLowerCase();
  return BLACKLIST.some((rx) => rx.test(low));
}

/** Returns { ok:true, name } or { ok:false, error }. */
export function validatePackageName(name) {
  const value = String(name || "").trim();
  if (!PACKAGE_NAME_RE.test(value)) {
    return { ok: false, error: "Invalid package name" };
  }
  if (isBlacklisted(value)) {
    return { ok: false, error: "Protected package (boot/system critical) — refused" };
  }
  return { ok: true, name: value };
}

export function validateSearchQuery(query) {
  const value = String(query || "").trim();
  if (!SEARCH_QUERY_RE.test(value)) {
    return { ok: false, error: "Invalid search query" };
  }
  return { ok: true, query: value };
}
