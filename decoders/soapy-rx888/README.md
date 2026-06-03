# RX888 SoapyRemote server

Exposes a USB **RX888 / SDDC-class** HF SDR over the network using
[SoapyRemote](https://github.com/pothosware/SoapyRemote), so decoder pods
running on other nodes (e.g. `hfdl`, `ft8-wspr`) can open the radio with a
`remote:driver=SDDC` device string instead of needing direct USB access.

This is **not a decoder** — it is the network front end for the physical SDR.
It runs `SoapySDRServer --bind 0.0.0.0:55132` and advertises the radio via the
`SoapySDDC` plugin built from [ExtIO_sddc](https://github.com/ik1xpv/ExtIO_sddc).
Supported hardware: RX888 MkII, RX888r2, RX999, RX-666, BBRF103, HF103.
A client connects with something like:

```
remote=rx888-soapy.sdr-research.svc.cluster.local:55132,remote:driver=SDDC
```

> The `ExtIO_sddc` build ships the FX3 firmware (`SDDC_FX3.img`) to
> `/usr/local/share/sddc/`; the driver uploads it to the device over USB the
> first time the radio is opened.

## Port

`55132/tcp` — the SoapyRemote control + data port (`EXPOSE 55132`, bind
`0.0.0.0:55132`). The reference Service is headless (`clusterIP: None`) and
exposes the same port.

## Build

Build context is this directory:

```sh
docker buildx build --platform linux/amd64 -t sdr-research-soapy-rx888 decoders/soapy-rx888
```

`SoapySDRServer` is not packaged by Ubuntu (the `soapysdr-module-remote` apt
package ships only the client `.so`), so the image builds **SoapyRemote** from
source. The `SDDC` driver is also not in apt, so `ExtIO_sddc` is built from
source as well.

## Runtime requirements

This server must run **on the node that the RX888 is physically plugged into**.
In the reference cluster it is deployed as a `DaemonSet` (so it lands on the
right node and restarts in place) rather than a Deployment.

- **Node pinning.** Pin to the node with the USB device via `nodeSelector`
  (e.g. `kubernetes.io/hostname: <node>`). The reference cluster also gates it
  behind an enable label (`sdr.<domain>/rx888-remote-enabled: "true"`) so the
  server is off by default — the always-on RX888 server keeps the radio busy and
  blocks local decoders (`hfdl`, `ft8-wspr`) from opening it.
- **Privileged + USB passthrough.** `securityContext.privileged: true` and a
  `hostPath` volume mounting `/dev/bus/usb` → `/dev/bus/usb` so libusb can claim
  the RX888 and upload firmware.
- **Single-consumer radio.** Only one process can hold the RX888 at a time.
  Scale any local HF decoders to 0 before enabling this server.
- **Health probes.** The reference DaemonSet uses exec probes that (1) confirm a
  `SoapySDRServer` process is running and (2) confirm a matching USB device is
  present (`SDR_USB_PROBE_REGEX`, e.g.
  `RX888|RX-888|RX999|RXLucy|HF103|BBRF103|FX3|Cypress|SDDC`).

## Architecture

amd64 in CI. In the reference cluster the RX888 host is an amd64 node, so the
production image tag is `…-amd64` and the GHCR build matrix publishes
`linux/amd64` for this image. The ExtIO_sddc build is amd64-only in CI; add
`linux/arm64` to the matrix entry only after validating an arm64 build.
