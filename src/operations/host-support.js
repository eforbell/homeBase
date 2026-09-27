// Which hosts the executor supports, decided from /etc/os-release. Ubuntu 22.04+ and Debian 12+,
// plus derivatives built on them (Linux Mint 21/22, Pop!_OS, ...), recognised by their Ubuntu or
// Debian base codename. install.sh applies the same rule in shell.

const UBUNTU_CODENAMES = Object.freeze({ jammy: '22.04', noble: '24.04', oracular: '24.10', plucky: '25.04', questing: '25.10' });
const DEBIAN_CODENAMES = Object.freeze({ bookworm: '12', trixie: '13' });

function parseOsRelease(content) {
  const fields = {};
  for (const line of String(content || '').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return fields;
}

// Returns { supported, base, name } where base is e.g. 'ubuntu 22.04' or 'debian 12'.
function hostSupport(content) {
  const os = parseOsRelease(content);
  const name = os.PRETTY_NAME || os.ID || 'unknown';
  const major = Number.parseInt(String(os.VERSION_ID || '').split('.')[0], 10);
  if (os.ID === 'ubuntu') return { supported: major >= 22, base: `ubuntu ${os.VERSION_ID}`, name };
  if (os.ID === 'debian') return { supported: major >= 12, base: `debian ${os.VERSION_ID}`, name };
  const like = String(os.ID_LIKE || '').split(/\s+/);
  const ubuntu = UBUNTU_CODENAMES[os.UBUNTU_CODENAME];
  if (like.includes('ubuntu') && ubuntu) return { supported: true, base: `ubuntu ${ubuntu}`, name };
  const debian = DEBIAN_CODENAMES[os.DEBIAN_CODENAME || os.VERSION_CODENAME];
  if (like.includes('debian') && debian) return { supported: true, base: `debian ${debian}`, name };
  return { supported: false, base: null, name };
}

module.exports = { hostSupport, parseOsRelease, UBUNTU_CODENAMES, DEBIAN_CODENAMES };
