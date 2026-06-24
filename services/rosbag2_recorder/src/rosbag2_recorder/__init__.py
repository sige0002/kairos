"""rosbag2_recorder: ROS 2 topics -> MCAP canonical recorder.

The service exposes the recorder's internal HTTP API (consumed by
``api_orchestrator``): ``POST /record/start|stop`` and ``GET
/record/status|metadata``. Recording is performed by spawning ``ros2 bag record
--storage mcap`` (see :mod:`rosbag2_recorder.recorder`); rosbag2 writes the MCAP
files and standard ``metadata.yaml``, and the recorder writes a kairos
``manifest.json`` alongside them for audit.
"""
