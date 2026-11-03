"""Validate multistage channel response in the GNU Radio image, without hardware.

Usage: python3 channel_filter_smoke.py /path/to/unified_sdr.py
"""

import ast
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from gnuradio import analog, blocks, filter, gr

path = Path(sys.argv[1])
tree = ast.parse(path.read_text())
helpers = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))
           and n.name in ("channel_filter_plan", "ChannelFilter")]
scope = dict(np=np, filter=filter, gr=gr, lru_cache=lru_cache)
exec(compile(ast.Module(body=helpers, type_ignores=[]), str(path), "exec"), scope)


def measure(rate, plan, offset, tone):
    tb = gr.top_block()
    src = analog.sig_source_c(rate, analog.GR_COS_WAVE, offset + tone, 1, 0)
    head = blocks.head(gr.sizeof_gr_complex, rate // 4)
    channel = scope["ChannelFilter"](plan, 0, rate)
    channel.set_center_freq(offset)
    sink = blocks.vector_sink_c()
    tb.connect(src, head, channel, sink)
    tb.run()
    samples = np.array(sink.data())
    # Discard startup/filter delay; test the steady-state complex signal.
    return samples, samples[len(samples) // 2:]


for rate in (240000, 2400000, 6000000):
    for name, out_rate, cutoff, transition, intermediate, tone in (
        ("FM", 48000, 10000, 2500, 240000, 1000),
        ("CW", 8000, 200, 50, 48000, 100),
    ):
        plan = scope["channel_filter_plan"](rate, out_rate, cutoff, transition, intermediate)
        # Test translation in both directions, as used by retuned dynamic slots.
        for offset in (-rate / 5, rate / 5):
            samples, steady = measure(rate, plan, offset, tone)
            assert abs(len(samples) - out_rate // 4) <= 2, (name, rate, len(samples))
            gain_db = 10 * np.log10(np.mean(abs(steady) ** 2))
            actual_tone = np.angle(np.mean(steady[1:] * np.conj(steady[:-1]))) * out_rate / (2 * np.pi)
            assert abs(gain_db) < 0.2, (name, rate, gain_db)
            assert abs(actual_tone - tone) < 1, (name, rate, actual_tone)
        # A blocker outside the narrow passband must not reach the recorder.
        _, stop = measure(rate, plan, 0, cutoff * 2)
        stop_db = 10 * np.log10(np.mean(abs(stop) ** 2) + 1e-30)
        assert stop_db < -50, (name, rate, "stopband", stop_db)
        if rate > intermediate:
            # This would fold onto the desired tone without the first-stage filter.
            _, alias = measure(rate, plan, 0, intermediate + tone)
            alias_db = 10 * np.log10(np.mean(abs(alias) ** 2) + 1e-30)
            assert alias_db < -50, (name, rate, "alias", alias_db)
        original = filter.firdes.low_pass(1.0, rate, cutoff, transition)
        noise_delta = 10 * np.log10(plan[-1] / sum(t*t for t in original))
        assert abs(noise_delta) < 0.2, (name, rate, "squelch noise gain", noise_delta)
        print(f"PASS {name} {rate}: rate, tuning, passband, rejection, noise gain", flush=True)
