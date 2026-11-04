# RX888 USB recovery experiment

The receiver enumerated as the FX3 bootloader, accepted the original firmware
with readback verification, and enumerated as RX888mk2 at USB SuperSpeed. It
then failed USB control transfers and configuration with error -110 before
streaming. The host driver crashed instead of reporting the failed USB access.

`driver-recovery.patch` applies to ExtIO_sddc commit `331b35c` and checks failed
enumeration/open, terminates USB descriptor strings, and allows three seconds
for firmware re-enumeration. This addresses observed host crashes. It does not
establish that the underlying USB fault is software rather than cable, power,
port, or receiver hardware.

`disable-link-power-saving.patch` keeps FX3 link power management disabled
while idle as well as while streaming, and rejects U1/U2 requests. This is an
experimental compatibility build based on the upstream firmware, not a new
radio implementation. The upstream image last changed on 2022-05-10 to improve
Intel USB compatibility; upstream host code includes changes from March 2026.

Build on Linux with `./build.sh OUTPUT_DIRECTORY`. The build uses the upstream
FX3 SDK and its licensing terms. Only our patches are stored here. The build
produces an image, but does not upload it or write persistent storage.

Validation requires a separate RAM-only firmware upload, a settling interval,
and at least ten minutes of actual sample streaming. A valid image checksum
or successful USB enumeration is not sufficient. Retain the original image
for comparison. Power cycling returns this receiver to its bootloader.

Build verified with GCC ARM 10.3.1 on Ubuntu 22.04. The experimental image's
FX3 section checksum passed. Hardware streaming validation is pending.

## Hardware result (2026-11-03 UTC)

The experimental image uploaded to RAM successfully, including readback and
checksum validation. It re-enumerated at 5000 Mb/s, then failed configuration
with kernel error `-110`, before a sample stream could start. The same failure
occurred with the original image. This build is **not a verified recovery** and
must not be selected as the production default.

The patched host driver returned a `RuntimeError` for the failed USB access
instead of the original segmentation fault. The receiver remains disabled
pending a test with a different USB 3 cable and port.
