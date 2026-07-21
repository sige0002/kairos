"""dora_live — live DDS ingest via dora-ros2-bridge with shared-memory fan-out.

One bridge node per topic (external events carry no topic attribution, so
per-topic nodes keep the mapping unambiguous; downstream attribution rides on
``send_output`` metadata). The control sidecar generates the dataflow from the
live manifest and supervises ``dora run``.
"""

__version__ = "0.1.0"
