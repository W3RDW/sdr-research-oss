# Hardware matrix

What SDR to use, what `OSMOSDR_ARGS` to set, and known gotchas per device.

| Device | Frequency | Sample rate | Driver string | Notes |
|---|---|---|---|---|
| **RTL-SDR Blog v3** | 24 MHz – 1.7 GHz | up to 2.56 MS/s | `rtl=0` or `rtl_tcp=host:port` | Cheapest path. 8-bit ADC. |
| **Nooelec NESDR** | same | same | `rtl=0` | Same chip as RTL-SDR Blog. |
| **Airspy Mini** | 24 MHz – 1.7 GHz | 3 or 6 MS/s | `airspy=0` | 12-bit ADC. 6 MS/s captures full 2m band in one shot. |
| **Airspy R2** | 24 MHz – 1.8 GHz | 2.5 / 10 MS/s | `airspy=0` | Wider BW than Mini. |
| **Airspy HF+ Discovery** | 0.5 kHz – 31 MHz, 60 – 260 MHz | 192 / 768 kHz | `airspyhf=0` | Best HF performance under $200. |
| **HackRF One** | 1 MHz – 6 GHz | up to 20 MS/s | `hackrf=0` | TX-capable. 8-bit ADC. |
| **RX888 MkII** | 0 – 64 MHz (HF direct sampling) | up to 130 MS/s | `driver=SDDC` | Wide HF survey. Needs `SoapySDDC` built from source. |
| **SDRplay RSPdx** | 1 kHz – 2 GHz | up to 10 MS/s | `driver=sdrplay,soapy=0` | Proprietary driver — not in apt. |
| **SoapyRemote** (any of the above on a remote host) | depends | depends | `soapy=0,driver=remote,remote=tcp://HOST:55132,remote:driver=DRIVER` | Run `SoapySDRServer` on the remote. |

## Quick reference per SDR

### RTL-SDR

```dotenv
OSMOSDR_ARGS=rtl=0
SAMPLE_RATE=2400000
DWELL_CENTER_HZ=146000000
RF_GAIN=40           # 0–49 dB; tuner-dependent
PPM_CORRECTION=0     # may need to tune; see docs/calibration.md
```

If you have multiple RTL-SDRs, set the device serial:

```bash
rtl_eeprom              # show current serials
rtl_eeprom -s 00000001  # set serial of device 0
```

Then: `OSMOSDR_ARGS=rtl=00000001`.

For network access (multiple consumers, cross-host):

```bash
rtl_tcp -a 0.0.0.0 -p 1234 -s 2400000 -d 0
```

Then in the SDR container: `OSMOSDR_ARGS=rtl_tcp=rtl-tcp:1234`.

### Airspy Mini

```dotenv
OSMOSDR_ARGS=airspy=0
SAMPLE_RATE=6000000     # or 3000000 if CPU-bound
DWELL_CENTER_HZ=146000000
RF_GAIN=18              # gain INDEX 0–21 (NOT dB)
PPM_CORRECTION=0        # factory-calibrated TCXO
```

`set_freq_corr()` is unsupported by some Airspy backends — the unified-sdr
script wraps it in try/except, so non-zero PPM may be silently ignored.

### Airspy HF+

```dotenv
OSMOSDR_ARGS=airspyhf=0
SAMPLE_RATE=768000
DWELL_CENTER_HZ=14076000  # 20m FT8
RF_GAIN=0                 # AGC; manual gain not exposed via osmosdr
```

Best for HF FT8/WSPR, CW chasing, AM broadcast monitoring.

### HackRF One

```dotenv
OSMOSDR_ARGS=hackrf=0
SAMPLE_RATE=8000000
DWELL_CENTER_HZ=146000000
RF_GAIN=14                # LNA gain 0–40, IF gain 0–62
```

8-bit ADC means worse dynamic range than Airspy. Good for survey work or wide
bands. Don't transmit accidentally — TX is enabled by default in some
flowgraphs.

### RX888 MkII (HF direct sampling)

Needs `SoapySDDC` built from source — not in apt. See
[`decoders/unified-sdr/sddc.md`](../decoders/unified-sdr/sddc.md) (TODO).

```dotenv
OSMOSDR_ARGS=driver=SDDC
SAMPLE_RATE=64000000      # full HF span
DWELL_CENTER_HZ=14000000  # 20m / 17m / 15m all visible at once
```

The RX888 is a USB-3 device. USB-2 hubs or front-panel ports often won't
deliver the bandwidth. Plug into a rear-panel USB-3 port directly.

### SoapyRemote (network SDR)

When the SDR lives on another host (e.g. a Pi at the antenna):

```bash
# On remote host (Pi, etc.)
SoapySDRServer --bind=0.0.0.0:55132
```

```dotenv
# In your sdr-research-oss .env / values.yaml
OSMOSDR_ARGS=soapy=0,driver=remote,remote=tcp://192.168.1.42:55132,remote:driver=airspy
```

Critical: `driver=remote` tells SoapySDR to use the SoapyRemote module;
`remote:driver=airspy` tells the remote server which physical driver to use.
Using `driver=airspy` (without `remote`) tries to open a local USB device.

## Squelch tuning

Default values (`RF_SQUELCH_DB=-50`, `ENERGY_THRESH_DB=10`) are tuned for
Airspy + 2m band. For RTL-SDR with default gain you may need:

```dotenv
RF_SQUELCH_DB=-45
SQUELCH_OPEN_DB=-45
SQUELCH_CLOSE_DB=-50
```

If you get *no* recordings: drop `RF_SQUELCH_DB` by 5 dB at a time. If you
get *only* noise: raise it 5 dB at a time. Check the heartbeat output at
`/data/detections/sdr_heartbeat_<CAPTURE_ID>.json` for noise floor estimates.

`ENERGY_THRESH_DB=10` is the FFT detector threshold. Raising it above 10 will
break FM detection (energy spreads across bins; per-bin peaks stay low).
Narrow-band signals (CW, RTTY) will tolerate higher thresholds.

## Multiple SDRs

Run multiple `unified-sdr` containers, each pinned to a different SDR via
serial / device index, each on a different `CAPTURE_ID`. They share the same
`/data` volume, so the API indexer picks up everything.

```yaml
# Two unified-sdr instances:
unifiedSdr:
  enabled: true
  captureId: "2m"
  osmosdrArgs: "rtl=00000001"
  dwellCenterHz: 146000000
# (additional Helm template — TODO. For now, deploy the chart twice with
# different release names.)
```
