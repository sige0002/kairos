"""dora_runner: post-recording validation & conversion (Stage 0 skeleton).

Stage 0 provides only a runnable FastAPI shell (/healthz, /readyz, stub root).
The dora-based job engine (MCAP loader, plugin/pipeline registry, fast_validation,
job/template APIs) lands in Stage 3. Reads MCAP via the mcap libraries, so it
needs no rclpy and runs on the slim Python image.
"""
