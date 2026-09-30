#!/usr/bin/env python3
"""Fetches Node.js and its shared libraries from the Termux package repository and lays them
out as Android jniLibs for one ABI.

Termux builds Node against Android's own libc (Bionic), so DNS, TLS and sockets work like in any
Android app. Android only extracts files named lib*.so from an APK and only allows executing files
from the extracted native library directory, so:
  * the node executable becomes libstnode.so;
  * every dependency is renamed to libnd_<name>.so, and DT_NEEDED / DT_SONAME are patched to match;
  * the Termux RUNPATH is removed (LD_LIBRARY_PATH points at the native library directory).

Usage: fetch_termux_node.py --abi arm64-v8a --out build-inputs [--package nodejs-lts]
Requires: readelf (binutils) and patchelf.
"""
import argparse
import io
import lzma
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import gzip

REPO = 'https://packages.termux.dev/apt/termux-main'
ARCHES = {'arm64-v8a': 'aarch64', 'x86_64': 'x86_64', 'armeabi-v7a': 'arm'}
PREFIX = 'data/data/com.termux/files/usr/'
# Provided by Android itself (NDK stable system libraries).
SYSTEM_LIBS = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so', 'libEGL.so', 'libGLESv2.so'}


def fetch(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()
        except Exception as error:  # noqa: BLE001
            if attempt == 3:
                raise
            print(f'  retry {url}: {error}', file=sys.stderr)


def load_index(arch):
    base = f'{REPO}/dists/stable/main/binary-{arch}/Packages'
    for suffix, decode in (('.xz', lzma.decompress), ('.gz', gzip.decompress), ('', lambda b: b)):
        try:
            text = decode(fetch(base + suffix)).decode('utf-8')
            break
        except Exception:  # noqa: BLE001
            continue
    else:
        raise RuntimeError('Cannot download the Termux package index')
    packages = {}
    for block in text.split('\n\n'):
        fields = {}
        key = None
        for line in block.splitlines():
            if line.startswith(' ') and key:
                fields[key] += '\n' + line.strip()
            elif ':' in line:
                key, _, value = line.partition(':')
                fields[key] = value.strip()
        if 'Package' in fields:
            packages[fields['Package']] = fields
            for provided in fields.get('Provides', '').split(','):
                name = provided.strip().split(' ')[0]
                if name and name not in packages:
                    packages.setdefault('__provides__' + name, fields)
    return packages


def dependencies(fields):
    result = []
    for group in fields.get('Depends', '').split(','):
        group = group.strip()
        if not group:
            continue
        first = group.split('|')[0].strip()
        result.append(re.sub(r'\s*\(.*\)', '', first).strip())
    return result


def resolve(packages, root):
    order, seen, stack = [], set(), [root]
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        fields = packages.get(name) or packages.get('__provides__' + name)
        if not fields:
            print(f'  (skipping unknown dependency {name})')
            continue
        order.append(fields)
        stack.extend(dependencies(fields))
    return order


def extract_deb(data, target):
    """Minimal ar(1) reader; extracts data.tar.* into target."""
    if not data.startswith(b'!<arch>\n'):
        raise RuntimeError('not a .deb')
    offset = 8
    while offset < len(data):
        header = data[offset:offset + 60]
        name = header[:16].decode().strip().rstrip('/')
        size = int(header[48:58].decode().strip())
        body = data[offset + 60:offset + 60 + size]
        offset += 60 + size + (size % 2)
        if name.startswith('data.tar'):
            if name.endswith('.zst'):
                import zstandard  # type: ignore  # noqa: PLC0415
                body = zstandard.ZstdDecompressor().decompress(body, max_output_size=1 << 31)
                mode = 'r:'
            else:
                mode = 'r:*'
            with tarfile.open(fileobj=io.BytesIO(body), mode=mode) as tar:
                tar.extractall(target, filter='tar') if sys.version_info >= (3, 12) else tar.extractall(target)
            return
    raise RuntimeError('data.tar not found in .deb')


def readelf_dynamic(path):
    output = subprocess.run(['readelf', '-d', path], check=True, capture_output=True, text=True).stdout
    needed = re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', output)
    soname = re.findall(r'\(SONAME\)\s+Library soname: \[(.+?)\]', output)
    return needed, (soname[0] if soname else None)


def mangle(soname):
    stem, _, version = soname.partition('.so')
    stem = re.sub(r'^lib', '', stem)
    version = re.sub(r'[^0-9A-Za-z]', '', version)
    return f"libnd_{re.sub(r'[^0-9A-Za-z_]', '_', stem)}{version}.so"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--abi', required=True, choices=sorted(ARCHES))
    parser.add_argument('--out', required=True)
    parser.add_argument('--package', default='nodejs-lts')
    args = parser.parse_args()

    arch = ARCHES[args.abi]
    work = tempfile.mkdtemp(prefix=f'termux-{arch}-')
    print(f'Resolving {args.package} for {arch}...')
    packages = load_index(arch)
    wanted = resolve(packages, args.package) + resolve(packages, 'ca-certificates')
    unique = {f['Package']: f for f in wanted}
    for fields in unique.values():
        print(f"  {fields['Package']} {fields.get('Version', '')}")
        extract_deb(fetch(f"{REPO}/{fields['Filename']}"), work)

    usr = os.path.join(work, PREFIX)
    libdir = os.path.join(usr, 'lib')
    node = os.path.join(usr, 'bin', 'node')
    if not os.path.isfile(node):
        raise RuntimeError('node binary not found in the packages')

    out_libs = os.path.join(args.out, 'jniLibs', args.abi)
    out_assets = os.path.join(args.out, 'assets')
    os.makedirs(out_libs, exist_ok=True)
    os.makedirs(out_assets, exist_ok=True)

    # Walk the DT_NEEDED closure starting from node.
    to_visit, libs = [node], {}
    while to_visit:
        current = to_visit.pop()
        needed, _ = readelf_dynamic(current)
        for name in needed:
            if name in SYSTEM_LIBS or name in libs:
                continue
            path = os.path.join(libdir, name)
            if not os.path.exists(path):
                raise RuntimeError(f'{name} (needed by {os.path.basename(current)}) is not in the Termux packages')
            libs[name] = os.path.realpath(path)
            to_visit.append(libs[name])

    renames = {name: mangle(name) for name in libs}
    total = 0
    for name, source in libs.items():
        target = os.path.join(out_libs, renames[name])
        shutil.copyfile(source, target)
        total += os.path.getsize(target)
    node_target = os.path.join(out_libs, 'libstnode.so')
    shutil.copyfile(node, node_target)
    total += os.path.getsize(node_target)

    for path in [node_target] + [os.path.join(out_libs, renames[n]) for n in libs]:
        needed, soname = readelf_dynamic(path)
        command = ['patchelf', '--remove-rpath']
        for name in needed:
            if name in renames:
                command += ['--replace-needed', name, renames[name]]
        if soname and soname in renames:
            command += ['--set-soname', renames[soname]]
        subprocess.run(command + [path], check=True)
        os.chmod(path, 0o755)

    cert = os.path.join(usr, 'etc', 'tls', 'cert.pem')
    if os.path.exists(cert):
        shutil.copyfile(cert, os.path.join(out_assets, 'cacert.pem'))

    version = unique.get(args.package, {}).get('Version', '?')
    with open(os.path.join(out_assets, f'node-{args.abi}.txt'), 'w') as handle:
        handle.write(f'{args.package} {version}\n')
        for name in sorted(libs):
            handle.write(f'{name} -> {renames[name]}\n')

    print(f'{args.abi}: node {version}, {len(libs)} libraries, {total / 1048576:.1f} MB -> {out_libs}')
    for name in sorted(libs):
        print(f'  {name} -> {renames[name]}')
    shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
