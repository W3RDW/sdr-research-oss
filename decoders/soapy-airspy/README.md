# Airspy SoapyRemote server

Exposes a USB **Airspy** SDR (Airspy Mini / R2) over the network using
[SoapyRemote](https://github.com/pothosware/SoapyRemote), so decoder pods
running on other nodes can open the radio with a `remote:driver=airspy`
device string instead of needing direct USB access.

This is **not a decoder** — it is the network front end for the physical SDR.
It runs `SoapySDRServer --bind 0.0.0.0:55132` and advertises the Airspy via the
`soapysdr-module-airspy` plugin. A client (e.g. `unified-sdr`) connects with
something like:

```
remote=airspy-soapy.sdr-research.svc.cluster.local:55132,remote:driver=airspy
```

## Port

`55132/tcp` — the SoapyRemote control + data port (`EXPOSE 55132`, bind
`0.0.0.0:55132`). The reference Service is headless (`clusterIP: None`) and
exposes the same port.

## Build

Build context is this directory:

```sh
docker buildx build --platform linux/arm64 -t sdr-research-soapy-airspy decoders/soapy-airspy
```

`SoapySDRServer` is not packaged by Ubuntu (the `soapysdr-module-remote` apt
package ships only the client `.so`), so the image builds **SoapyRemote** from
source. The Airspy driver comes from the `soapysdr-module-airspy` apt package.

## Runtime requirements

This server must run **on the node that the Airspy is physically plugged into**.
In the reference cluster it is deployed as a `DaemonSet` (so it lands on the
right node and restarts in place) rather than a Deployment.

- **Node pinning.** Pin to the node with the USB device via `nodeSelector`
  (e.g. `kubernetes.io/hostname: <node>`). The reference cluster also gates it
  behind an enable label (`sdr.<domain>/airspy-remote-enabled: "true"`) so the
  server is off by default and does not fight local decoders for the device.
- **Privileged + USB passthrough.** `securityContext.privileged: true` and a
  `hostPath` volume mounting `/dev/bus/usb` → `/dev/bus/usb` so libusb can claim
  the Airspy.
- **Single-consumer radio.** Only one process can hold the Airspy at a time.
  Stop any local decoder using the same device before enabling this server.
- **Health probes.** The reference DaemonSet uses exec probes that (1) confirm a
  `SoapySDRServer` process is running and (2) confirm a matching USB device is
  present (`SDR_USB_PROBE_REGEX`, e.g. `1d50:60a1|AIRSPY|www\.airspy\.com`).

## Architecture

arm64 in CI. In the reference cluster the Airspy host is an arm64 bare-metal
node, so the production image tag is `…-arm64` and the GHCR build matrix
publishes `linux/arm64` for this image. The SoapyRemote + Airspy build is not
arch-specific; add `linux/amd64` to the matrix entry if you run the Airspy on an
amd64 host.
