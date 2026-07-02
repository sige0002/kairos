"""dora_runner: post-recording validation & conversion.

Hosts the job engine (MCAP loader, plugin/pipeline registry, fast_validation,
job/template APIs) behind a FastAPI app (/healthz, /readyz, jobs, pipelines).
Reads MCAP via the mcap libraries, so it needs no rclpy and runs on the slim
Python image.
"""
