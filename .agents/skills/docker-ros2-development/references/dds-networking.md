# DDS networking and shared memory in containers

## Contents

- Establish the baseline
- Select a network mode
- Configure discovery
- Distinguish Fast DDS and Cyclone DDS shared memory
- Diagnose failures

## Establish the baseline

Confirm these values at both publisher and subscriber before changing Docker networking:

- ROS distribution and message definitions;
- `ROS_DOMAIN_ID`;
- selected `RMW_IMPLEMENTATION` and installed RMW packages;
- topic name, type, and namespace;
- publisher and subscriber QoS;
- host firewall and interface selection;
- whether endpoints are on one host, one LAN, a VPN, or routed networks.

Do not state that different DDS vendors can never interoperate at the DDS protocol level. For operational ROS 2 deployments, follow the project's tested same-RMW rule unless cross-vendor interoperability is explicitly tested and supported.

## Select a network mode

| Mode | Prefer when | Main costs |
|---|---|---|
| Host | Linux robot or single-host stack; multicast and native interfaces matter | no network namespace isolation; port conflicts |
| Bridge | CI, service isolation, explicit port exposure | discovery behavior must be tested/configured |
| Macvlan/ipvlan | container needs a first-class LAN address | host reachability and network administration are more complex |
| Overlay/routed | multi-host orchestrated deployment | multicast may not traverse; use vendor discovery facilities |

Do not categorically claim Docker bridge networking blocks multicast. Test the actual Docker network driver, kernel, firewall, and DDS implementation. Prefer explicit discovery configuration when the environment must behave deterministically.

## Configure discovery

### Cyclone DDS unicast peers

Use a version-compatible Cyclone DDS XML file when multicast is unavailable:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CycloneDDS xmlns="https://cdds.io/config">
  <Domain id="any">
    <General>
      <Interfaces>
        <NetworkInterface autodetermine="true"/>
      </Interfaces>
      <AllowMulticast>false</AllowMulticast>
    </General>
    <Discovery>
      <Peers>
        <Peer address="10.0.0.21"/>
        <Peer address="10.0.0.22"/>
      </Peers>
      <ParticipantIndex>auto</ParticipantIndex>
    </Discovery>
  </Domain>
</CycloneDDS>
```

Activate it with the repository-approved mounted path:

```yaml
environment:
  RMW_IMPLEMENTATION: rmw_cyclonedds_cpp
  CYCLONEDDS_URI: file:///config/cyclonedds.xml
volumes:
  - ./config:/config:ro
```

Use stable IPs or documented resolvable names. Validate the XML against the Cyclone DDS version in the image.

### Fast DDS discovery

Prefer the project's existing Fast DDS profile or Discovery Server deployment. Do not guess RTPS ports for hand-written `initialPeersList`; domain ID and participant IDs affect port selection.

Activate a tested profile with the variable supported by the installed Fast DDS version, commonly:

```yaml
environment:
  RMW_IMPLEMENTATION: rmw_fastrtps_cpp
  FASTRTPS_DEFAULT_PROFILES_FILE: /config/fastdds.xml
volumes:
  - ./config:/config:ro
```

Confirm whether the project uses `FASTRTPS_DEFAULT_PROFILES_FILE` or a newer alias before changing it.

## Fast DDS shared memory

Fast DDS creates an SHM transport by default when builtin transports are enabled. In Docker, two conditions matter:

1. Participants must recognize each other as being on the same host. Use the host network namespace for the documented standard path.
2. Participants must access the same IPC namespace. Use `ipc: host` or a deliberately shared container IPC namespace.

```yaml
services:
  camera:
    network_mode: host
    ipc: host
    environment:
      RMW_IMPLEMENTATION: rmw_fastrtps_cpp
```

Do not bind-mount `/dev/shm` as the default recommendation; eProsima recommends shared IPC. Do not combine `shm_size` with `ipc: host` and imply the per-container size controls the host IPC namespace.

SHM transport still copies between DDS histories and the transport. Treat these separately:

- SHM transport: a transport optimized for same-host communication;
- data-sharing delivery: shares writer history under type/QoS/memory constraints;
- loaned-message zero-copy: removes additional application copies only where the client library and type support it.

Measure before claiming any of them is active.

## Cyclone DDS shared memory

Do not use the incomplete legacy standalone `SharedMemory/Enable` XML pattern.

Current Cyclone DDS shared-memory exchange is version/build dependent. It requires the applicable PSMX/iceoryx integration, compatible libraries, a shared-memory service such as RouDi where required, and matching configuration. A stock ROS image containing only `rmw_cyclonedds_cpp` does not prove this support is present.

When support is absent, tune network transport instead:

- bind Cyclone DDS to the intended interface;
- increase host socket receive buffers for large fragmented samples;
- configure Cyclone's receive buffer request;
- reduce message size/rate where appropriate;
- verify QoS and loss with representative data.

## Diagnose discovery and data failures

Use this sequence:

1. Print environment inside each container.

   ```bash
   env | sort | rg '^(ROS|RMW|CYCLONE|FAST)'
   ```

2. Confirm installed RMW packages.

   ```bash
   ros2 pkg prefix rmw_fastrtps_cpp
   ros2 pkg prefix rmw_cyclonedds_cpp
   ```

3. Reset stale CLI daemon state after changing domain/RMW.

   ```bash
   ros2 daemon stop
   ros2 daemon start
   ```

4. Compare graph visibility from both endpoints.
5. Inspect topic type and QoS.

   ```bash
   ros2 topic info --verbose /camera/image
   ```

6. Run a minimal talker/listener using the same Compose topology.
7. Capture discovery/data traffic with `tcpdump` when graph visibility differs.
8. Inspect `/dev/shm` and vendor logs only after verifying the vendor supports and is configured for SHM.
9. Measure loopback/physical-interface traffic while adding subscribers to establish the actual path.

Distinguish failures:

- no participants: domain, RMW load, interface, discovery, firewall;
- participants but no endpoint match: topic type or QoS;
- endpoint match but corrupted/dropped large data: buffers, fragmentation, MTU, CPU, serialization;
- works on UDP but not SHM: host identity, IPC namespace, vendor support/configuration;
- intermittent after restarts: stale discovery state, participant index/ports, cleanup, resource exhaustion.

## Primary sources

- https://fast-dds.docs.eprosima.com/en/3.2.x/docker/shm_docker.html
- https://fast-dds.docs.eprosima.com/en/3.x/fastdds/transport/shared_memory/shared_memory.html
- https://fast-dds.docs.eprosima.com/en/latest/fastdds/transport/datasharing.html
- https://cyclonedds.io/docs/cyclonedds/latest/shared_memory/shared_mem_config.html
