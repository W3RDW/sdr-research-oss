#!/usr/bin/env bash
set -euo pipefail
# Requires git, make, gcc, gcc-arm-none-eabi and libnewlib-arm-none-eabi.
patch_dir=$(cd -- "$(dirname -- "$0")" && pwd)
output_dir=${1:?Usage: build.sh OUTPUT_DIRECTORY}
mkdir -p "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
git clone https://github.com/ik1xpv/ExtIO_sddc.git "$work_dir/source"
git -C "$work_dir/source" checkout 331b35cd619bf4af20444d64dc35b13a474493e6
git -C "$work_dir/source" apply "$patch_dir/disable-link-power-saving.patch"
make -C "$work_dir/source/SDDC_FX3" -j2
cp "$work_dir/source/SDDC_FX3/SDDC_FX3.img" "$output_dir/SDDC_FX3-no-lpm.img"
sha256sum "$output_dir/SDDC_FX3-no-lpm.img"
